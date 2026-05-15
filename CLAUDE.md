# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

Side-by-side dashboard comparing per-message **StatusCallback** events with **Event Streams** events for Twilio Programmable Messaging across SMS, WhatsApp, and RCS. Also sends outbound messages from a UI (channel + sender dropdowns, Content API template picker) and captures inbound messages.

Target account: **ISVDemo**. Confirm active with `twilio profiles:use ISVDemo`.

## Architecture

Single Twilio Serverless deployment hosts both the Next.js static frontend (under `/assets/`) and Functions backend (under `/functions/`). **Twilio Sync** is the realtime event store and the source of truth for runtime config (senders).

```
Browser ──Sync SDK──► Twilio Sync ◄── Functions (record)
                                         ▲   ▲
Twilio Messaging ──StatusCallback────────┘   │
Twilio Event Streams ──Webhook Sink──────────┘
```

### Functions (`functions/`)
- `send.js` — `POST /send` — outbound via Content API template (`contentSid` + `contentVariables`) or SMS free-form `body`. **Admin-only** (signed cookie) AND **destination must be in the `approved_to` Sync Document** AND **`from` must be in `approved_senders[channel]`** (each gate returns 403). Resolves StatusCallback URL in this order: `PUBLIC_BASE_URL` env → `https://${DOMAIN_NAME}` → omitted (localhost). Required in the send body: `channel`, `to`, `from`. Normalizes addresses *after* the allowlist check (so the allowlist is channel-agnostic). Detects `MG…` from-values and sends via `messagingServiceSid`.
- `templates.js` — `GET /templates` — lists Content API templates and computes a `channels` array from the template `types` map.
- `status-callback.js` — ingests Twilio StatusCallback form-posts. **Twilio request signature required** via `requireTwilioSignature` (403 on mismatch). Defaults `direction: "out"` if `Direction` absent (StatusCallbacks fire for outbound).
- `incoming-sms.js` — handles inbound messages. **Twilio request signature required**. Records them with `direction: "in"` and `eventType: "received"`; responds with empty TwiML.
- `events-sink.js` — handles batched Event Streams CloudEvents envelopes. **Keying**: classic messaging events go in by `MessageSid`; `com.twilio.comms-api.*` events go in by `operation_id` (so message-stage and operation-stage events for the same logical send share one row + timeline). Comms API rows have `channel: "comms"`. Comms API `to`/`from` arrive as `{address, channel}` objects and are flattened to strings before write.
- `sync-token.js` — `POST /sync-token` — mints a short-lived Access Token with a SyncGrant for the **public** Sync service only. Returns admin-scope (1h, identity `admin-<name>-<uuid>`) when the admin cookie is present, viewer-scope (30m, identity `viewer-<uuid>`) otherwise. Identity is server-generated; the request body cannot influence it.
- `admin-login.js` / `admin-logout.js` / `admin-me.js` — session cookie auth (HMAC-signed, HttpOnly, 24h TTL).
- `admin-list.js` / `admin-create.js` / `admin-remove.js` / `admin-rotate.js` — admin management (admin-only). `admin-remove` blocks self-removal and last-admin-removal.
- `approved-list.js` / `approved-remove.js` — destination allowlist management (admin-only). Reads from + writes to the `approved_to` Sync Document.
- `verify-start.js` / `verify-confirm.js` — Twilio Verify two-step flow for adding new approved destinations. `verify-start` validates E.164, ensures the value isn't already approved, sends a code via Verify (default channel `sms`, also `call` / `whatsapp`), and stashes a 10-minute `pending_verifications` Sync Map row keyed by value with `{label, channel, requestedBy, requestedAt}`. `verify-confirm` checks the pending row's `requestedBy` matches the calling admin (cross-admin tamper protection), runs `verificationChecks.create`, and only on `status === "approved"` appends the entry to `approved_to` with `verifiedAt` + `verifiedBy`. Wrong code → 400, pending row stays so the admin can retry within TTL.
- `senders-approved.js` / `senders-approved-set.js` — approved-senders management (admin-only). `senders-approved-set` takes the entire updated array per channel (atomic replace) so the UI's checkbox toggles can't race.
- `_shared/sync.js` — `recordEvent`, `loadApprovedTo`/`loadApprovedToList`/`saveApprovedTo`, `loadApprovedSenders`/`saveApprovedSenders` (all → public service); `loadAdmins`/`saveAdmins`, `upsertPendingVerification`/`loadPendingVerification`/`removePendingVerification` (all → **private** service via `syncPrivateService(context)`). Idempotently ensures the `messages` Sync Map and per-message `events:{MessageSid}` Sync List exist for ingest.
- `_shared/auth.js` — `signSession`, `verifySession`, `currentAdmin`, `requireAdmin(context, event)`, cookie helpers. Cookie format: `name.expiresAtUnix.hmacSha256(name+expiresAtUnix, SESSION_SECRET)`.
- `_shared/webhook-auth.js` — `requireTwilioSignature(context, event, path)`. Computes the URL via `PUBLIC_BASE_URL` → `https://${DOMAIN_NAME}`, reads `event.request.headers['x-twilio-signature']`, validates with `Twilio.validateRequest`. Throws `.status = 403` on mismatch. `SKIP_TWILIO_SIGNATURE=true` env opt-out for offline testing only.

### Sync architecture (two services)

Two separate Sync services, by design:

- **Public** (`SYNC_SERVICE_SID`) — browser receives a Sync grant via `/sync-token`. Holds messaging activity (`messages` Map, per-message `events:*` Lists) and viewer-safe config (`senders`, `approved_to`, `approved_senders`).
- **Private** (`SYNC_PRIVATE_SERVICE_SID`) — browser **never** gets a token for this. Holds admin/credential state: `approved_admins` (bcrypt hashes), `pending_verifications` Map. Only the function-side API key reads it.

`/sync-token` issues a viewer-scope token (`viewer-<uuid>`, 30m TTL) when there's no admin cookie, and an admin-scope token (`admin-<name>-<uuid>`, 1h TTL) when there is. Both grants reach the public service only — so an open-internet token is structurally safe (no credentials live there).

Migrate from a single-service setup with `pnpm run sync:split` (idempotent: copies admin docs to private, deletes from public).

### Sync data model
- **Sync Map `messages`** — keyed by either a Twilio `MessageSid` (for messaging webhooks + classic Event Streams events) **or** a Comms API `operation_id` (for `com.twilio.comms-api.*` events — channel set to `"comms"`). Fields: `to`, `from`, `channel`, `direction`, `createdAt`, `lastStatus`, `lastStatusAt`, `optOutType?`. Powers the home page message list.
- **Sync List `events:{key}`** — one per Map row, where `{key}` is whatever the row is keyed by (MessageSid or operation_id). Items: `{source: "status-callback"|"event-stream", eventType, timestamp, receivedAt, payload, envelope?}`. Powers the timeline.
- **Sync Document `senders`** — runtime config for the From dropdown. Schema: `{sms: Sender[], whatsapp: Sender[], rcs: Sender[]}`. Browser subscribes live; edits via Console / REST / `pnpm run refresh:senders` reach all connected clients with no redeploy.
- **Sync Document `approved_to`** — destination allowlist. Schema: `{numbers: [{label, value, verifiedAt?, verifiedBy?}]}`. The browser dropdown subscribes live; **`send.js` enforces it server-side** (403 on mismatch). New entries are added via the in-dashboard "Add destination" flow which gates on Twilio Verify and writes `verifiedAt`/`verifiedBy`. Bulk seed legacy entries via `pnpm run refresh:approved`.
- **Sync Document `approved_senders`** — per-channel From allowlist. Schema: `{sms: string[], whatsapp: string[], rcs: string[]}` (raw value strings, e.g. `+61480838905` or `MG…`). The Send form's From dropdown is the intersection of `senders[channel]` and `approved_senders[channel]`; `send.js` enforces it server-side. Managed via the dashboard's "Approved senders" checkbox UI.
- **Sync Document `approved_admins`** *(PRIVATE service)* — admin credentials. Schema: `{admins: [{name, passwordHash, createdAt}]}`. bcrypt hash (cost 12), never plaintext. Bootstrap with `pnpm run admin:bootstrap` (refuses if any admin exists); subsequent changes via the in-dashboard Manage admins panel.
- **Sync Map `pending_verifications`** *(PRIVATE service)* — short-lived (10 min item TTL) rows keyed by destination value, holding `{label, channel, requestedBy, requestedAt}` for in-flight Verify flows. Cleaned up automatically on success or on Sync TTL expiry.

### Frontend (`web/`)
Next.js 15 App Router, static-exported (`output: "export"`) into `/assets/`. In dev, export is disabled and API calls use rewrites to `twilio-run` on :3333 (see `web/next.config.mjs`).
- `app/page.tsx` — `<AuthProvider>` wraps everything; renders `Header`, `SendForm`, optional `AdminPanel` (when admin and toggled), and `MessageList`.
- `app/m/page.tsx` — timeline detail, **uses `?sid=…` query param** (static export can't prerender dynamic routes without `generateStaticParams`, so we query-param-route instead of `/m/[sid]`)
- `components/Header.tsx` — title + admin login/logout/manage-admins controls.
- `components/AdminLoginModal.tsx` — name + password prompt; calls `/admin-login`.
- `components/AdminPanel.tsx` — table of admins (name + createdAt), add / rotate / remove. Hides hashes always. Hosts the `ApprovedDestinationsSection` and `ApprovedSendersSection` subsections.
- `components/ApprovedDestinationsSection.tsx` — table of `approved_to` entries with a "Add destination" button (opens `AddDestinationModal`) and per-row Remove. Subscribes to the `approved_to` Sync Document for live updates.
- `components/AddDestinationModal.tsx` — two-step Verify flow: step 1 collects label + E.164 value + channel (sms/call/whatsapp) → POSTs `/verify-start`; step 2 collects the 6-digit code → POSTs `/verify-confirm`. Resend button replays step 1 within the 10-minute TTL.
- `components/ApprovedSendersSection.tsx` — three channel subsections (SMS / WhatsApp / RCS), each rendering every entry in `senders[channel]` with a checkbox. Toggling immediately POSTs the full updated array to `/senders-approved-set`. Subscribes to both `senders` and `approved_senders` for live state.
- `components/SendForm.tsx` — subscribes to `senders`, `approved_to`, AND `approved_senders` Sync Documents. To field is a `<select>` over the allowlist. From field is filtered to the intersection of `senders[channel]` and `approved_senders[channel]`. Form is wrapped in `<fieldset disabled>` when viewer, allowlist empty, or no approved senders for the chosen channel.
- `components/MessageList.tsx` — subscribes to the `messages` Sync Map; sorts by `lastStatusAt ?? createdAt` desc.
- `components/Timeline.tsx` — subscribes to `events:{sid}` Sync List; two-column layout (StatusCallback | Event Streams) with relative-time deltas and a collapsible param table per event.
- `lib/sync.ts` — single shared `SyncClient` promise; auto-refreshes token on `tokenAboutToExpire`.
- `lib/auth.tsx` — `<AuthProvider>` + `useAuth()` hook. Calls `/admin-me` on mount; exposes `login`, `logout`, `refresh`. Uses `credentials: "include"` so the cookie rides along.

## Common commands

```sh
pnpm install
pnpm --filter web dev            # Next.js dev on :3000 (rewrites /send, /templates, /sync-token, /status-callback, /events-sink, /incoming-sms to :3333)
pnpm run dev:functions           # twilio-run on :3333
pnpm run build                   # next build + copy to /assets
pnpm run deploy                  # build + twilio serverless:deploy --env .env.deploy
pnpm run refresh:senders         # pull SMS/MS/WA from live API, replace Sync Document
pnpm run refresh:senders -- --preserve   # merge mode (union by value) — keep manually added entries
pnpm run refresh:approved        # bulk-seed approved_to from data/approved-to.json (legacy entries, no Verify)
pnpm run verify:bootstrap        # idempotent: find/create the Twilio Verify Service, print VERIFY_SERVICE_SID
pnpm run sync:split              # one-time: provision the private Sync service + migrate admin/pending docs out of the public one
pnpm run admin:bootstrap         # one-time: seed first admin into approved_admins (refuses if any exist)
pnpm run session:secret          # generate 32-byte hex SESSION_SECRET
pnpm --filter web typecheck      # tsc --noEmit
```

There are no tests.

## Environment

Two env files — `.env` (local dev) and `.env.deploy` (what gets uploaded to Serverless).

- `.env` has `ACCOUNT_SID` + `AUTH_TOKEN` (for local `twilio-run`), `SYNC_SERVICE_SID`, `SYNC_PRIVATE_SERVICE_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `SESSION_SECRET`, `VERIFY_SERVICE_SID`, and `PUBLIC_BASE_URL` (public tunnel URL so StatusCallbacks from Twilio cloud can reach localhost).
- `.env.deploy` has `SYNC_SERVICE_SID`, `SYNC_PRIVATE_SERVICE_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `SESSION_SECRET`, `VERIFY_SERVICE_SID`. **Must omit** `ACCOUNT_SID`/`AUTH_TOKEN` (Serverless injects them) and `PUBLIC_BASE_URL` (so the deployed function uses `DOMAIN_NAME`).
- The webhook signature check (`requireTwilioSignature`) reads `AUTH_TOKEN` from context — locally that comes from `.env`, in production it's auto-injected by the Serverless runtime.
- `SESSION_SECRET` rotation invalidates every active admin session. Generate with `pnpm run session:secret` and paste into both `.env` and `.env.deploy`.

## Provisioned Twilio resources (ISVDemo)

SIDs are recorded in the untracked local `.env` and `.env.deploy`. The rough inventory (see `.env`/Console for the actual values — not committed for security scanners):

- **Public Sync Service** (`SYNC_SERVICE_SID` in `.env`) with Documents `senders`, `approved_to`, `approved_senders`; Map `messages`; per-message Lists `events:{MessageSid}`. The browser gets a Sync grant for this one.
- **Private Sync Service** (`SYNC_PRIVATE_SERVICE_SID` in `.env`) FriendlyName `message-event-dashboard-private` with Document `approved_admins` and Map `pending_verifications`. Browser never gets a grant — function-side only.
- **Verify Service** (`VERIFY_SERVICE_SID` in `.env`) FriendlyName `message-event-dashboard` — used by `/verify-start` and `/verify-confirm` to gate new approved destinations
- **Project API Key** FriendlyName `message-event-dashboard` — used for Access Tokens (`TWILIO_API_KEY` / `TWILIO_API_SECRET` in `.env`)
- **Deployed Serverless** — service name `twilio-message-eventdashboard`, env `dev`, domain in the deploy output
- **Event Streams sink + subscription** — webhook sink → `/events-sink`, subscription covers 7 `com.twilio.messaging.*` types
- **AU regulatory bundle + address** — needed as a pair when buying AU mobile numbers; different approved bundles use different addresses, don't mix
- **Public tunnel** (e.g. ngrok) pointed at Next.js dev on port 3000 — used as `PUBLIC_BASE_URL` so StatusCallbacks from the Twilio cloud reach the local machine. Next.js dev rewrites `/status-callback`, `/events-sink`, `/incoming-sms`, etc. to `twilio-run` on port 3333.

## Gotchas learned the hard way

- **`/` returns 404 on Serverless.** Twilio Serverless doesn't auto-serve `index.html` at directory roots. Canonical URL is `/index.html`. Function handlers can't register at `/`.
- **`@twilio/runtime-handler@2.1.0` is not whitelisted** by the Serverless runtime — pin to `2.0.3` in root `package.json`. `engines` is `>=20 <=22`; Node 23 works locally but Serverless runs node22.
- **Event Streams body shape**: `@twilio/runtime-handler` spreads JSON-array POST bodies onto the event object as numeric keys plus `request`/`bodySHA256`. `events-sink.js` reconstructs the array from numeric keys.
- **Twilio rejects `localhost` StatusCallback URLs.** `send.js` omits StatusCallback entirely when `DOMAIN_NAME` looks local and no `PUBLIC_BASE_URL` is set.
- **Function JSON responses**: use `response.setBody(obj)` (object), not `setBody(JSON.stringify(obj))` — the latter double-encodes via `@twilio/runtime-handler`.
- **Event Streams subscriptions are mostly immutable** — the `SinkSid` field silently won't change on PATCH. To repoint, create a new sink, delete the old subscription, create a new subscription against the new sink, then delete the old sink.
- **Advanced Opt-Out has no REST endpoint** — it's Console-only (Messaging Service → Opt-out management). Also, Twilio only executes Advanced Opt-Out auto-behaviors for US/CA numbers; on AU the config is accepted but inert (inbound STOP still reaches `/incoming-sms`, so handle opt-out yourself if needed).
- **AU mobile purchases** require both `BundleSid` and `AddressSid`, and the address must be the exact one in the bundle's item assignments (different approved bundles use different addresses — don't mix).
- **Next.js static export** can't prerender `app/m/[sid]/page.tsx` without `generateStaticParams`. Using `app/m/page.tsx` with a `?sid=…` query param instead.
- **Re-running shell scripts** that write intermediate files (`/tmp/lists.txt`, `/tmp/lists.json`): delete them first. Previous runs leave stale content that python/read loops pick up silently.
- **After editing a function in `functions/`**, `twilio-run` auto-reloads for file edits but **not for new files** — restart it (`lsof -ti:3333 | xargs kill -9 && pnpm run dev:functions`).

## Tooling defaults (from global prefs)

- Package manager: **pnpm**
- Language: **TypeScript** for frontend, CommonJS JS for Functions (Twilio Functions constraint)
- Twilio operations: prefer the Twilio CLI (`twilio`) over raw API calls when equivalent
