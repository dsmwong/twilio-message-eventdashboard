/**
 * GET /approved-list → 200 { numbers: [{label, value, verifiedAt?, verifiedBy?}] } (admin-only)
 */
const { loadApprovedToList } = require(Runtime.getFunctions()["_shared/sync"].path);
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  try {
    requireAdmin(context, event);
    const numbers = await loadApprovedToList(context);
    response.setStatusCode(200);
    response.setBody({ numbers });
    return callback(null, response);
  } catch (err) {
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
