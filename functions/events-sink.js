const { recordEvent } = require(Runtime.getFunctions()["_shared/sync"].path);

/**
 * Webhook sink for Twilio Event Streams (batched JSON array).
 * Body is typically `request.body` — an array of CloudEvents-shaped envelopes.
 */

function isCommsApi(envelope) {
  return (envelope?.type || "").toString().toLowerCase().startsWith("com.twilio.comms-api.");
}

/**
 * Sync Map key for the row this event belongs to.
 * - Comms API events  → operation_id  (groups all events for one logical operation
 *                                       — message stages AND operation stages —
 *                                       into the same row + timeline).
 * - Messaging events  → message_sid (or message_id as a fallback).
 */
function extractKey(envelope) {
  const p = envelope?.payload || envelope?.data || {};
  if (isCommsApi(envelope)) {
    return p.operation_id || p.operationId || null;
  }
  return p.message_sid || p.messageSid || p.MessageSid || p.message_id || p.messageId || null;
}

function extractTimestamp(envelope) {
  return envelope?.timestamp || envelope?.time || envelope?.payload?.timestamp || new Date().toISOString();
}

function extractChannel(envelope) {
  // Comms API rows are flagged distinctly so the dashboard can tell at a glance
  // that a row came in through the comms-api pipeline rather than the classic
  // messaging webhook. The underlying transport (sms/whatsapp/rcs) stays in the
  // payload for inspection.
  if (isCommsApi(envelope)) return "comms";
  const p = envelope?.payload || envelope?.data || {};
  const src = (p.source || p.channel || "").toString().toLowerCase();
  if (src.includes("whatsapp")) return "whatsapp";
  if (src.includes("rcs")) return "rcs";
  if (src.includes("sms") || src.includes("mms")) return "sms";
  return undefined;
}

// Flatten an address that may be a Comms API object {address, channel} to a string.
function flattenAddress(v) {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "object" && typeof v.address === "string") return v.address;
  return undefined;
}

function extractDirection(envelope) {
  const type = (envelope?.type || "").toString().toLowerCase();
  if (type.includes(".received") || type.includes("inbound-received")) return "in";
  if (
    type.includes(".sent") ||
    type.includes(".delivered") ||
    type.includes(".failed") ||
    type.includes(".undelivered") ||
    type.includes(".queued") ||
    type.includes(".scheduled") ||
    type.includes(".read")
  )
    return "out";
  const p = envelope?.payload || envelope?.data || {};
  const d = (p.direction || "").toString().toLowerCase();
  if (d.startsWith("inbound")) return "in";
  if (d.startsWith("outbound")) return "out";
  return undefined;
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");

  try {
    // @twilio/runtime-handler spreads JSON-array bodies onto the event object as numeric keys
    // and also adds `request`, `bodySHA256`. Reconstruct the array from numeric keys.
    let raw = event.request?.body;
    if (!raw) {
      const numericKeys = Object.keys(event)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b));
      if (numericKeys.length > 0) {
        raw = numericKeys.map((k) => event[k]);
      } else {
        const { request, bodySHA256, ...rest } = event;
        raw = rest;
      }
    }
    const envelopes = Array.isArray(raw) ? raw : raw?.events && Array.isArray(raw.events) ? raw.events : [raw];
    const nowIso = new Date().toISOString();

    for (const env of envelopes) {
      try {
        const messageSid = extractKey(env);
        if (!messageSid) continue;
        const eventType = env.type || env.eventtype || env.eventType || "unknown";
        const timestamp = extractTimestamp(env);
        const channel = extractChannel(env);
        const direction = extractDirection(env);
        const payload = env.payload || env.data || env;
        const optOutType = payload.optOutType || payload.opt_out_type || payload.OptOutType || undefined;

        const flatTo = flattenAddress(payload.to);
        const flatFrom = flattenAddress(payload.from);
        await recordEvent(context, {
          messageSid,
          messageMeta: {
            ...(flatTo ? { to: flatTo } : {}),
            ...(flatFrom ? { from: flatFrom } : {}),
            ...(channel ? { channel } : {}),
            ...(direction ? { direction } : {}),
            ...(optOutType ? { optOutType } : {}),
          },
          event: {
            source: "event-stream",
            eventType,
            timestamp,
            receivedAt: nowIso,
            payload,
            envelope: env,
          },
        });
      } catch (inner) {
        console.error("[events-sink] per-event error", inner);
      }
    }

    response.setStatusCode(200);
    response.setBody({ ok: true, count: envelopes.length });
    return callback(null, response);
  } catch (err) {
    console.error("[events-sink] error", err);
    response.setStatusCode(500);
    response.setBody({ error: String(err.message || err) });
    return callback(null, response);
  }
};
