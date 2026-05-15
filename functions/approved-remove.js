/**
 * POST /approved-remove  { value } → 200 (admin-only)
 *                                 → 400 missing value
 *                                 → 404 if value isn't on the allowlist
 */
const { loadApprovedToList, saveApprovedTo } = require(Runtime.getFunctions()["_shared/sync"].path);
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  try {
    requireAdmin(context, event);
    const value = (event.value || "").trim();
    if (!value) {
      response.setStatusCode(400);
      response.setBody({ error: "value is required" });
      return callback(null, response);
    }

    const numbers = await loadApprovedToList(context);
    if (!numbers.some((n) => n.value === value)) {
      response.setStatusCode(404);
      response.setBody({ error: "destination not on allowlist" });
      return callback(null, response);
    }
    const next = numbers.filter((n) => n.value !== value);
    await saveApprovedTo(context, next);

    response.setStatusCode(200);
    response.setBody({ ok: true });
    return callback(null, response);
  } catch (err) {
    console.error("[approved-remove] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
