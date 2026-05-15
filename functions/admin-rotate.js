/**
 * POST /admin-rotate  { name, password } → 200 (admin-only)
 *   Replaces the password hash for `name`. Any admin can rotate any other admin
 *   (including themselves); intended use is "the team can reset each other's
 *   passwords without console access."
 */
const bcrypt = require("bcryptjs");
const { loadAdmins, saveAdmins } = require(Runtime.getFunctions()["_shared/sync"].path);
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  try {
    requireAdmin(context, event);

    const name = (event.name || "").trim();
    const password = event.password || "";
    if (!name || !password) {
      response.setStatusCode(400);
      response.setBody({ error: "name and password are required" });
      return callback(null, response);
    }
    if (password.length < 8) {
      response.setStatusCode(400);
      response.setBody({ error: "password must be at least 8 characters" });
      return callback(null, response);
    }

    const admins = await loadAdmins(context);
    const idx = admins.findIndex((a) => a.name === name);
    if (idx === -1) {
      response.setStatusCode(404);
      response.setBody({ error: "no admin with that name" });
      return callback(null, response);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const next = admins.slice();
    next[idx] = { ...admins[idx], passwordHash };
    await saveAdmins(context, next);

    response.setStatusCode(200);
    response.setBody({ ok: true });
    return callback(null, response);
  } catch (err) {
    console.error("[admin-rotate] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
