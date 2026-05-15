/**
 * GET /admin-list → 200 { admins: [{ name, createdAt }] } (admin-only)
 * Hashes are never returned.
 */
const { loadAdmins } = require(Runtime.getFunctions()["_shared/sync"].path);
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  try {
    requireAdmin(context, event);
    const admins = await loadAdmins(context);
    response.setStatusCode(200);
    response.setBody({ admins: admins.map((a) => ({ name: a.name, createdAt: a.createdAt })) });
    return callback(null, response);
  } catch (err) {
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
