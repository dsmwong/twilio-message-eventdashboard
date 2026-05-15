/**
 * POST /admin-login  { name, password } → 200 { name } + Set-Cookie
 *                                       → 401 { error: "invalid credentials" }
 */
const bcrypt = require("bcryptjs");
const { loadAdmins } = require(Runtime.getFunctions()["_shared/sync"].path);
const { signSession, setCookieHeader, DEFAULT_TTL_SECONDS } = require(Runtime.getFunctions()["_shared/auth"].path);

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");

  try {
    const { name, password } = event;
    // Always run a bcrypt compare even if the admin doesn't exist, so timing
    // doesn't reveal which names are registered.
    const admins = await loadAdmins(context);
    const found = admins.find((a) => a.name === name);
    const hash = found?.passwordHash || "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid";
    const ok = (await bcrypt.compare(password || "", hash)) && Boolean(found);

    if (!ok) {
      response.setStatusCode(401);
      response.setBody({ error: "invalid credentials" });
      return callback(null, response);
    }

    const token = signSession(found.name, context.SESSION_SECRET);
    response.appendHeader("Set-Cookie", setCookieHeader(token, DEFAULT_TTL_SECONDS));
    response.setStatusCode(200);
    response.setBody({ name: found.name });
    return callback(null, response);
  } catch (err) {
    console.error("[admin-login] error", err);
    response.setStatusCode(500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
