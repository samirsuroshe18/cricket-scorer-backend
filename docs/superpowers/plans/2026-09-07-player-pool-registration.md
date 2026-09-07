# Player Pool Registration & Base Price Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in this session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tournament's organizer (org owner) register a player into that tournament's auction pool with a base price, list the pool, edit a price, or withdraw a player — the registration-and-pricing half of Phase 4's player auction, with no bid/auction-room mechanics and no code path from any player's stats to their base price.

**Architecture:** One new collection, `PlayerPoolEntry` (`{tournament, player, basePrice, createdBy}`, unique on `{tournament, player}`), living beside `Fixture` rather than embedded on `Tournament`. A new `playerPool.controller.js` (mirroring `fixture.controller.js`'s shape) reuses `tournament.controller.js`'s existing `findOwnedTournament`/`findAccessibleTournament` for access control — no new predicate. Player identity resolves through a local `findOrCreatePoolPlayer` helper: an existing `Player` owned by the organizer, or a fresh one created under the organizer's own `createdBy` scope by name — the same `{createdBy, nameLower}` upsert primitive `findOrCreatePlayer` uses, without that function's roster/opposing-team side effects (there is no team yet at pool-registration time). Base price is a plain organizer-entered integer; nothing in this feature reads `CareerStats` or `PlayerMatchStats`.

**Tech Stack:** Node/Express 5/Mongoose (backend), Flutter/GetX (frontend), Jest/Supertest (backend tests), `flutter test` (frontend tests).

**Spec:** [docs/superpowers/specs/2026-09-07-player-pool-registration-design.md](../specs/2026-09-07-player-pool-registration-design.md)

## Global Constraints

- Base price is organizer-set only. No task in this plan reads `CareerStats`, `PlayerMatchStats`, or any career-stats field for any purpose, including display.
- Registration/edit/withdraw are gated exactly like `addTournamentTeam`/`removeTournamentTeam` (`findOwnedTournament` — org owner only). Listing is gated like `getTournament`/`getFixtures` (`findAccessibleTournament` — any org member).
- No paid-tier / entitlement check anywhere in this plan — `Organization` has no tier field yet (Phase 6 unbuilt). Not stubbed in.
- `PlayerPoolEntry` has no `status` field and no `isDeleted` flag — existence is the only state; `DELETE` physically removes the document, same as `removeTournamentTeam`.
- `basePrice`: a whole number, `1`–`100000000` inclusive, on both create and edit.
- A `playerId` reference is only ever honored when that `Player`'s `createdBy` equals the requesting organizer's own id — never a cross-scorer lookup.
- New backend locale keys ship in all three of `src/locales/{en,hi,mr}/common.json` — `tests/locales.test.js` enforces parity.
- Client `TranslationKeys` additions need their local `en`/`hi`/`mr` Dart maps **and** a CMS bulk-update via `POST /api/v1/translations/bulk-update`, or the app renders the raw key once translations next sync (workspace CLAUDE.md).
- Endpoint paths start at `/v1/...`, never `/api/v1/...`, on the Flutter side (`FlavorConfig.baseUrl` already ends in `/api`).

---

## Task 1: Contract — update docs/api.md

**Files:**
- Modify: `docs/api.md` (workspace root — `cricket-scorer-workspace/docs/api.md`, not version-controlled by either repo)

**Interfaces:**
- Produces: the exact request/response/error shapes every later task implements against. No code in this task.

- [ ] **Step 1: Insert a new `## Player pool` section, right after the Tournament section's "What this pass does NOT cover" list and before the `---` separator to `## GET /v1/search`**

Find this existing text (search for `Any client-side (`cricket-scrorer`) model, endpoint, or UI.` followed by `---` then `## GET /v1/search`) and insert the new section between them:

````markdown
## Player pool

Phase 4's registration-and-base-price slice: which players are up for auction in a tournament, and
what they start at. No bid/auction-room mechanics exist yet — see "Still out of scope" below.

**The gaming-risk decision, stated plainly:** base price is a plain organizer-entered number. Nothing
here reads `CareerStats` or `PlayerMatchStats`, in any form, including as a suggested figure an
organizer merely confirms. `Player` has no link to `User` (see "Player has no link to User" above), so
there is no way to verify a `Player` document's stats were produced by, and reflect, a specific real
person who didn't control how those numbers were generated — not even restricting to
organization-verified (tournament/fixture-linked) matches closes this, since nothing prevents an org
owner from also being the delegated scorer, or colluding with one. A stats-derived or stats-suggested
price would launder a self-servable number with the appearance of objectivity. Closing this by
construction — no code path from stats to price at all — is simpler and actually correct, unlike a
filter that only raises the effort bar. See
`docs/superpowers/specs/2026-09-07-player-pool-registration-design.md` in `cricket-scorer-backend`
(§4) for the full reasoning.

**Identity:** a pool entry references a `Player`, resolved the same way `start-innings`'s
`bowlerName`/optional `bowlerId` pair works — find-or-create by name under the *organizer's own*
`createdBy` scope, or an explicit `playerId` the organizer already owns. This does not require the
player to have appeared in any match yet; the common case is an auction run before a tournament's
matches are ever scored.

### POST /v1/tournament/:tournamentId/pool

Registers a player into the pool with a base price. Owner-only (`findOwnedTournament` — the same
authority tier as `addTournamentTeam`/`generateFixtures`). No approval step: the organizer's act of
registering *is* the decision, since there is no player-side submission to approve.

#### Request
```json
{ "playerName": "Rohit Sharma", "playerId": null, "basePrice": 5000 }
```
`playerId` is optional — when given, it must belong to a `Player` already owned (`createdBy`) by the
requesting organizer; when omitted, `playerName` is required and resolves via find-or-create under the
organizer's own scorer scope, exactly like `findOrCreatePlayer`'s identity rule elsewhere in this API.
`basePrice` is a whole number, `1`–`100000000`.

#### Response `201`
```json
{
  "statusCode": 201,
  "data": {
    "playerId": "665f3b1c2d3e4f5a6b7c8d94", "playerName": "Rohit Sharma",
    "role": "batsman", "jerseyNumber": null, "battingStyle": null,
    "bowlingStyle": null, "bio": null,
    "basePrice": 5000, "registeredAt": "2026-09-07T10:00:00.000Z"
  },
  "message": "Player registered in pool",
  "success": true
}
```
`role`/`jerseyNumber`/`battingStyle`/`bowlingStyle`/`bio` are the `Player`'s own existing profile fields
(Phase 2) — editable via `PATCH /v1/player/:playerId`, no new profile surface here. `registeredAt` is the
pool entry's own `createdAt`, renamed for readability, same convention as `joinedAt`/`addedAt` elsewhere.

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `NOT_ORG_MEMBER` | caller isn't a member of the owning organization at all |
| 403 | `TOURNAMENT_NOT_OWNED` | caller is a member but not the owning organization's owner |
| 400 | `POOL_PLAYER_NAME_REQUIRED` | neither a usable `playerId` nor a non-blank `playerName` given |
| 400 | `INVALID_PLAYER_ID` | `playerId` given but doesn't resolve to a `Player` owned by the caller |
| 400 | `BASE_PRICE_REQUIRED` | `basePrice` missing |
| 400 | `INVALID_BASE_PRICE` | not a whole number in `1`–`100000000` |
| 409 | `PLAYER_ALREADY_IN_POOL` | this player is already registered for this tournament — `PATCH` to change the price instead |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

### GET /v1/tournament/:tournamentId/pool

Any org member. Registration order (`createdAt` asc) — a stable default, not an auction-order concept.

#### Response `200`
```json
{
  "statusCode": 200,
  "data": {
    "tournamentId": "665f1a2b3c4d5e6f7a8b9c01",
    "entries": [
      {
        "playerId": "665f3b1c2d3e4f5a6b7c8d94", "playerName": "Rohit Sharma",
        "role": "batsman", "jerseyNumber": null, "battingStyle": null,
        "bowlingStyle": null, "bio": null,
        "basePrice": 5000, "registeredAt": "2026-09-07T10:00:00.000Z"
      }
    ]
  },
  "message": "Pool fetched",
  "success": true
}
```
An empty pool returns `"entries": []`, not an error.

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `NOT_ORG_MEMBER` | caller isn't a member of the owning organization |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

### PATCH /v1/tournament/:tournamentId/pool/:playerId

Edits `basePrice` only. Owner-only.

#### Request
```json
{ "basePrice": 6000 }
```

#### Response `200`
Same shape as `POST`'s response, reflecting the updated `basePrice`. Message: "Pool entry updated".

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `NOT_ORG_MEMBER` | caller isn't a member of the owning organization at all |
| 403 | `TOURNAMENT_NOT_OWNED` | caller is a member but not the owning organization's owner |
| 400 | `INVALID_ID` | `playerId` isn't a well-formed ObjectId |
| 400 | `BASE_PRICE_REQUIRED` | `basePrice` missing |
| 400 | `INVALID_BASE_PRICE` | not a whole number in `1`–`100000000` |
| 404 | `POOL_ENTRY_NOT_FOUND` | no pool entry for this `{tournamentId, playerId}` pair |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

### DELETE /v1/tournament/:tournamentId/pool/:playerId

Withdraws (hard-removes) a pool entry. Owner-only. No cutoff in this pass — there is no "auction
started" event yet to gate against; unrestricted while the entry exists. The underlying `Player`
document is untouched — only the pool entry is removed.

#### Response `200`
```json
{
  "statusCode": 200,
  "data": { "tournamentId": "665f1a2b3c4d5e6f7a8b9c01", "playerId": "665f3b1c2d3e4f5a6b7c8d94" },
  "message": "Pool entry removed",
  "success": true
}
```

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `NOT_ORG_MEMBER` | caller isn't a member of the owning organization at all |
| 403 | `TOURNAMENT_NOT_OWNED` | caller is a member but not the owning organization's owner |
| 400 | `INVALID_ID` | `playerId` isn't a well-formed ObjectId |
| 404 | `POOL_ENTRY_NOT_FOUND` | no pool entry for this `{tournamentId, playerId}` pair |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

### Still out of scope

- All live-auction/bid-room mechanics — current-player-on-the-block, live bid ticker, countdown,
  sold/unsold resolution, server-authoritative bid acceptance, budgets, team-owner invites.
- `sold`/`unsold`/`in_auction` states and any transition between them — added to this same collection
  when the live-auction-room feature is designed, not before.
- A withdrawal cutoff tied to "the auction has started" — no such event exists yet.
- Paid-Organization access-control enforcement for the auction — blocked on Phase 6 defining what
  "paid" means on an `Organization` document.
- Displaying career stats alongside a pool listing — a display-only enhancement the live bid room is
  the more natural home for.
- Reconciling a pool-registered `Player` (owned by the organizer) with the same real person's `Player`
  document under a delegated scorer's own scorer-scope, if added to a team's live roster post-auction.
- Any client-side (`cricket-scrorer`) model, endpoint, or UI — covered in Tasks 7–13 of this same plan
  instead of being deferred; noted here only because the Tournament section above uses this exact
  phrasing for its own scope boundary.

---
````

- [ ] **Step 2: Add to `## Schema state`**

Append, under the most recent `**Applied by ... contract:**` heading (add a new one if the tournament
contract's is currently last):
```markdown
**Applied by the player-pool contract:**
- New collection `playerPoolEntry.model.js`: `tournament` (ref `Tournament`, required), `player` (ref
  `Player`, required), `basePrice` (`Number`, required, `1`–`100000000`), `createdBy` (ref `User`,
  required). Unique `{tournament, player}`; `{tournament: 1, createdAt: 1}` for list order.
- No changes to `Player`, `Team`, `Tournament`, or `Organization`'s own schemas.

New collection, no prior writer — nothing to migrate.
```

- [ ] **Step 3: Commit**

```bash
cd cricket-scorer-workspace
git status
```
The workspace root isn't a git repo — `docs/api.md` has no commit of its own. Move on to Task 2, where
the backend commit's message references this doc update.

---

## Task 2: `PlayerPoolEntry` model

**Files:**
- Create: `src/models/playerPoolEntry.model.js`
- Test: `tests/playerPoolEntry.model.test.js` (create)

**Interfaces:**
- Produces: `PlayerPoolEntry` (named export), a Mongoose model with a unique `{tournament, player}`
  index. Task 3 imports it.

- [ ] **Step 1: Write the failing test**

```js
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { PlayerPoolEntry } from '../src/models/playerPoolEntry.model.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Organization } from '../src/models/organization.model.js';
import { Player } from '../src/models/player.model.js';
import { User } from '../src/models/user.model.js';

describe('PlayerPoolEntry', () => {
  beforeAll(async () => {
    await connectTestDb();
    await PlayerPoolEntry.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const seed = async () => {
    const owner = await User.create({ email: 'owner@example.com', password: 'password123', fullName: 'Owner' });
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }],
    });
    const tournament = await Tournament.create({
      name: 'Summer T20', nameLower: 'summer t20', organization: org._id, format: 'league', createdBy: owner._id,
    });
    const player = await Player.create({ name: 'Rohit Sharma', nameLower: 'rohit sharma', createdBy: owner._id });
    return { owner, tournament, player };
  };

  it('creates with the given fields', async () => {
    const { owner, tournament, player } = await seed();

    const entry = await PlayerPoolEntry.create({
      tournament: tournament._id, player: player._id, basePrice: 5000, createdBy: owner._id,
    });

    expect(entry.basePrice).toBe(5000);
  });

  it('rejects a second entry for the same {tournament, player} pair', async () => {
    const { owner, tournament, player } = await seed();
    await PlayerPoolEntry.create({
      tournament: tournament._id, player: player._id, basePrice: 5000, createdBy: owner._id,
    });

    await expect(
      PlayerPoolEntry.create({
        tournament: tournament._id, player: player._id, basePrice: 6000, createdBy: owner._id,
      })
    ).rejects.toThrow();
  });

  it('allows the same player in two different tournaments', async () => {
    const { owner, tournament, player } = await seed();
    const tournament2 = await Tournament.create({
      name: 'Winter T20', nameLower: 'winter t20', organization: tournament.organization, format: 'knockout', createdBy: owner._id,
    });
    await PlayerPoolEntry.create({
      tournament: tournament._id, player: player._id, basePrice: 5000, createdBy: owner._id,
    });

    const second = await PlayerPoolEntry.create({
      tournament: tournament2._id, player: player._id, basePrice: 7000, createdBy: owner._id,
    });

    expect(second.basePrice).toBe(7000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/playerPoolEntry.model.test.js -v`
Expected: FAIL — `Cannot find module '../src/models/playerPoolEntry.model.js'`.

- [ ] **Step 3: Create the model**

```js
import mongoose, { Schema } from "mongoose";

const playerPoolEntrySchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true },
    player:     { type: Schema.Types.ObjectId, ref: 'Player', required: true },
    // Play-money only, per docs/roadmap.md's settled decision — a plain
    // organizer-entered integer, never derived from career stats. See
    // docs/superpowers/specs/2026-09-07-player-pool-registration-design.md
    // §4 for why stats are never read by this feature at all.
    basePrice:  { type: Number, required: true, min: 1, max: 100000000 },
    createdBy:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// One registration per player per tournament — re-registering an
// already-pooled player is a base-price edit (PATCH), not a second entry.
playerPoolEntrySchema.index({ tournament: 1, player: 1 }, { unique: true });
// Supports the pool listing's natural read order (registration order).
playerPoolEntrySchema.index({ tournament: 1, createdAt: 1 });

export const PlayerPoolEntry = mongoose.model('PlayerPoolEntry', playerPoolEntrySchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/playerPoolEntry.model.test.js -v`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
cd cricket-scorer-backend
git add src/models/playerPoolEntry.model.js tests/playerPoolEntry.model.test.js
git commit -m "$(cat <<'EOF'
feat: add PlayerPoolEntry model

New collection for Phase 4's player pool registration, per
docs/api.md's contract update. Unique on {tournament, player}.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `POST /v1/tournament/:tournamentId/pool`

**Files:**
- Create: `src/controllers/playerPool.controller.js`
- Modify: `src/routes/tournament.routes.js`
- Modify: `src/locales/{en,hi,mr}/common.json`
- Test: `tests/playerPool.test.js` (create)

**Interfaces:**
- Consumes: `findOwnedTournament` (existing, exported from `tournament.controller.js`), `Player`
  (existing model), `PlayerPoolEntry` (Task 2).
- Produces: `registerPoolPlayer` and `formatPoolEntry` (both exported from `playerPool.controller.js`
  — Tasks 4–6 reuse `formatPoolEntry`), mounted as `POST /v1/tournament/:tournamentId/pool`.

- [ ] **Step 1: Write the failing tests**

Create `tests/playerPool.test.js`:
```js
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';
import { PlayerPoolEntry } from '../src/models/playerPoolEntry.model.js';
import { Player } from '../src/models/player.model.js';

let app;

beforeAll(async () => {
  await connectTestDb();
  await Tournament.init();
  await PlayerPoolEntry.init();
  app = buildTestApp({ withOrganization: true, withTournament: true });
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const createOrg = (token, body) =>
  request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

const addMember = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${token}`).send(body);

const createTournament = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/tournaments`).set('Authorization', `Bearer ${token}`).send(body);

const registerPlayer = (token, tournamentId, body) =>
  request(app).post(`/api/v1/tournament/${tournamentId}/pool`).set('Authorization', `Bearer ${token}`).send(body);

// org owner + a plain member + a tournament they both belong to, none of
// this tournament's own pool populated yet — every register test builds on
// this same shape.
const setupOwnedTournament = async () => {
  const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
  const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
  const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
  const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
  const orgId = orgRes.body.data.id;
  await addMember(ownerToken, orgId, { email: 'member@example.com' });
  const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'league' });
  const tournamentId = tournamentRes.body.data.id;
  return { ownerToken, owner, memberToken, strangerToken, tournamentId };
};

describe('POST /:tournamentId/pool', () => {
  it('lets the org owner register a new player by name', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });

    expect(res.status).toBe(201);
    expect(res.body.data.playerName).toBe('Rohit Sharma');
    expect(res.body.data.basePrice).toBe(5000);
    const entry = await PlayerPoolEntry.findOne({ tournament: tournamentId });
    expect(entry.basePrice).toBe(5000);
  });

  it('rejects a plain org member (not owner) trying to register', async () => {
    const { memberToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(memberToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it('rejects a stranger with no relationship to the organization', async () => {
    const { strangerToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(strangerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('rejects a blank player name with no playerId given', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(ownerToken, tournamentId, { playerName: '  ', basePrice: 5000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('POOL_PLAYER_NAME_REQUIRED');
  });

  it('rejects a missing basePrice', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BASE_PRICE_REQUIRED');
  });

  it.each([0, -100, 1.5, 100000001])('rejects an invalid basePrice of %p', async (basePrice) => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BASE_PRICE');
  });

  it('rejects registering the same resolved player twice for the same tournament', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();
    await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });

    const res = await registerPlayer(ownerToken, tournamentId, { playerName: 'rohit sharma', basePrice: 6000 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAYER_ALREADY_IN_POOL');
  });

  it('allows registering the same player name across two different tournaments', async () => {
    const { ownerToken, owner, tournamentId } = await setupOwnedTournament();
    await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });
    const orgRes = await createOrg(ownerToken, { name: 'Second Org' });
    const tournament2Res = await createTournament(ownerToken, orgRes.body.data.id, { name: 'Winter T20', format: 'knockout' });

    const res = await registerPlayer(ownerToken, tournament2Res.body.data.id, { playerName: 'Rohit Sharma', basePrice: 7000 });

    expect(res.status).toBe(201);
  });

  it('accepts an explicit playerId already owned by the organizer', async () => {
    const { ownerToken, owner, tournamentId } = await setupOwnedTournament();
    const player = await Player.create({ name: 'Virat Kohli', nameLower: 'virat kohli', createdBy: owner._id });

    const res = await registerPlayer(ownerToken, tournamentId, { playerId: String(player._id), basePrice: 9000 });

    expect(res.status).toBe(201);
    expect(res.body.data.playerId).toBe(String(player._id));
  });

  it('rejects a playerId owned by a different user', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();
    const { user: someoneElse } = await createTestUser({ email: 'someoneelse@example.com' });
    const player = await Player.create({ name: 'Virat Kohli', nameLower: 'virat kohli', createdBy: someoneElse._id });

    const res = await registerPlayer(ownerToken, tournamentId, { playerId: String(player._id), basePrice: 9000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PLAYER_ID');
  });

  it('rejects with TOURNAMENT_NOT_FOUND for an unknown tournamentId', async () => {
    const { token } = await createTestUser();

    const res = await registerPlayer(token, '000000000000000000000000', { playerName: 'A', basePrice: 100 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/playerPool.test.js -v`
Expected: FAIL — `POST /api/v1/tournament/:tournamentId/pool` 404s (route doesn't exist yet).

- [ ] **Step 3: Add locale keys**

`src/locales/en/common.json`:
```json
  "POOL_PLAYER_NAME_REQUIRED": "The player's name is required",
  "INVALID_PLAYER_ID": "That player reference isn't valid",
  "BASE_PRICE_REQUIRED": "A base price is required",
  "INVALID_BASE_PRICE": "Base price must be a whole number between 1 and 100000000",
  "PLAYER_ALREADY_IN_POOL": "This player is already registered in this tournament's pool",
  "PLAYER_REGISTERED_IN_POOL": "Player registered in pool",
```
`src/locales/hi/common.json`:
```json
  "POOL_PLAYER_NAME_REQUIRED": "खिलाड़ी का नाम आवश्यक है",
  "INVALID_PLAYER_ID": "यह खिलाड़ी संदर्भ मान्य नहीं है",
  "BASE_PRICE_REQUIRED": "बेस प्राइस आवश्यक है",
  "INVALID_BASE_PRICE": "बेस प्राइस 1 और 100000000 के बीच एक पूर्ण संख्या होनी चाहिए",
  "PLAYER_ALREADY_IN_POOL": "यह खिलाड़ी पहले से ही इस टूर्नामेंट के पूल में पंजीकृत है",
  "PLAYER_REGISTERED_IN_POOL": "खिलाड़ी पूल में पंजीकृत किया गया",
```
`src/locales/mr/common.json`:
```json
  "POOL_PLAYER_NAME_REQUIRED": "खेळाडूचे नाव आवश्यक आहे",
  "INVALID_PLAYER_ID": "हा खेळाडू संदर्भ वैध नाही",
  "BASE_PRICE_REQUIRED": "बेस प्राइस आवश्यक आहे",
  "INVALID_BASE_PRICE": "बेस प्राइस 1 ते 100000000 दरम्यान पूर्ण संख्या असावी",
  "PLAYER_ALREADY_IN_POOL": "हा खेळाडू आधीच या स्पर्धेच्या पूलमध्ये नोंदणीकृत आहे",
  "PLAYER_REGISTERED_IN_POOL": "खेळाडू पूलमध्ये नोंदणीकृत केला",
```

*(Insert these anywhere alongside the other tournament/player keys — order doesn't matter, just valid
JSON. Keep all three files in the same relative order so a future diff between them stays readable.)*

- [ ] **Step 4: Create `playerPool.controller.js`**

```js
import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Player } from '../models/player.model.js';
import { PlayerPoolEntry } from '../models/playerPoolEntry.model.js';
import { findOwnedTournament } from './tournament.controller.js';

const asString = (value) => (typeof value === 'string' ? value : '');

const MAX_PLAYER_NAME_LENGTH = 50;
const MIN_BASE_PRICE = 1;
const MAX_BASE_PRICE = 100000000;

// Shared response shape for POST/PATCH's single-entry response and GET's
// list — a Player's own profile fields (Phase 2) plus this entry's
// tournament-scoped basePrice. Deliberately never includes any
// CareerStats/PlayerMatchStats field — see the design spec's §4.
const formatPoolEntry = (entry, player) => ({
    playerId: player._id,
    playerName: player.name,
    role: player.role,
    jerseyNumber: player.jerseyNumber ?? null,
    battingStyle: player.battingStyle ?? null,
    bowlingStyle: player.bowlingStyle ?? null,
    bio: player.bio ?? null,
    basePrice: entry.basePrice,
    registeredAt: entry.createdAt,
});

const validateBasePrice = (basePrice) => {
    if (basePrice === undefined || basePrice === null) {
        throw new ApiError(400, "BASE_PRICE_REQUIRED");
    }
    if (!Number.isInteger(basePrice) || basePrice < MIN_BASE_PRICE || basePrice > MAX_BASE_PRICE) {
        throw new ApiError(400, "INVALID_BASE_PRICE");
    }
};

// Resolves `playerId` (must already belong to the caller's own scorer-scope)
// or find-or-creates by `playerName` under it. Mirrors match.controller.js's
// findOrCreatePlayer's identity-resolution half only — no roster or
// opposing-team side effects, which have no meaning before a player has a
// team at all (the common case: an auction runs before any match is scored).
const findOrCreatePoolPlayer = async (playerName, playerId, createdBy) => {
    if (playerId) {
        if (!mongoose.Types.ObjectId.isValid(playerId)) {
            throw new ApiError(400, "INVALID_PLAYER_ID");
        }
        const player = await Player.findOne({ _id: playerId, createdBy, isDeleted: false });
        if (!player) {
            throw new ApiError(400, "INVALID_PLAYER_ID");
        }
        return player;
    }

    const name = asString(playerName).trim();
    if (!name || name.length > MAX_PLAYER_NAME_LENGTH) {
        throw new ApiError(400, "POOL_PLAYER_NAME_REQUIRED");
    }
    const nameLower = name.toLowerCase();
    try {
        return await Player.findOneAndUpdate(
            { createdBy, nameLower },
            { $setOnInsert: { name, createdBy, nameLower } },
            { new: true, upsert: true }
        );
    } catch (err) {
        if (err.code === 11000) {
            return await Player.findOne({ createdBy, nameLower });
        }
        throw err;
    }
};

const registerPoolPlayer = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    validateBasePrice(req.body.basePrice);
    const player = await findOrCreatePoolPlayer(req.body.playerName, req.body.playerId, req.user._id);

    let entry;
    try {
        entry = await PlayerPoolEntry.create({
            tournament: tournament._id,
            player: player._id,
            basePrice: req.body.basePrice,
            createdBy: req.user._id,
        });
    } catch (err) {
        if (err.code === 11000) {
            throw new ApiError(409, "PLAYER_ALREADY_IN_POOL");
        }
        throw err;
    }

    return res.status(201).json(new ApiResponse(201, formatPoolEntry(entry, player), req.t("PLAYER_REGISTERED_IN_POOL")));
});

export { registerPoolPlayer, formatPoolEntry, validateBasePrice, MIN_BASE_PRICE, MAX_BASE_PRICE };
```

- [ ] **Step 5: Add the route**

In `src/routes/tournament.routes.js`, add an import and the route. Widen the top imports:
```js
import { registerPoolPlayer } from "../controllers/playerPool.controller.js";
```
Add, after the existing `fixtures/:fixtureId` routes and before `standings`:
```js
router.route('/:tournamentId/pool').post(verifyJwt, registerPoolPlayer);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/playerPool.test.js -v`
Expected: PASS (all `describe('POST /:tournamentId/pool', ...)` tests)

- [ ] **Step 7: Run the locale parity test**

Run: `npx jest tests/locales.test.js -v`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/controllers/playerPool.controller.js src/routes/tournament.routes.js src/locales tests/playerPool.test.js
git commit -m "$(cat <<'EOF'
feat: add POST /v1/tournament/:tournamentId/pool

Registers a player into the auction pool with an organizer-set base
price. Identity resolves by name (find-or-create under the
organizer's own scope) or an existing owned playerId — no stats
involved anywhere in base-price determination.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `GET /v1/tournament/:tournamentId/pool`

**Files:**
- Modify: `src/controllers/playerPool.controller.js` (add `listPoolEntries`)
- Modify: `src/routes/tournament.routes.js` (add the route)
- Modify: `src/locales/{en,hi,mr}/common.json` (add `POOL_FETCHED`)
- Modify: `tests/playerPool.test.js` (append a `describe` block)

**Interfaces:**
- Consumes: `findAccessibleTournament` (existing, exported from `tournament.controller.js`),
  `formatPoolEntry` (Task 3, same file).
- Produces: `listPoolEntries`, mounted as `GET /v1/tournament/:tournamentId/pool`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/playerPool.test.js`, after the closing `});` of `describe('POST /:tournamentId/pool', ...)`:
```js
const listPool = (token, tournamentId) =>
  request(app).get(`/api/v1/tournament/${tournamentId}/pool`).set('Authorization', `Bearer ${token}`);

describe('GET /:tournamentId/pool', () => {
  it('lists registered players in registration order for any org member', async () => {
    const { ownerToken, memberToken, tournamentId } = await setupOwnedTournament();
    await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });
    await registerPlayer(ownerToken, tournamentId, { playerName: 'Virat Kohli', basePrice: 9000 });

    const res = await listPool(memberToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.entries.map((e) => e.playerName)).toEqual(['Rohit Sharma', 'Virat Kohli']);
    expect(res.body.data.entries[1].basePrice).toBe(9000);
  });

  it('returns an empty list, not an error, for a tournament with nothing registered', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await listPool(ownerToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toEqual([]);
  });

  it('rejects a non-member of the owning organization', async () => {
    const { strangerToken, tournamentId } = await setupOwnedTournament();

    const res = await listPool(strangerToken, tournamentId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('rejects with TOURNAMENT_NOT_FOUND for an unknown tournamentId', async () => {
    const { token } = await createTestUser();

    const res = await listPool(token, '000000000000000000000000');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/playerPool.test.js -v`
Expected: FAIL — `GET /api/v1/tournament/:tournamentId/pool` 404s.

- [ ] **Step 3: Add the locale key**

`src/locales/en/common.json`: `"POOL_FETCHED": "Pool fetched",`
`src/locales/hi/common.json`: `"POOL_FETCHED": "पूल प्राप्त हुआ",`
`src/locales/mr/common.json`: `"POOL_FETCHED": "पूल मिळाला",`

- [ ] **Step 4: Add the handler**

In `src/controllers/playerPool.controller.js`, add the import and handler:
```js
import { findOwnedTournament, findAccessibleTournament } from './tournament.controller.js';
```
(replaces the Task 3 single-name import)
```js
const listPoolEntries = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);

    const entries = await PlayerPoolEntry.find({ tournament: tournament._id })
        .sort({ createdAt: 1 })
        .populate('player', 'name role jerseyNumber battingStyle bowlingStyle bio');

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        entries: entries.map((entry) => formatPoolEntry(entry, entry.player)),
    }, req.t("POOL_FETCHED")));
});
```
Add `listPoolEntries` to the file's `export { ... }` line.

- [ ] **Step 5: Add the route**

In `src/routes/tournament.routes.js`, widen the import and the route:
```js
import { registerPoolPlayer, listPoolEntries } from "../controllers/playerPool.controller.js";
```
```js
router.route('/:tournamentId/pool')
    .post(verifyJwt, registerPoolPlayer)
    .get(verifyJwt, listPoolEntries);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/playerPool.test.js -v`
Expected: PASS (all tests in the file, both describe blocks)

- [ ] **Step 7: Commit**

```bash
git add src/controllers/playerPool.controller.js src/routes/tournament.routes.js src/locales tests/playerPool.test.js
git commit -m "$(cat <<'EOF'
feat: add GET /v1/tournament/:tournamentId/pool

Lists a tournament's registered pool, any org member, registration
order. Empty pool returns an empty list, not an error.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `PATCH /v1/tournament/:tournamentId/pool/:playerId`

**Files:**
- Modify: `src/controllers/playerPool.controller.js` (add `updatePoolEntry`)
- Modify: `src/routes/tournament.routes.js` (add the route)
- Modify: `src/locales/{en,hi,mr}/common.json` (add `POOL_ENTRY_NOT_FOUND`, `POOL_ENTRY_UPDATED`)
- Modify: `tests/playerPool.test.js` (append a `describe` block)

**Interfaces:**
- Consumes: `findOwnedTournament`, `formatPoolEntry`, `validateBasePrice` (Task 3, same file).
- Produces: `updatePoolEntry`, mounted as `PATCH /v1/tournament/:tournamentId/pool/:playerId`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/playerPool.test.js`:
```js
const updateEntry = (token, tournamentId, playerId, body) =>
  request(app)
    .patch(`/api/v1/tournament/${tournamentId}/pool/${playerId}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

describe('PATCH /:tournamentId/pool/:playerId', () => {
  it('lets the org owner change basePrice', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();
    const registerRes = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });
    const playerId = registerRes.body.data.playerId;

    const res = await updateEntry(ownerToken, tournamentId, playerId, { basePrice: 8000 });

    expect(res.status).toBe(200);
    expect(res.body.data.basePrice).toBe(8000);
    const entry = await PlayerPoolEntry.findOne({ tournament: tournamentId, player: playerId });
    expect(entry.basePrice).toBe(8000);
  });

  it('rejects a plain org member (not owner)', async () => {
    const { ownerToken, memberToken, tournamentId } = await setupOwnedTournament();
    const registerRes = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });

    const res = await updateEntry(memberToken, tournamentId, registerRes.body.data.playerId, { basePrice: 8000 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it('rejects an invalid basePrice', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();
    const registerRes = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });

    const res = await updateEntry(ownerToken, tournamentId, registerRes.body.data.playerId, { basePrice: -1 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BASE_PRICE');
  });

  it('fails with POOL_ENTRY_NOT_FOUND for a playerId never registered here', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await updateEntry(ownerToken, tournamentId, '000000000000000000000000', { basePrice: 8000 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('POOL_ENTRY_NOT_FOUND');
  });

  it('rejects with INVALID_ID for a malformed playerId', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await updateEntry(ownerToken, tournamentId, 'not-an-id', { basePrice: 8000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/playerPool.test.js -v`
Expected: FAIL — `PATCH /api/v1/tournament/:tournamentId/pool/:playerId` 404s.

- [ ] **Step 3: Add locale keys**

`src/locales/en/common.json`:
```json
  "POOL_ENTRY_NOT_FOUND": "That player isn't registered in this tournament's pool",
  "POOL_ENTRY_UPDATED": "Pool entry updated",
```
`src/locales/hi/common.json`:
```json
  "POOL_ENTRY_NOT_FOUND": "वह खिलाड़ी इस टूर्नामेंट के पूल में पंजीकृत नहीं है",
  "POOL_ENTRY_UPDATED": "पूल एंट्री अपडेट की गई",
```
`src/locales/mr/common.json`:
```json
  "POOL_ENTRY_NOT_FOUND": "तो खेळाडू या स्पर्धेच्या पूलमध्ये नोंदणीकृत नाही",
  "POOL_ENTRY_UPDATED": "पूल एंट्री अपडेट केली",
```

- [ ] **Step 4: Add the handler**

In `src/controllers/playerPool.controller.js`:
```js
const updatePoolEntry = catchAsync(async (req, res) => {
    const { tournamentId, playerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(playerId)) {
        throw new ApiError(400, "INVALID_ID");
    }
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    validateBasePrice(req.body.basePrice);

    const entry = await PlayerPoolEntry.findOneAndUpdate(
        { tournament: tournament._id, player: playerId },
        { $set: { basePrice: req.body.basePrice } },
        { new: true }
    ).populate('player', 'name role jerseyNumber battingStyle bowlingStyle bio');

    if (!entry) {
        throw new ApiError(404, "POOL_ENTRY_NOT_FOUND");
    }

    return res.status(200).json(new ApiResponse(200, formatPoolEntry(entry, entry.player), req.t("POOL_ENTRY_UPDATED")));
});
```
Add `updatePoolEntry` to the file's `export { ... }` line.

- [ ] **Step 5: Add the route**

In `src/routes/tournament.routes.js`, widen the import and add:
```js
import { registerPoolPlayer, listPoolEntries, updatePoolEntry } from "../controllers/playerPool.controller.js";
```
```js
router.route('/:tournamentId/pool/:playerId').patch(verifyJwt, updatePoolEntry);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/playerPool.test.js -v`
Expected: PASS (all tests in the file)

- [ ] **Step 7: Commit**

```bash
git add src/controllers/playerPool.controller.js src/routes/tournament.routes.js src/locales tests/playerPool.test.js
git commit -m "$(cat <<'EOF'
feat: add PATCH /v1/tournament/:tournamentId/pool/:playerId

Owner-only base-price edit. Same validation as registration.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `DELETE /v1/tournament/:tournamentId/pool/:playerId`

**Files:**
- Modify: `src/controllers/playerPool.controller.js` (add `removePoolEntry`)
- Modify: `src/routes/tournament.routes.js` (add the route)
- Modify: `src/locales/{en,hi,mr}/common.json` (add `POOL_ENTRY_REMOVED`)
- Modify: `tests/playerPool.test.js` (append a `describe` block)

**Interfaces:**
- Consumes: `findOwnedTournament` (Task 3, same file).
- Produces: `removePoolEntry`, mounted as `DELETE /v1/tournament/:tournamentId/pool/:playerId`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/playerPool.test.js`:
```js
const removeEntry = (token, tournamentId, playerId) =>
  request(app)
    .delete(`/api/v1/tournament/${tournamentId}/pool/${playerId}`)
    .set('Authorization', `Bearer ${token}`);

describe('DELETE /:tournamentId/pool/:playerId', () => {
  it('lets the org owner withdraw a registered player', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();
    const registerRes = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });
    const playerId = registerRes.body.data.playerId;

    const res = await removeEntry(ownerToken, tournamentId, playerId);

    expect(res.status).toBe(200);
    const entry = await PlayerPoolEntry.findOne({ tournament: tournamentId, player: playerId });
    expect(entry).toBeNull();
  });

  it('leaves the underlying Player document untouched', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();
    const registerRes = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });
    const playerId = registerRes.body.data.playerId;

    await removeEntry(ownerToken, tournamentId, playerId);

    const player = await Player.findById(playerId);
    expect(player).not.toBeNull();
    expect(player.isDeleted).toBe(false);
  });

  it('rejects a plain org member (not owner)', async () => {
    const { ownerToken, memberToken, tournamentId } = await setupOwnedTournament();
    const registerRes = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });

    const res = await removeEntry(memberToken, tournamentId, registerRes.body.data.playerId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it('fails with POOL_ENTRY_NOT_FOUND for a playerId never registered here', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await removeEntry(ownerToken, tournamentId, '000000000000000000000000');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('POOL_ENTRY_NOT_FOUND');
  });

  it('rejects with INVALID_ID for a malformed playerId', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await removeEntry(ownerToken, tournamentId, 'not-an-id');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/playerPool.test.js -v`
Expected: FAIL — `DELETE /api/v1/tournament/:tournamentId/pool/:playerId` 404s.

- [ ] **Step 3: Add the locale key**

`src/locales/en/common.json`: `"POOL_ENTRY_REMOVED": "Pool entry removed",`
`src/locales/hi/common.json`: `"POOL_ENTRY_REMOVED": "पूल एंट्री हटाई गई",`
`src/locales/mr/common.json`: `"POOL_ENTRY_REMOVED": "पूल एंट्री काढली",`

- [ ] **Step 4: Add the handler**

In `src/controllers/playerPool.controller.js`:
```js
const removePoolEntry = catchAsync(async (req, res) => {
    const { tournamentId, playerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(playerId)) {
        throw new ApiError(400, "INVALID_ID");
    }
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    const entry = await PlayerPoolEntry.findOneAndDelete({ tournament: tournament._id, player: playerId });
    if (!entry) {
        throw new ApiError(404, "POOL_ENTRY_NOT_FOUND");
    }

    return res.status(200).json(new ApiResponse(200, { tournamentId: tournament._id, playerId }, req.t("POOL_ENTRY_REMOVED")));
});
```
Add `removePoolEntry` to the file's `export { ... }` line.

- [ ] **Step 5: Add the route**

In `src/routes/tournament.routes.js`, widen the import and add:
```js
import { registerPoolPlayer, listPoolEntries, updatePoolEntry, removePoolEntry } from "../controllers/playerPool.controller.js";
```
```js
router.route('/:tournamentId/pool/:playerId')
    .patch(verifyJwt, updatePoolEntry)
    .delete(verifyJwt, removePoolEntry);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/playerPool.test.js -v`
Expected: PASS (all tests in the file — this is now the full backend test suite for this feature)

- [ ] **Step 7: Run the full backend suite**

Run: `npm test`
Expected: no new failures versus the pre-existing baseline (check `git stash` + re-run if any fail, to
confirm they're pre-existing/flaky-under-load, same as the bowler-roster feature's own verification
earlier this project — do not assume, verify).

- [ ] **Step 8: Commit**

```bash
git add src/controllers/playerPool.controller.js src/routes/tournament.routes.js src/locales tests/playerPool.test.js
git commit -m "$(cat <<'EOF'
feat: add DELETE /v1/tournament/:tournamentId/pool/:playerId

Owner-only withdrawal, hard-removes the pool entry. No cutoff in
this pass — no "auction started" event exists yet to gate against.
The underlying Player document is untouched.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Verify live against the dev server**

```bash
curl -s -m 3 http://localhost:9000/api/v1/tournament/000000000000000000000000/pool -H "Authorization: Bearer bad" -o /dev/null -w "%{http_code}\n"
```
Expected: `401` (confirms the route exists and `verifyJwt` runs — a missing route would 404 instead).
Do not start or restart the dev server yourself; if it isn't already running, ask before proceeding.

---

## Task 7: Flutter — data layer (endpoint, models, api service)

**Files:**
- Modify: `lib/features/tournament/data/tournament_endpoint.dart`
- Create: `lib/features/tournament/data/models/request/register_pool_player_req.dart` (+ `.g.dart`)
- Create: `lib/features/tournament/data/models/request/update_pool_entry_req.dart` (+ `.g.dart`)
- Create: `lib/features/tournament/data/models/response/pool_entry_res.dart` (+ `.g.dart`)
- Modify: `lib/features/tournament/data/data_sources/remote/tournament_api_service.dart`

**Interfaces:**
- Produces: `TournamentEndpoint.pool(tournamentId)`/`.poolEntry(tournamentId, playerId)`,
  `RegisterPoolPlayerReq`, `UpdatePoolEntryReq`, `PoolEntryRes`, and four new `TournamentApiService`
  methods (`registerPoolPlayer`, `getPool`, `updatePoolEntry`, `removePoolEntry`). Task 8 consumes all
  of these.

- [ ] **Step 1: Add endpoint constants**

In `lib/features/tournament/data/tournament_endpoint.dart`, add, after `leaderboards`:
```dart
  String pool(String tournamentId) => '/v1/tournament/$tournamentId/pool';

  String poolEntry(String tournamentId, String playerId) =>
      '/v1/tournament/$tournamentId/pool/$playerId';
```

- [ ] **Step 2: Create the request models**

`lib/features/tournament/data/models/request/register_pool_player_req.dart`:
```dart
import 'package:json_annotation/json_annotation.dart';

part 'register_pool_player_req.g.dart';

/// `POST /v1/tournament/:tournamentId/pool` — `playerId` optional, mirroring
/// `SelectBowlerReq`'s `bowlerName`/optional `bowlerId` pair: given, it must
/// already be owned by the caller; omitted, `playerName` find-or-creates
/// under the caller's own scorer scope.
@JsonSerializable()
class RegisterPoolPlayerReq {
  final String? playerName;
  final String? playerId;
  final int basePrice;

  RegisterPoolPlayerReq({this.playerName, this.playerId, required this.basePrice});

  factory RegisterPoolPlayerReq.fromJson(Map<String, dynamic> json) =>
      _$RegisterPoolPlayerReqFromJson(json);

  Map<String, dynamic> toJson() => _$RegisterPoolPlayerReqToJson(this);
}
```

`lib/features/tournament/data/models/request/update_pool_entry_req.dart`:
```dart
import 'package:json_annotation/json_annotation.dart';

part 'update_pool_entry_req.g.dart';

/// `PATCH /v1/tournament/:tournamentId/pool/:playerId` — basePrice only,
/// always required (not a partial-update shape like UpdateTournamentReq).
@JsonSerializable()
class UpdatePoolEntryReq {
  final int basePrice;

  UpdatePoolEntryReq({required this.basePrice});

  factory UpdatePoolEntryReq.fromJson(Map<String, dynamic> json) =>
      _$UpdatePoolEntryReqFromJson(json);

  Map<String, dynamic> toJson() => _$UpdatePoolEntryReqToJson(this);
}
```

- [ ] **Step 3: Create the response model**

`lib/features/tournament/data/models/response/pool_entry_res.dart`:
```dart
import 'package:json_annotation/json_annotation.dart';

part 'pool_entry_res.g.dart';

/// One entry in a tournament's auction pool — a `Player`'s existing Phase 2
/// profile fields plus this tournament's organizer-set `basePrice`.
/// Deliberately carries no career-stats field: base price never derives
/// from stats, and this response shouldn't imply otherwise. See
/// docs/api.md's "Player pool" section.
@JsonSerializable()
class PoolEntryRes {
  final String playerId;
  final String playerName;
  final String role;
  final int? jerseyNumber;
  final String? battingStyle;
  final String? bowlingStyle;
  final String? bio;
  final int basePrice;
  final String registeredAt;

  PoolEntryRes({
    required this.playerId,
    required this.playerName,
    required this.role,
    this.jerseyNumber,
    this.battingStyle,
    this.bowlingStyle,
    this.bio,
    required this.basePrice,
    required this.registeredAt,
  });

  factory PoolEntryRes.fromJson(Map<String, dynamic> json) =>
      _$PoolEntryResFromJson(json);

  Map<String, dynamic> toJson() => _$PoolEntryResToJson(this);
}
```

- [ ] **Step 4: Add the four api-service methods**

In `lib/features/tournament/data/data_sources/remote/tournament_api_service.dart`, add the two new
request-model imports alongside the existing `tournament/data/models/request/*` imports:
```dart
import 'package:cricket_scorer/features/tournament/data/models/request/register_pool_player_req.dart';
import 'package:cricket_scorer/features/tournament/data/models/request/update_pool_entry_req.dart';
```
Then add, after `getLeaderboards`:
```dart
  Future<Either<ApiResponseModel, CricketFailure>> registerPoolPlayer({
    required String tournamentId,
    required RegisterPoolPlayerReq params,
  }) async {
    return await apiClient.post(
      endpoint: tournamentEndpoint.pool(tournamentId),
      data: params.toJson(),
    );
  }

  Future<Either<ApiResponseModel, CricketFailure>> getPool({
    required String tournamentId,
  }) async {
    return await apiClient.get(endpoint: tournamentEndpoint.pool(tournamentId));
  }

  Future<Either<ApiResponseModel, CricketFailure>> updatePoolEntry({
    required String tournamentId,
    required String playerId,
    required UpdatePoolEntryReq params,
  }) async {
    return await apiClient.patch(
      endpoint: tournamentEndpoint.poolEntry(tournamentId, playerId),
      data: params.toJson(),
    );
  }

  Future<Either<ApiResponseModel, CricketFailure>> removePoolEntry({
    required String tournamentId,
    required String playerId,
  }) async {
    return await apiClient.delete(
      endpoint: tournamentEndpoint.poolEntry(tournamentId, playerId),
    );
  }
```

- [ ] **Step 5: Generate the `.g.dart` files**

Run: `dart run build_runner build --delete-conflicting-outputs`

If this hangs (seen previously in this project when a `flutter run` session is active at the same
time — both processes contend for Dart's native-asset build locks under `.dart_tool/`), check for a
live `flutter run` process first (`ps aux | grep flutter_tools`); never kill the user's own session —
ask, or hand-write the two small generated files by mirroring an existing simple model's `.g.dart`
(e.g. `lib/features/tournament/data/models/response/standings_row_res.g.dart` for the response model's
shape, `lib/features/tournament/data/models/request/enroll_tournament_team_req.g.dart` for a request
model's).

- [ ] **Step 6: Verify**

Run: `flutter analyze`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
cd cricket-scrorer
git add lib/features/tournament/data/tournament_endpoint.dart lib/features/tournament/data/models/request/register_pool_player_req.dart lib/features/tournament/data/models/request/register_pool_player_req.g.dart lib/features/tournament/data/models/request/update_pool_entry_req.dart lib/features/tournament/data/models/request/update_pool_entry_req.g.dart lib/features/tournament/data/models/response/pool_entry_res.dart lib/features/tournament/data/models/response/pool_entry_res.g.dart lib/features/tournament/data/data_sources/remote/tournament_api_service.dart
git commit -m "$(cat <<'EOF'
feat: add player-pool data layer (endpoint, models, api service)

Request/response models and the four API-service methods for
GET/POST/PATCH/DELETE .../pool, matching the backend contract in
docs/api.md.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Flutter — repository

**Files:**
- Modify: `lib/features/tournament/domain/repositories/tournament_repository.dart`
- Modify: `lib/features/tournament/data/repositories/tournament_repository_impl.dart`

**Interfaces:**
- Consumes: Task 7's api-service methods and models.
- Produces: `TournamentRepository.registerPoolPlayer`/`getPool`/`updatePoolEntry`/`removePoolEntry`.
  Task 9's usecases consume all four.

- [ ] **Step 1: Add to the repository interface**

In `lib/features/tournament/domain/repositories/tournament_repository.dart`, add the two new imports
alongside the existing `tournament/data/models/request/*` imports:
```dart
import 'package:cricket_scorer/features/tournament/data/models/request/register_pool_player_req.dart';
import 'package:cricket_scorer/features/tournament/data/models/request/update_pool_entry_req.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/pool_entry_res.dart';
```
Then add, after `getLeaderboards`:
```dart
  /// `POST /v1/tournament/:tournamentId/pool` — owner-only. Base price is
  /// always organizer-set; nothing here reads career stats.
  Future<Either<CricketResponse<PoolEntryRes>, CricketFailure>>
  registerPoolPlayer({
    required String tournamentId,
    required RegisterPoolPlayerReq params,
  });

  /// `GET /v1/tournament/:tournamentId/pool` — any org member.
  Future<Either<CricketResponse<List<PoolEntryRes>>, CricketFailure>>
  getPool({required String tournamentId});

  /// `PATCH /v1/tournament/:tournamentId/pool/:playerId` — owner-only,
  /// basePrice only.
  Future<Either<CricketResponse<PoolEntryRes>, CricketFailure>>
  updatePoolEntry({
    required String tournamentId,
    required String playerId,
    required UpdatePoolEntryReq params,
  });

  /// `DELETE /v1/tournament/:tournamentId/pool/:playerId` — owner-only,
  /// hard removal. No cutoff in this pass.
  Future<Either<CricketResponse<void>, CricketFailure>> removePoolEntry({
    required String tournamentId,
    required String playerId,
  });
```

- [ ] **Step 2: Implement in `TournamentRepositoryImpl`**

In `lib/features/tournament/data/repositories/tournament_repository_impl.dart`, add the same three
imports as Step 1:
```dart
import 'package:cricket_scorer/features/tournament/data/models/request/register_pool_player_req.dart';
import 'package:cricket_scorer/features/tournament/data/models/request/update_pool_entry_req.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/pool_entry_res.dart';
```
Then add, after `getLeaderboards`:
```dart
  @override
  Future<Either<CricketResponse<PoolEntryRes>, CricketFailure>>
  registerPoolPlayer({
    required String tournamentId,
    required RegisterPoolPlayerReq params,
  }) async {
    final response = await tournamentApiService.registerPoolPlayer(
      tournamentId: tournamentId,
      params: params,
    );
    if (response.isResult) {
      return Either.result(
        CricketResponse(
          data: PoolEntryRes.fromJson(
            response.result.data as Map<String, dynamic>,
          ),
          message: response.result.message,
        ),
      );
    }
    return Either.fallback(response.fallback);
  }

  @override
  Future<Either<CricketResponse<List<PoolEntryRes>>, CricketFailure>>
  getPool({required String tournamentId}) async {
    final response = await tournamentApiService.getPool(
      tournamentId: tournamentId,
    );
    if (response.isResult) {
      final data = response.result.data as Map<String, dynamic>;
      final entriesJson = data['entries'] as List<dynamic>;
      return Either.result(
        CricketResponse(
          data: entriesJson
              .map((json) => PoolEntryRes.fromJson(json as Map<String, dynamic>))
              .toList(),
          message: response.result.message,
        ),
      );
    }
    return Either.fallback(response.fallback);
  }

  @override
  Future<Either<CricketResponse<PoolEntryRes>, CricketFailure>>
  updatePoolEntry({
    required String tournamentId,
    required String playerId,
    required UpdatePoolEntryReq params,
  }) async {
    final response = await tournamentApiService.updatePoolEntry(
      tournamentId: tournamentId,
      playerId: playerId,
      params: params,
    );
    if (response.isResult) {
      return Either.result(
        CricketResponse(
          data: PoolEntryRes.fromJson(
            response.result.data as Map<String, dynamic>,
          ),
          message: response.result.message,
        ),
      );
    }
    return Either.fallback(response.fallback);
  }

  @override
  Future<Either<CricketResponse<void>, CricketFailure>> removePoolEntry({
    required String tournamentId,
    required String playerId,
  }) async {
    final response = await tournamentApiService.removePoolEntry(
      tournamentId: tournamentId,
      playerId: playerId,
    );
    if (response.isResult) {
      return Either.result(
        CricketResponse(data: null, message: response.result.message),
      );
    }
    return Either.fallback(response.fallback);
  }
```

- [ ] **Step 3: Verify**

Run: `flutter analyze`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add lib/features/tournament/domain/repositories/tournament_repository.dart lib/features/tournament/data/repositories/tournament_repository_impl.dart
git commit -m "$(cat <<'EOF'
feat: add player-pool methods to TournamentRepository

registerPoolPlayer/getPool/updatePoolEntry/removePoolEntry, wired
straight through to the Task 7 api-service methods.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Flutter — usecases + DI

**Files:**
- Create: `lib/features/tournament/domain/usecases/register_pool_player.dart`
- Create: `lib/features/tournament/domain/usecases/get_pool.dart`
- Create: `lib/features/tournament/domain/usecases/update_pool_entry.dart`
- Create: `lib/features/tournament/domain/usecases/remove_pool_entry.dart`
- Modify: `lib/core/di/injection/tournament_injection.dart`

**Interfaces:**
- Consumes: `TournamentRepository` (Task 8).
- Produces: `RegisterPoolPlayerUseCase`, `GetPoolUseCase`, `UpdatePoolEntryUseCase`,
  `RemovePoolEntryUseCase`, all registered in DI. Task 10's controller consumes all four.

- [ ] **Step 1: Create the four usecases**

`lib/features/tournament/domain/usecases/register_pool_player.dart`:
```dart
import 'package:cricket_scorer/core/error/cricket_failure.dart';
import 'package:cricket_scorer/core/network/models/cricket_response.dart';
import 'package:cricket_scorer/core/usecase/usecase.dart';
import 'package:cricket_scorer/core/utils/either_util.dart';
import 'package:cricket_scorer/features/tournament/data/models/request/register_pool_player_req.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/pool_entry_res.dart';
import 'package:cricket_scorer/features/tournament/domain/repositories/tournament_repository.dart';

class RegisterPoolPlayerParams {
  final String tournamentId;
  final String? playerName;
  final String? playerId;
  final int basePrice;

  RegisterPoolPlayerParams({
    required this.tournamentId,
    this.playerName,
    this.playerId,
    required this.basePrice,
  });
}

class RegisterPoolPlayerUseCase
    implements
        UseCase<Either<CricketResponse<PoolEntryRes>, CricketFailure>,
            RegisterPoolPlayerParams> {
  final TournamentRepository tournamentRepository;

  RegisterPoolPlayerUseCase({required this.tournamentRepository});

  @override
  Future<Either<CricketResponse<PoolEntryRes>, CricketFailure>> call({
    RegisterPoolPlayerParams? params,
  }) {
    return tournamentRepository.registerPoolPlayer(
      tournamentId: params!.tournamentId,
      params: RegisterPoolPlayerReq(
        playerName: params.playerName,
        playerId: params.playerId,
        basePrice: params.basePrice,
      ),
    );
  }
}
```

`lib/features/tournament/domain/usecases/get_pool.dart`:
```dart
import 'package:cricket_scorer/core/error/cricket_failure.dart';
import 'package:cricket_scorer/core/network/models/cricket_response.dart';
import 'package:cricket_scorer/core/usecase/usecase.dart';
import 'package:cricket_scorer/core/utils/either_util.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/pool_entry_res.dart';
import 'package:cricket_scorer/features/tournament/domain/repositories/tournament_repository.dart';

class GetPoolParams {
  final String tournamentId;

  GetPoolParams({required this.tournamentId});
}

class GetPoolUseCase
    implements
        UseCase<Either<CricketResponse<List<PoolEntryRes>>, CricketFailure>,
            GetPoolParams> {
  final TournamentRepository tournamentRepository;

  GetPoolUseCase({required this.tournamentRepository});

  @override
  Future<Either<CricketResponse<List<PoolEntryRes>>, CricketFailure>> call({
    GetPoolParams? params,
  }) {
    return tournamentRepository.getPool(tournamentId: params!.tournamentId);
  }
}
```

`lib/features/tournament/domain/usecases/update_pool_entry.dart`:
```dart
import 'package:cricket_scorer/core/error/cricket_failure.dart';
import 'package:cricket_scorer/core/network/models/cricket_response.dart';
import 'package:cricket_scorer/core/usecase/usecase.dart';
import 'package:cricket_scorer/core/utils/either_util.dart';
import 'package:cricket_scorer/features/tournament/data/models/request/update_pool_entry_req.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/pool_entry_res.dart';
import 'package:cricket_scorer/features/tournament/domain/repositories/tournament_repository.dart';

class UpdatePoolEntryParams {
  final String tournamentId;
  final String playerId;
  final int basePrice;

  UpdatePoolEntryParams({
    required this.tournamentId,
    required this.playerId,
    required this.basePrice,
  });
}

class UpdatePoolEntryUseCase
    implements
        UseCase<Either<CricketResponse<PoolEntryRes>, CricketFailure>,
            UpdatePoolEntryParams> {
  final TournamentRepository tournamentRepository;

  UpdatePoolEntryUseCase({required this.tournamentRepository});

  @override
  Future<Either<CricketResponse<PoolEntryRes>, CricketFailure>> call({
    UpdatePoolEntryParams? params,
  }) {
    return tournamentRepository.updatePoolEntry(
      tournamentId: params!.tournamentId,
      playerId: params.playerId,
      params: UpdatePoolEntryReq(basePrice: params.basePrice),
    );
  }
}
```

`lib/features/tournament/domain/usecases/remove_pool_entry.dart`:
```dart
import 'package:cricket_scorer/core/error/cricket_failure.dart';
import 'package:cricket_scorer/core/network/models/cricket_response.dart';
import 'package:cricket_scorer/core/usecase/usecase.dart';
import 'package:cricket_scorer/core/utils/either_util.dart';
import 'package:cricket_scorer/features/tournament/domain/repositories/tournament_repository.dart';

class RemovePoolEntryParams {
  final String tournamentId;
  final String playerId;

  RemovePoolEntryParams({required this.tournamentId, required this.playerId});
}

class RemovePoolEntryUseCase
    implements
        UseCase<Either<CricketResponse<void>, CricketFailure>,
            RemovePoolEntryParams> {
  final TournamentRepository tournamentRepository;

  RemovePoolEntryUseCase({required this.tournamentRepository});

  @override
  Future<Either<CricketResponse<void>, CricketFailure>> call({
    RemovePoolEntryParams? params,
  }) {
    return tournamentRepository.removePoolEntry(
      tournamentId: params!.tournamentId,
      playerId: params.playerId,
    );
  }
}
```

- [ ] **Step 2: Register all four in DI**

In `lib/core/di/injection/tournament_injection.dart`, add the four imports alongside the existing
`tournament/domain/usecases/*` imports:
```dart
import 'package:cricket_scorer/features/tournament/domain/usecases/register_pool_player.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/get_pool.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/update_pool_entry.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/remove_pool_entry.dart';
```
Then add, after `GetLeaderboardsUseCase`'s registration:
```dart
    Get.lazyPut<RegisterPoolPlayerUseCase>(
      () => RegisterPoolPlayerUseCase(
        tournamentRepository: Get.find<TournamentRepository>(),
      ),
      fenix: true,
    );

    Get.lazyPut<GetPoolUseCase>(
      () => GetPoolUseCase(
        tournamentRepository: Get.find<TournamentRepository>(),
      ),
      fenix: true,
    );

    Get.lazyPut<UpdatePoolEntryUseCase>(
      () => UpdatePoolEntryUseCase(
        tournamentRepository: Get.find<TournamentRepository>(),
      ),
      fenix: true,
    );

    Get.lazyPut<RemovePoolEntryUseCase>(
      () => RemovePoolEntryUseCase(
        tournamentRepository: Get.find<TournamentRepository>(),
      ),
      fenix: true,
    );
```

- [ ] **Step 3: Verify**

Run: `flutter analyze`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add lib/features/tournament/domain/usecases/register_pool_player.dart lib/features/tournament/domain/usecases/get_pool.dart lib/features/tournament/domain/usecases/update_pool_entry.dart lib/features/tournament/domain/usecases/remove_pool_entry.dart lib/core/di/injection/tournament_injection.dart
git commit -m "$(cat <<'EOF'
feat: add player-pool usecases and DI registration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Flutter — controller, binding, and a unit test

**Files:**
- Modify: `lib/features/tournament/presentation/controllers/tournament_detail_controller.dart`
- Modify: `lib/features/tournament/presentation/bindings/tournament_detail_binding.dart`
- Modify: `test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart`
  (existing file — add to it)

**Interfaces:**
- Consumes: Task 9's four usecases.
- Produces: `TournamentDetailController.poolEntries`/`poolLoading`/`poolError`/`loadPool()`/
  `registerPoolPlayer(...)`/`updatePoolEntry(...)`/`removePoolEntry(...)`. Task 11/12's screen and sheet
  consume these.

*(This widens `TournamentDetailController`'s constructor with four new required fields. Before writing
this task's code, grep for every other place that constructs `TournamentDetailController` directly —
`grep -rl "TournamentDetailController(" test/ lib/` — the same check this project's CLAUDE.md notes was
done for the org-controller widening earlier in this project, to catch every call site before running
`flutter analyze` rather than after.)*

- [ ] **Step 1: Write the failing test**

Find the existing fake `TournamentDetailController`-supporting test doubles in
`test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart` (it already
fakes `GetTournamentUseCase` etc. — follow its exact existing fake-class shape for the four new
usecases). Add fakes for `RegisterPoolPlayerUseCase`, `GetPoolUseCase`, `UpdatePoolEntryUseCase`,
`RemovePoolEntryUseCase` (each a simple settable-response fake, mirroring however the file's existing
`_FakeGetStandingsUseCase`/`_FakeGetLeaderboardsUseCase` — if present — are shaped; if this file predates
standings/leaderboards being added to this controller, mirror whichever existing fake is structurally
closest and read the file in full first, since its own patterns are the ground truth, not this plan).

Add this test:
```dart
test('loadPool populates poolEntries on success', () async {
  fakeGetPoolUseCase.response = Either.result(
    CricketResponse(
      data: [
        PoolEntryRes(
          playerId: 'p1', playerName: 'Rohit Sharma', role: 'batsman',
          basePrice: 5000, registeredAt: '2026-09-07T10:00:00.000Z',
        ),
      ],
      message: 'ok',
    ),
  );

  await controller.loadPool();

  expect(controller.poolEntries.length, 1);
  expect(controller.poolEntries.first.playerName, 'Rohit Sharma');
  expect(controller.poolLoading.value, isFalse);
});

test('registerPoolPlayer reloads the pool on success', () async {
  fakeRegisterPoolPlayerUseCase.response = Either.result(
    CricketResponse(
      data: PoolEntryRes(
        playerId: 'p1', playerName: 'Rohit Sharma', role: 'batsman',
        basePrice: 5000, registeredAt: '2026-09-07T10:00:00.000Z',
      ),
      message: 'ok',
    ),
  );
  fakeGetPoolUseCase.response = Either.result(
    CricketResponse(
      data: [
        PoolEntryRes(
          playerId: 'p1', playerName: 'Rohit Sharma', role: 'batsman',
          basePrice: 5000, registeredAt: '2026-09-07T10:00:00.000Z',
        ),
      ],
      message: 'ok',
    ),
  );

  final success = await controller.registerPoolPlayer(playerName: 'Rohit Sharma', basePrice: 5000);

  expect(success, isTrue);
  expect(controller.poolEntries.length, 1);
});
```

*(Adjust the exact fake-response assignment syntax to whatever this file's other fakes already use —
some fakes in this codebase expose a settable `response`/`Function` field, others take a constructor
argument; match the file's own established pattern, not this snippet verbatim, if they differ.)*

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart`
Expected: FAIL — compile error, `poolEntries`/`loadPool`/`registerPoolPlayer` undefined.

- [ ] **Step 3: Widen the controller**

In `lib/features/tournament/presentation/controllers/tournament_detail_controller.dart`, add the four
new imports alongside the existing `tournament/domain/usecases/*` imports:
```dart
import 'package:cricket_scorer/features/tournament/data/models/response/pool_entry_res.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/register_pool_player.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/get_pool.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/update_pool_entry.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/remove_pool_entry.dart';
```
Then add four new required constructor fields, and four new methods plus three new Rx fields:
```dart
  final RegisterPoolPlayerUseCase registerPoolPlayerUseCase;
  final GetPoolUseCase getPoolUseCase;
  final UpdatePoolEntryUseCase updatePoolEntryUseCase;
  final RemovePoolEntryUseCase removePoolEntryUseCase;
```
(added to the constructor's field list and its named-parameter list, alongside the existing
`getLeaderboardsUseCase`).

```dart
  // Same lazy-load reasoning as standings/leaderboards above — fetched only
  // when the pool screen actually opens.
  final poolEntries = <PoolEntryRes>[].obs;
  final poolLoading = false.obs;
  final poolError = Rxn<String>();

  Future<void> loadPool() async {
    poolLoading.value = true;
    poolError.value = null;

    final response = await getPoolUseCase(
      params: GetPoolParams(tournamentId: tournamentId),
    );

    if (!response.isResult) {
      poolError.value = response.fallback.message;
      poolLoading.value = false;
      return;
    }

    poolEntries.assignAll(response.result.data!);
    poolLoading.value = false;
  }

  /// Returns true on success (and reloads the pool), false otherwise —
  /// mirrors updateTournament/enrollTeam's own boolean-result shape. The
  /// sheet that calls this shows its own error on false; this controller
  /// method never calls CricketSnackbar directly (see the class doc).
  Future<bool> registerPoolPlayer({
    String? playerName,
    String? playerId,
    required int basePrice,
  }) async {
    final response = await registerPoolPlayerUseCase(
      params: RegisterPoolPlayerParams(
        tournamentId: tournamentId,
        playerName: playerName,
        playerId: playerId,
        basePrice: basePrice,
      ),
    );

    if (!response.isResult) return false;
    await loadPool();
    return true;
  }

  Future<bool> updatePoolEntry({
    required String playerId,
    required int basePrice,
  }) async {
    final response = await updatePoolEntryUseCase(
      params: UpdatePoolEntryParams(
        tournamentId: tournamentId,
        playerId: playerId,
        basePrice: basePrice,
      ),
    );

    if (!response.isResult) return false;
    await loadPool();
    return true;
  }

  Future<bool> removePoolEntry(String playerId) async {
    final response = await removePoolEntryUseCase(
      params: RemovePoolEntryParams(
        tournamentId: tournamentId,
        playerId: playerId,
      ),
    );

    if (!response.isResult) return false;
    await loadPool();
    return true;
  }
```

- [ ] **Step 4: Widen the binding**

In `lib/features/tournament/presentation/bindings/tournament_detail_binding.dart`, add the four
imports alongside the existing `tournament/domain/usecases/*` imports:
```dart
import 'package:cricket_scorer/features/tournament/domain/usecases/register_pool_player.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/get_pool.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/update_pool_entry.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/remove_pool_entry.dart';
```
Then add the four constructor arguments:
```dart
        registerPoolPlayerUseCase: Get.find<RegisterPoolPlayerUseCase>(),
        getPoolUseCase: Get.find<GetPoolUseCase>(),
        updatePoolEntryUseCase: Get.find<UpdatePoolEntryUseCase>(),
        removePoolEntryUseCase: Get.find<RemovePoolEntryUseCase>(),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `flutter test test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart`
Expected: PASS (all tests in the file, existing + new)

- [ ] **Step 6: Run `flutter analyze`**

Expected: no new errors — this is the check that catches every other direct
`TournamentDetailController(...)` construction site this task's constructor widening might have broken
(per this task's opening note).

- [ ] **Step 7: Commit**

```bash
git add lib/features/tournament/presentation/controllers/tournament_detail_controller.dart lib/features/tournament/presentation/bindings/tournament_detail_binding.dart test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart
git commit -m "$(cat <<'EOF'
feat: wire player-pool into TournamentDetailController

poolEntries/loadPool/registerPoolPlayer/updatePoolEntry/removePoolEntry,
lazy-loaded the same way standings/leaderboards already are.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Flutter — route and screen

**Files:**
- Modify: `lib/config/routes/app_routes.dart`
- Modify: `lib/config/routes/app_pages.dart`
- Create: `lib/features/tournament/presentation/pages/tournament_player_pool_screen.dart`
- Create: `test/features/tournament/presentation/pages/tournament_player_pool_screen_test.dart`

**Interfaces:**
- Consumes: Task 10's controller fields/methods.
- Produces: `AppRoutes.tournamentPool`/`.tournamentPoolPath(tournamentId)`,
  `TournamentPlayerPoolScreen`. Task 12 links to this route from the detail screen.

- [ ] **Step 1: Add the route constant**

In `lib/config/routes/app_routes.dart`, add after `tournamentLeaderboardsPath`:
```dart

  /// Registered with a GetX path parameter, same shape as
  /// [tournamentLeaderboards]. Never navigate with this constant directly —
  /// use [tournamentPoolPath]. No binding of its own, same reasoning as
  /// standings/leaderboards: reuses the tag-registered
  /// `TournamentDetailController`.
  static const String tournamentPool =
      '/tournament/:tournamentId/pool';

  static String tournamentPoolPath(String tournamentId) =>
      '/tournament/$tournamentId/pool';
```

- [ ] **Step 2: Register the page**

In `lib/config/routes/app_pages.dart`, add the import alongside the existing
`tournament_leaderboards_screen.dart`/`tournament_standings_screen.dart` imports:
```dart
import 'package:cricket_scorer/features/tournament/presentation/pages/tournament_player_pool_screen.dart';
```
Then add, after the `tournamentLeaderboards` `GetPage`:
```dart
    GetPage(
      name: AppRoutes.tournamentPool,
      page: () => const TournamentPlayerPoolScreen(),
    ),
```

- [ ] **Step 3: Write the failing widget test**

Create `test/features/tournament/presentation/pages/tournament_player_pool_screen_test.dart`. Follow
`tournament_standings_screen_test.dart`'s exact setup pattern (`GetMaterialApp` + `GetPage` +
`Get.parameters`, fakes pre-registered via `Get.put<UseCaseType>()` before navigation, since
`TournamentDetailController` reads `Get.parameters` in its own construction path via the binding — this
screen needs the real GetX routing machinery, not a bare `pumpWidget`, per the client CLAUDE.md's
three-controller-test-patterns note):
```dart
import 'package:cricket_scorer/config/routes/app_pages.dart';
import 'package:cricket_scorer/config/routes/app_routes.dart';
import 'package:cricket_scorer/core/network/models/cricket_response.dart';
import 'package:cricket_scorer/core/utils/either_util.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/pool_entry_res.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/get_pool.dart';
import 'package:cricket_scorer/features/tournament/presentation/pages/tournament_player_pool_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get/get.dart';

// ... (fakes for every usecase TournamentDetailController's binding resolves
// via Get.find, following exactly the pattern already established in
// tournament_standings_screen_test.dart / tournament_leaderboards_screen_test.dart
// for this same controller — read one of those two files in full before
// writing this fake list, since they are the ground truth for exactly which
// usecases must be stubbed and how, not this plan.)

void main() {
  testWidgets('shows the registered pool entries', (tester) async {
    // Arrange: register every TournamentDetailController usecase fake via
    // Get.put<UseCaseType>(), matching the sibling screen tests' setup,
    // with the pool-specific fake below returning a populated list.
    final fakeGetPool = _FakeGetPoolUseCase();
    fakeGetPool.response = Either.result(
      CricketResponse(
        data: [
          PoolEntryRes(
            playerId: 'p1', playerName: 'Rohit Sharma', role: 'batsman',
            basePrice: 5000, registeredAt: '2026-09-07T10:00:00.000Z',
          ),
        ],
        message: 'ok',
      ),
    );
    Get.put<GetPoolUseCase>(fakeGetPool);

    await tester.pumpWidget(
      GetMaterialApp(
        initialRoute: AppRoutes.tournamentPoolPath('tournament-1'),
        getPages: AppPages.pages,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Rohit Sharma'), findsOneWidget);
    expect(find.textContaining('5000'), findsOneWidget);
  });
}

class _FakeGetPoolUseCase implements GetPoolUseCase {
  Either<CricketResponse<List<PoolEntryRes>>, dynamic>? response;

  @override
  Future<Either<CricketResponse<List<PoolEntryRes>>, dynamic>> call({
    GetPoolParams? params,
  }) async => response!;

  @override
  dynamic get tournamentRepository => throw UnimplementedError();
}
```
*(This is a skeleton — the implementer must fill in every other required fake by reading
`tournament_standings_screen_test.dart` in full first, exactly as this step's comment says. Do not
guess at the other fakes' shapes.)*

- [ ] **Step 4: Run test to verify it fails**

Run: `flutter test test/features/tournament/presentation/pages/tournament_player_pool_screen_test.dart`
Expected: FAIL — `tournament_player_pool_screen.dart` doesn't exist yet.

- [ ] **Step 5: Create the screen**

`lib/features/tournament/presentation/pages/tournament_player_pool_screen.dart`:
```dart
import 'package:cricket_scorer/core/extensions/space_extension.dart';
import 'package:cricket_scorer/core/extensions/theme_x.dart';
import 'package:cricket_scorer/core/global/widgets/cricket_button.dart';
import 'package:cricket_scorer/core/global/widgets/cricket_text.dart';
import 'package:cricket_scorer/core/global/widgets/custom_app_bar.dart';
import 'package:cricket_scorer/core/translations/translation_keys.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/pool_entry_res.dart';
import 'package:cricket_scorer/features/tournament/presentation/controllers/tournament_detail_controller.dart';
import 'package:cricket_scorer/features/tournament/presentation/widget/pool_player_sheet.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

/// A tournament's auction pool — reached from `TournamentDetailScreen`'s
/// "Player pool" action. Reuses that screen's own tag-registered
/// `TournamentDetailController`, same pattern as standings/leaderboards:
/// one more piece of tournament data, fetched lazily via `loadPool()` only
/// when this screen actually opens.
class TournamentPlayerPoolScreen extends StatefulWidget {
  const TournamentPlayerPoolScreen({super.key});

  @override
  State<TournamentPlayerPoolScreen> createState() =>
      _TournamentPlayerPoolScreenState();
}

class _TournamentPlayerPoolScreenState
    extends State<TournamentPlayerPoolScreen> {
  late final String _tournamentId = Get.parameters['tournamentId']?.trim() ?? '';
  late final TournamentDetailController controller =
      Get.find<TournamentDetailController>(tag: _tournamentId);

  @override
  void initState() {
    super.initState();
    controller.loadPool();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: CustomAppBar(
        title: TranslationKeys.playerPool.tr,
        actions: [
          Obx(() {
            if (!controller.isOwner) return const SizedBox.shrink();
            return IconButton(
              icon: const Icon(Icons.person_add_alt_outlined),
              onPressed: () => showPoolPlayerSheet(controller: controller),
            );
          }),
        ],
      ),
      body: SafeArea(
        child: Obx(() {
          final loading = controller.poolLoading.value;
          final error = controller.poolError.value;
          final entries = controller.poolEntries;

          if (loading && entries.isEmpty) {
            return const Center(child: CircularProgressIndicator());
          }
          if (error != null && entries.isEmpty) {
            return Center(
              child: Padding(
                padding: 24.p,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.error_outline,
                      size: 56,
                      color: context.colorScheme.onSurfaceVariant,
                    ),
                    16.h,
                    CricketText(text: error, textAlign: TextAlign.center),
                    24.h,
                    CricketButton(
                      buttonText: TranslationKeys.retry.tr,
                      onPressed: controller.loadPool,
                      width: 160,
                    ),
                  ],
                ),
              ),
            );
          }
          if (entries.isEmpty) {
            return Center(
              child: CricketText(
                text: TranslationKeys.noPlayersInPoolYet.tr,
                style: context.textTheme.bodyMedium?.copyWith(
                  color: context.colorScheme.onSurfaceVariant,
                ),
              ),
            );
          }

          return RefreshIndicator(
            onRefresh: controller.loadPool,
            child: ListView.separated(
              padding: 16.p,
              itemCount: entries.length,
              separatorBuilder: (_, __) => 8.h,
              itemBuilder: (context, index) =>
                  _PoolEntryTile(entry: entries[index], controller: controller),
            ),
          );
        }),
      ),
    );
  }
}

class _PoolEntryTile extends StatelessWidget {
  const _PoolEntryTile({required this.entry, required this.controller});

  final PoolEntryRes entry;
  final TournamentDetailController controller;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: 12.p,
      decoration: BoxDecoration(
        color: context.colors.chipBackground,
        borderRadius: 12.radius,
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                CricketText(
                  text: entry.playerName,
                  style: context.textTheme.bodyMedium?.copyWith(
                    color: context.colorScheme.onSurface,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                4.h,
                CricketText(
                  text: entry.role,
                  style: context.textTheme.bodySmall?.copyWith(
                    color: context.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          CricketText(
            text: '${entry.basePrice}',
            style: context.textTheme.bodyMedium?.copyWith(
              fontWeight: FontWeight.w600,
              color: context.colorScheme.primary,
            ),
          ),
          Obx(() {
            if (!controller.isOwner) return const SizedBox.shrink();
            return Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                IconButton(
                  icon: const Icon(Icons.edit_outlined, size: 20),
                  onPressed: () => showPoolPlayerSheet(
                    controller: controller,
                    existingEntry: entry,
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close, size: 20),
                  onPressed: () => controller.removePoolEntry(entry.playerId),
                ),
              ],
            );
          }),
        ],
      ),
    );
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `flutter test test/features/tournament/presentation/pages/tournament_player_pool_screen_test.dart`
Expected: PASS. (This step will fail to compile until Task 12 creates `pool_player_sheet.dart` — if
executing tasks strictly in order, stub `showPoolPlayerSheet` as a no-op function returning
`Future<void>` in a placeholder file first, then let Task 12 replace it with the real implementation; do
not leave the stub in place after Task 12 completes.)

- [ ] **Step 7: Commit**

```bash
git add lib/config/routes/app_routes.dart lib/config/routes/app_pages.dart lib/features/tournament/presentation/pages/tournament_player_pool_screen.dart test/features/tournament/presentation/pages/tournament_player_pool_screen_test.dart
git commit -m "$(cat <<'EOF'
feat: add TournamentPlayerPoolScreen and its route

Lists a tournament's pool; owner-only add/edit/remove actions.
Reuses the tag-registered TournamentDetailController, same pattern
as standings/leaderboards.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Flutter — add/edit sheet, detail-screen entry point, translations

**Files:**
- Create: `lib/features/tournament/presentation/widget/pool_player_sheet.dart`
- Modify: `lib/features/tournament/presentation/pages/tournament_detail_screen.dart`
- Modify: `lib/core/translations/translation_keys.dart`
- Modify: `lib/core/translations/en.dart`, `hi.dart`, `mr.dart`
- Modify: `test/features/tournament/presentation/widget/` (create a widget test for the sheet)

**Interfaces:**
- Consumes: `TournamentDetailController.registerPoolPlayer`/`updatePoolEntry` (Task 10).
- Produces: `showPoolPlayerSheet({controller, existingEntry})`, wired from both the pool screen
  (Task 11, already calling it) and a new entry point on the tournament detail screen.

- [ ] **Step 1: Add translation keys**

In `lib/core/translations/translation_keys.dart`, add near the existing `leaderboards`/`noLeaderboardsYet`
keys:
```dart
  static const String playerPool = 'player_pool';
  static const String noPlayersInPoolYet = 'no_players_in_pool_yet';
  static const String registerPlayer = 'register_player';
  static const String editBasePrice = 'edit_base_price';
  static const String playerName = 'player_name';
  static const String basePrice = 'base_price';
  static const String playerRegisteredInPool = 'player_registered_in_pool';
  static const String poolEntryUpdated = 'pool_entry_updated';
  static const String invalidBasePrice = 'invalid_base_price';
```

In `lib/core/translations/en.dart` (find the map literal, add alongside the other tournament-section
entries):
```dart
    TranslationKeys.playerPool: 'Player pool',
    TranslationKeys.noPlayersInPoolYet: 'No players registered yet',
    TranslationKeys.registerPlayer: 'Register player',
    TranslationKeys.editBasePrice: 'Edit base price',
    TranslationKeys.playerName: 'Player name',
    TranslationKeys.basePrice: 'Base price',
    TranslationKeys.playerRegisteredInPool: 'Player registered in pool',
    TranslationKeys.poolEntryUpdated: 'Pool entry updated',
    TranslationKeys.invalidBasePrice: 'Enter a whole number between 1 and 100000000',
```
In `lib/core/translations/hi.dart`:
```dart
    TranslationKeys.playerPool: 'खिलाड़ी पूल',
    TranslationKeys.noPlayersInPoolYet: 'अभी तक कोई खिलाड़ी पंजीकृत नहीं है',
    TranslationKeys.registerPlayer: 'खिलाड़ी पंजीकृत करें',
    TranslationKeys.editBasePrice: 'बेस प्राइस संपादित करें',
    TranslationKeys.playerName: 'खिलाड़ी का नाम',
    TranslationKeys.basePrice: 'बेस प्राइस',
    TranslationKeys.playerRegisteredInPool: 'खिलाड़ी पूल में पंजीकृत किया गया',
    TranslationKeys.poolEntryUpdated: 'पूल एंट्री अपडेट की गई',
    TranslationKeys.invalidBasePrice: '1 और 100000000 के बीच एक पूर्ण संख्या दर्ज करें',
```
In `lib/core/translations/mr.dart`:
```dart
    TranslationKeys.playerPool: 'खेळाडू पूल',
    TranslationKeys.noPlayersInPoolYet: 'अद्याप कोणताही खेळाडू नोंदणीकृत नाही',
    TranslationKeys.registerPlayer: 'खेळाडू नोंदणी करा',
    TranslationKeys.editBasePrice: 'बेस प्राइस संपादित करा',
    TranslationKeys.playerName: 'खेळाडूचे नाव',
    TranslationKeys.basePrice: 'बेस प्राइस',
    TranslationKeys.playerRegisteredInPool: 'खेळाडू पूलमध्ये नोंदणीकृत केला',
    TranslationKeys.invalidBasePrice: '1 ते 100000000 दरम्यान पूर्ण संख्या टाका',
    TranslationKeys.poolEntryUpdated: 'पूल एंट्री अपडेट केली',
```

*(Match the exact map-literal syntax already used in each file — read a few lines around the
`leaderboards`/`standings` entries first, since some of these files may key by the raw string constant
rather than `TranslationKeys.xxx`; follow whichever this project's files actually do.)*

- [ ] **Step 2: Write the failing widget test**

Create `test/features/tournament/presentation/widget/pool_player_sheet_test.dart`, mirroring
`edit_tournament_sheet.dart`'s own test if one exists (check first — if not, mirror
`next_bowler_bottom_sheet_test.dart`'s bare-`GetMaterialApp` + `ElevatedButton`-that-opens-the-sheet
pattern instead, since this sheet doesn't need a real routed `TournamentDetailController`, only a
callback). Given `showPoolPlayerSheet` takes a real `TournamentDetailController` (not a callback like
`NextBowlerBottomSheet` does), construct a minimal real controller with fake usecases in the test,
following whichever pattern `tournament_detail_controller_test.dart` (Task 10) already established for
constructing one outside full GetX routing:
```dart
testWidgets('registering a new player submits name and base price', (tester) async {
  // Arrange a TournamentDetailController with every usecase faked (reuse the
  // same fakes Task 10's controller test defines — import that test file's
  // fakes if they're already suitably named/exported, or duplicate the
  // minimal subset this sheet's code path actually calls:
  // registerPoolPlayerUseCase and getPoolUseCase).
  // ... construct `controller` here ...

  await tester.pumpWidget(
    GetMaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => ElevatedButton(
            onPressed: () => showPoolPlayerSheet(controller: controller),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();

  await tester.enterText(find.byType(TextFormField).first, 'Rohit Sharma');
  await tester.enterText(find.byType(TextFormField).last, '5000');
  await tester.tap(find.byType(CricketButton));
  await tester.pumpAndSettle();

  // Assert on the fake usecase's captured call, same style
  // score_ball_controller_test.dart uses for lastSelectBowlerReq.
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `flutter test test/features/tournament/presentation/widget/pool_player_sheet_test.dart`
Expected: FAIL — `pool_player_sheet.dart` doesn't exist.

- [ ] **Step 4: Create the sheet**

`lib/features/tournament/presentation/widget/pool_player_sheet.dart`:
```dart
import 'package:cricket_scorer/core/extensions/space_extension.dart';
import 'package:cricket_scorer/core/global/widgets/bootom_sheets/custom_bottomsheet.dart';
import 'package:cricket_scorer/core/global/widgets/cricket_button.dart';
import 'package:cricket_scorer/core/global/widgets/cricket_text.dart';
import 'package:cricket_scorer/core/global/widgets/cricket_text_field.dart';
import 'package:cricket_scorer/core/global/widgets/snackbars/cricket_snackbar.dart';
import 'package:cricket_scorer/core/translations/translation_keys.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/pool_entry_res.dart';
import 'package:cricket_scorer/features/tournament/presentation/controllers/tournament_detail_controller.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

/// One sheet handles both register (no [existingEntry]) and edit-price
/// (with one): registering needs a name; editing only ever touches
/// `basePrice` on an already-identified player, so the name renders
/// read-only instead of as a second editable field for the same person.
Future<void> showPoolPlayerSheet({
  required TournamentDetailController controller,
  PoolEntryRes? existingEntry,
}) async {
  final nameController = TextEditingController(text: existingEntry?.playerName ?? '');
  final priceController = TextEditingController(
    text: existingEntry != null ? '${existingEntry.basePrice}' : '',
  );
  final formKey = GlobalKey<FormState>();

  final saved = await CustomBottomSheet.wrapBottomSheet<bool>(
    headlineText: existingEntry == null
        ? TranslationKeys.registerPlayer.tr
        : TranslationKeys.editBasePrice.tr,
    child: Form(
      key: formKey,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (existingEntry == null)
              CricketTextField(
                controller: nameController,
                hintText: TranslationKeys.playerName.tr,
                labelText: TranslationKeys.playerName.tr,
                textCapitalization: TextCapitalization.words,
                maxLength: 50,
                isRequired: true,
              )
            else
              CricketText(
                text: existingEntry.playerName,
                style: Theme.of(Get.context!).textTheme.bodyLarge,
              ),
            16.h,
            CricketTextField(
              controller: priceController,
              hintText: TranslationKeys.basePrice.tr,
              labelText: TranslationKeys.basePrice.tr,
              prefixIcon: const Icon(Icons.currency_rupee),
              keyboardType: TextInputType.number,
              isRequired: true,
              validator: (value) {
                final parsed = int.tryParse((value ?? '').trim());
                if (parsed == null || parsed < 1 || parsed > 100000000) {
                  return TranslationKeys.invalidBasePrice.tr;
                }
                return null;
              },
            ),
            20.h,
            CricketButton(
              buttonText: TranslationKeys.save.tr,
              onPressed: () async {
                if (!formKey.currentState!.validate()) return;
                final basePrice = int.parse(priceController.text.trim());

                final success = existingEntry == null
                    ? await controller.registerPoolPlayer(
                        playerName: nameController.text.trim(),
                        basePrice: basePrice,
                      )
                    : await controller.updatePoolEntry(
                        playerId: existingEntry.playerId,
                        basePrice: basePrice,
                      );

                if (success) {
                  Get.back<bool>(result: true);
                } else {
                  CricketSnackbar.showErrorMessage(
                    TranslationKeys.somethingWentWrong.tr,
                  );
                }
              },
            ),
          ],
        ),
      ),
    ),
  );

  if (saved == true) {
    CricketSnackbar.showSuccessMessage(
      existingEntry == null
          ? TranslationKeys.playerRegisteredInPool.tr
          : TranslationKeys.poolEntryUpdated.tr,
    );
  }
}
```
`TranslationKeys.somethingWentWrong` and `.save` already exist — see `edit_tournament_sheet.dart`'s own
usage of both above. `invalidBasePrice` is added fresh in Step 1.

- [ ] **Step 5: Add the detail-screen entry point**

In `lib/features/tournament/presentation/pages/tournament_detail_screen.dart`, add the import, then add
a third `TextButton` alongside the existing Standings/Leaderboards row (both org-owner-only and
everyone-visible variants exist elsewhere in this file — Player pool is visible to any org member, same
as Leaderboards, so add it unconditionally within that same `Row`):
```dart
                        TextButton(
                          onPressed: () => Get.toNamed<dynamic>(
                            AppRoutes.tournamentPoolPath(_tournamentId),
                          ),
                          child: CricketText(text: TranslationKeys.playerPool.tr),
                        ),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `flutter test test/features/tournament/presentation/widget/pool_player_sheet_test.dart`
Expected: PASS

Also re-run Task 11's screen test now that the real sheet exists (replacing any placeholder stub from
Task 11 Step 6):
Run: `flutter test test/features/tournament/presentation/pages/tournament_player_pool_screen_test.dart`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add lib/features/tournament/presentation/widget/pool_player_sheet.dart lib/features/tournament/presentation/pages/tournament_detail_screen.dart lib/core/translations/translation_keys.dart lib/core/translations/en.dart lib/core/translations/hi.dart lib/core/translations/mr.dart test/features/tournament/presentation/widget/pool_player_sheet_test.dart
git commit -m "$(cat <<'EOF'
feat: add pool_player_sheet and wire Player pool into tournament detail

One sheet handles both registering a new player (name + base price)
and editing an existing entry's base price (price only, name shown
read-only). Reachable from the tournament detail screen's action row,
same as Standings/Leaderboards.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Upload the new translation keys to the CMS**

Per the workspace CLAUDE.md — a `TranslationKeys` entry plus the local en/hi/mr maps is not enough; the
CMS map replaces the local one wholesale on next sync, so a missing CMS record renders as the raw key.
Bulk-upload the eight keys added in Step 1 via `POST /api/v1/translations/bulk-update` (`verifyAdmin`),
body: `[{key, translations:{en,hi,mr}}, …]` for each of `player_pool`, `no_players_in_pool_yet`,
`register_player`, `edit_base_price`, `player_name`, `base_price`, `player_registered_in_pool`,
`pool_entry_updated`, using the exact string values from Step 1. Confirm with a `GET
/api/v1/translations/all` call afterward that all eight keys are present.

---

## Task 13: Finishing — full verification, both repos

**Files:** none (verification only)

- [ ] **Step 1: Backend full suite**

```bash
cd cricket-scorer-backend
npm test
```
Expected: no new failures versus the pre-existing baseline established in Task 6 Step 7.

- [ ] **Step 2: Backend lint/format, if configured**

Check `package.json` for a lint script; run it if one exists. (As of this plan's writing, this backend
has no such script — skip if still true.)

- [ ] **Step 3: Frontend full suite**

```bash
cd cricket-scrorer
flutter analyze
flutter test
```
Expected: `flutter analyze` clean; `flutter test` all passing, no regressions in unrelated suites.

- [ ] **Step 4: Live verification against the dev server**

```bash
curl -s -m 3 http://localhost:9000/api/v1/tournament/000000000000000000000000/pool -H "Authorization: Bearer bad" -o /dev/null -w "%{http_code}\n"
```
Expected: `401`. Do not start/stop the dev server yourself.

- [ ] **Step 5: Manual check in a running app (if a simulator/emulator is already available)**

Never boot a simulator or device yourself — use one already running, or ask. If one is available:
create an organization, a tournament, open its detail screen, tap "Player pool," register a player with
a base price, confirm it appears with the price shown, edit the price, confirm the update, remove the
entry, confirm the list returns to empty. Confirm no career-stats figure appears anywhere on this
screen or in the add/edit sheet — that absence is itself part of what this feature is supposed to prove.

- [ ] **Step 6: Use the `finishing-a-development-branch` skill in both repos**

Per this plan's own required workflow — present the merge/PR/keep-as-is menu for
`feat-player-pool-registration` in both `cricket-scorer-backend` and `cricket-scrorer`, and act on
whichever the user chooses. Do not merge or push without that explicit choice.
