/**
 * GET /admin-me → 200 { name } | 401
 */
const { currentAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);

exports.handler = function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  try {
    const admin = currentAdmin(context, event);
    if (!admin) {
      response.setStatusCode(401);
      response.setBody({ error: "not signed in" });
      return callback(null, response);
    }
    response.setStatusCode(200);
    response.setBody({ name: admin.name });
    return callback(null, response);
  } catch (err) {
    console.error("[admin-me] error", err);
    response.setStatusCode(500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
