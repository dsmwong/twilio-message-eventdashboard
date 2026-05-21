/**
 * Shared helpers for the Twilio Communications API
 * (https://comms.twilio.com/v1/...).
 *
 * The Comms API is not yet exposed in the typed `twilio` SDK we ship,
 * so these helpers wrap node's https module with HTTP Basic auth using
 * the function's ACCOUNT_SID + AUTH_TOKEN from context.
 */
const https = require("https");

const COMMS_HOST = "comms.twilio.com";
const SENDERS_PATH = "/v1/Senders";
const MESSAGES_PATH = "/v1/Messages";

const SUPPORTED_FROM_CHANNELS = ["SMS", "RCS", "WHATSAPP"];

function basicAuth(accountSid, authToken) {
  return Buffer.from(`${accountSid}:${authToken}`).toString("base64");
}

function request(method, accountSid, authToken, path, payload) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: COMMS_HOST,
      path,
      method,
      headers: {
        Authorization: `Basic ${basicAuth(accountSid, authToken)}`,
        Accept: "application/json",
      },
    };
    let body = null;
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** List senders, paginated, filtered by channel and status. */
async function listSenders(context, { channel, status = "ACTIVATED" } = {}) {
  const accountSid = context.ACCOUNT_SID;
  const authToken = context.AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw Object.assign(new Error("ACCOUNT_SID/AUTH_TOKEN not available"), { status: 500 });
  }
  const senders = [];
  let pageToken = null;
  do {
    const params = [`status=${status}`, "pageSize=100"];
    if (channel) params.push(`channel=${channel}`);
    if (pageToken) params.push(`pageToken=${encodeURIComponent(pageToken)}`);
    const path = `${SENDERS_PATH}?${params.join("&")}`;
    const result = await request("GET", accountSid, authToken, path);
    if (result.status !== 200) {
      const err = new Error(`comms api senders ${result.status}`);
      err.status = result.status;
      err.upstream = result.body;
      throw err;
    }
    const list = Array.isArray(result.body && result.body.senders) ? result.body.senders : [];
    senders.push(...list);
    pageToken = result.body && result.body.pagination && result.body.pagination.nextPageToken
      ? result.body.pagination.nextPageToken
      : null;
  } while (pageToken);
  return senders;
}

/**
 * List ACTIVATED senders across the channels we surface in the dashboard
 * (SMS, RCS, WHATSAPP). Returns the raw API objects.
 */
async function listAllActivatedSenders(context) {
  const all = [];
  for (const channel of SUPPORTED_FROM_CHANNELS) {
    const list = await listSenders(context, { channel });
    all.push(...list);
  }
  return all;
}

/** Build a map of address → sender object for quick channel lookup. */
function indexByAddress(senders) {
  const map = new Map();
  for (const s of senders) {
    if (s && s.address) map.set(s.address, s);
  }
  return map;
}

/** POST a Messages operation. Returns {status, body, headers}. */
function createOperation(context, payload) {
  return request("POST", context.ACCOUNT_SID, context.AUTH_TOKEN, MESSAGES_PATH, payload);
}

/**
 * Fetch a Comms API operation by id. The bulk-send 202 response includes an
 * `operationLocation` URL like `https://comms.twilio.com/v1/Messages/Operations/{id}`,
 * so that's the primary path we try; if Twilio surfaces the resource at a
 * different path we fall back to `/v1/Operations/{id}`.
 */
async function getOperation(context, operationId) {
  const accountSid = context.ACCOUNT_SID;
  const authToken = context.AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw Object.assign(new Error("ACCOUNT_SID/AUTH_TOKEN not available"), { status: 500 });
  }
  const paths = [
    `/v1/Messages/Operations/${encodeURIComponent(operationId)}`,
    `/v1/Operations/${encodeURIComponent(operationId)}`,
  ];
  let last;
  for (const path of paths) {
    const result = await request("GET", accountSid, authToken, path);
    if (result.status === 200) return result.body;
    last = result;
    if (result.status !== 404) break;
  }
  const err = new Error(`getOperation ${last.status}`);
  err.status = last.status;
  err.upstream = last.body;
  throw err;
}

module.exports = {
  SUPPORTED_FROM_CHANNELS,
  listSenders,
  listAllActivatedSenders,
  indexByAddress,
  createOperation,
  getOperation,
};
