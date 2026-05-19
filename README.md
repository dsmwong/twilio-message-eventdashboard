# Twilio Messaging Event Dashboard

A side-by-side dashboard comparing per-message **StatusCallback** events with **Event Streams** events for Twilio Programmable Messaging across **SMS**, **WhatsApp**, and **RCS**.

The whole app — Next.js static frontend + Functions backend — deploys to a single **Twilio Serverless** service. **Twilio Sync** is the realtime event store.

## Architecture

```
Browser ──Sync SDK──► Twilio Sync ◄── Functions
                                         ▲   ▲
Twilio Messaging ──StatusCallback────────┘   │
Twilio Event Streams ──Webhook Sink──────────┘
```

Functions:
- `POST /send` — sends SMS / WhatsApp / RCS via the Content API (or SMS free-form). **Admin-only**, **destination must be on the allowlist**, **From must be on the per-channel approved-senders list**.
- `POST /send-comms` — bulk send via the Twilio **Communications API** (`POST https://comms.twilio.com/v1/Messages`). One operation, up to 100 recipients, free-form SMS body. Same admin / `approved_to` / `approved_senders.comms` gates as `/send`. Returns `{operationId, recipientCount}`.
- `GET /comms-senders` — admin-only catalogue of `ONLINE` Channels Senders (`channel=sms`) plus the current `approved_senders.comms` slice. The browser fetches this on demand when "Comms API" is selected — these senders are **not** mirrored into the Sync `senders` document.
- `GET /templates` — lists Content API templates available on this account.
- `POST /sync-token` — mints Access Tokens for the browser Sync client. Returns viewer-scope (30m) by default, admin-scope (1h) when an admin cookie is present. Both grants reach only the **public** Sync service (no credentials there).
- `POST /status-callback` — receives per-message status webhooks. **Twilio request signature required** (403 on mismatch).
- `POST /incoming-sms` — receives inbound SMS/MMS. **Twilio request signature required** (403 on mismatch).
- `POST /events-sink` — receives batched Event Streams events. Classic messaging events are keyed by `MessageSid`; `com.twilio.comms-api.*` events are keyed by `operation_id` and tagged with `channel: "comms"` so all events (message-stage + operation-stage) for one send group together.
- `POST /admin-login` / `POST /admin-logout` / `GET /admin-me` — session cookie auth for admins.
- `GET /admin-list` / `POST /admin-create` / `POST /admin-remove` / `POST /admin-rotate` — admin management (admin-only).
- `GET /approved-list` / `POST /approved-remove` — destination allowlist management (admin-only).
- `POST /verify-start` / `POST /verify-confirm` — Twilio Verify two-step flow for adding new approved destinations (admin-only).
- `GET /senders-approved` / `POST /senders-approved-set` — per-channel approved-senders management (admin-only).

Frontend:
- `/` — send form + live message list.
- `/m/?sid=MM…` — two-column timeline (StatusCallback | Event Streams).

## One-time setup

Target account: **ISVDemo**. Confirm it's active:

```sh
twilio profiles:list
twilio profiles:use ISVDemo   # if not already active
```

Provision a Sync service and an API key on the account:

```sh
twilio api:sync:v1:services:create --friendly-name message-event-dashboard
twilio api:core:keys:create --friendly-name message-event-dashboard
```

Copy the SIDs/secret into `.env` (see `.env.example`).

### Senders (stored live in Sync)

The sender dropdown reads from a **Sync Document** named `senders` on the dashboard's Sync Service — so you can update senders without rebuilding or redeploying the UI. Connected browsers subscribe and update instantly.

Schema:

```json
{
  "sms": [
    { "label": "+1 415 555 0100", "value": "+14155550100", "kind": "phone" },
    { "label": "MG: Alerts", "value": "MG…", "kind": "messaging-service" }
  ],
  "whatsapp": [{ "label": "WhatsApp Sandbox", "value": "+14155238886", "kind": "whatsapp" }],
  "rcs": [{ "label": "Demo RCS Agent", "value": "rcs:agent_id", "kind": "rcs-agent" }]
}
```

Refresh the Sync Document from live Twilio APIs (phone numbers, Messaging Services, WhatsApp senders):

```sh
pnpm run refresh:senders             # replaces sms + whatsapp from API, keeps rcs
pnpm run refresh:senders -- --preserve  # merge-only (union by value, keeps manual entries)
```

Manual edits: Twilio Console → Sync → Documents → `senders`, or `POST` to `/v1/Services/.../Documents/senders` with `Data=<json>`.

### Approved destinations (allowlist)

`functions/send.js` only accepts a `to` value listed in the **`approved_to`** Sync Document — same live-subscription pattern as `senders`. The UI's "To" field is a dropdown sourced from this document, and any hand-crafted POST whose `to` isn't on the list is rejected with HTTP 403.

Schema:

```json
{
  "numbers": [
    {
      "label": "My phone",
      "value": "+61417000000",
      "verifiedAt": "2026-05-15T03:30:00Z",
      "verifiedBy": "dawong"
    }
  ]
}
```

**Recommended path — add via the dashboard UI** (admin → Manage admins → Approved destinations → Add destination):
the dashboard sends a Twilio Verify code to the prospective number. Only after the code is confirmed is the entry written to `approved_to`, with `verifiedAt` and `verifiedBy` set automatically. This proves the admin controls the destination before any traffic is allowed to it.

This requires a Verify Service:

```sh
pnpm run verify:bootstrap                       # creates / finds the Verify service
# paste VERIFY_SERVICE_SID into .env and .env.deploy
pnpm run deploy
```

**Bulk seed (legacy)** — optional, for migrating existing lists or pre-populating in dev. Entries written this way have no `verifiedAt` and show as "legacy" in the admin UI; they still work for sending but lack the verification provenance.

```sh
cp data/approved-to.example.json data/approved-to.json   # gitignored
# edit data/approved-to.json
pnpm run refresh:approved                                # default file: data/approved-to.json
```

Manual edits: Twilio Console → Sync → Documents → `approved_to`. Connected browsers update instantly.

### Approved senders (per-channel From restriction)

The Send form's From dropdown is the **intersection** of the `senders` catalogue (everything the account has) and the **`approved_senders`** Sync Document (the admin-curated subset). `functions/send.js` rejects any `from` not in the appropriate channel's array with HTTP 403.

Schema:

```json
{
  "sms": ["+61480838905", "MG50456b819124898a66a83ebee673125f"],
  "whatsapp": ["+14155238886"],
  "rcs": []
}
```

Manage in the dashboard (admin → Manage admins → Approved senders): each channel shows every entry in `senders[channel]` with a checkbox. Toggling a checkbox immediately rewrites that channel's array. Empty array for a channel means "no sends from that channel" until something is approved.

### Sync architecture (two services)

The dashboard uses **two separate Sync services** — a hard split between public messaging activity and private credentials.

| Service | Browser grant | Contents |
|---|---|---|
| Public (`SYNC_SERVICE_SID`) | yes (via `/sync-token`) | `messages`, `events:*`, `senders`, `approved_to`, `approved_senders` |
| Private (`SYNC_PRIVATE_SERVICE_SID`) | **never** | `approved_admins` (bcrypt hashes), `pending_verifications` |

This means an open-internet `/sync-token` call only ever yields a token for the public service — there's no credential data on the other end. Provision/migrate with:

```sh
pnpm run sync:split    # idempotent: provisions the private service, copies admin docs in, deletes from public
# paste SYNC_PRIVATE_SERVICE_SID into .env and .env.deploy
pnpm run deploy
```

### Roles & access

The dashboard has two roles, **served from one URL**:

- **Viewer** (default, no login) — sees the message list + timeline. Send form is visible but greyed out (`<fieldset disabled>`).
- **Admin** (signed in) — full access: send messages, manage admins.

Auth is name + password. Passwords are hashed with bcrypt (cost 12) and stored in the **`approved_admins`** Sync Document. Sessions are HttpOnly+Secure+SameSite=Lax cookies HMAC-signed by `SESSION_SECRET`.

**One-time deploy steps:**

```sh
pnpm run session:secret                # 32-byte hex; paste into .env and .env.deploy as SESSION_SECRET=…
pnpm run deploy                        # ship the latest functions + UI
pnpm run admin:bootstrap               # interactive: name + password (echo-off)
```

`admin:bootstrap` refuses to run if any admins already exist — once you've seeded the first one, every subsequent change happens through the **Manage admins** panel inside the dashboard (add / rotate / remove). Self-removal and last-admin-removal are blocked server-side.

## Develop

```sh
pnpm install
pnpm --filter web dev          # Next.js dev server (no Sync — UI only)
pnpm run dev:functions         # twilio-run — serves /functions/* locally
```

## Deploy

```sh
pnpm run deploy                # builds Next.js static export, copies to /assets, twilio serverless:deploy
```

Grab the deployed domain from the deploy output, then create the Event Streams sink and subscription:

```sh
twilio api:events:v1:sinks:create \
  --description "msg-dashboard" \
  --sink-type webhook \
  --sink-configuration '{"destination":"https://<YOUR-DOMAIN>/events-sink","method":"POST","batch_events":true}'

# capture SINK_SID, then subscribe to messaging event types:
twilio api:events:v1:subscriptions:create \
  --description "msg-dashboard" \
  --sink-sid <SINK_SID> \
  --types '[{"type":"com.twilio.messaging.message.delivered","schema_version":1},{"type":"com.twilio.messaging.message.sent","schema_version":1},{"type":"com.twilio.messaging.message.failed","schema_version":1},{"type":"com.twilio.messaging.message.received","schema_version":1}]'
```

## Notes

- Functions rely on `ACCOUNT_SID` / `AUTH_TOKEN` injected by the Serverless runtime; for local dev `twilio-run` reads them from the active Twilio CLI profile.
- Templates are **read-only** from this dashboard; create/approve them in the Twilio Console.
- All functions are public (no `.protected.js` suffix) because the browser cannot sign requests. For production, put the dashboard behind auth at the infrastructure layer.
