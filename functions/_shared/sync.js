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
const ADMINS_DOC = "approved_admins";

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

module.exports = {
  recordEvent,
  MESSAGES_MAP,
  APPROVED_TO_DOC,
  ADMINS_DOC,
  loadApprovedTo,
  loadAdmins,
  saveAdmins,
};
