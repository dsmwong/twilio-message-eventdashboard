#!/usr/bin/env node
/**
 * Seeds the FIRST admin into the `approved_admins` Sync Document.
 * - Refuses to run if any admins already exist (use the in-dashboard
 *   "Manage admins" panel for subsequent changes).
 * - Prompts for name + password on stdin with echo off, hashes locally
 *   with bcrypt, writes the document.
 *
 * Usage: pnpm run admin:bootstrap
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import twilio from "twilio";
import bcrypt from "bcryptjs";

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

// 1. Refuse if there are already admins.
let existing = [];
try {
  const doc = await svc.documents("approved_admins").fetch();
  existing = Array.isArray(doc.data?.admins) ? doc.data.admins : [];
} catch (err) {
  if (err.status !== 404) throw err;
}
if (existing.length > 0) {
  console.error(`[admin-bootstrap] refused — ${existing.length} admin(s) already exist.`);
  console.error("Use the dashboard's Manage Admins panel to add more.");
  process.exit(1);
}

// 2. Prompt for name and password.
const rl = createInterface({ input, output });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a)));

const askPassword = (q) =>
  new Promise((res) => {
    output.write(q);
    let buf = "";
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\n" || ch === "\r" || ch === "") {
          input.removeListener("data", onData);
          input.setRawMode(false);
          input.pause();
          output.write("\n");
          res(buf);
          return;
        }
        if (ch === "") {
          // Ctrl-C
          process.exit(130);
        }
        if (ch === "" || ch === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });

const name = (await ask("admin name: ")).trim();
if (!name) {
  console.error("[admin-bootstrap] name is required");
  process.exit(1);
}
rl.close();

const pw1 = await askPassword("password (8+ chars, hidden): ");
const pw2 = await askPassword("confirm password: ");
if (pw1 !== pw2) {
  console.error("[admin-bootstrap] passwords don't match");
  process.exit(1);
}
if (pw1.length < 8) {
  console.error("[admin-bootstrap] password must be at least 8 characters");
  process.exit(1);
}

// 3. Hash and write.
const passwordHash = await bcrypt.hash(pw1, 12);
const createdAt = new Date().toISOString();
const data = { admins: [{ name, passwordHash, createdAt }] };

try {
  await svc.documents("approved_admins").update({ data });
  console.log(`[admin-bootstrap] Updated 'approved_admins' with first admin: ${name}`);
} catch (err) {
  if (err.status !== 404) throw err;
  await svc.documents.create({ uniqueName: "approved_admins", data });
  console.log(`[admin-bootstrap] Created 'approved_admins' with first admin: ${name}`);
}
