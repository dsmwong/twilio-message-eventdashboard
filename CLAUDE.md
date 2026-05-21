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
- `senders-approved.js` / `senders-approved-set.js` — approved-senders management (admin-only). `senders-approved-set` takes the entire updated array per channel (atomic replace) so the UI's checkbox toggles can't race. Channels: `sms`, `whatsapp`, `rcs`, `comms`.
- `comms-senders.js` — `GET /comms-senders` — admin-only catalogue for the Comms API channel. Calls `client.messaging.v2.channelsSenders.list({channel:"sms"})`, filters to `ONLINE`, returns `{catalogue:[{label,value,status}], approved:string[]}` where `approved` is the `comms` slice of `approved_senders`. Browser-side this is fetched lazily by `SendForm` (when the Comms channel is picked) and eagerly by `ApprovedSendersSection`. **No browser Sync grant ever sees it** — Channels Senders are a function-side fetch only.
- `send-comms.js` — `POST /send-comms` — bulk fan-out via the Twilio **Communications API** (`POST https://comms.twilio.com/v1/Messages` with HTTP Basic auth). Body: `{from, to:[…], body}`. Same triple gate as `/send`: `requireAdmin` → `loadApprovedTo` covers every entry in `to[]` → `from` in `approved_senders.comms`. Caps `to` at 100 entries. Returns `{operationId, recipientCount}` from the upstream 202. The `comms_operation_*` events feed back through `/events-sink` (already keyed by `operation_id`, channel `"comms"`).
- `orchestrator-callback.js` — `POST /orchestrator-callback?secret=…` — Twilio Conversation Orchestrator (Conversations v2) statusCallback receiver. Orchestrator does NOT sign its callbacks (no `X-Twilio-Signature`), so this endpoint validates a shared secret on the URL query string against `ORCHESTRATOR_CALLBACK_SECRET` (403 mismatch). The body shape is `{eventType, timestamp, data: {id, …}}`; the function classifies by `data.id` prefix (`conv_conversation_*` / `conv_participant_*` / `conv_communication_*`), stores the upstream `eventType` verbatim (e.g. `CONVERSATION_CREATED`, `PARTICIPANT_ADDED`), and writes one Sync List entry per callback into `events:{conversationId}`. Dedupes by `(entityId, eventType)` so retries / repeated lifecycle transitions don't duplicate. Updates the `messages` Map row's `lastStatus` from CONVERSATION_* events (re-fetching `getConversation` if the body lacks an authoritative participants list), and atomically unions PARTICIPANT_ADDED addresses into `participantAddresses` via `recordEvent`'s `__arrayUnion` directive (concurrent callbacks survive a 4-attempt retry loop). Updates the `phone_to_conversations` Sync Document for each participant. Communication events never touch the row's participant list (Twilio occasionally routes a comm with a recipient that isn't on the conversation).
- `conversation-close.js` — `POST /conversation-close` — admin-only. Body `{conversationId, status?}` where status is `ACTIVE`, `INACTIVE`, or `CLOSED` (default CLOSED). PATCHes the Conversation Orchestrator conversation upstream and immediately updates the local `messages` Map row (Twilio's statusCallback for programmatic PATCHes is inconsistent — particularly for `ACTIVE` transitions). Also synthesises a `CONVERSATION_<STATUS>` event into the timeline so the admin-driven transition is visible.
- `phones-list.js` — `GET /phones-list` — non-Sync REST view of the `phone_to_conversations` Sync Document (`{phones: [{value, conversationCount, lastActivityAt}]}`). Browser primarily subscribes to the Sync Document directly; this is a fallback.
- `resource-fetch.js` — `GET /resource-fetch?id=<id>[&conversationId=<conv>]` — on-demand fetch of any recognised Twilio resource id. Classifies by prefix:
  - `SM`/`MM` → SDK `client.messages(id).fetch()`.
  - `MG` → SDK `client.messaging.v1.services(id).fetch()`.
  - `conv_conversation_` / `conv_participant_` / `conv_communication_` → conversations-api helpers with parent-conversation fallback when the standalone path 404s (Twilio currently requires the parent context for participants/communications, so the optional `conversationId` query string is needed for those).
  - `conv_configuration_` → `getConfiguration(id)` against `/v2/ControlPlane/Configurations/{id}`.
  - `comms_operation_` → comms-api `getOperation`, tries `/v1/Messages/Operations/{id}` first then `/v1/Operations/{id}`.
  - `mem_profile_` → memory-api `getProfile(id)` against `memory.twilio.com/v1/Services/{MEMORY_STORE_ID}/Profiles/{id}`. Account-level Memory access required; otherwise the upstream 20404 propagates.
  Validates id against `^[A-Za-z0-9_-]{1,200}$` before passing to Twilio. Open (no auth) — read-only, returns the same data already visible in the timeline. Powers the dashboard's "View resource" modal (`web/components/ResourceModal.tsx`).
- `_shared/sync.js` — `recordEvent`, `loadApprovedTo`/`loadApprovedToList`/`saveApprovedTo`, `loadApprovedSenders`/`saveApprovedSenders`, `loadPhoneIndex`/`appendConversationToPhone` (all → public service); `loadAdmins`/`saveAdmins`, `upsertPendingVerification`/`loadPendingVerification`/`removePendingVerification` (all → **private** service via `syncPrivateService(context)`). Idempotently ensures the `messages` Sync Map and per-message `events:{MessageSid}` Sync List exist for ingest.
- `_shared/conversations-api.js` — raw HTTPS client for the Twilio Communications/Conversations v2 API at `https://conversations.twilio.com/v2/...` (HTTP Basic with ACCOUNT_SID/AUTH_TOKEN, JSON-only). Exports `getConversation`, `listCommunications`, `getParticipant`, `getCommunication`, `getConfiguration`. Used by `orchestrator-callback.js` and `resource-fetch.js`.
- `_shared/memory-api.js` — raw HTTPS client for `https://memory.twilio.com/v1/...` (Conversation Memory). Exports `getProfile(context, profileId)`, which reads `MEMORY_STORE_ID` from context and fetches `/v1/Services/{store}/Profiles/{id}`. Returns Twilio's 20404 if the account doesn't have Memory access enabled.
- `_shared/auth.js` — `signSession`, `verifySession`, `currentAdmin`, `requireAdmin(context, event)`, cookie helpers. Cookie format: `name.expiresAtUnix.hmacSha256(name+expiresAtUnix, SESSION_SECRET)`.
- `_shared/webhook-auth.js` — `requireTwilioSignature(context, event, path)`. Computes the URL via `PUBLIC_BASE_URL` → `https://${DOMAIN_NAME}`, reads `event.request.headers['x-twilio-signature']`, validates with `Twilio.validateRequest`. Throws `.status = 403` on mismatch. `SKIP_TWILIO_SIGNATURE=true` env opt-out for offline testing only.

### Sync architecture (two services)

Two separate Sync services, by design:

- **Public** (`SYNC_SERVICE_SID`) — browser receives a Sync grant via `/sync-token`. Holds messaging activity (`messages` Map, per-message `events:*` Lists, `phone_to_conversations` Document) and viewer-safe config (`senders`, `approved_to`, `approved_senders`).
- **Private** (`SYNC_PRIVATE_SERVICE_SID`) — browser **never** gets a token for this. Holds admin/credential state: `approved_admins` (bcrypt hashes), `pending_verifications` Map. Only the function-side API key reads it.

`/sync-token` issues a viewer-scope token (`viewer-<uuid>`, 30m TTL) when there's no admin cookie, and an admin-scope token (`admin-<name>-<uuid>`, 1h TTL) when there is. Both grants reach the public service only — so an open-internet token is structurally safe (no credentials live there).

Migrate from a single-service setup with `pnpm run sync:split` (idempotent: copies admin docs to private, deletes from public).

### Sync data model
- **Sync Map `messages`** — keyed by a Twilio `MessageSid` (for messaging webhooks + classic Event Streams events), a Comms API `operation_id` (for `com.twilio.comms-api.*` events — channel set to `"comms"`), or a Conversation Orchestrator conversation id (for `/orchestrator-callback` events — channel set to `"conversations"`, with `participantAddresses: string[]`). Fields: `to`, `from`, `channel`, `direction`, `createdAt`, `lastStatus`, `lastStatusAt`, `optOutType?`, `participantAddresses?`, `conversationId?`. Powers the home page Messages / Conversations / Phones tabs.
- **Sync List `events:{key}`** — one per Map row, where `{key}` is whatever the row is keyed by (MessageSid, operation_id, or conversationId). Items: `{source: "status-callback"|"event-stream"|"orchestrator", eventType, timestamp, receivedAt, payload, envelope?}`. Conversation events use eventType `lifecycle.<status>` and `communication.<channel>.<direction>`. Powers the timeline.
- **Sync Document `phone_to_conversations`** — index of customer phone numbers → conversation ids, populated by `/orchestrator-callback`. Schema: `{numbers: { "+E164": {conversationIds: string[], lastActivityAt: ISO} }}`. Powers the Phones tab.
- **Sync Document `senders`** — runtime config for the From dropdown. Schema: `{sms: Sender[], whatsapp: Sender[], rcs: Sender[]}`. Browser subscribes live; edits via Console / REST / `pnpm run refresh:senders` reach all connected clients with no redeploy.
- **Sync Document `approved_to`** — destination allowlist. Schema: `{numbers: [{label, value, verifiedAt?, verifiedBy?}]}`. The browser dropdown subscribes live; **`send.js` enforces it server-side** (403 on mismatch). New entries are added via the in-dashboard "Add destination" flow which gates on Twilio Verify and writes `verifiedAt`/`verifiedBy`. Bulk seed legacy entries via `pnpm run refresh:approved`.
- **Sync Document `approved_senders`** — per-channel From allowlist. Schema: `{sms: string[], whatsapp: string[], rcs: string[], comms: string[]}` (raw value strings, e.g. `+61480838905` or `MG…`). For sms/whatsapp/rcs the Send form's From dropdown is the intersection of `senders[channel]` and `approved_senders[channel]`. For `comms` the catalogue comes from `/comms-senders` (live Channels Senders API), and the dropdown is its intersection with `approved_senders.comms`. `send.js` and `send-comms.js` both enforce server-side. Managed via the dashboard's "Approved senders" checkbox UI (the `comms` row sources its catalogue from `/comms-senders` rather than the Sync `senders` document).
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
- `components/HomeTabs.tsx` — tab control switching between `<MessageList/>`, `<ConversationList/>`, and `<PhonesList/>`.
- `components/MessageList.tsx` — subscribes to the `messages` Sync Map; sorts by `lastStatusAt ?? createdAt` desc. Filters out `channel === "conversations"` rows (those live on the Conversations tab).
- `components/ConversationList.tsx` — subscribes to the same `messages` Map filtered to `channel === "conversations"`. Columns: Conversation ID, Status, Participants (badges), Last update.
- `components/PhonesList.tsx` — subscribes to the `phone_to_conversations` Sync Document. Click a row to expand and see the conversations linked to that customer phone.
- `components/Timeline.tsx` — subscribes to `events:{sid}` Sync List. Three layout branches: classic 2-col (StatusCallback | Event Streams), Comms API 3-col (Operation | Comms · Message | Messaging · Message), and Conversations 2-col (Lifecycle | Communications). Detection by SID prefix or, for Conversations, by all events having `source === "orchestrator"` as a fallback. `PayloadTable` cells whose value is a recognised Twilio resource id render as a clickable button that opens the `ResourceModal`. `EnvelopeJson` (full-JSON dumps) stays unstyled raw text.
- `components/ResourceModal.tsx` + `lib/useResourceModal.tsx` — modal popup for any recognised Twilio resource id (`SM*`/`MM*`, `conv_conversation_*`, `conv_participant_*`, `conv_communication_*`, `comms_operation_*`). Fetches `GET /resource-fetch?id=…` on open, displays pretty-printed JSON with a copy button, closes on Esc / overlay click. Mounted via `<ResourceModalProvider>` at the top of `app/page.tsx` and `app/m/page.tsx`; descendants call `useResourceModal().open(id, conversationId?)`.
- `components/ViewResourceButton.tsx` + `lib/resourceId.ts` — the small `{ }` button rendered next to ids in `MessageList`/`ConversationList`/`PhonesList`, plus the `isResourceId(value)` prefix detector used by both the button gating and the timeline's `PayloadTable`.
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
pnpm run conversations:bootstrap # idempotent: provision Memory Store + Conversation Orchestrator Configuration, print MEMORY_STORE_ID + CONVERSATIONS_CONFIG_ID
pnpm run sync:split              # one-time: provision the private Sync service + migrate admin/pending docs out of the public one
pnpm run admin:bootstrap         # one-time: seed first admin into approved_admins (refuses if any exist)
pnpm run session:secret          # generate 32-byte hex SESSION_SECRET
pnpm --filter web typecheck      # tsc --noEmit
```

There are no tests.

## Environment

Two env files — `.env` (local dev) and `.env.deploy` (what gets uploaded to Serverless).

- `.env` has `ACCOUNT_SID` + `AUTH_TOKEN` (for local `twilio-run`), `SYNC_SERVICE_SID`, `SYNC_PRIVATE_SERVICE_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `SESSION_SECRET`, `VERIFY_SERVICE_SID`, optionally `MEMORY_STORE_ID` + `CONVERSATIONS_CONFIG_ID` (Conversation Orchestrator), and `PUBLIC_BASE_URL` (public tunnel URL so StatusCallbacks from Twilio cloud can reach localhost).
- `.env.deploy` has `SYNC_SERVICE_SID`, `SYNC_PRIVATE_SERVICE_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `SESSION_SECRET`, `VERIFY_SERVICE_SID`, and optionally `MEMORY_STORE_ID` + `CONVERSATIONS_CONFIG_ID`. **Must omit** `ACCOUNT_SID`/`AUTH_TOKEN` (Serverless injects them) and `PUBLIC_BASE_URL` (so the deployed function uses `DOMAIN_NAME`).
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
