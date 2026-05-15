/**
 * POST /admin-remove  { name } → 200 (admin-only)
 *                              → 400 if removing yourself or the last admin
 *                              → 404 if the name isn't an admin
 *                              → 401 if not signed in
 */
const { loadAdmins, saveAdmins } = require(Runtime.getFunctions()["_shared/sync"].path);
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  try {
    const me = requireAdmin(context, event);
    const target = (event.name || "").trim();
    if (!target) {
      response.setStatusCode(400);
      response.setBody({ error: "name is required" });
      return callback(null, response);
    }
    if (target === me.name) {
      response.setStatusCode(400);
      response.setBody({ error: "you can't remove yourself" });
      return callback(null, response);
    }

    const admins = await loadAdmins(context);
    if (!admins.some((a) => a.name === target)) {
      response.setStatusCode(404);
      response.setBody({ error: "no admin with that name" });
      return callback(null, response);
    }
    if (admins.length <= 1) {
      response.setStatusCode(400);
      response.setBody({ error: "can't remove the last admin" });
      return callback(null, response);
    }

    const next = admins.filter((a) => a.name !== target);
    await saveAdmins(context, next);

    response.setStatusCode(200);
    response.setBody({ ok: true });
    return callback(null, response);
  } catch (err) {
    console.error("[admin-remove] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
