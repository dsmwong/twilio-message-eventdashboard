#!/usr/bin/env node
/**
 * Provisions a Twilio Conversation Orchestrator (v2) setup:
 *
 *  - A Memory Store (mandatory dependency for any Configuration).
 *  - A Configuration named `message-event-dashboard-conv` with capture rules
 *    derived from the senders Sync Document (so every Twilio number we own is
 *    captured) and a statusCallbacks pointer at /orchestrator-callback.
 *
 * Idempotent: re-runs reuse existing resources (matched by uniqueName /
 * displayName) and report their IDs without duplicating.
 *
 * Auth: HTTP Basic — ACCOUNT_SID + AUTH_TOKEN from .env. Both these v2 APIs
 * (memory.twilio.com, conversations.twilio.com/v2) are JSON-only and not yet
 * exposed in the typed twilio SDK.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import twilio from "twilio";

const MEMORY_STORE_UNIQUE_NAME = "message-event-dashboard-mem";
const CONFIG_DISPLAY_NAME = "message-event-dashboard-conv";
const CALLBACK_PATH = "/orchestrator-callback";

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

const {
  ACCOUNT_SID,
  AUTH_TOKEN,
  TWILIO_API_KEY,
  TWILIO_API_SECRET,
  SYNC_SERVICE_SID,
  PUBLIC_BASE_URL,
} = env;

if (!ACCOUNT_SID || !AUTH_TOKEN) {
  console.error("Missing ACCOUNT_SID / AUTH_TOKEN in .env (needed for Basic auth on v2 APIs).");
  process.exit(1);
}
if (!SYNC_SERVICE_SID) {
  console.error("Missing SYNC_SERVICE_SID in .env (needed to read the senders document).");
  process.exit(1);
}
if (!PUBLIC_BASE_URL) {
  console.error("Missing PUBLIC_BASE_URL in .env (needed for the statusCallbacks URL).");
  console.error("Set it to your ngrok URL for local dev (e.g. https://dawong.au.ngrok.io).");
  process.exit(1);
}

const callbackUrl = `${PUBLIC_BASE_URL.replace(/\/$/, "")}${CALLBACK_PATH}`;

// Use API key + secret for the Twilio SDK calls (just used to read senders doc).
const sdkClient = twilio(
  TWILIO_API_KEY || ACCOUNT_SID,
  TWILIO_API_SECRET || AUTH_TOKEN,
  TWILIO_API_KEY ? { accountSid: ACCOUNT_SID } : undefined
);

function basicAuth() {
  return Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
}

function request(host, method, path, payload) {
  return new Promise((resolve, reject) => {
    const opts = {
      host,
      path,
      method,
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        Accept: "application/json",
      },
    };
    let body = null;
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ───────────── 1. Memory Store ─────────────

console.log("[conversations-bootstrap] Looking up Memory Store…");
let memoryStoreSid = null;
{
  // List existing services. The skill says POST with the same uniqueName returns
  // the existing one, but we'd rather be explicit than rely on undocumented
  // idempotency. The shape of the list response isn't documented — try both
  // `services` and `stores` keys defensively.
  const list = await request("memory.twilio.com", "GET", "/v1/Services?PageSize=50");
  if (list.status === 200 && list.body) {
    const items = list.body.services || list.body.stores || [];
    const match = items.find(
      (s) => s.uniqueName === MEMORY_STORE_UNIQUE_NAME || s.unique_name === MEMORY_STORE_UNIQUE_NAME
    );
    if (match) {
      memoryStoreSid = match.sid || match.id;
      console.log(`  → reusing Memory Store ${memoryStoreSid}`);
    }
  } else if (list.status !== 404) {
    console.warn(`  list returned ${list.status}, will attempt POST anyway:`, list.body);
  }

  if (!memoryStoreSid) {
    const created = await request("memory.twilio.com", "POST", "/v1/Services", {
      uniqueName: MEMORY_STORE_UNIQUE_NAME,
      friendlyName: "Message Event Dashboard Memory",
    });
    if (created.status >= 200 && created.status < 300 && created.body) {
      memoryStoreSid = created.body.sid || created.body.id;
      console.log(`  → created Memory Store ${memoryStoreSid}`);
    } else {
      console.error("  Memory Store create failed:", created.status, created.body);
      process.exit(1);
    }
  }
}

// ───────────── 2. Capture rules from senders document ─────────────

console.log("[conversations-bootstrap] Reading senders document for capture rules…");
const sendersDoc = await sdkClient.sync.v1
  .services(SYNC_SERVICE_SID)
  .documents("senders")
  .fetch()
  .catch((err) => {
    if (err.status === 404) return null;
    throw err;
  });

const sendersData = sendersDoc?.data || {};
const smsValues = (sendersData.sms || [])
  .map((s) => s.value)
  .filter((v) => typeof v === "string" && v.startsWith("+")); // skip Messaging Service SIDs (MG…) — Conversations capture rules expect E.164
const whatsappValues = (sendersData.whatsapp || []).map((s) => s.value).filter(Boolean);
const rcsValues = (sendersData.rcs || []).map((s) => s.value).filter(Boolean);

function pairsFor(channel, values) {
  const rules = [];
  for (const v of values) {
    rules.push({ from: v, to: "*", metadata: {} });
    rules.push({ from: "*", to: v, metadata: {} });
  }
  return rules;
}

function inboundFor(values) {
  // VOICE: only PSTN inbound to our numbers. Outbound voice from us is initiated
  // via the REST API and not relevant for this dashboard's observe-only scope.
  return values.map((v) => ({ from: "*", to: v, metadata: {} }));
}

const channelSettings = {
  SMS: {
    captureRules: pairsFor("SMS", smsValues),
    statusTimeouts: { inactive: 10, closed: 60 },
  },
  WHATSAPP: {
    captureRules: pairsFor("WHATSAPP", whatsappValues),
    statusTimeouts: { inactive: 10, closed: 60 },
  },
  RCS: {
    captureRules: pairsFor("RCS", rcsValues),
    statusTimeouts: { inactive: 10, closed: 60 },
  },
  VOICE: {
    captureRules: inboundFor(smsValues), // PSTN-only — same E.164 set
  },
};

console.log(
  `  rules: SMS=${channelSettings.SMS.captureRules.length} ` +
    `WHATSAPP=${channelSettings.WHATSAPP.captureRules.length} ` +
    `RCS=${channelSettings.RCS.captureRules.length} ` +
    `VOICE=${channelSettings.VOICE.captureRules.length}`
);
console.warn(
  "  ⚠️  VOICE capture rules use Real-Time Transcription. Do NOT combine with \n" +
    "      ConversationRelay TwiML on these numbers — that causes double STT billing."
);

// ───────────── 3. Configuration ─────────────

console.log("[conversations-bootstrap] Looking up Configuration…");
async function findConfig() {
  const list = await request(
    "conversations.twilio.com",
    "GET",
    "/v2/ControlPlane/Configurations?PageSize=50"
  );
  if (list.status !== 200 || !list.body) return null;
  // The list response key isn't documented. Try common shapes.
  const items = list.body.configurations || list.body.items || [];
  return items.find((c) => c.displayName === CONFIG_DISPLAY_NAME || c.display_name === CONFIG_DISPLAY_NAME) || null;
}

let config = await findConfig();
if (config) {
  console.log(`  → reusing Configuration ${config.id || config.sid}`);
} else {
  const payload = {
    displayName: CONFIG_DISPLAY_NAME,
    description: "Capture-everything for the dashboard demo (observe-only)",
    conversationGroupingType: "GROUP_BY_PROFILE",
    memoryStoreId: memoryStoreSid,
    memoryExtractionEnabled: false,
    channelSettings,
    statusCallbacks: [{ url: callbackUrl, method: "POST" }],
  };
  console.log(`  POST /v2/ControlPlane/Configurations…`);
  const created = await request(
    "conversations.twilio.com",
    "POST",
    "/v2/ControlPlane/Configurations",
    payload
  );
  if (created.status === 202 || (created.status >= 200 && created.status < 300)) {
    // The POST may return 202 with an operation envelope (no immediate id).
    // Poll the list endpoint until our displayName is present.
    console.log(`  → POST returned ${created.status}, polling list for displayName match…`);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const found = await findConfig();
      if (found) {
        config = found;
        console.log(`  → Configuration ready: ${config.id || config.sid}`);
        break;
      }
      process.stdout.write(".");
    }
    if (!config) {
      console.error("\n  Configuration didn't appear in list within 30s.");
      console.error("  POST response was:", created.body);
      process.exit(1);
    }
  } else {
    console.error("  Configuration create failed:", created.status, created.body);
    process.exit(1);
  }
}

const configId = config.id || config.sid;

// ───────────── 4. Output ─────────────

console.log("");
console.log("Done. Add these to .env and .env.deploy:");
console.log(`  MEMORY_STORE_ID=${memoryStoreSid}`);
console.log(`  CONVERSATIONS_CONFIG_ID=${configId}`);
console.log("");
console.log(`statusCallbacks URL is set to: ${callbackUrl}`);
console.log("If you change PUBLIC_BASE_URL or domain, re-run this script.");
