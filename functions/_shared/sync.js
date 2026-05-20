/**
 * Shared helpers for writing messaging events into Twilio Sync.
 *
 * The dashboard uses TWO Sync services:
 *
 *   - public  (SYNC_SERVICE_SID)         — `messages`, per-message `events:*` lists,
 *                                          `senders`, `approved_to`, `approved_senders`.
 *                                          The browser receives a Sync grant for this one.
 *
 *   - private (SYNC_PRIVATE_SERVICE_SID) — `approved_admins` (bcrypt hashes),
 *                                          `pending_verifications` Map.
 *                                          The browser never gets a grant for this.
 *
 * Helpers below are split accordingly. All admin/credential lookups go through
 * the private service via the function-side API key; the browser cannot reach it.
 */

const MESSAGES_MAP = "messages";

/** Resolve PUBLIC Sync service SID. */
function syncServiceSid(context) {
  const sid = context.SYNC_SERVICE_SID;
  if (!sid) throw new Error("SYNC_SERVICE_SID is not set in environment");
  return sid;
}

/** Resolve PRIVATE Sync service SID (admin/credential state). */
function syncPrivateServiceSid(context) {
  const sid = context.SYNC_PRIVATE_SERVICE_SID;
  if (!sid) throw new Error("SYNC_PRIVATE_SERVICE_SID is not set in environment");
  return sid;
}

/** Public Sync service resource (browser-readable). */
function syncService(context) {
  const client = context.getTwilioClient();
  return client.sync.v1.services(syncServiceSid(context));
}

/** Private Sync service resource (admin/credential only). */
function syncPrivateService(context) {
  const client = context.getTwilioClient();
  return client.sync.v1.services(syncPrivateServiceSid(context));
}

/** Ensure the messages Map and the per-message events List exist. Idempotent. */
async function ensureContainers(context, messageSid) {
  const svc = syncService(context);
  const listName = `events:${messageSid}`;
  try {
    await svc.syncMaps.create({ uniqueName: MESSAGES_MAP });
  } catch (err) {
    if (err.status !== 409) throw err;
  }
  try {
    await svc.syncLists.create({ uniqueName: listName });
  } catch (err) {
    if (err.status !== 409) throw err;
  }
  return { listName };
}

/** Upsert the message row in the Map and append an event item to the List. */
async function recordEvent(context, { messageSid, messageMeta, event }) {
  if (!messageSid) return;
  const svc = syncService(context);
  const { listName } = await ensureContainers(context, messageSid);

  // Upsert map item. Handle the race where two concurrent callbacks both see
  // a 404 fetch and both try to create — the loser gets 409, retry as update.
  // Array-valued fields named in `arrayUnion` are merged set-style (existing
  // ∪ new) so concurrent appends don't clobber each other.
  if (messageMeta) {
    const arrayUnionFields = Array.isArray(messageMeta.__arrayUnion)
      ? messageMeta.__arrayUnion
      : [];
    const cleanMeta = { ...messageMeta };
    delete cleanMeta.__arrayUnion;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const existing = await svc.syncMaps(MESSAGES_MAP).syncMapItems(messageSid).fetch();
        const merged = { ...existing.data, ...cleanMeta };
        for (const field of arrayUnionFields) {
          const prev = Array.isArray(existing.data?.[field]) ? existing.data[field] : [];
          const incoming = Array.isArray(cleanMeta[field]) ? cleanMeta[field] : [];
          merged[field] = Array.from(new Set([...prev, ...incoming]));
        }
        await svc
          .syncMaps(MESSAGES_MAP)
          .syncMapItems(messageSid)
          .update({ data: merged });
        break;
      } catch (err) {
        if (err.status === 404) {
          try {
            await svc
              .syncMaps(MESSAGES_MAP)
              .syncMapItems.create({
                key: messageSid,
                data: { createdAt: new Date().toISOString(), ...cleanMeta },
              });
            break;
          } catch (createErr) {
            if (createErr.status === 409 && attempt < 4) continue;
            throw createErr;
          }
        }
        // Optimistic-concurrency conflict on update → re-fetch and retry.
        if ((err.status === 409 || err.status === 412) && attempt < 4) continue;
        throw err;
      }
    }
  }

  // Append event to list
  await svc.syncLists(listName).syncListItems.create({ data: event });
}

const APPROVED_TO_DOC = "approved_to";
const APPROVED_SENDERS_DOC = "approved_senders";
const ADMINS_DOC = "approved_admins";
const PENDING_VERIFICATIONS_MAP = "pending_verifications";
const PHONE_INDEX_DOC = "phone_to_conversations";

const SENDER_CHANNELS = ["sms", "whatsapp", "rcs", "comms"];

/**
 * Returns a Set of approved E.164 destinations from the `approved_to` Sync Document.
 * Returns null if the document doesn't exist (callers should fail closed).
 */
async function loadApprovedTo(context) {
  const svc = syncService(context);
  try {
    const doc = await svc.documents(APPROVED_TO_DOC).fetch();
    const numbers = Array.isArray(doc.data?.numbers) ? doc.data.numbers : [];
    return new Set(numbers.map((n) => n.value).filter(Boolean));
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Returns the admins array `[{name, passwordHash, createdAt}]` from `approved_admins`
 * on the PRIVATE Sync service.
 * Empty array if the document doesn't exist yet.
 */
async function loadAdmins(context) {
  const svc = syncPrivateService(context);
  try {
    const doc = await svc.documents(ADMINS_DOC).fetch();
    return Array.isArray(doc.data?.admins) ? doc.data.admins : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

/**
 * Replace the entire `admins` array on the PRIVATE service. Creates the doc on first call.
 */
async function saveAdmins(context, admins) {
  const svc = syncPrivateService(context);
  const data = { admins };
  try {
    await svc.documents(ADMINS_DOC).update({ data });
  } catch (err) {
    if (err.status !== 404) throw err;
    await svc.documents.create({ uniqueName: ADMINS_DOC, data });
  }
}

/**
 * Returns the full approved-to list `[{label, value, verifiedAt?, verifiedBy?}]`
 * (loadApprovedTo() above returns just the Set<value> for fast send-time lookup).
 */
async function loadApprovedToList(context) {
  const svc = syncService(context);
  try {
    const doc = await svc.documents(APPROVED_TO_DOC).fetch();
    return Array.isArray(doc.data?.numbers) ? doc.data.numbers : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

/** Replace the approved_to numbers array. Creates the document on first call. */
async function saveApprovedTo(context, numbers) {
  const svc = syncService(context);
  const data = { numbers };
  try {
    await svc.documents(APPROVED_TO_DOC).update({ data });
  } catch (err) {
    if (err.status !== 404) throw err;
    await svc.documents.create({ uniqueName: APPROVED_TO_DOC, data });
  }
}

/**
 * Returns approved senders as `{sms: Set<value>, whatsapp: Set<value>, rcs: Set<value>}`.
 * Missing channels default to empty Sets, missing document defaults to all empty.
 */
async function loadApprovedSenders(context) {
  const svc = syncService(context);
  let raw = {};
  try {
    const doc = await svc.documents(APPROVED_SENDERS_DOC).fetch();
    raw = doc.data || {};
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const out = {};
  for (const ch of SENDER_CHANNELS) {
    out[ch] = new Set(Array.isArray(raw[ch]) ? raw[ch] : []);
  }
  return out;
}

/** Replace approved senders for the given channels. Creates the document on first call. */
async function saveApprovedSenders(context, channels) {
  const svc = syncService(context);
  const data = {};
  for (const ch of SENDER_CHANNELS) {
    data[ch] = Array.isArray(channels[ch]) ? channels[ch] : [];
  }
  try {
    await svc.documents(APPROVED_SENDERS_DOC).update({ data });
  } catch (err) {
    if (err.status !== 404) throw err;
    await svc.documents.create({ uniqueName: APPROVED_SENDERS_DOC, data });
  }
}

/** Ensure the pending_verifications Sync Map exists on the PRIVATE service. Idempotent. */
async function ensurePendingVerificationsMap(context) {
  const svc = syncPrivateService(context);
  try {
    await svc.syncMaps.create({ uniqueName: PENDING_VERIFICATIONS_MAP });
  } catch (err) {
    if (err.status !== 409) throw err;
  }
  return svc.syncMaps(PENDING_VERIFICATIONS_MAP);
}

/** Upsert a pending verification row keyed by the destination value. 10-minute TTL. */
async function upsertPendingVerification(context, value, data) {
  const map = await ensurePendingVerificationsMap(context);
  const itemTtl = 600; // seconds — Verify codes expire in 10 min
  try {
    await map.syncMapItems(value).update({ data, itemTtl });
  } catch (err) {
    if (err.status !== 404) throw err;
    await map.syncMapItems.create({ key: value, data, itemTtl });
  }
}

/** Fetch a pending verification row, or null if missing/expired. */
async function loadPendingVerification(context, value) {
  const map = await ensurePendingVerificationsMap(context);
  try {
    const item = await map.syncMapItems(value).fetch();
    return item.data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Remove a pending verification row. Idempotent. */
async function removePendingVerification(context, value) {
  const map = await ensurePendingVerificationsMap(context);
  try {
    await map.syncMapItems(value).remove();
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

/**
 * Phone → conversations index. Schema:
 *   { numbers: { "+E164": { conversationIds: string[], lastActivityAt: ISO } } }
 *
 * Updated by orchestrator-callback.js as new conversations arrive. Browser
 * subscribes to it directly via Sync to render the Phones tab.
 */
async function loadPhoneIndex(context) {
  const svc = syncService(context);
  try {
    const doc = await svc.documents(PHONE_INDEX_DOC).fetch();
    const numbers = doc.data && typeof doc.data.numbers === "object" ? doc.data.numbers : {};
    return numbers;
  } catch (err) {
    if (err.status === 404) return {};
    throw err;
  }
}

/**
 * Append (idempotently — set semantics on conversationIds) a conversation to
 * the phone's entry in the index, updating lastActivityAt. Creates the doc on
 * first call.
 */
async function appendConversationToPhone(context, phone, conversationId, lastActivityAt) {
  if (!phone || !conversationId) return;
  const svc = syncService(context);
  // Retry loop handles two concurrent callbacks racing on the same Document.
  for (let attempt = 0; attempt < 5; attempt++) {
    let numbers = {};
    try {
      const existing = await svc.documents(PHONE_INDEX_DOC).fetch();
      if (existing.data && typeof existing.data.numbers === "object") {
        numbers = existing.data.numbers;
      }
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    const cur = numbers[phone] || { conversationIds: [], lastActivityAt: null };
    const set = new Set(cur.conversationIds || []);
    set.add(conversationId);
    numbers[phone] = {
      conversationIds: Array.from(set),
      lastActivityAt: lastActivityAt || cur.lastActivityAt || new Date().toISOString(),
    };
    const data = { numbers };
    try {
      await svc.documents(PHONE_INDEX_DOC).update({ data });
      return;
    } catch (err) {
      if (err.status === 404) {
        try {
          await svc.documents.create({ uniqueName: PHONE_INDEX_DOC, data });
          return;
        } catch (createErr) {
          // 409 = another caller created it concurrently; re-fetch + retry.
          if (createErr.status === 409 && attempt < 4) continue;
          throw createErr;
        }
      }
      // 409/412 on update → optimistic-concurrency conflict; re-fetch + retry.
      if ((err.status === 409 || err.status === 412) && attempt < 4) continue;
      throw err;
    }
  }
}

module.exports = {
  recordEvent,
  MESSAGES_MAP,
  APPROVED_TO_DOC,
  APPROVED_SENDERS_DOC,
  ADMINS_DOC,
  PENDING_VERIFICATIONS_MAP,
  PHONE_INDEX_DOC,
  SENDER_CHANNELS,
  loadApprovedTo,
  loadApprovedToList,
  saveApprovedTo,
  loadApprovedSenders,
  saveApprovedSenders,
  loadAdmins,
  saveAdmins,
  upsertPendingVerification,
  loadPendingVerification,
  removePendingVerification,
  loadPhoneIndex,
  appendConversationToPhone,
};
