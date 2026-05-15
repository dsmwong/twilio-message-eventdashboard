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
- `POST /send` — sends SMS / WhatsApp / RCS via the Content API (or SMS free-form). **Admin-only**, **destination must be on the allowlist**.
- `GET /templates` — lists Content API templates available on this account.
- `POST /sync-token` — mints Access Tokens for the browser Sync client.
- `POST /status-callback` — receives per-message status webhooks.
- `POST /events-sink` — receives batched Event Streams events.
- `POST /admin-login` / `POST /admin-logout` / `GET /admin-me` — session cookie auth for admins.
- `GET /admin-list` / `POST /admin-create` / `POST /admin-remove` / `POST /admin-rotate` — admin management (admin-only).

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
    { "label": "My phone", "value": "+61417000000" },
    { "label": "Customer ACME (CTO)", "value": "+15551234567" }
  ]
}
```

Seed / refresh:

```sh
cp data/approved-to.example.json data/approved-to.json   # gitignored
# edit data/approved-to.json
pnpm run refresh:approved                                # default file: data/approved-to.json
pnpm run refresh:approved path/to/other.json             # alt file
```

Manual edits: Twilio Console → Sync → Documents → `approved_to`. Connected browsers update instantly.

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
