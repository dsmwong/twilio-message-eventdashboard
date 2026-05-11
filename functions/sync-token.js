/**
 * POST /sync-token
 * Returns a short-lived Twilio Access Token with a SyncGrant for the dashboard.
 */

const { randomUUID } = require("crypto");

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");
  response.appendHeader("Access-Control-Allow-Origin", "*");

  try {
    const apiKey = context.TWILIO_API_KEY;
    const apiSecret = context.TWILIO_API_SECRET;
    const accountSid = context.ACCOUNT_SID;
    const syncServiceSid = context.SYNC_SERVICE_SID;

    if (!apiKey || !apiSecret) throw new Error("TWILIO_API_KEY / TWILIO_API_SECRET not set");
    if (!syncServiceSid) throw new Error("SYNC_SERVICE_SID not set");

    const { AccessToken } = Twilio.jwt;
    const identity = event.identity || `dashboard-${randomUUID()}`;

    const token = new AccessToken(accountSid, apiKey, apiSecret, {
      identity,
      ttl: 3600,
    });

    const grant = new AccessToken.SyncGrant({ serviceSid: syncServiceSid });
    token.addGrant(grant);

    response.setStatusCode(200);
    response.setBody({ identity, token: token.toJwt() });
    return callback(null, response);
  } catch (err) {
    console.error("[sync-token] error", err);
    response.setStatusCode(500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
