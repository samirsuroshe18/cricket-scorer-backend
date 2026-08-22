# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

REST API backend for a cricket scoring mobile app. Node.js + Express 5 + MongoDB (Mongoose 9), ESM throughout (`"type": "module"` — always use `import`, and include the `.js` extension in relative imports).

Two feature areas are live: **user auth/profile** and a **translation/localization CMS**. A third — **live cricket scoring** — has its Mongoose models defined (Match, Inning, Over, BallEvent, Team, Player, Scorecard) but no controllers or routes yet. Most new work will be building that out.

```bash
npm run dev         # nodemon, NODE_ENV=development → loads .env.development
npm run prod        # node, NODE_ENV=production → loads .env.production
npm test            # cross-env NODE_ENV=test + jest (ESM via --experimental-vm-modules)
npm run test:watch
```

## Architecture

**Flat, deliberately.** `routes → controllers → Mongoose models`. There is **no service or repository layer, and none should be introduced** — not even for the scoring domain. Controllers are where request handling, validation, and model calls all live together.

Layer responsibilities:
- **`src/routes/*.routes.js`** — path + HTTP verb definitions only. Attach middleware (`verifyJwt`, `authLimiter`, `upload`) here, never business logic.
- **`src/controllers/*.controller.js`** — validate input, call Mongoose directly, return `ApiResponse`. Every handler wrapped in `catchAsync`.
- **`src/models/*.model.js`** — schema, indexes, hooks, and instance methods. Cross-cutting record behavior (password hashing, soft-delete filtering) belongs in hooks here, not in controllers.
- **`src/utils/`** — cross-cutting helpers (`ApiError`, `ApiResponse`, `catchAsync`, cloudinary, mailSender, FCM).
- **`src/middlewares/`** — request-pipeline concerns.

**Startup:** `src/index.js` loads env → connects Mongo → starts the app from `src/app.js`.

**Middleware order in `src/app.js` matters** — helmet → CORS → body parsers (100kb limit) → static → cookie-parser → `sanitizeMiddleware` → `localeMiddleware` → `globalLimiter` → routers → `errorHandler`. `errorHandler` must stay last. `localeMiddleware` must come before routers so `req.t` exists.

## Folder Structure & Where New Code Goes

Flat, one file per resource — **no feature/module folders**. To add an endpoint, touch these in order:

1. **`src/models/<resource>.model.js`** — if the model doesn't exist. (Scoring models already exist; don't recreate them.)
2. **`src/locales/{en,hi,mr}/common.json`** — add a `SCREAMING_SNAKE_CASE` key for every error and success message. All three files must stay in sync; [tests/locales.test.js](tests/locales.test.js) fails the build if they drift.
3. **`src/controllers/<resource>.controller.js`** — `catchAsync`-wrapped handler; validate, then call the model; return `ApiResponse`.
4. **`src/routes/<resource>.routes.js`** — define the route, attach `verifyJwt` (and `authLimiter` if credential/OTP-related).
5. **`src/app.js`** — mount the router at `/api/v1/<resource>`.

Reusable constants go in `src/constants/<topic>.constants.js` — enum-like sets as a frozen object (`Object.freeze`), following `OTP_TYPES` / `SUPPORTED_LANGUAGES`; single scalars as a plain named export, following `MIN_PASSWORD_LENGTH`.

## API Conventions

**Base path:** `/api/v1/<resource>`. Route paths are kebab-case (`/forgot-password`, `/update-fcm`).

**Success** — always `new ApiResponse(statusCode, data, req.t("SOME_KEY"))`:
```json
{ "statusCode": 200, "data": {...}, "message": "…", "success": true }
```

**Error** — always `throw new ApiError(statusCode, "SOME_KEY", { params })`. `errorHandler` catches it and emits:
```json
{ "statusCode": 400, "code": "SOME_KEY", "message": "…" }
```

**The message argument is an i18n key, never a sentence.** `errorHandler` copies `err.message` straight into the response's `code` field, so a translated string there makes `code` locale-dependent and unmatchable by clients. `verifyJwt` shipped this bug against all four of its auth errors and it silently disabled token refresh in the mobile client — the codes are a contract, not display text.
- `ApiError(status, key, options)` — the third arg is an **options object**: `{ params }` for interpolation values, `{ localFilePath }` to have `errorHandler` clean up a temp upload. Passing params positionally **fails silently** — the constructor only reads `options.params`, so `new ApiError(400, "KEY", { min: 8 })` yields `params = {}` and the message renders with an unfilled `{{min}}`. It does not throw.
- `req.t` is attached per-request by `localeMiddleware`, resolving language from `req.user.language` → `Accept-Language` header → `en`. **In practice only the latter two fire:** `localeMiddleware` is mounted app-wide before the routers, while `verifyJwt` runs per-route afterwards, so `req.user` is always undefined at that point and a user's saved language preference never affects API messages.
- Keys live in `src/locales/{en,hi,mr}/common.json` (i18next + fs-backend, preloaded once at boot). Interpolation uses `{{placeholder}}`.
- Non-`ApiError` exceptions are logged server-side and returned as `INTERNAL_SERVER_ERROR` — never leaked to the client.

**Validation:** manual inline checks at the top of each controller — `if (!email?.trim()) throw new ApiError(400, "EMAIL_REQUIRED")`. **Do not add Joi, Zod, or express-validator.**

**Pagination:** nothing paginates today — there is no `.skip()`/`.limit()` or `?page`/`?limit` handling anywhere in `src/`, because the only list endpoints are the translation CMS reads (exempt: `Localization` is capped at one document per `languageCode` enum value). This is a rule for the endpoints you are about to write, not a description of existing code: when you add the first list endpoint over a growing collection — `BallEvent` above all, one document per delivery — use offset-based `?page` & `?limit` with a sane default and an enforced max limit.

## Auth & Security

- **Tokens:** JWT access + refresh, minted by instance methods on the `User` model. Access token read from the `accessToken` cookie *or* `Authorization: Bearer`. Refresh token is sent in the **`x-refresh-token` header**, not a cookie.
- **`verifyJwt`** ([src/middlewares/auth.middleware.js](src/middlewares/auth.middleware.js)) attaches `req.user` with sensitive fields already `.select()`-ed out. Protect new routes with it by default; leave a route public only with clear reason (as with the translation CMS read endpoints).
- **Single session per user is intentional.** `User.refreshToken` is one field, not a list — a new login invalidates the previous session. Don't convert this to multi-device without being asked.
- **Refresh rotation:** the incoming refresh token must match the stored one; logout unsets `refreshToken`/`fcmToken` by matching on the token itself.
- **The two refresh-token endpoints disagree on transport.** `GET /refresh-token` reads `x-refresh-token`, but `GET /logout` reads it from `Authorization: Bearer` (`user.controller.js:152`) and is mounted without `verifyJwt`, then looks the user up collection-wide by the credential alone — the shape called out as a bug for reset tokens above. Unify on `x-refresh-token` when you next touch logout; changing it is a client-breaking change, so coordinate both repos.
- **Passwords:** bcrypt via a `pre('save')` hook on `User`. Use `bcrypt` — `bcryptjs` was removed, don't reintroduce it. Never hash in a controller. Password writes use `{ validateBeforeSave: false }`, which **skips schema validators** — so any handler that sets a password must check `MIN_PASSWORD_LENGTH` (`src/constants/password.constants.js`) explicitly.
- **Reset tokens must be bound to the requesting account.** Validate the hashed token against the user identified by the request, never with a collection-wide `findOne({ otpVerifyToken })` — that lets any valid token reset any account.
- **OTP flows:** unverified signups get a TTL doc (`expireDocAfterSeconds`) that self-deletes. Password reset is OTP → short-lived **hashed** reset token (`generateSecureToken`) → `setPassword`. There's a 30s resend throttle. OTPs **should** use `crypto.randomInt` — `forgotPassword` and `resendOtp` do, but `registerUser` (`user.controller.js:56`) and `loginUser` (`:98`) still generate with `Math.random()`; migrate them rather than copying them.
- **Rate limiting:** `globalLimiter` (300 req / 15 min) app-wide; `authLimiter` (10 req / 15 min, successful requests skipped) on register/login/forgot-password/verify-otp/resend-otp/set-password. Apply `authLimiter` to any new credential or OTP route.
- **NoSQL injection:** `sanitizeMiddleware` strips keys starting with `$` or containing `.` from body/params/query. `express-mongo-sanitize` is deliberately **not** used — it reassigns `req.query`, which is a getter in Express 5 and throws.
- **Response hygiene:** `password`, `refreshToken`, `emailOtp`, `emailOtpExpiry`, `otpVerifyToken`, and `otpVerifyTokenExpiry` must never reach a response. The OTP/reset fields are `select: false` in the schema — opt in with `.select("+field")` where a handler genuinely needs them, and add `select: false` to any new secret field rather than filtering it per-endpoint.
- **Secrets:** `.env.development` / `.env.production` and `service-account-file-*.json` are gitignored — never commit real values or read secrets from anywhere but `process.env`.

## Database Conventions

- **No migration tooling.** Schema evolution is Mongoose-schema-only. New fields should be optional or carry a default so existing documents stay valid.
- **Transactions:** multi-document writes where a partial result would corrupt state must be wrapped in a Mongoose session/transaction. This is **required for scoring writes**, where one ball touches BallEvent + Over + Inning (+ Match at innings end) and a half-applied ball breaks a live match. Deployment is a replica set / Atlas, so transactions are available. (The translation CMS's `incrementGlobalVersion()` bump is deliberately non-transactional best-effort — a missed bump only leaves clients with a stale cache until the next write.)
- **Soft deletes:** deletable resources carry an `isDeleted` flag rather than being removed. `User` enforces this globally via a `pre(/^find/)` hook; bypass with `{ includeSoftDeleted: true }` on the query. `Match`, `Team`, and `Player` have the flag — apply the same pattern to new resources.
- **Indexes** are declared in the model file next to the schema. Add one for any new query path; the existing compound indexes encode real access patterns (e.g. `{ createdBy: 1, createdAt: -1 }` for history screens).
- **Connection pooling** is configured once in [src/database/database.js](src/database/database.js) (`maxPoolSize: 10`). Never call `mongoose.connect` anywhere else.
- Use `.lean()` for read-only queries that don't need Mongoose documents.

### Scoring domain specifics

`Match → Inning` (1–2 per match, unique compound index) `→ Over → BallEvent`, plus `Team`/`Player`/`Scorecard`. Built for offline-first clients: `Match.syncStatus` (`local`/`syncing`/`synced`/`conflict`) tracks cloud sync.

**`BallEvent` is append-only.** `pre('updateOne')`/`pre('findOneAndUpdate')` hooks throw on any mutation attempt. Undo is delete-plus-restore from the embedded `preEventState` snapshot, ordered by `absoluteBallSeq`. Preserve this model rather than reworking it into in-place updates.

**The model is registered as `'Inning'`, singular.** `ballEvent`, `over`, and `scorecard` all previously declared `ref: 'Innings'`, which would have thrown `MissingSchemaError` on the first `.populate('inningsId')` — latent only because no scoring controller exists yet. Fixed; keep new refs matching the registered name exactly.

### Translations: two independent systems

Don't conflate them. **`src/locales/*/common.json`** are static backend response strings (i18next). The **`Localization`/`TranslationMeta` models** are a client-facing CMS that serves app strings to the mobile client, with a global version counter (`incrementGlobalVersion()` on every write) that clients poll via `GET /version` to invalidate their cache. They only share the language codes `en`/`hi`/`mr`.

## Naming Conventions

- Files: `<resource>.<role>.js` — `user.controller.js`, `user.routes.js`, `auth.middleware.js`, `match.model.js`, `otp.constants.js`. Lowercase resource, dot-separated role.
- Models: exported as a named PascalCase singular export — `export const User = mongoose.model('User', userSchema)` — from a lowercase file.
- i18n / error codes: `SCREAMING_SNAKE_CASE`, shared between `ApiError` call sites and the locale JSON files.
- Route paths: kebab-case. Query params and JSON fields: camelCase.
- Tests: `tests/<subject>.test.js`.

## Testing

Jest + supertest, ESM-native (`NODE_OPTIONS=--experimental-vm-modules`, `transform: {}` — no Babel). Tests live in `tests/` matching `**/tests/**/*.test.js`.

Two suites exist today:
- [tests/sanitize.middleware.test.js](tests/sanitize.middleware.test.js) — the pattern for middleware/controller tests: mount the single unit on a minimal Express instance and drive it with supertest. Do **not** import `src/app.js` in a test — it initializes Firebase Admin at import time and needs a service-account file.
- [tests/locales.test.js](tests/locales.test.js) — enforces key parity across `en`/`hi`/`mr` (nested keys included) and rejects empty **top-level** values; the empty-value check uses `Object.entries` and does not recurse, so nested groups like `ACCOUNT_STATUS` are exempt from it.

**There is no DB-backed test setup** (no `mongodb-memory-server`, no fixtures), which is why nothing exercises a controller end-to-end yet. Adding one is the prerequisite for testing the scoring endpoints — don't assume you can just `await Model.create(...)` in a test.

## Things to Avoid

- **Don't add a service or repository layer**, or reorganize into feature/module folders.
- **Don't add a validation library** (Joi/Zod/express-validator) — manual checks only.
- **Don't hardcode user-facing strings** in `ApiError`/`ApiResponse`. Add an i18n key to all three locale files.
- **Don't pass `ApiError` params positionally** — it takes `(statusCode, key, optionsObject)`, and a positional third arg is dropped silently rather than throwing.
- **Don't pass `req.t(...)` as the `ApiError` message** — it must be the bare key, or the response's `code` becomes a translated sentence.
- **Don't reintroduce `bcryptjs`**, or `express-mongo-sanitize` (Express 5 incompatible).
- **Don't return unbounded lists** or unpaginated `.find()` results.
- **Don't trust `{ validateBeforeSave: false }` to still enforce the schema** — it skips *all* validators. Check the constraint by hand in the controller (this is how an unenforced 8-char password minimum slipped through).
- **Don't look up a credential by the credential alone** — e.g. `findOne({ otpVerifyToken })` without binding it to the account from the request. That exact shape was an account-takeover bug in `setPassword`.
- **Don't read an OTP/reset field without `.select("+field")`** — they're `select: false`, so a bare read silently yields `undefined` and any guard around it becomes dead code.
- **Don't mutate `BallEvent` documents** — the model throws by design.
- **Don't do multi-document scoring writes without a transaction.**
- **Don't call `mongoose.connect`** outside `src/database/database.js`, or `dotenv.config` outside `src/config/env.js`.
- **Don't hard-delete** records that have an `isDeleted` flag.
- **Don't commit** `.env.*` or `service-account-file-*.json`.
