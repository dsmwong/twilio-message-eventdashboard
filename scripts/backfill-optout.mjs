#!/usr/bin/env node
/**
 * Walks every item in the Sync Map `messages` and, for any row that lacks
 * `optOutType`, scans its `events:{MessageSid}` list for an OptOutType field
 * in either StatusCallback form params or Event Streams payloads, then
 * patches the Map row.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import twilio from "twilio";

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
const svc = client.sync.v1.services(SYNC_SERVICE_SID);

function extractOptOut(item) {
  const data = item.data ?? {};
  const payload = data.payload ?? {};
  return (
    data.optOutType ||
    data.OptOutType ||
    payload.OptOutType ||
    payload.optOutType ||
    payload.opt_out_type ||
    null
  );
}

let scanned = 0;
let patched = 0;
let alreadySet = 0;
let noList = 0;

const mapItems = await svc.syncMaps("messages").syncMapItems.list({ limit: 1000 });
console.log(`[backfill] scanning ${mapItems.length} messages`);

for (const row of mapItems) {
  scanned++;
  const sid = row.key;
  const rowData = row.data ?? {};

  if (rowData.optOutType) {
    alreadySet++;
    continue;
  }

  let items;
  try {
    items = await svc.syncLists(`events:${sid}`).syncListItems.list({ limit: 1000 });
  } catch (err) {
    if (err.status === 404) {
      noList++;
      continue;
    }
    throw err;
  }

  let optOutType = null;
  for (const it of items) {
    const v = extractOptOut(it);
    if (v) {
      optOutType = v;
      break;
    }
  }

  if (optOutType) {
    await svc.syncMaps("messages").syncMapItems(sid).update({
      data: { ...rowData, optOutType },
    });
    patched++;
    console.log(`  [${sid}] optOutType="${optOutType}"`);
  }
}

console.log(
  `[backfill] done — scanned=${scanned}, already_set=${alreadySet}, patched=${patched}, no_list=${noList}`
);
