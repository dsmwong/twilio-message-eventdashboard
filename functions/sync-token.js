/**
 * POST /sync-token
 * Returns a short-lived Twilio Access Token with a SyncGrant for the PUBLIC
 * Sync service. Identity is server-generated and bound to the requester:
 *   - admin cookie present  → identity "admin-<name>-<uuid>", 1h TTL
 *   - no admin cookie       → identity "viewer-<uuid>",        30m TTL
 *
 * Both tokens grant the same public Sync service. Admin/credential state
 * lives on a separate private Sync service that the browser never gets a
 * token for. Identity is set server-side (not from the request body) to
 * prevent privilege escalation if Sync ACLs are ever enabled.
 */

const { randomUUID } = require("crypto");
const { currentAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);

const ADMIN_TTL_SECONDS = 3600;
const VIEWER_TTL_SECONDS = 1800;

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");

  try {
    const apiKey = context.TWILIO_API_KEY;
    const apiSecret = context.TWILIO_API_SECRET;
    const accountSid = context.ACCOUNT_SID;
    const syncServiceSid = context.SYNC_SERVICE_SID;

    if (!apiKey || !apiSecret) throw new Error("TWILIO_API_KEY / TWILIO_API_SECRET not set");
    if (!syncServiceSid) throw new Error("SYNC_SERVICE_SID not set");

    const admin = currentAdmin(context, event);
    const identity = admin
      ? `admin-${admin.name}-${randomUUID()}`
      : `viewer-${randomUUID()}`;
    const ttl = admin ? ADMIN_TTL_SECONDS : VIEWER_TTL_SECONDS;

    const { AccessToken } = Twilio.jwt;
    const token = new AccessToken(accountSid, apiKey, apiSecret, { identity, ttl });
    token.addGrant(new AccessToken.SyncGrant({ serviceSid: syncServiceSid }));

    response.setStatusCode(200);
    response.setBody({ identity, token: token.toJwt(), role: admin ? "admin" : "viewer" });
    return callback(null, response);
  } catch (err) {
    console.error("[sync-token] error", err);
    response.setStatusCode(500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
