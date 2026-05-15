/**
 * Shared helpers for writing messaging events into Twilio Sync.
 */

const MESSAGES_MAP = "messages";

/** Resolve Sync service SID from env (prefer SYNC_SERVICE_SID, fall back to default). */
function syncServiceSid(context) {
  const sid = context.SYNC_SERVICE_SID;
  if (!sid) throw new Error("SYNC_SERVICE_SID is not set in environment");
  return sid;
}

/** Return a lazily-initialized Sync service resource. */
function syncService(context) {
  const client = context.getTwilioClient();
  return client.sync.v1.services(syncServiceSid(context));
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

  // Upsert map item
  if (messageMeta) {
    try {
      const existing = await svc.syncMaps(MESSAGES_MAP).syncMapItems(messageSid).fetch();
      const merged = { ...existing.data, ...messageMeta };
      await svc
        .syncMaps(MESSAGES_MAP)
        .syncMapItems(messageSid)
        .update({ data: merged });
    } catch (err) {
      if (err.status !== 404) throw err;
      await svc
        .syncMaps(MESSAGES_MAP)
        .syncMapItems.create({
          key: messageSid,
          data: { createdAt: new Date().toISOString(), ...messageMeta },
        });
    }
  }

  // Append event to list
  await svc.syncLists(listName).syncListItems.create({ data: event });
}

const APPROVED_TO_DOC = "approved_to";
const APPROVED_SENDERS_DOC = "approved_senders";
const ADMINS_DOC = "approved_admins";
const PENDING_VERIFICATIONS_MAP = "pending_verifications";

const SENDER_CHANNELS = ["sms", "whatsapp", "rcs"];

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
 * Returns the admins array `[{name, passwordHash, createdAt}]` from `approved_admins`.
 * Empty array if the document doesn't exist yet.
 */
async function loadAdmins(context) {
  const svc = syncService(context);
  try {
    const doc = await svc.documents(ADMINS_DOC).fetch();
    return Array.isArray(doc.data?.admins) ? doc.data.admins : [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}

/**
 * Replace the entire `admins` array. Creates the document on first call.
 */
async function saveAdmins(context, admins) {
  const svc = syncService(context);
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

/** Ensure the pending_verifications Sync Map exists. Idempotent. */
async function ensurePendingVerificationsMap(context) {
  const svc = syncService(context);
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

module.exports = {
  recordEvent,
  MESSAGES_MAP,
  APPROVED_TO_DOC,
  APPROVED_SENDERS_DOC,
  ADMINS_DOC,
  PENDING_VERIFICATIONS_MAP,
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
};
