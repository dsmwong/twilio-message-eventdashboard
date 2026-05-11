#!/usr/bin/env node
/**
 * Queries the Twilio account for senders (SMS phone numbers + Messaging Services + WhatsApp + RCS agents)
 * and writes them directly into the Sync Document `senders`. No senders.json file involved.
 *
 * Usage: node scripts/refresh-senders.mjs [--preserve]
 *   --preserve   Keep existing senders in the doc and merge with fresh results (by value).
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import twilio from "twilio";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const preserve = process.argv.includes("--preserve");

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

// 1. Phone numbers with SMS capability
const numbers = await client.incomingPhoneNumbers.list({ limit: 1000 });
const smsPhones = numbers
  .filter((n) => n.capabilities?.sms)
  .map((n) => ({
    label: `${n.friendlyName || n.phoneNumber} (${n.phoneNumber})`,
    value: n.phoneNumber,
    kind: "phone",
  }))
  .sort((a, b) => a.label.localeCompare(b.label));

// 2. Messaging Services
const services = await client.messaging.v1.services.list({ limit: 1000 });
const messagingServices = services.map((s) => ({
  label: `MG: ${s.friendlyName}`,
  value: s.sid,
  kind: "messaging-service",
}));

// 3. WhatsApp senders (via Channels Senders API, scoped to channel=whatsapp).
let whatsapp = [];
try {
  const waSenders = await client.messaging.v2.channelsSenders.list({ channel: "whatsapp", limit: 1000 });
  whatsapp = waSenders.map((s) => {
    const raw = s.senderId || "";
    const num = raw.replace(/^whatsapp:/i, "");
    const name = s.profile?.name ? `${s.profile.name} (${num})` : num;
    return { label: `WA: ${name}`, value: num, kind: "whatsapp" };
  });
} catch (err) {
  console.warn("[refresh-senders] WhatsApp channel listing failed:", err.message);
}
if (whatsapp.length === 0) {
  whatsapp = [{ label: "WhatsApp Sandbox (+14155238886)", value: "+14155238886", kind: "whatsapp" }];
}

// 4. RCS agents — no public REST listing API yet, keep whatever's already there
let rcs = [];
if (preserve) {
  try {
    const existing = await client.sync.v1.services(SYNC_SERVICE_SID).documents("senders").fetch();
    rcs = existing.data?.rcs || [];
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

let sms = [...messagingServices, ...smsPhones];
let whatsappOut = whatsapp;
let rcsOut = rcs;

if (preserve) {
  const svc = client.sync.v1.services(SYNC_SERVICE_SID);
  try {
    const existing = await svc.documents("senders").fetch();
    const mergeByValue = (fresh, old) => {
      const map = new Map(old.map((o) => [o.value, o]));
      for (const f of fresh) map.set(f.value, f);
      return Array.from(map.values());
    };
    sms = mergeByValue(sms, existing.data?.sms || []);
    whatsappOut = mergeByValue(whatsapp, existing.data?.whatsapp || []);
    rcsOut = existing.data?.rcs || [];
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

const data = { sms, whatsapp: whatsappOut, rcs: rcsOut };

// Upsert Sync Document
const svc = client.sync.v1.services(SYNC_SERVICE_SID);
try {
  await svc.documents("senders").update({ data });
  console.log("[refresh-senders] Updated Sync Document 'senders'");
} catch (err) {
  if (err.status !== 404) throw err;
  await svc.documents.create({ uniqueName: "senders", data });
  console.log("[refresh-senders] Created Sync Document 'senders'");
}

console.log(
  `[refresh-senders] Counts: sms=${sms.length} (incl ${messagingServices.length} MS, ${smsPhones.length} phones), whatsapp=${whatsappOut.length}, rcs=${rcsOut.length}${preserve ? " (merged)" : " (replaced)"}`
);
