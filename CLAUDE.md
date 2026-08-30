# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

REST API backend for a cricket scoring mobile app. Node.js + Express 5 + MongoDB (Mongoose 9), ESM throughout (`"type": "module"` — always use `import`, and include the `.js` extension in relative imports).

Three feature areas are live: **user auth/profile**, a **translation/localization CMS**, and **live cricket scoring** — `match.controller.js` + `match.routes.js` serve `create`, `start-innings`, `select-bowler`, `score-ball`, `undo-ball`, `sync`, `abandon`, `delete`, and the scorecard/history reads, with `match.socket.js` broadcasting to spectators. Scoring covers runs, extras, wickets, server-computed strike rotation, over completion and per-over bowler assignment (including the Law 17.6 refusal of a bowler two overs running), undo (`undoBall`, `resolveUndo.js`), the innings 1→2 transition, and scorecard generation including bowler figures (`generateScorecard`/`getMatchScorecard`, `src/utils/scorecard.js`) — all built and tested. The offline-sync batch endpoint (`POST /v1/match/:matchId/sync`) is also built (see Scoring domain specifics below). The contract lives in `../cricket-scorer-workspace/docs/api.md` — keep it in step with the controller.

**This file previously understated what's built here** (an earlier version said undo/innings-2/scorecard weren't done) — verified against the actual controller 2026-08-29. If you're relying on an older read of this file, re-check before re-deriving or re-planning any of the above.

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

**Pagination:** `GET /match/history` (added 2026-08-29) is the first — offset-based `?page`/`?limit`, default 20, enforced max 50, `INVALID_PAGINATION` outside that range. Follow its shape (see `getMatchHistory` in `match.controller.js`) for the next one, rather than inventing a second convention. `BallEvent` — one document per delivery — is the collection most likely to need this next.

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

### Known gaps (scoring) — found in the 2026-08-29 Phase 1 review

- **Fixed (2026-08-29): no endpoint set `Match.status = 'abandoned'` or `Match.isDeleted = true`.** Now two endpoints, documented in [docs/api.md](../docs/api.md): `POST /:matchId/abandon` (a live/innings_break match that will never finish — rain, a no-show; generates a best-effort partial scorecard and emits `match:abandoned` to the room) and `DELETE /:matchId` (soft-delete, any status, no socket emission — a spectator on a deleted match just sees the next public read 404, same as an unknown code). Covered by [tests/matchAbandonDelete.test.js](tests/matchAbandonDelete.test.js). **The Flutter client now has UI for both** (match-history screen, abandon trigger, delete confirmation) **and spectator-side handling of `match:abandoned`** — see [cricket-scrorer/CLAUDE.md](../cricket-scrorer/CLAUDE.md) for both.
- **Fixed (2026-08-30): the batsman half of the `findOrCreatePlayer` name-collision bug.** `findOrCreatePlayer` still keys on `{teamId, name}` exact match, but `applyDelivery`'s incoming-batsman check now also rejects a name matching any batsman *already dismissed* earlier in this innings (not just the current crease pair) with a new `INCOMING_BATSMAN_NAME_REUSED` — checked against `BallEvent.dismissedPlayerName`, so an undone wicket's deleted row frees the name back up for free, no extra undo-path code needed. Covered by [tests/incomingBatsmanNameCollision.test.js](tests/incomingBatsmanNameCollision.test.js). **Fixed (2026-08-31): the same collision class for bowler names**, via real disambiguation rather than a reject-on-reuse rule — a bowler legitimately reuses their own name across overs, so that rule would have false-positived on the normal case. `selectBowler` (and the equivalent sync-batch `bowler` event) now accepts an optional `bowlerId`: present, it resolves that exact `Player` (a scorer re-picking a known bowler), no name matching involved; absent, the name resolves to a *new* player — `resolveBowler` now does a plain `Player.create` for that path instead of `findOrCreatePlayer`'s find-on-conflict, so a name colliding with an existing `Player` on the bowling side is a genuine `400 BOWLER_NAME_ALREADY_EXISTS` instead of a silent merge. One nuance the fix needed: the previous-over's-bowler-by-name check now runs *before* `resolveBowler`, specifically so typing the immediately-preceding bowler's name back (the single most common way a scorer hits Law 17.6, with no `bowlerId` involved) still gets `BOWLER_CANNOT_BOWL_CONSECUTIVE_OVERS` rather than being caught by the new collision rule first. Covered by [tests/bowlerNameCollision.test.js](tests/bowlerNameCollision.test.js) and, client-side, by [score_ball_controller_test.dart](../cricket-scrorer/test/features/scoring/presentation/controllers/score_ball_controller_test.dart)'s `selectBowler bowlerId disambiguation` group and [next_bowler_bottom_sheet_test.dart](../cricket-scrorer/test/features/scoring/presentation/widget/next_bowler_bottom_sheet_test.dart) — plus verified live end-to-end on the emulator: a chip-picked returning bowler resolves with no error, and a freshly-typed name colliding with an earlier bowler surfaces the new message directly in the (still-open) picker sheet. **Still open**: the bowler picker has no roster-wide candidate list independent of what it has seen this match — see docs/api.md's "still open" note on `GET /v1/match/:matchId/bowlers` — but that's a UX gap now, not a data-corruption one.
- **Fixed (2026-08-30): `findOrCreateTeam` used to key on `{createdBy, name}`**, so typing the same team name across two unrelated matches silently reused the same `Team` and player pool. Decided this was a bug, not a Phase-2-forward choice: teams are meant to be ad-hoc, per-match-only (`docs/roadmap.md`). `findOrCreateTeam` is gone — `createMatch` now unconditionally `Team.create()`s fresh documents for both sides every time (its only call site), and the `{createdBy, name}` unique index on `Team` is gone with it, since two different real teams sharing a name is now expected, not a collision to reject. `findOrCreatePlayer` needed no change: it was already scoped by `teamId`, which is now always match-unique for free. Covered by [tests/matchTeamScoping.test.js](tests/matchTeamScoping.test.js).
- **Fixed (2026-08-30): `selectBowler` called `applyBowlerSelection` with a plain, unconditional `inning.save()`**, so two near-simultaneous calls for the same over could both pass every check off the same stale read, and whichever save landed last silently won — both callers got a 200 with their own choice echoed back. The persisting write is now a compare-and-swap (`Inning.findOneAndUpdate` matched on `currentBowlerId` as read at the start of the call); the loser's filter no longer matches once the winner has committed, and it gets `409 BOWLER_SELECTION_CONFLICT` instead of a false success. No transaction needed — the CAS is the concurrency control. Covered by [tests/selectBowlerRace.test.js](tests/selectBowlerRace.test.js).
- **Fixed (2026-08-29): no DB-backed integration test exercised `match.controller.js` itself.** See the Testing section above — every scoring endpoint now has real HTTP+Mongo coverage.
- **Fixed (2026-08-29): `scoreBall` and `syncMatch` used to duplicate their post-delivery orchestration almost verbatim** (building the response view, the match-completion scorecard generation, both socket emissions). Extracted into a shared `finishBallDelivery({ match, req, result })`, called from both. Behavior-preserving — verified against the full 322-test suite before and after, not just by inspection.
- **Deliberately deferred (2026-08-29): whether `match.controller.js` (1894 lines, 11 endpoints across lifecycle/scoring/reads) should split into sibling files.** Considered and explicitly not done now — the user's call was to revisit once Phase 2 (stats) actually starts reading this same Match/Inning/BallEvent data, rather than split preemptively. If that becomes the trigger: the natural cut is lifecycle (create/start-innings/select-bowler/abandon/delete) vs. scoring (scoreBall/undoBall/syncMatch + their shared `apply*`/`finishBallDelivery` helpers) vs. reads (scorecard/public) — still flat, no service layer, just more sibling `<resource>.<role>.js`-style files. A smaller alternative considered: extract just the shared `apply*`/`finishBallDelivery` helpers into `src/utils/`, joining the existing `resolveX` pure functions there.

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

Four suites exist today. Beyond the two described below, `tests/resolveDelivery.test.js` and `tests/resolveStrike.test.js` cover the pure scoring rules — the runs/extras split and rotate-then-substitute. **This is the pattern to follow for scoring logic:** keep the rule in a pure `src/utils/` function so it is testable without a database, and leave only the state handling in the controller.

The two originals:
- [tests/sanitize.middleware.test.js](tests/sanitize.middleware.test.js) — the pattern for middleware/controller tests: mount the single unit on a minimal Express instance and drive it with supertest. Do **not** import `src/app.js` in a test — it initializes Firebase Admin at import time and needs a service-account file.
- [tests/locales.test.js](tests/locales.test.js) — enforces key parity across `en`/`hi`/`mr` (nested keys included) and rejects empty **top-level** values; the empty-value check uses `Object.entries` and does not recurse, so nested groups like `ACCOUNT_STATUS` are exempt from it.

**DB-backed controller tests now exist (added 2026-08-29), covering every scoring endpoint.** [tests/setup/testDb.js](tests/setup/testDb.js) spins up a real `mongodb-memory-server` **replica set** (`MongoMemoryReplSet.create({ replSet: { count: 1 } })`, not a standalone `MongoMemoryServer`) per suite (`connectTestDb`/`disconnectTestDb`/`clearTestDb`) — a standalone instance silently **hangs forever**, not errors, the moment a test reaches `session.withTransaction(...)` (`scoreBall`, `undoBall`, `startInnings`, `syncMatch` all use one), since the driver waits for replication acks a standalone `mongod` never sends. [tests/helpers/buildTestApp.js](tests/helpers/buildTestApp.js) mounts just the match router on a minimal Express app (same "don't import `src/app.js`" reasoning as `sanitize.middleware.test.js`, so `req.app.get('io')` is always `undefined` and every socket-emit call site's own `if (io)` guard skips it harmlessly — a test here cannot assert on socket emissions this way). [tests/helpers/authTestUser.js](tests/helpers/authTestUser.js) creates a real persisted `User` and signs a real access token, so `verifyJwt` and each controller's own `createdBy` ownership check run unmodified rather than being stubbed. [tests/helpers/matchSetup.js](tests/helpers/matchSetup.js) adds `createMatch`/`startLiveInnings`/`scoreDotBall` convenience wrappers over the real HTTP endpoints, shared by the test files below rather than duplicated per file.

Coverage: [tests/matchAbandonDelete.test.js](tests/matchAbandonDelete.test.js) (abandon/delete), [tests/scoringFlow.test.js](tests/scoringFlow.test.js) (`startInnings`/`selectBowler`/`scoreBall`/`undoBall`, including idempotent-replay and Law 17.6), [tests/syncMatch.test.js](tests/syncMatch.test.js) (clean batch apply, lost-response resume, genuine `409 SYNC_CONFLICT`, partial-batch `failedAt`/`failedCode`). This is the pattern to extend for any new controller test — reuse the existing setup/helpers rather than building a second DB-test harness.

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
