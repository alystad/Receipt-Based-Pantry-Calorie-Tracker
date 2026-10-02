# Pantry (backend)

Zero-friction pantry and meal tracking. The only recurring action is
photographing your meal — receipts fill the pantry, meal photos empty it.

**This is an API-only backend.** The UI lives in a separate Expo (React
Native) app that calls these endpoints. There is no browser-facing page in
this repo — `next` is used purely as a Node.js route-handler runtime, the
same rationale the codebase already had before the UI was split out (see
"Architecture notes" below).

## How the loop works

| Step | What happens | Where |
| --- | --- | --- |
| 1 | User connects Gmail (read-only) | `src/lib/google.ts` |
| 2 | Daily cron lists Publix receipts newer than the stored cursor, then parses them | `src/lib/gmail.ts`, `src/lib/receipt-sync.ts`, `src/lib/ai/receipts.ts` |
| 3 | Meal photo → macros, matched against the actual products bought | `src/lib/ai/vision.ts`, `src/lib/meals.ts` |
| 4 | Same photo deducts what was consumed from the pantry | `src/lib/pantry.ts` |
| 5 | Weekly plan under cuisine + hard equipment constraints | `src/lib/ai/planner.ts` |
| 6 | Grocery list = plan minus current pantry, phrased for the user's store | `src/lib/plans.ts` |
| 7 | "Suggested for you" meals precompute in the background whenever the pantry changes | `src/lib/suggestions.ts` |

Cold start is handled by the onboarding bulk scan: a few wide photos of the
shelves and fridge bootstrap the pantry to roughly 70–80% coverage
(`/api/onboarding/scan`), and receipts correct it from there.

## Setup

### 1. Database

Any Postgres works; a free Neon or Supabase project is enough. Then:

```bash
cp .env.example .env.local     # fill in DATABASE_URL
npm install
npm run db:migrate             # applies db/schema.sql (idempotent)
```

`npm run db:reset` drops and recreates the public schema.

### 2. Google / Gmail OAuth

1. Google Cloud Console → new project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **OAuth consent screen** → External. Add the scope
   `https://www.googleapis.com/auth/gmail.readonly`. While the app is in
   Testing, add yourself under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application**
   (must be Web application, not a native/mobile client type — offline
   refresh tokens for the Gmail cron sync require it). Authorized redirect
   URI: `http://localhost:3000/api/auth/google/callback` for local dev, plus
   **`https://<your-vercel-domain>/api/auth/google/callback`** once deployed.
   This one redirect URI is shared by both the web-test flow and the mobile
   flow — see "Mobile auth" below for why the Expo app doesn't need its own
   Google client.
5. Put the client ID and secret in `.env.local`.

> Using the Gmail read-only scope in production requires Google verification.
> Testing mode allows up to 100 test users, which is plenty for an MVP.

### 3. Secrets

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # CRON_SECRET
```

Add your `OPENAI_API_KEY`. Model IDs are configurable —
`OPENAI_VISION_MODEL` (default `gpt-4o`) and `OPENAI_TEXT_MODEL`
(default `gpt-4o-mini`).

### 4. Run

```bash
npm run dev     # http://localhost:3000
```

## Deploying (Vercel)

1. `vercel login`, then `vercel link` from this directory (or `vercel` to
   create+link a new project).
2. In the Vercel project's **Settings → Environment Variables**, set every
   variable in `.env.example` for the Production environment:
   `DATABASE_URL`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `OPENAI_API_KEY`,
   `OPENAI_VISION_MODEL`, `OPENAI_TEXT_MODEL`, `UNSPLASH_ACCESS_KEY`
   (optional), `APP_URL`, `CRON_SECRET`, `MOBILE_APP_SCHEME` (optional,
   defaults to `pantry`).
   - `GOOGLE_REDIRECT_URI` and `APP_URL` must both point at the real Vercel
     domain, e.g. `https://pantry-api.vercel.app`.
3. `vercel deploy --prod`.
4. **Register the exact same redirect URI in Google Cloud Console** (step 2.4
   above) — `https://<your-vercel-domain>/api/auth/google/callback`. Google
   rejects the OAuth exchange if this doesn't match `GOOGLE_REDIRECT_URI`
   byte-for-byte.
5. Smoke-test: `curl https://<your-vercel-domain>/api/pantry` should return
   `{"error":"Not signed in"}` with a 401 (proves the deploy is live and
   talking to Postgres, not just serving a static 404).

## Mobile auth (Expo app)

There is no separate mobile OAuth client. The Expo app opens the *same*
`/api/auth/google` flow used for browser testing, but tells it to hand back a
bearer token instead of a cookie:

1. App calls `expo-auth-session`'s browser flow pointed at
   `GET /api/auth/google?platform=mobile`.
2. Backend does the *entire* Google handshake server-side as usual — this is
   required regardless of client, since the Gmail refresh token has to live
   on the backend for the daily cron sync, and offline refresh tokens are
   only issued to the registered Web application client.
3. On success, the callback redirects to
   `<MOBILE_APP_SCHEME>://auth-callback?token=<bearer-token>&onboarded=<bool>`
   instead of setting a cookie. Expo's auth session captures that redirect.
4. The app stores the token in `SecureStore` and sends
   `Authorization: Bearer <token>` on every request from then on.

A browser/curl client that omits `?platform=mobile` still gets the original
cookie-session behavior (`POST` gets a JSON body back instead of a page
redirect, since there's no page to redirect to anymore).

`requireUserId()` / `getSessionUserId()` (`src/lib/session.ts`) accept either
transport — bearer header is checked first, cookie is the fallback — so no
route handler needed to change for this.

## CORS

`src/proxy.ts` applies permissive CORS (`Access-Control-Allow-Origin:
*`) to every `/api/*` route and handles the `OPTIONS` preflight. This is safe
specifically *because* auth is bearer-token, not cookie-based — there's no
credentialed-cookie leak to worry about. A native app's own `fetch` calls
don't send an `Origin` header and aren't subject to CORS at all; this exists
for Expo's web preview and any browser-based testing tool.

## Architecture notes

**Backend lives in Next.js route handlers, not a separate service.** They are
Node.js processes; keeping them in the same deploy means one free Vercel
project instead of a Render instance that cold-starts for 30 seconds and
misses cron windows. Nothing in `src/lib/` imports React, so it can be lifted
into a standalone Express service unchanged if that ever becomes necessary.

**The pantry is a ledger, not a counter.** `pantry_transactions` is
append-only; `pantry_items.quantity` is a cached rollup that
`rebuildQuantities()` can always recompute. This is what makes passive
deduction safe — a bad vision estimate is one reversible row, and quantities
clamp at zero rather than going negative and poisoning the grocery list.

**Everything converts to g / ml / count** (`src/lib/units.ts`) so a purchase and
a consumption can be subtracted from each other, and `matchKey()` collapses
`PUB GRN BNS 12OZ`, `Publix green beans`, and a vision label of `green beans`
onto one row.

**Macros prefer real product data.** When a meal component matches a pantry
item with known nutrition, macros are recomputed from that product's per-100g
label values instead of the model's eyeball estimate. Every `meal_log_items`
row records which source it used, and the client can show it.

**Gmail is never enumerated.** Every read goes through `messages.list` with a
`q` search query built in `buildPublixReceiptQuery()`: sender, subject, and a
time bound that comes from the `gmail_sync_state` cursor (or a 90-day window on
the very first poll). The cursor only advances when a whole batch is processed
without error, so a failure retries next poll rather than being skipped, and a
10-minute overlap covers Gmail's second-precision `internalDate`. Reprocessing
is harmless — messages are deduped by `gmail_message_id` before any parse spend.

**Suggested meals are precomputed, not generated on read.**
`regenerateSuggestedMeals()` runs in the background (via `next/server`'s
`after()`) whenever the pantry actually changes — a receipt, a camera
capture, a manual edit — and writes the full "Suggested for you" set to
`suggested_meals`. Reading it (`readSuggestedMeals()`) is a plain SELECT with
no generation in the request path. See `src/lib/suggestions.ts`.

**Cost control.** Gmail search and dedupe happen before any LLM call; receipts
already ingested never get re-parsed; nutrition backfill is capped per run;
dish images and build-your-own results are cached by dish name / by
pantry+constraints hash respectively, so identical requests never regenerate.
The only metered service is OpenAI.

## Cron

`vercel.json` schedules `/api/cron/sync-receipts` daily at 08:00 UTC. Vercel
sends `Authorization: Bearer $CRON_SECRET` automatically; the route rejects
anything else. Locally:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/sync-receipts
```

## API

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/auth/google` | GET | Start OAuth (`?platform=mobile` for the Expo app) |
| `/api/auth/google/callback` | GET | Exchange code, issue session (cookie or bearer token) |
| `/api/auth/disconnect` | POST | Revoke Gmail grant |
| `/api/auth/logout` | POST | Clear the cookie session |
| `/api/onboarding/scan` | POST | Bulk pantry scan (multipart, ≤6 photos) |
| `/api/capture` | POST | Camera capture — classifies as receipt or meal, routes accordingly |
| `/api/meals` | POST / GET | Log a meal photo / today's meals |
| `/api/meals/manual` | POST | Manually log a meal |
| `/api/pantry` | GET / POST | List pantry / manual add |
| `/api/pantry/[id]` | PATCH / DELETE | Correct quantity / remove |
| `/api/receipts/sync` | POST | Manual receipt sync |
| `/api/plan` | GET / POST | Current plan / generate plan + list |
| `/api/grocery-list/[itemId]` | PATCH | Check an item off |
| `/api/preferences` | GET / PUT | Weekly preferences |
| `/api/suggestions` | GET / POST | Read precomputed "Suggested for you" |
| `/api/suggestions/cuisine-rows` | GET | Cuisine-row suggestions |
| `/api/suggestions/custom` | POST | "Build your own" AI meals |
| `/api/suggestions/[id]` , `/api/suggested-meals/[id]` | — | (see detail lookups in `src/lib/suggestions.ts`) |
| `/api/suggestions/[id]/image` , `/api/suggested-meals/[id]/image` | POST | Lazily resolve a dish photo |
| `/api/meal-images/[id]` | GET | Serve an internally-stored AI-generated dish image |
| `/api/photos/[id]` | GET | Serve a stored photo |

## Not built yet

- **The Publix `from:` and `subject:` filters are placeholders** (`PUBLIX_FROM`
  and `PUBLIX_SUBJECT` in `src/lib/gmail.ts`). `publix.com` currently matches
  marketing and survey mail too. Tighten both to the real sending address and
  subject line as soon as a genuine e-receipt has been captured.
- Only Publix is polled. The `stores` table still carries other chains for
  tagging, but nothing fetches their mail.
- No test suite. The parsing and unit-conversion layers are the natural first
  targets, since they are pure functions.
