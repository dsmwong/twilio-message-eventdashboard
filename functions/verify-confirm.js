/**
 * POST /verify-confirm  { value, code } → 200 { value, label, verifiedAt } (admin-only)
 *                                       → 400 wrong code / no pending request / missing fields
 *                                       → 403 cross-admin tamper (different admin than who started)
 *                                       → 503 VERIFY_SERVICE_SID not set
 *
 * On success, appends `{label, value, verifiedAt, verifiedBy}` to approved_to
 * and clears the pending row.
 */
const {
  loadApprovedToList,
  saveApprovedTo,
  loadPendingVerification,
  removePendingVerification,
} = require(Runtime.getFunctions()["_shared/sync"].path);
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  try {
    const admin = requireAdmin(context, event);

    const verifySid = context.VERIFY_SERVICE_SID;
    if (!verifySid) {
      response.setStatusCode(503);
      response.setBody({ error: "VERIFY_SERVICE_SID is not set" });
      return callback(null, response);
    }

    const value = (event.value || "").trim();
    const code = (event.code || "").trim();
    if (!value || !code) {
      response.setStatusCode(400);
      response.setBody({ error: "value and code are required" });
      return callback(null, response);
    }

    const pending = await loadPendingVerification(context, value);
    if (!pending) {
      response.setStatusCode(400);
      response.setBody({ error: "no pending verification (expired or never started)" });
      return callback(null, response);
    }
    if (pending.requestedBy !== admin.name) {
      response.setStatusCode(403);
      response.setBody({ error: "another admin started this verification" });
      return callback(null, response);
    }

    const client = context.getTwilioClient();
    const check = await client.verify.v2
      .services(verifySid)
      .verificationChecks.create({ to: value, code });

    if (check.status !== "approved") {
      response.setStatusCode(400);
      response.setBody({ error: "code did not match", status: check.status });
      return callback(null, response);
    }

    // Append to allowlist (re-fetch to avoid clobbering concurrent updates).
    const numbers = await loadApprovedToList(context);
    if (!numbers.some((n) => n.value === value)) {
      const verifiedAt = new Date().toISOString();
      const next = [
        ...numbers,
        { label: pending.label, value, verifiedAt, verifiedBy: admin.name },
      ];
      await saveApprovedTo(context, next);
    }
    await removePendingVerification(context, value);

    response.setStatusCode(200);
    response.setBody({ value, label: pending.label, verifiedAt: new Date().toISOString() });
    return callback(null, response);
  } catch (err) {
    console.error("[verify-confirm] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err), code: err.code, moreInfo: err.moreInfo });
    return callback(null, response);
  }
};
