#!/usr/bin/env node
/**
 * Reads a JSON file of approved destinations and writes it to the
 * Sync Document `approved_to`. The browser dropdown subscribes to that
 * document, and `functions/send.js` enforces the allowlist server-side.
 *
 * Usage:
 *   node scripts/refresh-approved-to.mjs                   # uses data/approved-to.json
 *   node scripts/refresh-approved-to.mjs path/to/list.json
 *
 * Schema:
 *   { "numbers": [ { "label": "My phone", "value": "+61417000000" }, ... ] }
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

const srcPath = process.argv[2] || resolve(root, "data/approved-to.json");
let raw;
try {
  raw = await readFile(srcPath, "utf8");
} catch (err) {
  if (err.code === "ENOENT") {
    console.error(`[refresh-approved] file not found: ${srcPath}`);
    console.error("Hint: cp data/approved-to.example.json data/approved-to.json && edit");
    process.exit(1);
  }
  throw err;
}

const data = JSON.parse(raw);
if (!Array.isArray(data?.numbers)) {
  console.error("[refresh-approved] file must contain { numbers: [{label, value}] }");
  process.exit(1);
}

// Validate each entry.
for (const entry of data.numbers) {
  if (!entry || typeof entry.value !== "string" || typeof entry.label !== "string") {
    console.error("[refresh-approved] every entry needs string `label` and string `value`:", entry);
    process.exit(1);
  }
}

const client = twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid: ACCOUNT_SID });
const svc = client.sync.v1.services(SYNC_SERVICE_SID);

try {
  await svc.documents("approved_to").update({ data });
  console.log("[refresh-approved] Updated Sync Document 'approved_to'");
} catch (err) {
  if (err.status !== 404) throw err;
  await svc.documents.create({ uniqueName: "approved_to", data });
  console.log("[refresh-approved] Created Sync Document 'approved_to'");
}

console.log(`[refresh-approved] Source: ${srcPath}`);
console.log(`[refresh-approved] Approved destinations: ${data.numbers.length}`);
