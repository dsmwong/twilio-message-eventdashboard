/**
 * POST /send
 * Body: { channel, to, from, body?, contentSid?, contentVariables? }
 * Auth: signed admin cookie (dashboard_session) — viewers cannot send.
 * Allowlist: `to` must be present in the `approved_to` Sync Document.
 * Calls twilio.messages.create(...) with a statusCallback pointing at this deployment's status-callback URL.
 */
const { requireAdmin } = require(Runtime.getFunctions()["_shared/auth"].path);
const { loadApprovedTo } = require(Runtime.getFunctions()["_shared/sync"].path);

function normalize(channel, address) {
  if (!address) return address;
  if (channel === "whatsapp" && !address.startsWith("whatsapp:")) return `whatsapp:${address}`;
  if (channel === "rcs" && !address.startsWith("rcs:") && !address.startsWith("messaging-profile:")) return `rcs:${address}`;
  return address;
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");

  try {
    // 1. Admin session required.
    requireAdmin(context, event);

    const { channel, to, from, body, contentSid, contentVariables } = event;
    if (!channel || !to || !from) {
      response.setStatusCode(400);
      response.setBody({ error: "channel, to, from are required" });
      return callback(null, response);
    }
    if (!contentSid && !body) {
      response.setStatusCode(400);
      response.setBody({ error: "Either contentSid or body is required" });
      return callback(null, response);
    }

    // 2. Destination must be on the allowlist (compared pre-normalization
    // against the canonical E.164 stored in approved_to).
    const approved = await loadApprovedTo(context);
    if (!approved) {
      response.setStatusCode(503);
      response.setBody({ error: "approved_to allowlist is not configured" });
      return callback(null, response);
    }
    if (!approved.has(to)) {
      response.setStatusCode(403);
      response.setBody({ error: "destination not in allowlist" });
      return callback(null, response);
    }

    // Resolve a public base URL for StatusCallback.
    // Prefer PUBLIC_BASE_URL (e.g. an ngrok URL for local dev); otherwise fall back to DOMAIN_NAME.
    // Twilio rejects localhost URLs, so if we can't build a public URL, skip the callback.
    const publicBase = (context.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const domain = context.DOMAIN_NAME || "";
    const isLocal = /^(localhost|127\.0\.0\.1)(:|$)/.test(domain);
    const statusCallback = publicBase
      ? `${publicBase}/status-callback`
      : isLocal
        ? null
        : `https://${domain}/status-callback`;

    const isMessagingService = from.startsWith("MG");

    const params = {
      to: normalize(channel, to),
    };
    if (statusCallback) params.statusCallback = statusCallback;
    if (isMessagingService) params.messagingServiceSid = from;
    else params.from = normalize(channel, from);

    if (contentSid) {
      params.contentSid = contentSid;
      if (contentVariables && Object.keys(contentVariables).length > 0) {
        params.contentVariables = JSON.stringify(contentVariables);
      }
    } else {
      params.body = body;
    }

    const client = context.getTwilioClient();
    const message = await client.messages.create(params);

    response.setStatusCode(200);
    response.setBody({ sid: message.sid, status: message.status });
    return callback(null, response);
  } catch (err) {
    console.error("[send] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err), code: err.code, moreInfo: err.moreInfo });
    return callback(null, response);
  }
};
