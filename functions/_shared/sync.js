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

module.exports = { recordEvent, MESSAGES_MAP };
