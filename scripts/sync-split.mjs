#!/usr/bin/env node
/**
 * One-time migration: split admin/credential state into a separate private
 * Sync Service that the browser never gets a grant for.
 *
 * - Finds (or creates) the private service `message-event-dashboard-private`.
 * - Copies the `approved_admins` Document from the public service into the private one.
 * - Copies the `pending_verifications` Map (and any items) from public to private.
 * - Deletes the originals from the public service.
 * - Prints both SIDs so you can paste them into .env / .env.deploy.
 *
 * Idempotent: if the private service exists and already has the docs, the
 * copy step overwrites with whatever is currently in public; if public is
 * already cleaned up, the delete step is a no-op (404).
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import twilio from "twilio";

const FRIENDLY_NAME = "message-event-dashboard-private";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const env = Object.fromEntries(
  (await readFile(resolve(root, ".env"), "utf8"))
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const { ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, SYNC_SERVICE_SID } = env;
if (!ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET || !SYNC_SERVICE_SID) {
  console.error("Missing ACCOUNT_SID / TWILIO_API_KEY / TWILIO_API_SECRET / SYNC_SERVICE_SID in .env");
  process.exit(1);
}

const client = twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid: ACCOUNT_SID });

// 1. Find or create the private service.
const services = await client.sync.v1.services.list({ pageSize: 50 });
let privateSvc = services.find((s) => s.friendlyName === FRIENDLY_NAME);
if (privateSvc) {
  console.log(`[sync-split] Found existing private service: ${privateSvc.sid}`);
} else {
  privateSvc = await client.sync.v1.services.create({ friendlyName: FRIENDLY_NAME });
  console.log(`[sync-split] Created private service: ${privateSvc.sid}`);
}

const PUBLIC = client.sync.v1.services(SYNC_SERVICE_SID);
const PRIVATE = client.sync.v1.services(privateSvc.sid);

// 2. Copy approved_admins document.
let admins = [];
try {
  const doc = await PUBLIC.documents("approved_admins").fetch();
  admins = Array.isArray(doc.data?.admins) ? doc.data.admins : [];
  console.log(`[sync-split] Read ${admins.length} admins from public service.`);
} catch (err) {
  if (err.status !== 404) throw err;
  console.log("[sync-split] No approved_admins doc in public service (already migrated or never seeded).");
}
if (admins.length > 0 || !(await fetchSafe(PRIVATE.documents("approved_admins")))) {
  const data = { admins };
  try {
    await PRIVATE.documents("approved_admins").update({ data });
  } catch (err) {
    if (err.status !== 404) throw err;
    await PRIVATE.documents.create({ uniqueName: "approved_admins", data });
  }
  console.log(`[sync-split] Wrote approved_admins to private service (${admins.length} entries).`);
}

// 3. Copy pending_verifications map (items have TTL; copy whatever's still alive).
let pendingItems = [];
try {
  await PUBLIC.syncMaps("pending_verifications").fetch();
  pendingItems = await PUBLIC.syncMaps("pending_verifications").syncMapItems.list({ pageSize: 100 });
  console.log(`[sync-split] Read ${pendingItems.length} pending_verifications items from public service.`);
} catch (err) {
  if (err.status !== 404) throw err;
  console.log("[sync-split] No pending_verifications map in public service.");
}
// Ensure the private map exists
try {
  await PRIVATE.syncMaps.create({ uniqueName: "pending_verifications" });
} catch (err) {
  if (err.status !== 409) throw err;
}
for (const item of pendingItems) {
  try {
    await PRIVATE.syncMaps("pending_verifications").syncMapItems(item.key).update({ data: item.data });
  } catch (err) {
    if (err.status !== 404) throw err;
    await PRIVATE.syncMaps("pending_verifications").syncMapItems.create({
      key: item.key,
      data: item.data,
      itemTtl: 600,
    });
  }
}
if (pendingItems.length > 0) {
  console.log(`[sync-split] Wrote ${pendingItems.length} pending items to private service.`);
}

// 4. Delete originals from public service.
try {
  await PUBLIC.documents("approved_admins").remove();
  console.log("[sync-split] Deleted approved_admins from public service.");
} catch (err) {
  if (err.status !== 404) throw err;
}
try {
  await PUBLIC.syncMaps("pending_verifications").remove();
  console.log("[sync-split] Deleted pending_verifications map from public service.");
} catch (err) {
  if (err.status !== 404) throw err;
}

console.log("");
console.log("Migration complete. Add this to .env and .env.deploy:");
console.log(`  SYNC_PRIVATE_SERVICE_SID=${privateSvc.sid}`);

async function fetchSafe(resource) {
  try {
    await resource.fetch();
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}
