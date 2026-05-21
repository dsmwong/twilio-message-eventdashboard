# Twilio Messaging Event Dashboard

A live observation dashboard for Twilio messaging activity. It captures and displays events from **three different Twilio sources** side-by-side:

- **Programmable Messaging** — `StatusCallback` webhooks compared with `Event Streams` events for each `MessageSid`. Originally the only mode this dashboard supported.
- **Communications API** — bulk-send operations and their fan-out events, grouped by `operation_id`. Includes a UI to fire bulk sends.
- **Conversation Orchestrator (Conversations v2)** — captured conversations with their full lifecycle: `CONVERSATION_CREATED`, `PARTICIPANT_ADDED`, `COMMUNICATION_CREATED`, `CONVERSATION_INACTIVE` / `CLOSED`, plus admin transition controls.

The whole app — Next.js static frontend + Twilio Functions backend — deploys to a single **Twilio Serverless** service. **Twilio Sync** is the realtime event store and the source of truth for runtime config.

## Architecture

```
                                        ┌─────────────────────────────┐
Twilio Programmable Messaging ─StatusCallback───┐                     │
Twilio Event Streams ──Webhook Sink─────────────┤                     │
Twilio Communications API ─Event Streams────────┤────► Functions ◄── Browser
Twilio Conversation Orchestrator ─statusCallback┘         │              ▲
                                                          ▼              │
                                                    Twilio Sync ─Sync SDK┘
```

### Three home-page tabs

| Tab | Source | Drilldown |
|---|---|---|
| **Messages** | StatusCallback + classic Event Streams | 2-column timeline (`StatusCallback` \| `Event Streams`) for `SM…` / `MM…`, 3-column (`Operation` \| `Comms API · Message` \| `Messaging · Message`) for `comms_operation_…` |
| **Conversations** | `/orchestrator-callback` | 2-column timeline (`Lifecycle` \| `Communications`). Status pills (ACTIVE/INACTIVE/CLOSED). Admin Inactive/Activate/Close buttons. |
| **Phones** | derived index from conversations | Click a customer phone to see every conversation it appears in. |

### Send forms

A single Send panel for admins covers four channels:
- **SMS / WhatsApp / RCS** via `messages.create` — Content API templates or free-form body.
- **Comms API (bulk)** via `POST https://comms.twilio.com/v1/Messages` — multi-select recipients, free-form body.

All sends are gated by both an **approved-destinations allowlist** and a **per-channel approved-senders list**.

## Quick start

```sh
pnpm install

# 1. Provision Twilio resources (one-time)
twilio profiles:use ISVDemo                              # confirm target account
twilio api:sync:v1:services:create --friendly-name message-event-dashboard
twilio api:core:keys:create --friendly-name message-event-dashboard
pnpm run verify:bootstrap                                # Twilio Verify Service for destination verification
pnpm run sync:split                                      # split admin/credential state into private Sync service
pnpm run session:secret                                  # 32-byte hex for cookie HMAC

# 2. Paste the resulting SIDs into .env and .env.deploy (see "Environment" below)

# 3. Ship it
pnpm run deploy
pnpm run admin:bootstrap                                 # interactive: seed first admin

# 4. Wire Event Streams (after first deploy, see "Wire Event Streams" below)

# 5. (Optional) Wire Conversation Orchestrator (see "Wire Conversation Orchestrator" below)
```

For local development, see [Develop](#develop) below.

## Functions reference

### Public ingest endpoints
| Endpoint | Source | Auth |
|---|---|---|
| `POST /status-callback` | Programmable Messaging StatusCallback | `X-Twilio-Signature` |
| `POST /incoming-sms` | Inbound SMS/MMS webhook | `X-Twilio-Signature` |
| `POST /events-sink` | Event Streams batched webhook | (open) |
| `POST /orchestrator-callback?secret=…` | Conversation Orchestrator statusCallbacks | shared secret on URL |

### Send endpoints (admin-only)
| Endpoint | Description |
|---|---|
| `POST /send` | SMS / WhatsApp / RCS via Content API or SMS free-form. Triple gate: admin → `approved_to` → `approved_senders[channel]`. |
| `POST /send-comms` | Bulk send via the Communications API. Up to 100 recipients per operation. Same triple gate. |
| `GET /comms-senders` | Live catalogue of `ACTIVATED` Comms API senders + the approved subset. |
| `GET /templates` | Lists Content API templates (read-only — create/approve in Console). |

### Read endpoints (browser & admin)
| Endpoint | Description |
|---|---|
| `POST /sync-token` | Mints a Sync access token. Viewer scope (30m) by default; admin scope (1h) when the admin cookie is present. Both grants reach the **public** Sync service only. |
| `GET /phones-list` | Non-Sync REST view of the `phone_to_conversations` document (browser primarily subscribes live). |
| `GET /resource-fetch?id=…` | On-demand fetch of any recognised Twilio resource id (`SM*`/`MM*`, `MG*`, `conv_conversation_*`, `conv_participant_*`, `conv_communication_*`, `conv_configuration_*`, `comms_operation_*`, `mem_profile_*`). Returns `{kind, id, resource}`. Powers the dashboard's "View resource" modal. Open (no auth) — same data the timeline already shows. |

### Admin & control endpoints
| Endpoint | Description |
|---|---|
| `POST /admin-login` / `POST /admin-logout` / `GET /admin-me` | Session cookie auth. |
| `GET /admin-list` / `POST /admin-create` / `POST /admin-remove` / `POST /admin-rotate` | Admin management. |
| `GET /approved-list` / `POST /approved-remove` | Destination allowlist management. |
| `POST /verify-start` / `POST /verify-confirm` | Twilio Verify two-step flow for adding new approved destinations. |
| `GET /senders-approved` / `POST /senders-approved-set` | Per-channel approved-senders management. |
| `POST /conversation-close` | Admin transition: PATCH a conversation to `ACTIVE` / `INACTIVE` / `CLOSED` and update the local Sync row. |

## Configuration & state

The dashboard uses **two separate Twilio Sync services** — a hard split between public messaging activity and private credentials.

| Service | Browser grant | Contents |
|---|---|---|
| Public (`SYNC_SERVICE_SID`) | yes (via `/sync-token`) | `messages` Map, per-row `events:*` Lists, `senders`, `approved_to`, `approved_senders`, `phone_to_conversations` |
| Private (`SYNC_PRIVATE_SERVICE_SID`) | **never** | `approved_admins` (bcrypt hashes), `pending_verifications` |

An open-internet `/sync-token` call only ever yields a token for the public service — there's no credential data on the other end. Provision the private service once with:

```sh
pnpm run sync:split    # idempotent: creates the private service, copies admin docs over, removes them from public
```

### Senders (Sync Document, runtime config)

Backs the From dropdown across SMS / WhatsApp / RCS. Updates without redeploy — connected browsers re-render live.

```json
{
  "sms":      [{ "label": "+1 415 555 0100", "value": "+14155550100", "kind": "phone" },
               { "label": "MG: Alerts", "value": "MG…", "kind": "messaging-service" }],
  "whatsapp": [{ "label": "WhatsApp Sandbox", "value": "+14155238886", "kind": "whatsapp" }],
  "rcs":      [{ "label": "Demo RCS Agent", "value": "rcs:agent_id", "kind": "rcs-agent" }]
}
```

```sh
pnpm run refresh:senders               # replace from live Twilio APIs (sms + whatsapp; preserves rcs)
pnpm run refresh:senders -- --preserve # union-merge, keep manual entries
```

For Comms API senders specifically, the Send form fetches `/comms-senders` on demand — Channels Senders are a function-side fetch, never mirrored into Sync.

### Approved destinations (allowlist)

Every `to` is rejected with HTTP 403 unless it appears in the **`approved_to`** Sync Document. Schema:

```json
{ "numbers": [{ "label": "My phone", "value": "+61417000000", "verifiedAt": "2026-05-15T03:30:00Z", "verifiedBy": "dawong" }] }
```

**Recommended path:** add via the dashboard UI (admin → *Manage admins* → *Approved destinations* → *Add destination*). The flow sends a Twilio Verify code to the prospective number and only writes the entry on a confirmed code. This requires a Verify Service (`pnpm run verify:bootstrap`).

**Bulk seed (legacy):** `cp data/approved-to.example.json data/approved-to.json && pnpm run refresh:approved`. Entries written this way show as "legacy" — they work but lack verification provenance.

### Approved senders (per-channel From restriction)

The Send form's From dropdown is the intersection of `senders[channel]` and **`approved_senders[channel]`**. `send.js` and `send-comms.js` enforce server-side. Schema:

```json
{
  "sms":      ["+61480838905", "MG50456b819124898a66a83ebee673125f"],
  "whatsapp": ["+14155238886"],
  "rcs":      [],
  "comms":    ["+61480838905"]
}
```

Manage in the dashboard (admin → *Manage admins* → *Approved senders*). For the `comms` channel the catalogue is sourced live from `/comms-senders` rather than the `senders` document.

### Roles & access

Two roles, served from one URL:
- **Viewer** (default, no login) — sees lists + timelines. Send form is visible but greyed out.
- **Admin** (signed in) — full access: send messages, manage admins, transition conversations.

Auth is name + password. Passwords are bcrypt (cost 12) in the **`approved_admins`** Sync Document on the private service. Sessions are HttpOnly+Secure+SameSite=Lax cookies HMAC-signed by `SESSION_SECRET`. Bootstrap with `pnpm run admin:bootstrap` (refuses if any admin exists); subsequent changes are in-dashboard.

## Wire Event Streams

After your first deploy, create the sink + subscriptions to feed the dashboard:

```sh
twilio api:events:v1:sinks:create \
  --description "msg-dashboard" \
  --sink-type webhook \
  --sink-configuration '{"destination":"https://<YOUR-DOMAIN>/events-sink","method":"POST","batch_events":true}'

# Capture SINK_SID, then subscribe to messaging + Comms API event types:
twilio api:events:v1:subscriptions:create \
  --description "msg-dashboard" \
  --sink-sid <SINK_SID> \
  --types '[
    {"type":"com.twilio.messaging.message.delivered","schema_version":1},
    {"type":"com.twilio.messaging.message.sent","schema_version":1},
    {"type":"com.twilio.messaging.message.failed","schema_version":1},
    {"type":"com.twilio.messaging.message.received","schema_version":1}
  ]'
```

For Comms API observation, additionally subscribe to whatever `com.twilio.comms-api.*` types your account emits — `events-sink.js` keys those by `operation_id` and tags rows with `channel: "comms"` so message-stage and operation-stage events for one logical send group together.

## Wire Conversation Orchestrator (Conversations v2)

The Conversations and Phones tabs only populate when the Orchestrator is delivering callbacks here. Setup is one-time, in the Twilio Console:

1. **Create a Memory Store** (Console → *Conversations* → *Memory*). The typed Twilio SDK doesn't yet expose this resource, and the Memory Store API may require per-account enablement.
2. **Create a Configuration** with:
   - `conversationGroupingType: GROUP_BY_PROFILE` (recommended — same customer's SMS/WhatsApp/RCS/Voice traffic share one conversation thread).
   - `memoryStoreId` from step 1.
   - Capture rules for the numbers you want to observe.
   - `statusCallbacks` set to `https://<your-domain>/orchestrator-callback?secret=<ORCHESTRATOR_CALLBACK_SECRET>`.
3. **Generate a callback secret** and put it in both env files:
   ```sh
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```

The secret is mandatory. Conversation Orchestrator does NOT sign its statusCallbacks (no `X-Twilio-Signature` header), so the dashboard validates a shared secret on the URL instead. Mismatch returns 403.

A bootstrap helper script `pnpm run conversations:bootstrap` is included but is currently best-effort — at the time of writing, the Memory Store API was not enabled on the test account. The Console flow above is the supported path.

### Voice double-billing warning

Orchestrator passive `VOICE` capture rules use Real-Time Transcription. If you also use ConversationRelay or Transcription TwiML on the same numbers, you'll be charged for STT twice. Configure VOICE capture rules carefully or omit them entirely.

### Implementation notes

- Every state change (`CONVERSATION_CREATED`, `PARTICIPANT_ADDED`, `COMMUNICATION_CREATED`, `CONVERSATION_INACTIVE`, `CONVERSATION_CLOSED`, …) arrives only at `/orchestrator-callback`. Each callback's body is the canonical event payload; the dashboard stores `eventType` verbatim.
- Concurrent callbacks for the same conversation (Twilio fans them out in parallel) are handled atomically: `PARTICIPANT_ADDED` unions into the row's participant list; conversation events overwrite with Twilio's authoritative list (re-fetched from `GET /v2/Conversations/{id}` if the body's list is empty).
- Communication callbacks never touch the row's participant list — Twilio occasionally routes a comm with a recipient that isn't on the conversation, which would otherwise poison the participant set.
- Admin **Inactive / Activate / Close** buttons PATCH Twilio and *also* update the local Sync row inline, because Twilio's statusCallback delivery for programmatic PATCHes is inconsistent (especially for `ACTIVE` transitions).

## Environment

Two env files — `.env` (local dev) and `.env.deploy` (uploaded to Serverless).

| Variable | `.env` | `.env.deploy` | Purpose |
|---|:---:|:---:|---|
| `ACCOUNT_SID` / `AUTH_TOKEN` | ✓ | (Serverless injects) | Twilio account credentials. |
| `SYNC_SERVICE_SID` | ✓ | ✓ | Public Sync service. |
| `SYNC_PRIVATE_SERVICE_SID` | ✓ | ✓ | Private Sync service (admin/credential state). |
| `TWILIO_API_KEY` / `TWILIO_API_SECRET` | ✓ | ✓ | Mints browser Sync access tokens. |
| `SESSION_SECRET` | ✓ | ✓ | HMAC-signs the admin session cookie. Rotation invalidates sessions. |
| `VERIFY_SERVICE_SID` | ✓ | ✓ | Twilio Verify Service for destination verification. |
| `MEMORY_STORE_ID` | ✓ | ✓ | Conversation Orchestrator Memory Store id (optional — only needed if Conversations tab is in use). |
| `CONVERSATIONS_CONFIG_ID` | ✓ | ✓ | Conversation Orchestrator Configuration id (optional). |
| `ORCHESTRATOR_CALLBACK_SECRET` | ✓ | ✓ | Shared secret on the `/orchestrator-callback` URL. Required when Conversation Orchestrator is wired. |
| `PUBLIC_BASE_URL` | ✓ | **omit** | Public tunnel URL (e.g. ngrok) for local StatusCallback delivery. The deployed function uses `DOMAIN_NAME` instead. |

## Develop

```sh
pnpm --filter web dev          # Next.js dev on :3000
pnpm run dev:functions         # twilio-run on :3333 — proxied via Next dev rewrites
ngrok http --url=<your-url> 3000   # public tunnel for Twilio webhooks
```

The dev rewrites in `web/next.config.mjs` mirror the deployed `/index.html` and `/m/index.html` URLs so dev links match production.

## Deploy

```sh
pnpm run deploy                # builds Next.js static export, copies to /assets, twilio serverless:deploy
```

## Notes

- Templates are read-only from this dashboard; create/approve them in the Twilio Console.
- All functions are public (no `.protected.js` suffix) because the browser cannot sign requests. For production, put the dashboard behind auth at the infrastructure layer.
- The `events-sink` endpoint is intentionally unauthenticated — it accepts batched Event Streams payloads from Twilio's webhook sink. It writes to Sync but cannot read sensitive data.
- For local dev, `twilio-run` reads `ACCOUNT_SID` / `AUTH_TOKEN` from `.env`; in production, Twilio Serverless injects them.
