/**
 * Shared helpers for Twilio Conversation Memory at memory.twilio.com.
 *
 * Mirror of comms-api.js / conversations-api.js — same untyped JSON-over-HTTPS
 * pattern with HTTP Basic auth. Memory may require per-account enablement; if
 * the account isn't enabled, every call returns 404 (Twilio's `20404`).
 */
const https = require("https");

const HOST = "memory.twilio.com";

function basicAuth(accountSid, authToken) {
  return Buffer.from(`${accountSid}:${authToken}`).toString("base64");
}

function request(method, accountSid, authToken, path) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: HOST,
      path,
      method,
      headers: {
        Authorization: `Basic ${basicAuth(accountSid, authToken)}`,
        Accept: "application/json",
      },
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetch a Memory profile by id. Requires the parent Memory Store sid; we read
 * it from MEMORY_STORE_ID in the runtime context. Profile API path is
 * `/v1/Services/{storeSid}/Profiles/{profileId}`.
 */
async function getProfile(context, profileId) {
  const accountSid = context.ACCOUNT_SID;
  const authToken = context.AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw Object.assign(new Error("ACCOUNT_SID/AUTH_TOKEN not available"), { status: 500 });
  }
  const storeSid = context.MEMORY_STORE_ID;
  if (!storeSid) {
    const err = new Error("MEMORY_STORE_ID not configured; cannot fetch memory profile");
    err.status = 503;
    throw err;
  }
  const result = await request(
    "GET",
    accountSid,
    authToken,
    `/v1/Stores/${encodeURIComponent(storeSid)}/Profiles/${encodeURIComponent(profileId)}`
  );
  if (result.status === 200) return result.body;
  const err = new Error(`getProfile ${result.status}`);
  err.status = result.status;
  err.upstream = result.body;
  throw err;
}

module.exports = {
  getProfile,
};
