#!/usr/bin/env node
/**
 * Provisions the Twilio Verify Service used for confirming new approved
 * destinations. Idempotent: if a service with FriendlyName
 * "message-event-dashboard" already exists, prints its SID; otherwise
 * creates one and prints the new SID. Either way, paste the SID into
 * `.env` and `.env.deploy` as VERIFY_SERVICE_SID.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import twilio from "twilio";

const FRIENDLY_NAME = "message-event-dashboard";

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

const { ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET } = env;
if (!ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET) {
  console.error("Missing ACCOUNT_SID / TWILIO_API_KEY / TWILIO_API_SECRET in .env");
  process.exit(1);
}

const client = twilio(TWILIO_API_KEY, TWILIO_API_SECRET, { accountSid: ACCOUNT_SID });

const existing = await client.verify.v2.services.list({ pageSize: 50 });
let match = existing.find((s) => s.friendlyName === FRIENDLY_NAME);

if (match) {
  console.log(`[verify-bootstrap] Found existing service: ${match.sid}`);
} else {
  match = await client.verify.v2.services.create({ friendlyName: FRIENDLY_NAME });
  console.log(`[verify-bootstrap] Created new service: ${match.sid}`);
}

console.log("");
console.log("Add this to .env and .env.deploy:");
console.log(`  VERIFY_SERVICE_SID=${match.sid}`);
