/**
 * POST /orchestrator-callback
 *
 * Receives Twilio Conversation Orchestrator (Conversations v2) statusCallback
 * notifications. Conversation Orchestrator does NOT publish a public Event
 * Streams family for v2 conversations — every state change arrives here as
 * its own callback fire.
 *
 * Auth: shared secret via ?secret=… query string. Conversation Orchestrator's
 * statusCallbacks does NOT sign callbacks (no X-Twilio-Signature header), so
 * we put the secret in the configured URL itself. Twilio echoes the URL
 * verbatim so the secret arrives on every fire. Compare against
 * ORCHESTRATOR_CALLBACK_SECRET in context. 403 on mismatch.
 *
 * Each callback body is itself an event. We classify by the `id` prefix:
 *   - conv_conversation_…   → lifecycle.<status>            (e.g. lifecycle.ACTIVE)
 *   - conv_participant_…    → participant.<action>          (e.g. participant.added)
 *   - conv_communication_…  → communication.<channel>.<dir> (e.g. communication.sms.in)
 * Anything else is recorded with eventType "orchestrator.<id-prefix>" so we
 * never silently drop a callback.
 *
 * Side-effects per call:
 *   1. One event appended to events:{conversationId}, deduped by entity id.
 *   2. Upserts the row in the `messages` Sync Map with channel="conversations",
 *      participant addresses (when known), and last status.
 *   3. Updates the `phone_to_conversations` Sync Document for each participant.
 */
const {
  recordEvent,
  appendConversationToPhone,
} = require(Runtime.getFunctions()["_shared/sync"].path);
const {
  getConversation,
} = require(Runtime.getFunctions()["_shared/conversations-api"].path);

/**
 * The Twilio Functions runtime parses JSON bodies onto the event object. We
 * reconstruct the canonical body — preferring event.request.body, falling
 * back to spreading event minus runtime-injected keys.
 */
function reconstructBody(event) {
  if (event && event.request && typeof event.request.body === "string" && event.request.body.length > 0) {
    try {
      return { rawBody: event.request.body, parsed: JSON.parse(event.request.body) };
    } catch {
      // fall through
    }
  }
  const { request, bodySHA256, secret, ...rest } = event || {};
  const numericKeys = Object.keys(rest).filter((k) => /^\d+$/.test(k));
  if (numericKeys.length > 0 && numericKeys.length === Object.keys(rest).length) {
    const arr = numericKeys.sort((a, b) => Number(a) - Number(b)).map((k) => rest[k]);
    return { rawBody: JSON.stringify(arr), parsed: arr };
  }
  return { rawBody: JSON.stringify(rest), parsed: rest };
}

/**
 * The callback body is wrapped: { eventType, timestamp, data: { id, ... } }.
 * `data` carries the entity (conversation, participant, or communication).
 */
function unwrap(parsed) {
  const wrapper = parsed && typeof parsed === "object" ? parsed : {};
  const data = wrapper.data && typeof wrapper.data === "object" ? wrapper.data : wrapper;
  const upstreamEventType = typeof wrapper.eventType === "string" ? wrapper.eventType : null;
  const upstreamTimestamp = typeof wrapper.timestamp === "string" ? wrapper.timestamp : null;
  return { wrapper, data, upstreamEventType, upstreamTimestamp };
}

/** Find the conversation id from the (unwrapped) data block. */
function pickConversationId(data) {
  if (!data || typeof data !== "object") return null;
  if (typeof data.conversationId === "string" && data.conversationId.startsWith("conv_conversation_"))
    return data.conversationId;
  if (typeof data.id === "string" && data.id.startsWith("conv_conversation_")) return data.id;
  for (const v of Object.values(data)) {
    if (typeof v === "string" && v.startsWith("conv_conversation_")) return v;
  }
  return null;
}

/**
 * Classify the callback. The eventType stored is the verbatim upstream value
 * (e.g. "CONVERSATION_CREATED", "PARTICIPANT_ADDED", "COMMUNICATION_CREATED")
 * so the timeline displays exactly what Twilio sent. Entity type is derived
 * from the id prefix and used only for routing logic (lastStatus updates,
 * column grouping in the UI).
 */
function classify(data, upstreamEventType) {
  const id = data && typeof data.id === "string" ? data.id : null;
  let entityType = "unknown";
  if (id && id.startsWith("conv_conversation_")) entityType = "conversation";
  else if (id && id.startsWith("conv_participant_")) entityType = "participant";
  else if (id && id.startsWith("conv_communication_")) entityType = "communication";

  let eventType = upstreamEventType;
  if (!eventType) {
    // Fallback when the wrapper didn't include an explicit eventType — derive
    // a synthetic upper-snake string from what we can see, so the UI still
    // gets a consistent shape.
    if (entityType === "conversation") {
      const status = (data.status || data.state || "UNKNOWN").toString().toUpperCase();
      eventType = `CONVERSATION_${status}`;
    } else if (entityType === "participant") {
      eventType = "PARTICIPANT_ADDED";
    } else if (entityType === "communication") {
      eventType = "COMMUNICATION_CREATED";
    } else {
      eventType = "ORCHESTRATOR_UNKNOWN";
    }
  }

  return { entityType, entityId: id, eventType };
}

/**
 * Extract participant addresses from a participant-or-conversation shaped
 * body. Does NOT extract from communication recipients — Twilio sometimes
 * routes a communication through a conversation whose participants don't
 * include the recipient address (we observed this), which would poison
 * the row's participant list. Use Twilio's authoritative participants list
 * from the conversation resource instead.
 */
function extractParticipantAddresses(data) {
  const out = new Set();
  const collect = (val) => {
    if (!val) return;
    if (typeof val === "string") out.add(val);
    else if (typeof val === "object" && typeof val.address === "string") out.add(val.address);
  };
  // Conversation-shape: data.participants[].addresses[]
  if (Array.isArray(data?.participants)) {
    for (const p of data.participants) {
      collect(p?.address);
      if (Array.isArray(p?.addresses)) p.addresses.forEach(collect);
    }
  }
  // Participant-shape: data.addresses[]
  if (Array.isArray(data?.addresses)) data.addresses.forEach(collect);
  return Array.from(out);
}

/**
 * Read the existing events:{conversationId} list and return a set of
 * "<entityId>::<eventType>" keys that are already recorded. Used to dedupe.
 */
async function loadExistingEvents(context, conversationId) {
  const seen = new Set();
  const client = context.getTwilioClient();
  const listName = `events:${conversationId}`;
  for (let page = 0; page < 20; page++) {
    let items;
    try {
      items = await client.sync.v1
        .services(context.SYNC_SERVICE_SID)
        .syncLists(listName)
        .syncListItems.list({ pageSize: 100 });
    } catch (err) {
      if (err.status === 404) return seen;
      throw err;
    }
    for (const item of items) {
      const ev = item.data || {};
      // New shape: payload IS the inner data (has .id directly).
      // Old shape: payload was the wrapped body (id at .data.id).
      // Tolerate both for migration.
      const payload = ev?.payload || {};
      const entityId =
        (typeof payload.id === "string" && payload.id) ||
        (payload.data && typeof payload.data.id === "string" && payload.data.id) ||
        null;
      const evType = typeof ev.eventType === "string" ? ev.eventType : "";
      if (entityId && evType) seen.add(`${entityId}::${evType}`);
    }
    if (items.length < 100) break;
  }
  return seen;
}

exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader("Content-Type", "application/json");

  try {
    const { rawBody, parsed } = reconstructBody(event);

    // Shared-secret auth (Orchestrator does not sign these callbacks).
    const expected = context.ORCHESTRATOR_CALLBACK_SECRET;
    if (expected) {
      const got = (event && event.secret) || "";
      if (got !== expected) {
        const err = new Error("missing or wrong callback secret");
        err.status = 403;
        throw err;
      }
    } else if (context.SKIP_TWILIO_SIGNATURE !== "true") {
      const err = new Error("ORCHESTRATOR_CALLBACK_SECRET not set; refusing unsigned request");
      err.status = 503;
      throw err;
    }

    const { data, upstreamEventType, upstreamTimestamp } = unwrap(parsed);
    const conversationId = pickConversationId(data);
    if (!conversationId) {
      console.warn(
        "[orchestrator-callback] no conversationId in body, dropping. raw=",
        rawBody && rawBody.slice(0, 600)
      );
      response.setStatusCode(200);
      response.setBody({ ok: true, skipped: "no-conversation-id" });
      return callback(null, response);
    }

    const { entityType, entityId, eventType } = classify(data, upstreamEventType);
    console.log(
      `[orchestrator-callback] ${eventType} entity=${entityId || "?"} conv=${conversationId}`
    );

    // Dedupe: skip if we've already recorded this exact (entityId, eventType)
    // pair. We dedupe on both because the SAME conversation entity fires
    // multiple lifecycle events (CONVERSATION_CREATED, ACTIVE, INACTIVE,
    // CLOSED) and we want to keep all of them.
    if (entityId) {
      const seen = await loadExistingEvents(context, conversationId);
      const key = `${entityId}::${eventType}`;
      if (seen.has(key)) {
        response.setStatusCode(200);
        response.setBody({ ok: true, skipped: "duplicate", entityId, eventType });
        return callback(null, response);
      }
    }

    // Build the messages-row metadata. Different callback shapes expose
    // different fields — merge what we can and keep what's already there.

    // Participant-address resolution by entity type. Communication events
    // never touch the row's participant list because Twilio sometimes routes
    // a communication through a conversation whose participants don't include
    // the recipient address (observed: a comm with recipient=+61480893069
    // delivered through a conversation whose only AGENT participant was
    // +61480838905). Trust only authoritative participant/conversation events.
    let bodyAddresses = [];
    let authoritativeAddresses = null; // null = no overwrite; [] = clear; [a,b] = replace
    if (entityType === "participant") {
      // Append-only: extract this single participant's address(es).
      bodyAddresses = extractParticipantAddresses(data);
    } else if (entityType === "conversation") {
      // Use the body's participants list when populated; otherwise re-fetch.
      bodyAddresses = extractParticipantAddresses(data);
      const fromBody = Array.isArray(data?.participants) ? data.participants : null;
      if (!fromBody || fromBody.length === 0) {
        try {
          const fresh = await getConversation(context, conversationId);
          authoritativeAddresses = extractParticipantAddresses(fresh);
        } catch (err) {
          console.warn(
            `[orchestrator-callback] getConversation ${conversationId} failed`,
            err.status,
            err.upstream
          );
        }
      } else {
        authoritativeAddresses = bodyAddresses;
      }
    }

    // lastStatus reflects the most recent conversation lifecycle. Trust the
    // body's `status` if present; otherwise infer from the upstream eventType
    // verb. Non-conversation entities don't move lastStatus.
    let lastStatus;
    if (entityType === "conversation") {
      const explicit = (data.status || data.state || "").toString().toUpperCase();
      if (explicit) {
        lastStatus = explicit;
      } else if (upstreamEventType === "CONVERSATION_CREATED") {
        lastStatus = "ACTIVE";
      } else if (upstreamEventType === "CONVERSATION_INACTIVE") {
        lastStatus = "INACTIVE";
      } else if (upstreamEventType === "CONVERSATION_CLOSED") {
        lastStatus = "CLOSED";
      } else if (upstreamEventType && upstreamEventType.startsWith("CONVERSATION_")) {
        lastStatus = upstreamEventType.replace(/^CONVERSATION_/, "");
      }
    }
    const nowIso = new Date().toISOString();

    const messageMeta = {
      channel: "conversations",
      conversationId,
      lastStatusAt: nowIso,
    };
    if (lastStatus) messageMeta.lastStatus = lastStatus;
    if (authoritativeAddresses) {
      // Conversation event: replace the row's list with Twilio's authoritative one.
      // No __arrayUnion here — we want a true overwrite from the source of truth.
      messageMeta.participantAddresses = authoritativeAddresses;
    } else if (entityType === "participant" && bodyAddresses.length > 0) {
      // Participant event: union-merge into the existing list inside recordEvent
      // (atomic — survives concurrent callbacks racing each other).
      messageMeta.participantAddresses = bodyAddresses;
      messageMeta.__arrayUnion = ["participantAddresses"];
    }

    await recordEvent(context, {
      messageSid: conversationId,
      messageMeta,
      event: {
        source: "orchestrator",
        eventType,
        timestamp: upstreamTimestamp || data.occurredAt || data.createdAt || data.created_at || nowIso,
        receivedAt: nowIso,
        // payload = the entity (mirrors Event Streams' "the inner data is the
        // event payload"); envelope = the full callback body Twilio delivered,
        // so the timeline's "full JSON" panel can show it verbatim.
        payload: data,
        envelope: parsed,
      },
    });

    // Update phone index. Use only authoritative addresses (conversation event)
    // or the body's own participant addresses (PARTICIPANT_ADDED) — never
    // communication recipients.
    const indexAddresses = authoritativeAddresses || bodyAddresses;
    for (const addr of indexAddresses) {
      if (typeof addr !== "string" || addr.length === 0) continue;
      try {
        await appendConversationToPhone(context, addr, conversationId, nowIso);
      } catch (err) {
        console.warn(`[orchestrator-callback] phone-index update for ${addr} failed`, err);
      }
    }

    response.setStatusCode(200);
    response.setBody({ ok: true, conversationId, eventType });
    return callback(null, response);
  } catch (err) {
    console.error("[orchestrator-callback] error", err);
    response.setStatusCode(err.status || 500);
    response.setBody({ error: err.message || String(err) });
    return callback(null, response);
  }
};
