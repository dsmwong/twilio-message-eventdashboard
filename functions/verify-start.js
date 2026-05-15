/**
 * POST /verify-start  { value, label, channel? } → 200 (admin-only)
 *                                                → 400 invalid value / already approved / missing fields
 *                                                → 503 VERIFY_SERVICE_SID not set
 *
 * Sends a Twilio Verify code to `value` and stores a 10-minute pending row
 * keyed by value (so /verify-confirm can recover the label and bind to the
 * calling admin).
 */
const {
  loadApprovedToList,
  upsertPendingVerification,
} = require(Runtime.getFunctions()["_shared/sync"].path);
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);

const E164 = /^\+[1-9]\d{6,14}$/;
const ALLOWED_CHANNELS = new Set(["sms", "call", "whatsapp", "email"]);

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
    const label = (event.label || "").trim();
    const channel = (event.channel || "sms").trim().toLowerCase();

    if (!value || !label) {
      response.setStatusCode(400);
      response.setBody({ error: "value and label are required" });
      return callback(null, response);
    }
    if (!E164.test(value)) {
      response.setStatusCode(400);
      response.setBody({ error: "value must be E.164 (e.g. +15551234567)" });
      return callback(null, response);
    }
    if (!ALLOWED_CHANNELS.has(channel)) {
      response.setStatusCode(400);
      response.setBody({ error: `channel must be one of: ${[...ALLOWED_CHANNELS].join(", ")}` });
      return callback(null, response);
    }

    const existing = await loadApprovedToList(context);
    if (existing.some((n) => n.value === value)) {
      response.setStatusCode(400);
      response.setBody({ error: "destination is already on the allowlist" });
      return callback(null, response);
    }

    // Send the code via Twilio Verify.
    const client = context.getTwilioClient();
    await client.verify.v2.services(verifySid).verifications.create({ to: value, channel });

    // Track the pending request so the confirm step can recover the label
    // and bind the verification to the admin who started it.
    await upsertPendingVerification(context, value, {
      label,
      channel,
      requestedBy: admin.name,
      requestedAt: new Date().toISOString(),
    });

    response.setStatusCode(200);
    response.setBody({ ok: true });
    return callback(null, response);
  } catch (err) {
    console.error("[verify-start] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err), code: err.code, moreInfo: err.moreInfo });
    return callback(null, response);
  }
};
