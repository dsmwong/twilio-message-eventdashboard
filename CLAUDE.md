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
- `send.js` — `POST /send` — outbound via Content API template (`contentSid` + `contentVariables`) or SMS free-form `body`. **Admin-only** (signed cookie) AND **destination must be in the `approved_to` Sync Document** (returns 403 otherwise). Resolves StatusCallback URL in this order: `PUBLIC_BASE_URL` env → `https://${DOMAIN_NAME}` → omitted (localhost). Required in the send body: `channel`, `to`, `from`. Normalizes addresses *after* the allowlist check (so the allowlist is channel-agnostic). Detects `MG…` from-values and sends via `messagingServiceSid`.
- `templates.js` — `GET /templates` — lists Content API templates and computes a `channels` array from the template `types` map.
- `status-callback.js` — ingests Twilio StatusCallback form-posts. Defaults `direction: "out"` if `Direction` absent (StatusCallbacks fire for outbound).
- `incoming-sms.js` — handles inbound messages; records them with `direction: "in"` and `eventType: "received"`; responds with empty TwiML.
- `events-sink.js` — handles batched Event Streams CloudEvents envelopes.
- `sync-token.js` — `POST /sync-token` — mints short-lived Access Token with SyncGrant for the browser client.
- `admin-login.js` / `admin-logout.js` / `admin-me.js` — session cookie auth (HMAC-signed, HttpOnly, 24h TTL).
- `admin-list.js` / `admin-create.js` / `admin-remove.js` / `admin-rotate.js` — admin management (admin-only). `admin-remove` blocks self-removal and last-admin-removal.
- `_shared/sync.js` — `recordEvent`, `loadApprovedTo`, `loadAdmins`, `saveAdmins`. Idempotently ensures the `messages` Sync Map and per-message `events:{MessageSid}` Sync List exist for ingest.
- `_shared/auth.js` — `signSession`, `verifySession`, `requireAdmin(context, event)`, cookie helpers. Cookie format: `name.expiresAtUnix.hmacSha256(name+expiresAtUnix, SESSION_SECRET)`.

### Sync data model
- **Sync Map `messages`** — keyed by `MessageSid`. Fields: `to`, `from`, `channel`, `direction`, `createdAt`, `lastStatus`, `lastStatusAt`, `optOutType?`. Powers the home page message list.
- **Sync List `events:{MessageSid}`** — one per message. Items: `{source: "status-callback"|"event-stream", eventType, timestamp, receivedAt, payload, envelope?}`. Powers the timeline.
- **Sync Document `senders`** — runtime config for the From dropdown. Schema: `{sms: Sender[], whatsapp: Sender[], rcs: Sender[]}`. Browser subscribes live; edits via Console / REST / `pnpm run refresh:senders` reach all connected clients with no redeploy.
- **Sync Document `approved_to`** — destination allowlist. Schema: `{numbers: [{label, value}]}`. The browser dropdown subscribes live; **`send.js` enforces it server-side** (403 on mismatch). Update via `pnpm run refresh:approved` (file source) or Console.
- **Sync Document `approved_admins`** — admin credentials. Schema: `{admins: [{name, passwordHash, createdAt}]}`. bcrypt hash (cost 12), never plaintext. Bootstrap with `pnpm run admin:bootstrap` (refuses if any admin exists); subsequent changes via the in-dashboard Manage admins panel.

### Frontend (`web/`)
Next.js 15 App Router, static-exported (`output: "export"`) into `/assets/`. In dev, export is disabled and API calls use rewrites to `twilio-run` on :3333 (see `web/next.config.mjs`).
- `app/page.tsx` — `<AuthProvider>` wraps everything; renders `Header`, `SendForm`, optional `AdminPanel` (when admin and toggled), and `MessageList`.
- `app/m/page.tsx` — timeline detail, **uses `?sid=…` query param** (static export can't prerender dynamic routes without `generateStaticParams`, so we query-param-route instead of `/m/[sid]`)
- `components/Header.tsx` — title + admin login/logout/manage-admins controls.
- `components/AdminLoginModal.tsx` — name + password prompt; calls `/admin-login`.
- `components/AdminPanel.tsx` — table of admins (name + createdAt), add / rotate / remove. Hides hashes always.
- `components/SendForm.tsx` — subscribes to the `senders` AND `approved_to` Sync Documents. The To field is a `<select>` over the allowlist. Form is wrapped in `<fieldset disabled>` when `useAuth().admin` is null (viewer mode).
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
pnpm run refresh:approved        # upsert approved_to Sync Document from data/approved-to.json
pnpm run admin:bootstrap         # one-time: seed first admin into approved_admins (refuses if any exist)
pnpm run session:secret          # generate 32-byte hex SESSION_SECRET
pnpm --filter web typecheck      # tsc --noEmit
```

There are no tests.

## Environment

Two env files — `.env` (local dev) and `.env.deploy` (what gets uploaded to Serverless).

- `.env` has `ACCOUNT_SID` + `AUTH_TOKEN` (for local `twilio-run`), `SYNC_SERVICE_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `SESSION_SECRET`, and `PUBLIC_BASE_URL` (public tunnel URL so StatusCallbacks from Twilio cloud can reach localhost).
- `.env.deploy` has `SYNC_SERVICE_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `SESSION_SECRET`. **Must omit** `ACCOUNT_SID`/`AUTH_TOKEN` (Serverless injects them) and `PUBLIC_BASE_URL` (so the deployed function uses `DOMAIN_NAME`).
- `SESSION_SECRET` rotation invalidates every active admin session. Generate with `pnpm run session:secret` and paste into both `.env` and `.env.deploy`.

## Provisioned Twilio resources (ISVDemo)

SIDs are recorded in the untracked local `.env` and `.env.deploy`. The rough inventory (see `.env`/Console for the actual values — not committed for security scanners):

- **Sync Service** (`SYNC_SERVICE_SID` in `.env`) with Document `senders`, Map `messages`, per-message Lists `events:{MessageSid}`
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
