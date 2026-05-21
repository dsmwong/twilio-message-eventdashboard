/**
 * Shared helpers for the Twilio Conversation Orchestrator (Conversations v2)
 * REST API at https://conversations.twilio.com/v2/...
 *
 * This product is not yet exposed in the typed twilio SDK we ship, so the
 * helpers wrap node's https module with HTTP Basic auth (ACCOUNT_SID +
 * AUTH_TOKEN from context). All endpoints require Content-Type: application/json.
 *
 * Mirror of functions/_shared/comms-api.js — same shape so future maintainers
 * see one pattern for "untyped Twilio JSON API client".
 */
const https = require("https");

const HOST = "conversations.twilio.com";

function basicAuth(accountSid, authToken) {
  return Buffer.from(`${accountSid}:${authToken}`).toString("base64");
}

function request(method, accountSid, authToken, path, payload) {
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

/** Fetch the canonical (single-resource) view of a conversation. */
async function getConversation(context, conversationId) {
  const accountSid = context.ACCOUNT_SID;
  const authToken = context.AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw Object.assign(new Error("ACCOUNT_SID/AUTH_TOKEN not available"), { status: 500 });
  }
  const result = await request(
    "GET",
    accountSid,
    authToken,
    `/v2/Conversations/${encodeURIComponent(conversationId)}`
  );
  if (result.status !== 200) {
    const err = new Error(`getConversation ${result.status}`);
    err.status = result.status;
    err.upstream = result.body;
    throw err;
  }
  return result.body;
}

/**
 * List all Communications for a Conversation, paginated. Returns the union of
 * every page in original order. The skill warns the list view returns less data
 * than the single-resource view but for messages the body is generally
 * present, so this is good enough for timeline rendering without a follow-up
 * fetch per communication.
 */
async function listCommunications(context, conversationId) {
  const accountSid = context.ACCOUNT_SID;
  const authToken = context.AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw Object.assign(new Error("ACCOUNT_SID/AUTH_TOKEN not available"), { status: 500 });
  }
  const all = [];
  let pageToken = null;
  for (let page = 0; page < 20; page++) {
    const params = ["PageSize=100"];
    if (pageToken) params.push(`PageToken=${encodeURIComponent(pageToken)}`);
    const path = `/v2/Conversations/${encodeURIComponent(conversationId)}/Communications?${params.join("&")}`;
    const result = await request("GET", accountSid, authToken, path);
    if (result.status !== 200) {
      const err = new Error(`listCommunications ${result.status}`);
      err.status = result.status;
      err.upstream = result.body;
      throw err;
    }
    const items = Array.isArray(result.body && result.body.communications)
      ? result.body.communications
      : [];
    all.push(...items);
    // The pagination shape isn't documented; try a couple of common keys.
    pageToken =
      (result.body && result.body.meta && result.body.meta.next_page_token) ||
      (result.body && result.body.pagination && result.body.pagination.nextPageToken) ||
      null;
    if (!pageToken) break;
  }
  return all;
}

/**
 * Fetch a Participant by its standalone id. Tries `/v2/Participants/{id}`
 * first; if Twilio returns 404, falls back to scanning the parent conversation
 * (where participant ids are also surfaced inside `data.participants`).
 *
 * Caller may optionally pass `conversationId` to skip the standalone attempt.
 */
async function getParticipant(context, participantId, conversationId) {
  const accountSid = context.ACCOUNT_SID;
  const authToken = context.AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw Object.assign(new Error("ACCOUNT_SID/AUTH_TOKEN not available"), { status: 500 });
  }
  if (!conversationId) {
    const result = await request(
      "GET",
      accountSid,
      authToken,
      `/v2/Participants/${encodeURIComponent(participantId)}`
    );
    if (result.status === 200) return result.body;
    if (result.status !== 404) {
      const err = new Error(`getParticipant ${result.status}`);
      err.status = result.status;
      err.upstream = result.body;
      throw err;
    }
  }
  // Fallback: pull parent conversation, find the participant by id.
  if (conversationId) {
    const conv = await getConversation(context, conversationId);
    const match = (conv?.participants || []).find((p) => p?.id === participantId);
    if (match) return match;
  }
  const err = new Error("participant not found");
  err.status = 404;
  throw err;
}

/**
 * Fetch a Communication by its standalone id. Tries `/v2/Communications/{id}`
 * first; if Twilio returns 404 and the caller knows the parent conversation,
 * falls back to scanning the conversation's communications list.
 */
async function getCommunication(context, communicationId, conversationId) {
  const accountSid = context.ACCOUNT_SID;
  const authToken = context.AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw Object.assign(new Error("ACCOUNT_SID/AUTH_TOKEN not available"), { status: 500 });
  }
  const result = await request(
    "GET",
    accountSid,
    authToken,
    `/v2/Communications/${encodeURIComponent(communicationId)}`
  );
  if (result.status === 200) return result.body;
  if (result.status !== 404) {
    const err = new Error(`getCommunication ${result.status}`);
    err.status = result.status;
    err.upstream = result.body;
    throw err;
  }
  if (conversationId) {
    const items = await listCommunications(context, conversationId);
    const match = items.find((c) => c?.id === communicationId);
    if (match) return match;
  }
  const err = new Error("communication not found");
  err.status = 404;
  throw err;
}

/** Fetch a Configuration (the orchestrator-config a conversation is pinned to). */
async function getConfiguration(context, configurationId) {
  const accountSid = context.ACCOUNT_SID;
  const authToken = context.AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw Object.assign(new Error("ACCOUNT_SID/AUTH_TOKEN not available"), { status: 500 });
  }
  const result = await request(
    "GET",
    accountSid,
    authToken,
    `/v2/ControlPlane/Configurations/${encodeURIComponent(configurationId)}`
  );
  if (result.status !== 200) {
    const err = new Error(`getConfiguration ${result.status}`);
    err.status = result.status;
    err.upstream = result.body;
    throw err;
  }
  return result.body;
}

module.exports = {
  getConversation,
  listCommunications,
  getParticipant,
  getCommunication,
  getConfiguration,
};
