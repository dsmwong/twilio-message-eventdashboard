/**
 * GET /senders-approved → 200 { sms: [], whatsapp: [], rcs: [] } (admin-only)
 */
const { loadApprovedSenders, SENDER_CHANNELS } = require(Runtime.getFunctions()["_shared/sync"].path);
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  try {
    requireAdmin(context, event);
    const sets = await loadApprovedSenders(context);
    const out = {};
    for (const ch of SENDER_CHANNELS) out[ch] = [...sets[ch]];
    response.setStatusCode(200);
    response.setBody(out);
    return callback(null, response);
  } catch (err) {
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
