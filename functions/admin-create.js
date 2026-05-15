/**
 * POST /admin-create  { name, password } → 200 { name, createdAt }  (admin-only)
 *                                        → 400 (missing fields, dup name, weak password)
 *                                        → 401 (not signed in)
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
    if (admins.some((a) => a.name === name)) {
      response.setStatusCode(400);
      response.setBody({ error: "admin with that name already exists" });
      return callback(null, response);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const createdAt = new Date().toISOString();
    const next = [...admins, { name, passwordHash, createdAt }];
    await saveAdmins(context, next);

    response.setStatusCode(200);
    response.setBody({ name, createdAt });
    return callback(null, response);
  } catch (err) {
    console.error("[admin-create] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
