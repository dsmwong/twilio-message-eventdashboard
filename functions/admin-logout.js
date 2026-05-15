/**
 * POST /admin-logout → 200 + Set-Cookie clear
 */
const { clearCookieHeader } = require(Runtime.getFunctions()["_shared/auth"].path);

exports.handler = function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  response.appendHeader("Set-Cookie", clearCookieHeader());
  response.setStatusCode(200);
  response.setBody({ ok: true });
  return callback(null, response);
};
