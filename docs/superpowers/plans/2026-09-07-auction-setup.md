# Auction Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in this session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tournament's organizer configure an auction before it runs: tournament-wide squad-composition rules (min/max squad size, optional per-role caps) and, per enrolled team, which organization member owns it and what budget they start with. No live-auction mechanics — setup only.

**Architecture:** Two new collections, `AuctionSettings` (one per tournament) and `AuctionTeamOwner` (one per `{tournament, team}`, unique also on `{tournament, owner}`). One combined endpoint, `PATCH /v1/tournament/:tournamentId/auction-setup`, applies each of `minSquadSize`/`maxSquadSize`/`categoryCaps`/`owners` only if present in the request (mirroring `updateTournament`'s per-field convention), wrapped in one transaction since a request touching `owners` replaces a whole document set atomically. `GET` reads the combined state back. Access control reuses `findOwnedTournament`/`findAccessibleTournament` verbatim behind two thin, clearly-named seams (`canConfigureAuction`/`canViewAuctionSetup`) where Phase 6's paid-tier check will attach once it exists.

**Tech Stack:** Node/Express 5/Mongoose (backend), Flutter/GetX (frontend), Jest/Supertest (backend tests), `flutter test` (frontend tests).

**Spec:** [docs/superpowers/specs/2026-09-07-auction-setup-design.md](../specs/2026-09-07-auction-setup-design.md)

## Global Constraints

- No code path from `CareerStats`/`PlayerMatchStats` to `budget`, `minSquadSize`, `maxSquadSize`, or `categoryCaps` — organizer-entered numbers only, same rule as `PlayerPoolEntry.basePrice`.
- No real-currency type, payment-provider reference, or redemption/payout field anywhere in either new model. `budget` is a play-money integer, `1`–`100000000`.
- Access control: `PATCH` → `findOwnedTournament` (org owner only). `GET` → `findAccessibleTournament` (any org member). No paid-tier field added speculatively — the two named seams are placeholders for Phase 6, not stubs with fake data.
- An owner must be an existing member of the tournament's own `Organization` (`isOrgMember`) — never an arbitrary registered user, never a name-only record.
- One owner per team, one team per owner, within a tournament — enforced by two compound unique indexes on `AuctionTeamOwner`, not application logic alone.
- `owners`, when present in the request, fully replaces the current owner set (empty array clears all); absent, existing owners are untouched. `minSquadSize`/`maxSquadSize`/`categoryCaps` follow `updateTournament`'s exact `!== undefined`-per-field convention — no explicit-null-clear.
- The `owners`-replacement write (and any settings write happening alongside it) is wrapped in one Mongoose transaction.
- New backend locale keys ship in all three of `src/locales/{en,hi,mr}/common.json` — `tests/locales.test.js` enforces parity.
- Client `TranslationKeys` additions need their local `en`/`hi`/`mr` Dart maps **and** a CMS bulk-update via `POST /api/v1/translations/bulk-update`, or the app renders the raw key once translations next sync.
- Endpoint paths start at `/v1/...`, never `/api/v1/...`, on the Flutter side.
- `docs/roadmap.md`'s Phase 4 row gets refreshed once this slice lands (it currently has no per-feature status breakdown the way Phase 1–3 do — see Task 14).

---

## Task 1: Contract — update docs/api.md

**Files:**
- Modify: `docs/api.md` (workspace root — not version-controlled by either repo)

- [ ] **Step 1: Insert a new `## Auction setup` section, right after the Player pool section's "Still out of scope" list and before the `---` separator to `## GET /v1/search`**

Find the end of the `## Player pool` section (search for `- Any client-side (\`cricket-scrorer\`) model, endpoint, or UI — built in the same change as the backend,` followed by its closing sentence, then `---` then `## GET /v1/search`) and insert:

````markdown
## Auction setup

Phase 4's pre-event config surface: which organization member owns each enrolled team's bidding for a
tournament's auction, what budget they start with, and what squad shape the auction enforces once
something exists to enforce it against. No live-auction mechanics exist yet — see "Still out of scope"
below.

**Owner identity, stated plainly:** an owner must be an existing member of the tournament's own
`Organization`, resolved via `isOrgMember` — the identical rule and identical reasoning delegated
scoring already established for its own assignee pool. An owner is not a name-only record the way
`Player` is: the (future) live auction room needs them to actually authenticate to bid, which is exactly
what `Player` never needs and exactly why `Player` has no `User` link. Assignment is direct, the same
shape as `PATCH /v1/match/:matchId/scorer` — this app has no invite/accept infrastructure anywhere, and
this pass doesn't invent one.

**Budget, like base price, is a plain organizer-entered number.** Nothing here reads `CareerStats` or
`PlayerMatchStats`, in any form. See `docs/superpowers/specs/2026-09-07-auction-setup-design.md` in
`cricket-scorer-backend` (§3.7) for why that holds regardless of which side of the auction a number
concerns.

### PATCH /v1/tournament/:tournamentId/auction-setup

Owner-only (`findOwnedTournament`). Each field below is applied only if present in the request body —
the same convention `PATCH /v1/tournament/:tournamentId` already uses. `owners`, when present, **fully
replaces** the current owner list (an empty array clears every owner); omitted, existing owners are
untouched. Wrapped in one transaction: a request naming `owners` replaces a whole document set, and a
partial application (three of five owners inserted, then a validation failure) would leave the auction
in a worse state than either the old or new one.

#### Request
```json
{
  "minSquadSize": 15,
  "maxSquadSize": 20,
  "categoryCaps": { "wicketkeeper": 3, "allrounder": 5 },
  "owners": [
    { "teamId": "665f1a2b3c4d5e6f7a8b9c10", "userId": "665f1a2b3c4d5e6f7a8b9c50", "budget": 100000 },
    { "teamId": "665f1a2b3c4d5e6f7a8b9c11", "userId": "665f1a2b3c4d5e6f7a8b9c51", "budget": 100000 }
  ]
}
```
All four top-level fields are optional and independent — send only what you're changing. `categoryCaps`
keys must be one of `batsman`/`bowler`/`allrounder`/`wicketkeeper` (not `unknown` — nothing meaningful to
cap there). Each `owners` entry's `teamId` must already be enrolled in this tournament, and `userId` must
be a member of the tournament's organization; the same team or user cannot appear twice in one request.

#### Response `200`
```json
{
  "statusCode": 200,
  "data": {
    "tournamentId": "665f1a2b3c4d5e6f7a8b9c01",
    "minSquadSize": 15,
    "maxSquadSize": 20,
    "categoryCaps": { "wicketkeeper": 3, "allrounder": 5 },
    "owners": [
      {
        "teamId": "665f1a2b3c4d5e6f7a8b9c10", "teamName": "Riverside U19",
        "userId": "665f1a2b3c4d5e6f7a8b9c50", "userName": "Asha Rao",
        "budget": 100000
      }
    ]
  },
  "message": "Auction setup saved",
  "success": true
}
```
`minSquadSize`/`maxSquadSize`/`categoryCaps` are `null` until ever set, individually — setting one does
not require setting the others.

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `NOT_ORG_MEMBER` | caller isn't a member of the owning organization at all |
| 403 | `TOURNAMENT_NOT_OWNED` | caller is a member but not the owning organization's owner |
| 400 | `INVALID_SQUAD_SIZE` | `minSquadSize`/`maxSquadSize` not a whole number in `1`–`100`, or the effective min exceeds the effective max after this update |
| 400 | `INVALID_CATEGORY_CAP` | `categoryCaps` isn't a plain object, has a key outside the four capped roles, or a value outside `1`–`100` |
| 400 | `INVALID_OWNERS_LIST` | `owners` present but not an array |
| 400 | `AUCTION_SETUP_TEAM_NOT_IN_TOURNAMENT` | an owners entry's `teamId` isn't enrolled in this tournament |
| 400 | `AUCTION_SETUP_DUPLICATE_TEAM` | the same `teamId` appears twice in one request |
| 400 | `AUCTION_SETUP_INVALID_OWNER` | a `userId` is malformed or isn't a member of the tournament's organization |
| 400 | `AUCTION_SETUP_DUPLICATE_OWNER` | the same `userId` appears twice in one request |
| 400 | `BUDGET_REQUIRED` | an owners entry's `budget` is missing |
| 400 | `INVALID_BUDGET` | not a whole number in `1`–`100000000` |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

### GET /v1/tournament/:tournamentId/auction-setup

Any org member (`findAccessibleTournament`). Same response shape as `PATCH` above. Before anything is
ever set: `minSquadSize`/`maxSquadSize`/`categoryCaps` are `null` and `owners` is `[]` — not an error.

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `NOT_ORG_MEMBER` | caller isn't a member of the owning organization |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

### Still out of scope

- All live-auction/bid-room mechanics — current-player-on-the-block, live bid ticker, countdown,
  sold/unsold resolution, server-authoritative bid acceptance, budget being spent or decremented.
- Enforcing squad rules or category caps against anything — this pass stores configuration only.
- A completeness/readiness gate ("every enrolled team has an owner") — no such event exists yet.
- Clearing `minSquadSize`/`maxSquadSize`/`categoryCaps` back to unset once set — a real, minor gap;
  replacing requires a new value, not an explicit clear, in this pass.
- Owner-side discovery — a `User` seeing "you own team X's auction" anywhere.
- Post-auction squad view, SOLD cards.
- Paid-Organization access-control enforcement — blocked on Phase 6 defining what "paid" means on an
  `Organization` document.
- Any change to `Player`, `Team`, `Tournament`, `Organization`, or `PlayerPoolEntry`'s existing schemas or
  endpoints.

---
````

- [ ] **Step 2: Add to `## Schema state`**

Append, after the player-pool contract's entry:
```markdown
**Applied by the auction-setup contract:**
- New collection `auctionSettings.model.js`: `tournament` (ref `Tournament`, required, unique),
  `minSquadSize`/`maxSquadSize` (`Number`, optional, `1`–`100`), `categoryCaps` (`Mixed`, optional plain
  object keyed by a capped `Player` role), `createdBy` (ref `User`, required).
- New collection `auctionTeamOwner.model.js`: `tournament` (ref `Tournament`, required), `team` (ref
  `Team`, required), `owner` (ref `User`, required), `budget` (`Number`, required, `1`–`100000000`),
  `createdBy` (ref `User`, required). Unique `{tournament, team}` and `{tournament, owner}`.
- No changes to `Player`, `Team`, `Tournament`, `Organization`, or `PlayerPoolEntry`'s own schemas.

New collections, no prior writer — nothing to migrate.
```

- [ ] **Step 3: Commit**

```bash
cd cricket-scorer-workspace
git status
```
The workspace root isn't a git repo — `docs/api.md` has no commit of its own. Move on to Task 2.

---

## Task 2: `AuctionSettings` model

**Files:**
- Create: `src/models/auctionSettings.model.js`
- Test: `tests/auctionSettings.model.test.js` (create)

**Interfaces:**
- Produces: `AuctionSettings`, `CATEGORY_CAP_ROLES` (both named exports). Tasks 4/6 import both.

- [ ] **Step 1: Write the failing test**

```js
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { AuctionSettings, CATEGORY_CAP_ROLES } from '../src/models/auctionSettings.model.js';
import { PLAYER_ROLES } from '../src/models/player.model.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Organization } from '../src/models/organization.model.js';
import { User } from '../src/models/user.model.js';

describe('AuctionSettings', () => {
  beforeAll(async () => {
    await connectTestDb();
    await AuctionSettings.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const seedTournament = async () => {
    const owner = await User.create({ email: 'owner@example.com', password: 'password123', fullName: 'Owner' });
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }],
    });
    return Tournament.create({
      name: 'Summer T20', nameLower: 'summer t20', organization: org._id, format: 'league', createdBy: owner._id,
    });
  };

  it('CATEGORY_CAP_ROLES excludes unknown, includes every other player role', () => {
    expect(CATEGORY_CAP_ROLES).not.toContain('unknown');
    expect(CATEGORY_CAP_ROLES.sort()).toEqual(PLAYER_ROLES.filter((r) => r !== 'unknown').sort());
  });

  it('creates with the given fields', async () => {
    const tournament = await seedTournament();
    const owner = await User.findOne({ email: 'owner@example.com' });

    const settings = await AuctionSettings.create({
      tournament: tournament._id, minSquadSize: 15, maxSquadSize: 20,
      categoryCaps: { wicketkeeper: 3 }, createdBy: owner._id,
    });

    expect(settings.minSquadSize).toBe(15);
    expect(settings.categoryCaps).toEqual({ wicketkeeper: 3 });
  });

  it('rejects a second document for the same tournament', async () => {
    const tournament = await seedTournament();
    const owner = await User.findOne({ email: 'owner@example.com' });
    await AuctionSettings.create({ tournament: tournament._id, createdBy: owner._id });

    await expect(
      AuctionSettings.create({ tournament: tournament._id, createdBy: owner._id })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/auctionSettings.model.test.js -v`
Expected: FAIL — `Cannot find module '../src/models/auctionSettings.model.js'`.

- [ ] **Step 3: Create the model**

```js
import mongoose, { Schema } from "mongoose";
import { PLAYER_ROLES } from "./player.model.js";

// Category caps only apply to a real playing role — 'unknown' is excluded,
// nothing meaningful to cap when the role itself is undetermined.
export const CATEGORY_CAP_ROLES = PLAYER_ROLES.filter((role) => role !== 'unknown');

const auctionSettingsSchema = new Schema(
  {
    tournament:   { type: Schema.Types.ObjectId, ref: 'Tournament', required: true, unique: true },
    minSquadSize: { type: Number, min: 1, max: 100 },
    maxSquadSize: { type: Number, min: 1, max: 100 },
    // Plain object keyed by a CATEGORY_CAP_ROLES member -> max count for
    // that role, e.g. {"wicketkeeper": 3}. Not a Mongoose Map: small,
    // fixed-key-space, always read/written whole rather than queried
    // per-key.
    categoryCaps: { type: Schema.Types.Mixed },
    createdBy:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

export const AuctionSettings = mongoose.model('AuctionSettings', auctionSettingsSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/auctionSettings.model.test.js -v`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
cd cricket-scorer-backend
git add src/models/auctionSettings.model.js tests/auctionSettings.model.test.js
git commit -m "$(cat <<'EOF'
feat: add AuctionSettings model

Tournament-wide auction squad rules: one document per tournament,
optional min/max squad size and per-role category caps reusing
Player's existing role enum.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `AuctionTeamOwner` model

**Files:**
- Create: `src/models/auctionTeamOwner.model.js`
- Test: `tests/auctionTeamOwner.model.test.js` (create)

**Interfaces:**
- Produces: `AuctionTeamOwner` (named export). Tasks 5/6 import it.

- [ ] **Step 1: Write the failing test**

```js
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { AuctionTeamOwner } from '../src/models/auctionTeamOwner.model.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Organization } from '../src/models/organization.model.js';
import { Team } from '../src/models/team.model.js';
import { User } from '../src/models/user.model.js';

describe('AuctionTeamOwner', () => {
  beforeAll(async () => {
    await connectTestDb();
    await AuctionTeamOwner.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const seed = async () => {
    const owner = await User.create({ email: 'owner@example.com', password: 'password123', fullName: 'Owner' });
    const member = await User.create({ email: 'member@example.com', password: 'password123', fullName: 'Member' });
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }, { user: member._id, role: 'member' }],
    });
    const tournament = await Tournament.create({
      name: 'Summer T20', nameLower: 'summer t20', organization: org._id, format: 'league', createdBy: owner._id,
    });
    const teamA = await Team.create({ name: 'Team A', createdBy: owner._id, organization: org._id });
    const teamB = await Team.create({ name: 'Team B', createdBy: owner._id, organization: org._id });
    return { owner, member, org, tournament, teamA, teamB };
  };

  it('creates with the given fields', async () => {
    const { tournament, teamA, member, owner } = await seed();

    const doc = await AuctionTeamOwner.create({
      tournament: tournament._id, team: teamA._id, owner: member._id, budget: 100000, createdBy: owner._id,
    });

    expect(doc.budget).toBe(100000);
  });

  it('rejects a second owner for the same team in the same tournament', async () => {
    const { tournament, teamA, member, owner } = await seed();
    await AuctionTeamOwner.create({
      tournament: tournament._id, team: teamA._id, owner: member._id, budget: 100000, createdBy: owner._id,
    });

    await expect(
      AuctionTeamOwner.create({
        tournament: tournament._id, team: teamA._id, owner: owner._id, budget: 50000, createdBy: owner._id,
      })
    ).rejects.toThrow();
  });

  it('rejects the same owner assigned to a second team in the same tournament', async () => {
    const { tournament, teamA, teamB, member, owner } = await seed();
    await AuctionTeamOwner.create({
      tournament: tournament._id, team: teamA._id, owner: member._id, budget: 100000, createdBy: owner._id,
    });

    await expect(
      AuctionTeamOwner.create({
        tournament: tournament._id, team: teamB._id, owner: member._id, budget: 100000, createdBy: owner._id,
      })
    ).rejects.toThrow();
  });

  it('allows the same team/owner pairing across two different tournaments', async () => {
    const { tournament, teamA, member, owner, org } = await seed();
    const tournament2 = await Tournament.create({
      name: 'Winter T20', nameLower: 'winter t20', organization: org._id, format: 'knockout', createdBy: owner._id,
    });
    await AuctionTeamOwner.create({
      tournament: tournament._id, team: teamA._id, owner: member._id, budget: 100000, createdBy: owner._id,
    });

    const second = await AuctionTeamOwner.create({
      tournament: tournament2._id, team: teamA._id, owner: member._id, budget: 75000, createdBy: owner._id,
    });

    expect(second.budget).toBe(75000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/auctionTeamOwner.model.test.js -v`
Expected: FAIL — `Cannot find module '../src/models/auctionTeamOwner.model.js'`.

- [ ] **Step 3: Create the model**

```js
import mongoose, { Schema } from "mongoose";

const auctionTeamOwnerSchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true },
    team:       { type: Schema.Types.ObjectId, ref: 'Team', required: true },
    owner:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Play-money only, per docs/roadmap.md's settled decision — a plain
    // organizer-entered integer, never derived from career stats. Same
    // reasoning as PlayerPoolEntry.basePrice.
    budget:     { type: Number, required: true, min: 1, max: 100000000 },
    createdBy:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// One owner per team...
auctionTeamOwnerSchema.index({ tournament: 1, team: 1 }, { unique: true });
// ...and one team per owner, within a tournament.
auctionTeamOwnerSchema.index({ tournament: 1, owner: 1 }, { unique: true });

export const AuctionTeamOwner = mongoose.model('AuctionTeamOwner', auctionTeamOwnerSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/auctionTeamOwner.model.test.js -v`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add src/models/auctionTeamOwner.model.js tests/auctionTeamOwner.model.test.js
git commit -m "$(cat <<'EOF'
feat: add AuctionTeamOwner model

One owner (an existing org member) plus a play-money budget per
enrolled team, per tournament. Unique on {tournament, team} and
{tournament, owner} — one owner per team, one team per owner.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `PATCH /v1/tournament/:tournamentId/auction-setup` — squad rules only

Builds the endpoint's settings-only path first (no `owners` handling yet — Task 5 adds that), so the
cross-field validation and transaction plumbing are provable in isolation before the more complex owners
path is layered on.

**Files:**
- Create: `src/controllers/auctionSetup.controller.js`
- Modify: `src/routes/tournament.routes.js`
- Modify: `src/locales/{en,hi,mr}/common.json`
- Test: `tests/auctionSetup.test.js` (create)

**Interfaces:**
- Consumes: `findOwnedTournament` (existing, exported from `tournament.controller.js`), `AuctionSettings`,
  `CATEGORY_CAP_ROLES` (Task 2).
- Produces: `setAuctionSetup`, `formatAuctionSetup` (both exported — Task 6 reuses `formatAuctionSetup`),
  mounted as `PATCH /v1/tournament/:tournamentId/auction-setup`.

- [ ] **Step 1: Write the failing tests**

Create `tests/auctionSetup.test.js`:
```js
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';
import { AuctionSettings } from '../src/models/auctionSettings.model.js';
import { AuctionTeamOwner } from '../src/models/auctionTeamOwner.model.js';

let app;

beforeAll(async () => {
  await connectTestDb();
  await Tournament.init();
  await AuctionSettings.init();
  await AuctionTeamOwner.init();
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

const createOrgTeam = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

const addTeamToTournament = (token, tournamentId, teamId) =>
  request(app).post(`/api/v1/tournament/${tournamentId}/teams`).set('Authorization', `Bearer ${token}`).send({ teamId });

const patchSetup = (token, tournamentId, body) =>
  request(app).patch(`/api/v1/tournament/${tournamentId}/auction-setup`).set('Authorization', `Bearer ${token}`).send(body);

// org owner + a plain member + a tournament with two enrolled teams —
// every test in this file builds on this same shape.
const setupOwnedTournament = async () => {
  const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
  const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
  const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
  const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
  const orgId = orgRes.body.data.id;
  await addMember(ownerToken, orgId, { email: 'member@example.com' });
  const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'league' });
  const tournamentId = tournamentRes.body.data.id;
  const teamARes = await createOrgTeam(ownerToken, orgId, { name: 'Team A' });
  const teamBRes = await createOrgTeam(ownerToken, orgId, { name: 'Team B' });
  await addTeamToTournament(ownerToken, tournamentId, teamARes.body.data.id);
  await addTeamToTournament(ownerToken, tournamentId, teamBRes.body.data.id);
  return {
    ownerToken, owner, memberToken, member, strangerToken, orgId, tournamentId,
    teamAId: teamARes.body.data.id, teamBId: teamBRes.body.data.id,
  };
};

describe('PATCH /:tournamentId/auction-setup — squad rules', () => {
  it('lets the org owner set minSquadSize and maxSquadSize', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { minSquadSize: 15, maxSquadSize: 20 });

    expect(res.status).toBe(200);
    expect(res.body.data.minSquadSize).toBe(15);
    expect(res.body.data.maxSquadSize).toBe(20);
    const settings = await AuctionSettings.findOne({ tournament: tournamentId });
    expect(settings.minSquadSize).toBe(15);
  });

  it('sets categoryCaps independently of squad size', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { categoryCaps: { wicketkeeper: 3 } });

    expect(res.status).toBe(200);
    expect(res.body.data.categoryCaps).toEqual({ wicketkeeper: 3 });
    expect(res.body.data.minSquadSize).toBeNull();
  });

  it('rejects minSquadSize greater than maxSquadSize in the same request', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { minSquadSize: 20, maxSquadSize: 15 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SQUAD_SIZE');
  });

  it('rejects lowering maxSquadSize below an already-stored minSquadSize', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, { minSquadSize: 20 });

    const res = await patchSetup(ownerToken, tournamentId, { maxSquadSize: 15 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SQUAD_SIZE');
  });

  it.each([0, -5, 1.5, 101])('rejects an out-of-range minSquadSize of %p', async (minSquadSize) => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { minSquadSize });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SQUAD_SIZE');
  });

  it('rejects a categoryCaps key outside the four capped roles', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { categoryCaps: { unknown: 2 } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CATEGORY_CAP');
  });

  it('rejects a categoryCaps value that is not a positive whole number', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { categoryCaps: { bowler: 0 } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CATEGORY_CAP');
  });

  it('rejects a plain org member (not owner)', async () => {
    const { memberToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(memberToken, tournamentId, { minSquadSize: 15 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it('rejects a stranger with no relationship to the organization', async () => {
    const { strangerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(strangerToken, tournamentId, { minSquadSize: 15 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('rejects with TOURNAMENT_NOT_FOUND for an unknown tournamentId', async () => {
    const { token } = await createTestUser();

    const res = await patchSetup(token, '000000000000000000000000', { minSquadSize: 15 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/auctionSetup.test.js -v`
Expected: FAIL — `PATCH /api/v1/tournament/:tournamentId/auction-setup` 404s (route doesn't exist yet).

- [ ] **Step 3: Add locale keys**

`src/locales/en/common.json`:
```json
  "INVALID_SQUAD_SIZE": "Squad size must be a whole number between 1 and 100, and the minimum cannot exceed the maximum",
  "INVALID_CATEGORY_CAP": "Category caps must be whole numbers between 1 and 100, keyed by a real player role",
  "AUCTION_SETUP_SAVED": "Auction setup saved",
```
`src/locales/hi/common.json`:
```json
  "INVALID_SQUAD_SIZE": "स्क्वाड साइज़ 1 और 100 के बीच एक पूर्ण संख्या होनी चाहिए, और न्यूनतम अधिकतम से ज़्यादा नहीं हो सकता",
  "INVALID_CATEGORY_CAP": "श्रेणी सीमाएँ 1 और 100 के बीच पूर्ण संख्या होनी चाहिए, एक वास्तविक खिलाड़ी भूमिका के अनुसार",
  "AUCTION_SETUP_SAVED": "नीलामी सेटअप सहेजा गया",
```
`src/locales/mr/common.json`:
```json
  "INVALID_SQUAD_SIZE": "स्क्वाड साइज 1 ते 100 दरम्यान पूर्ण संख्या असावी, आणि किमान कमाल पेक्षा जास्त असू शकत नाही",
  "INVALID_CATEGORY_CAP": "श्रेणी मर्यादा 1 ते 100 दरम्यान पूर्ण संख्या असावी, वास्तविक खेळाडू भूमिकेनुसार",
  "AUCTION_SETUP_SAVED": "लिलाव सेटअप जतन केले",
```

- [ ] **Step 4: Create `auctionSetup.controller.js`**

```js
import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { AuctionSettings, CATEGORY_CAP_ROLES } from '../models/auctionSettings.model.js';
import { AuctionTeamOwner } from '../models/auctionTeamOwner.model.js';
import { findOwnedTournament, findAccessibleTournament } from './tournament.controller.js';

// The paid-tier half of the roadmap's settled auction-access-control
// decision — "does this auction's tournament belong to a paid
// Organization" — cannot be checked yet: Organization carries no
// tier/subscription field at all (Phase 6 is unbuilt). These seams are
// where that check attaches once it exists; today they are identical to
// findOwnedTournament/findAccessibleTournament. Not stubbed with a
// speculative field — see the design spec's §5.
const canConfigureAuction = (tournamentId, userId) => findOwnedTournament(tournamentId, userId);
const canViewAuctionSetup = (tournamentId, userId) => findAccessibleTournament(tournamentId, userId);

const validateSquadSizeField = (value) => {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new ApiError(400, "INVALID_SQUAD_SIZE");
    }
};

const validateCategoryCaps = (categoryCaps) => {
    if (categoryCaps === null || typeof categoryCaps !== 'object' || Array.isArray(categoryCaps)) {
        throw new ApiError(400, "INVALID_CATEGORY_CAP");
    }
    for (const [role, cap] of Object.entries(categoryCaps)) {
        if (!CATEGORY_CAP_ROLES.includes(role)) {
            throw new ApiError(400, "INVALID_CATEGORY_CAP");
        }
        if (!Number.isInteger(cap) || cap < 1 || cap > 100) {
            throw new ApiError(400, "INVALID_CATEGORY_CAP");
        }
    }
};

// Shared response shape for PATCH/GET — see Task 6 for the owners half.
const formatAuctionSetup = async (tournamentId) => {
    const [settings, owners] = await Promise.all([
        AuctionSettings.findOne({ tournament: tournamentId }),
        AuctionTeamOwner.find({ tournament: tournamentId })
            .populate('team', 'name shortName')
            .populate('owner', 'fullName'),
    ]);

    return {
        tournamentId,
        minSquadSize: settings?.minSquadSize ?? null,
        maxSquadSize: settings?.maxSquadSize ?? null,
        categoryCaps: settings?.categoryCaps ?? null,
        owners: owners.map((o) => ({
            teamId: o.team._id, teamName: o.team.name,
            userId: o.owner._id, userName: o.owner.fullName,
            budget: o.budget,
        })),
    };
};

const setAuctionSetup = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await canConfigureAuction(tournamentId, req.user._id);

    const settingsUpdate = {};
    if (req.body.minSquadSize !== undefined) {
        validateSquadSizeField(req.body.minSquadSize);
        settingsUpdate.minSquadSize = req.body.minSquadSize;
    }
    if (req.body.maxSquadSize !== undefined) {
        validateSquadSizeField(req.body.maxSquadSize);
        settingsUpdate.maxSquadSize = req.body.maxSquadSize;
    }
    // The cross-check must hold against the *effective* pair after this
    // update applies, not just the two fields present in this request —
    // otherwise a request that only lowers maxSquadSize (leaving an
    // already-stored, now-larger minSquadSize untouched) would sail
    // through and leave min > max stored.
    if (settingsUpdate.minSquadSize !== undefined || settingsUpdate.maxSquadSize !== undefined) {
        const existing = await AuctionSettings.findOne({ tournament: tournament._id });
        const effectiveMin = settingsUpdate.minSquadSize !== undefined
            ? settingsUpdate.minSquadSize : existing?.minSquadSize;
        const effectiveMax = settingsUpdate.maxSquadSize !== undefined
            ? settingsUpdate.maxSquadSize : existing?.maxSquadSize;
        if (effectiveMin != null && effectiveMax != null && effectiveMin > effectiveMax) {
            throw new ApiError(400, "INVALID_SQUAD_SIZE");
        }
    }
    if (req.body.categoryCaps !== undefined) {
        validateCategoryCaps(req.body.categoryCaps);
        settingsUpdate.categoryCaps = req.body.categoryCaps;
    }

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            if (Object.keys(settingsUpdate).length > 0) {
                settingsUpdate.createdBy = req.user._id;
                await AuctionSettings.findOneAndUpdate(
                    { tournament: tournament._id },
                    { $set: settingsUpdate },
                    { upsert: true, session }
                );
            }
        });
    } finally {
        await session.endSession();
    }

    return res.status(200).json(
        new ApiResponse(200, await formatAuctionSetup(tournament._id), req.t("AUCTION_SETUP_SAVED"))
    );
});

export { setAuctionSetup, formatAuctionSetup, canConfigureAuction, canViewAuctionSetup, validateSquadSizeField, validateCategoryCaps };
```

- [ ] **Step 5: Add the route**

In `src/routes/tournament.routes.js`, add an import and the route. Widen the top imports:
```js
import { setAuctionSetup } from "../controllers/auctionSetup.controller.js";
```
Add, after the `pool/:playerId` routes:
```js
router.route('/:tournamentId/auction-setup').patch(verifyJwt, setAuctionSetup);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/auctionSetup.test.js -v`
Expected: PASS (all tests in the file)

- [ ] **Step 7: Run the locale parity test**

Run: `npx jest tests/locales.test.js -v`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/controllers/auctionSetup.controller.js src/routes/tournament.routes.js src/locales tests/auctionSetup.test.js
git commit -m "$(cat <<'EOF'
feat: add PATCH /v1/tournament/:tournamentId/auction-setup (squad rules)

Owner-only. minSquadSize/maxSquadSize/categoryCaps each applied only
if present, mirroring updateTournament's per-field convention. The
min<=max check compares against the *effective* pair (existing value
when one side isn't being changed this call), not just the two
fields present in the request.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Extend the endpoint with the `owners` array and the transaction

**Files:**
- Modify: `src/controllers/auctionSetup.controller.js` (add `validateOwners`, extend `setAuctionSetup`)
- Modify: `src/locales/{en,hi,mr}/common.json`
- Modify: `tests/auctionSetup.test.js` (append a `describe` block)

**Interfaces:**
- Consumes: `Organization` model, `isOrgMember` (existing, from `organizationAccess.js`).
- Produces: widened `setAuctionSetup` handling `owners`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/auctionSetup.test.js`:
```js
describe('PATCH /:tournamentId/auction-setup — owners', () => {
  it('assigns owners and budgets to enrolled teams', async () => {
    const { ownerToken, member, tournamentId, teamAId, teamBId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.owners).toHaveLength(1);
    expect(res.body.data.owners[0]).toMatchObject({
      teamId: teamAId, userId: String(member._id), budget: 100000,
    });
    const stored = await AuctionTeamOwner.findOne({ tournament: tournamentId });
    expect(stored.budget).toBe(100000);
  });

  it('setting owners does not touch previously-set squad rules', async () => {
    const { ownerToken, member, tournamentId, teamAId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, { minSquadSize: 15 });

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    expect(res.body.data.minSquadSize).toBe(15);
  });

  it('setting squad rules does not touch previously-set owners', async () => {
    const { ownerToken, member, tournamentId, teamAId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    const res = await patchSetup(ownerToken, tournamentId, { minSquadSize: 15 });

    expect(res.body.data.owners).toHaveLength(1);
  });

  it('an empty owners array clears every existing owner', async () => {
    const { ownerToken, member, tournamentId, teamAId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    const res = await patchSetup(ownerToken, tournamentId, { owners: [] });

    expect(res.status).toBe(200);
    expect(res.body.data.owners).toEqual([]);
    const count = await AuctionTeamOwner.countDocuments({ tournament: tournamentId });
    expect(count).toBe(0);
  });

  it('resubmitting the owners array replaces the previous set entirely', async () => {
    const { ownerToken, member, owner, tournamentId, teamAId, teamBId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamBId, userId: String(owner._id), budget: 50000 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.owners).toHaveLength(1);
    expect(res.body.data.owners[0].teamId).toBe(teamBId);
    const count = await AuctionTeamOwner.countDocuments({ tournament: tournamentId });
    expect(count).toBe(1);
  });

  it('rejects a teamId not enrolled in this tournament', async () => {
    const { ownerToken, member, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: '000000000000000000000000', userId: String(member._id), budget: 100000 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUCTION_SETUP_TEAM_NOT_IN_TOURNAMENT');
  });

  it('rejects the same team appearing twice in one request', async () => {
    const { ownerToken, member, owner, tournamentId, teamAId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [
        { teamId: teamAId, userId: String(member._id), budget: 100000 },
        { teamId: teamAId, userId: String(owner._id), budget: 50000 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUCTION_SETUP_DUPLICATE_TEAM');
  });

  it('rejects the same owner appearing twice in one request', async () => {
    const { ownerToken, member, tournamentId, teamAId, teamBId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [
        { teamId: teamAId, userId: String(member._id), budget: 100000 },
        { teamId: teamBId, userId: String(member._id), budget: 50000 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUCTION_SETUP_DUPLICATE_OWNER');
  });

  it('rejects a userId who is not a member of the organization', async () => {
    const { ownerToken, tournamentId, teamAId } = await setupOwnedTournament();
    const { user: outsider } = await createTestUser({ email: 'outsider@example.com' });

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(outsider._id), budget: 100000 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUCTION_SETUP_INVALID_OWNER');
  });

  it('rejects a missing budget', async () => {
    const { ownerToken, member, tournamentId, teamAId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id) }],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BUDGET_REQUIRED');
  });

  it.each([0, -100, 1.5, 100000001])('rejects an invalid budget of %p', async (budget) => {
    const { ownerToken, member, tournamentId, teamAId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget }],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BUDGET');
  });

  it('rejects owners that is present but not an array', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { owners: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_OWNERS_LIST');
  });

  it('rolls back the whole request when one owners entry is invalid — no partial application', async () => {
    const { ownerToken, member, owner, tournamentId, teamAId, teamBId } = await setupOwnedTournament();
    const { user: outsider } = await createTestUser({ email: 'outsider2@example.com' });

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [
        { teamId: teamAId, userId: String(member._id), budget: 100000 },
        { teamId: teamBId, userId: String(outsider._id), budget: 50000 },
      ],
    });

    expect(res.status).toBe(400);
    const count = await AuctionTeamOwner.countDocuments({ tournament: tournamentId });
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/auctionSetup.test.js -v`
Expected: FAIL — every new test in this describe block fails, since `owners` is not yet read by the
handler (requests silently succeed with `owners` ignored, or fail assertions expecting it to be applied).

- [ ] **Step 3: Add locale keys**

`src/locales/en/common.json`:
```json
  "INVALID_OWNERS_LIST": "owners must be an array",
  "AUCTION_SETUP_TEAM_NOT_IN_TOURNAMENT": "That team isn't enrolled in this tournament",
  "AUCTION_SETUP_DUPLICATE_TEAM": "The same team was listed more than once",
  "AUCTION_SETUP_INVALID_OWNER": "That user isn't a member of this tournament's organization",
  "AUCTION_SETUP_DUPLICATE_OWNER": "The same owner was listed more than once",
  "BUDGET_REQUIRED": "A budget is required",
  "INVALID_BUDGET": "Budget must be a whole number between 1 and 100000000",
```
`src/locales/hi/common.json`:
```json
  "INVALID_OWNERS_LIST": "owners एक ऐरे होना चाहिए",
  "AUCTION_SETUP_TEAM_NOT_IN_TOURNAMENT": "वह टीम इस टूर्नामेंट में शामिल नहीं है",
  "AUCTION_SETUP_DUPLICATE_TEAM": "एक ही टीम एक से अधिक बार सूचीबद्ध की गई",
  "AUCTION_SETUP_INVALID_OWNER": "वह उपयोगकर्ता इस टूर्नामेंट के संगठन का सदस्य नहीं है",
  "AUCTION_SETUP_DUPLICATE_OWNER": "एक ही मालिक एक से अधिक बार सूचीबद्ध किया गया",
  "BUDGET_REQUIRED": "बजट आवश्यक है",
  "INVALID_BUDGET": "बजट 1 और 100000000 के बीच एक पूर्ण संख्या होनी चाहिए",
```
`src/locales/mr/common.json`:
```json
  "INVALID_OWNERS_LIST": "owners एक अ‍ॅरे असावा",
  "AUCTION_SETUP_TEAM_NOT_IN_TOURNAMENT": "तो संघ या स्पर्धेत नोंदणीकृत नाही",
  "AUCTION_SETUP_DUPLICATE_TEAM": "एकच संघ एकापेक्षा जास्त वेळा सूचीबद्ध केला",
  "AUCTION_SETUP_INVALID_OWNER": "तो वापरकर्ता या स्पर्धेच्या संस्थेचा सदस्य नाही",
  "AUCTION_SETUP_DUPLICATE_OWNER": "एकच मालक एकापेक्षा जास्त वेळा सूचीबद्ध केला",
  "BUDGET_REQUIRED": "बजेट आवश्यक आहे",
  "INVALID_BUDGET": "बजेट 1 ते 100000000 दरम्यान पूर्ण संख्या असावी",
```

- [ ] **Step 4: Add `validateOwners` and widen `setAuctionSetup`**

In `src/controllers/auctionSetup.controller.js`, add the imports:
```js
import { Organization } from '../models/organization.model.js';
import { isOrgMember } from '../utils/organizationAccess.js';
```
Add, after `validateCategoryCaps`:
```js
const asString = (value) => (typeof value === 'string' ? value : '');

const validateBudgetField = (budget) => {
    if (budget === undefined || budget === null) {
        throw new ApiError(400, "BUDGET_REQUIRED");
    }
    if (!Number.isInteger(budget) || budget < 1 || budget > 100000000) {
        throw new ApiError(400, "INVALID_BUDGET");
    }
};

// team must already be enrolled; owner must be a member of the tournament's
// own organization; no team or owner repeated within the same request —
// this is what turns a duplicate into a specific 400 instead of a generic
// 500 from a caught E11000 at the storage layer.
const validateOwners = async (owners, tournament) => {
    if (!Array.isArray(owners)) {
        throw new ApiError(400, "INVALID_OWNERS_LIST");
    }

    const enrolledTeamIds = new Set(tournament.teams.map((t) => String(t.team)));
    const seenTeams = new Set();
    const seenOwnerIds = new Set();
    const resolved = [];

    for (const entry of owners) {
        const teamId = asString(entry?.teamId).trim();
        const userId = asString(entry?.userId).trim();

        if (!mongoose.Types.ObjectId.isValid(teamId) || !enrolledTeamIds.has(teamId)) {
            throw new ApiError(400, "AUCTION_SETUP_TEAM_NOT_IN_TOURNAMENT");
        }
        if (seenTeams.has(teamId)) {
            throw new ApiError(400, "AUCTION_SETUP_DUPLICATE_TEAM");
        }
        seenTeams.add(teamId);

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            throw new ApiError(400, "AUCTION_SETUP_INVALID_OWNER");
        }
        if (seenOwnerIds.has(userId)) {
            throw new ApiError(400, "AUCTION_SETUP_DUPLICATE_OWNER");
        }
        seenOwnerIds.add(userId);

        validateBudgetField(entry?.budget);
        resolved.push({ teamId, userId, budget: entry.budget });
    }

    if (resolved.length > 0) {
        const org = await Organization.findOne({ _id: tournament.organization, isDeleted: false });
        for (const { userId } of resolved) {
            if (!isOrgMember(org, userId)) {
                throw new ApiError(400, "AUCTION_SETUP_INVALID_OWNER");
            }
        }
    }

    return resolved;
};
```
Widen `setAuctionSetup` — insert this block right after the `categoryCaps` handling and before the
`session.startSession()` line:
```js
    const ownersProvided = req.body.owners !== undefined;
    const resolvedOwners = ownersProvided
        ? await validateOwners(req.body.owners, tournament)
        : null;
```
Then widen the transaction body:
```js
        await session.withTransaction(async () => {
            if (Object.keys(settingsUpdate).length > 0) {
                settingsUpdate.createdBy = req.user._id;
                await AuctionSettings.findOneAndUpdate(
                    { tournament: tournament._id },
                    { $set: settingsUpdate },
                    { upsert: true, session }
                );
            }
            if (ownersProvided) {
                await AuctionTeamOwner.deleteMany({ tournament: tournament._id }, { session });
                if (resolvedOwners.length > 0) {
                    await AuctionTeamOwner.insertMany(
                        resolvedOwners.map((o) => ({
                            tournament: tournament._id, team: o.teamId, owner: o.userId,
                            budget: o.budget, createdBy: req.user._id,
                        })),
                        { session }
                    );
                }
            }
        });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/auctionSetup.test.js -v`
Expected: PASS (all tests in the file, both describe blocks)

- [ ] **Step 6: Commit**

```bash
git add src/controllers/auctionSetup.controller.js src/locales tests/auctionSetup.test.js
git commit -m "$(cat <<'EOF'
feat: extend auction-setup with owners array and transaction

owners, when present, fully replaces the current owner set inside
the same transaction as any settings write. Validates team
enrollment, org membership, and per-request duplicates before
touching the database; a mid-list validation failure leaves owners
unchanged, proven directly by a rollback-specific test.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `GET /v1/tournament/:tournamentId/auction-setup`

**Files:**
- Modify: `src/controllers/auctionSetup.controller.js` (add `getAuctionSetup`)
- Modify: `src/routes/tournament.routes.js`
- Modify: `src/locales/{en,hi,mr}/common.json`
- Modify: `tests/auctionSetup.test.js` (append a `describe` block)

**Interfaces:**
- Consumes: `canViewAuctionSetup`, `formatAuctionSetup` (Task 4, same file).
- Produces: `getAuctionSetup`, mounted as `GET /v1/tournament/:tournamentId/auction-setup`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/auctionSetup.test.js`:
```js
const getSetup = (token, tournamentId) =>
  request(app).get(`/api/v1/tournament/${tournamentId}/auction-setup`).set('Authorization', `Bearer ${token}`);

describe('GET /:tournamentId/auction-setup', () => {
  it('returns null squad-rule fields and an empty owners array before anything is set', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await getSetup(ownerToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.minSquadSize).toBeNull();
    expect(res.body.data.maxSquadSize).toBeNull();
    expect(res.body.data.categoryCaps).toBeNull();
    expect(res.body.data.owners).toEqual([]);
  });

  it('any org member can read the current setup, with names resolved', async () => {
    const { ownerToken, memberToken, member, tournamentId, teamAId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, {
      minSquadSize: 15,
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    const res = await getSetup(memberToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.minSquadSize).toBe(15);
    expect(res.body.data.owners[0]).toMatchObject({ teamId: teamAId, budget: 100000 });
    expect(res.body.data.owners[0].userName).toBeTruthy();
    expect(res.body.data.owners[0].teamName).toBe('Team A');
  });

  it('rejects a non-member of the organization', async () => {
    const { strangerToken, tournamentId } = await setupOwnedTournament();

    const res = await getSetup(strangerToken, tournamentId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('rejects with TOURNAMENT_NOT_FOUND for an unknown tournamentId', async () => {
    const { token } = await createTestUser();

    const res = await getSetup(token, '000000000000000000000000');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/auctionSetup.test.js -v`
Expected: FAIL — `GET /api/v1/tournament/:tournamentId/auction-setup` 404s.

- [ ] **Step 3: Add the locale key**

`src/locales/en/common.json`: `"AUCTION_SETUP_FETCHED": "Auction setup fetched",`
`src/locales/hi/common.json`: `"AUCTION_SETUP_FETCHED": "नीलामी सेटअप प्राप्त हुआ",`
`src/locales/mr/common.json`: `"AUCTION_SETUP_FETCHED": "लिलाव सेटअप मिळाले",`

- [ ] **Step 4: Add the handler**

In `src/controllers/auctionSetup.controller.js`, add:
```js
const getAuctionSetup = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await canViewAuctionSetup(tournamentId, req.user._id);

    return res.status(200).json(
        new ApiResponse(200, await formatAuctionSetup(tournament._id), req.t("AUCTION_SETUP_FETCHED"))
    );
});
```
Add `getAuctionSetup` to the file's `export { ... }` line.

- [ ] **Step 5: Add the route**

In `src/routes/tournament.routes.js`, widen the import and route:
```js
import { setAuctionSetup, getAuctionSetup } from "../controllers/auctionSetup.controller.js";
```
```js
router.route('/:tournamentId/auction-setup')
    .patch(verifyJwt, setAuctionSetup)
    .get(verifyJwt, getAuctionSetup);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/auctionSetup.test.js -v`
Expected: PASS (all tests in the file — this is now the full backend test suite for this feature)

- [ ] **Step 7: Run the full backend suite**

Run: `npm test`
Expected: no new *deterministic* failures versus the pre-existing baseline. This backend's DB-heavy
suites are known-flaky under full-parallel-worker load (documented in this project's own history) — if
anything in this feature's own files fails only under full-suite load, re-run `npx jest
tests/auctionSetup.test.js tests/auctionSettings.model.test.js tests/auctionTeamOwner.model.test.js`
in isolation to confirm it's clean there, and re-run the full suite once more to confirm the failing set
isn't stable (same method used to clear the bowler-roster and player-pool features earlier this project).

- [ ] **Step 8: Commit**

```bash
git add src/controllers/auctionSetup.controller.js src/routes/tournament.routes.js src/locales tests/auctionSetup.test.js
git commit -m "$(cat <<'EOF'
feat: add GET /v1/tournament/:tournamentId/auction-setup

Any org member. Same shape as the PATCH response; null/empty before
anything is ever set, not an error.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Verify live against the dev server**

```bash
curl -s -m 3 http://localhost:9000/api/v1/tournament/000000000000000000000000/auction-setup -H "Authorization: Bearer bad" -o /dev/null -w "%{http_code}\n"
```
Expected: `401`. Do not start/stop the dev server yourself; if it isn't already running, ask.

---

## Task 7: Flutter — data layer (endpoint, models, api service)

**Files:**
- Modify: `lib/features/tournament/data/tournament_endpoint.dart`
- Create: `lib/features/tournament/data/models/request/update_auction_setup_req.dart` (hand-written, no
  `build_runner` — see Step 2)
- Create: `lib/features/tournament/data/models/response/auction_setup_res.dart` (+ `.g.dart`)
- Modify: `lib/features/tournament/data/data_sources/remote/tournament_api_service.dart`

**Interfaces:**
- Produces: `TournamentEndpoint.auctionSetup(tournamentId)`, `UpdateAuctionSetupReq`,
  `AuctionOwnerInput`, `AuctionSetupRes`, `AuctionOwnerRes`, and two new `TournamentApiService` methods
  (`setAuctionSetup`, `getAuctionSetup`). Task 8 consumes all of these.

- [ ] **Step 1: Add the endpoint constant**

In `lib/features/tournament/data/tournament_endpoint.dart`, add after `poolEntry`:
```dart
  String auctionSetup(String tournamentId) =>
      '/v1/tournament/$tournamentId/auction-setup';
```

- [ ] **Step 2: Create the request model — hand-written, mirroring `UpdateTournamentReq`**

`lib/features/tournament/data/models/request/update_auction_setup_req.dart`:
```dart
/// `PATCH /v1/tournament/:tournamentId/auction-setup` — every field is
/// independently optional. Deliberately **not** `@JsonSerializable`, same
/// reasoning as `UpdateTournamentReq`: `toJson()` omits an absent field
/// entirely rather than serializing it as `null`, because the backend
/// distinguishes "not sent" (leave unchanged) from a value — see the design
/// spec's §3.4, which also notes there is no explicit-clear path for any of
/// these fields in this pass, so `null` is never a meaningful value to send.
class UpdateAuctionSetupReq {
  final int? minSquadSize;
  final int? maxSquadSize;
  final Map<String, int>? categoryCaps;
  final List<AuctionOwnerInput>? owners;

  UpdateAuctionSetupReq({
    this.minSquadSize,
    this.maxSquadSize,
    this.categoryCaps,
    this.owners,
  });

  Map<String, dynamic> toJson() {
    final json = <String, dynamic>{};
    if (minSquadSize != null) json['minSquadSize'] = minSquadSize;
    if (maxSquadSize != null) json['maxSquadSize'] = maxSquadSize;
    if (categoryCaps != null) json['categoryCaps'] = categoryCaps;
    if (owners != null) {
      json['owners'] = owners!.map((o) => o.toJson()).toList();
    }
    return json;
  }
}

/// One row of the `owners` array — a team, the org member owning it, and
/// their budget. Play-money only; see the design spec's §3.7.
class AuctionOwnerInput {
  final String teamId;
  final String userId;
  final int budget;

  AuctionOwnerInput({
    required this.teamId,
    required this.userId,
    required this.budget,
  });

  Map<String, dynamic> toJson() => {
    'teamId': teamId,
    'userId': userId,
    'budget': budget,
  };
}
```
No `part`/`.g.dart` for this file — it is request-only (never deserialized) and hand-written end to end,
so it needs no `build_runner` step at all.

- [ ] **Step 3: Create the response model**

`lib/features/tournament/data/models/response/auction_setup_res.dart`:
```dart
import 'package:json_annotation/json_annotation.dart';

part 'auction_setup_res.g.dart';

/// A tournament's current auction setup — squad rules plus the resolved
/// owner list. `minSquadSize`/`maxSquadSize`/`categoryCaps` are `null`
/// until ever set, independently of each other and of `owners`.
@JsonSerializable(explicitToJson: true)
class AuctionSetupRes {
  final String tournamentId;
  final int? minSquadSize;
  final int? maxSquadSize;
  final Map<String, int>? categoryCaps;
  final List<AuctionOwnerRes> owners;

  AuctionSetupRes({
    required this.tournamentId,
    this.minSquadSize,
    this.maxSquadSize,
    this.categoryCaps,
    required this.owners,
  });

  factory AuctionSetupRes.fromJson(Map<String, dynamic> json) =>
      _$AuctionSetupResFromJson(json);

  Map<String, dynamic> toJson() => _$AuctionSetupResToJson(this);
}

/// One resolved owner row — team and user names included for display,
/// exactly as `docs/api.md`'s response example shows.
@JsonSerializable()
class AuctionOwnerRes {
  final String teamId;
  final String teamName;
  final String userId;
  final String userName;
  final int budget;

  AuctionOwnerRes({
    required this.teamId,
    required this.teamName,
    required this.userId,
    required this.userName,
    required this.budget,
  });

  factory AuctionOwnerRes.fromJson(Map<String, dynamic> json) =>
      _$AuctionOwnerResFromJson(json);

  Map<String, dynamic> toJson() => _$AuctionOwnerResToJson(this);
}
```

- [ ] **Step 4: Add the two api-service methods**

In `lib/features/tournament/data/data_sources/remote/tournament_api_service.dart`, add the two new
imports alongside the existing `tournament/data/models/*` imports:
```dart
import 'package:cricket_scorer/features/tournament/data/models/request/update_auction_setup_req.dart';
```
Add, after `removePoolEntry`:
```dart
  Future<Either<ApiResponseModel, CricketFailure>> setAuctionSetup({
    required String tournamentId,
    required UpdateAuctionSetupReq params,
  }) async {
    return await apiClient.patch(
      endpoint: tournamentEndpoint.auctionSetup(tournamentId),
      data: params.toJson(),
    );
  }

  Future<Either<ApiResponseModel, CricketFailure>> getAuctionSetup({
    required String tournamentId,
  }) async {
    return await apiClient.get(endpoint: tournamentEndpoint.auctionSetup(tournamentId));
  }
```

- [ ] **Step 5: Generate `auction_setup_res.g.dart`**

Run: `dart run build_runner build --delete-conflicting-outputs`

If this hangs (this project has seen it deadlock against a concurrently-running `flutter run` session's
native-asset build locks under `.dart_tool/` — check `ps aux | grep flutter_tools` first; never kill the
user's own session), hand-write the file instead, mirroring `pool_entry_res.g.dart`'s exact style for the
nullable-`int?`/`Map<String, int>?` fields:
```dart
// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'auction_setup_res.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

AuctionSetupRes _$AuctionSetupResFromJson(Map<String, dynamic> json) =>
    AuctionSetupRes(
      tournamentId: json['tournamentId'] as String,
      minSquadSize: (json['minSquadSize'] as num?)?.toInt(),
      maxSquadSize: (json['maxSquadSize'] as num?)?.toInt(),
      categoryCaps: (json['categoryCaps'] as Map<String, dynamic>?)?.map(
        (k, v) => MapEntry(k, (v as num).toInt()),
      ),
      owners: (json['owners'] as List<dynamic>)
          .map((e) => AuctionOwnerRes.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$AuctionSetupResToJson(AuctionSetupRes instance) =>
    <String, dynamic>{
      'tournamentId': instance.tournamentId,
      'minSquadSize': instance.minSquadSize,
      'maxSquadSize': instance.maxSquadSize,
      'categoryCaps': instance.categoryCaps,
      'owners': instance.owners.map((e) => e.toJson()).toList(),
    };

AuctionOwnerRes _$AuctionOwnerResFromJson(Map<String, dynamic> json) =>
    AuctionOwnerRes(
      teamId: json['teamId'] as String,
      teamName: json['teamName'] as String,
      userId: json['userId'] as String,
      userName: json['userName'] as String,
      budget: (json['budget'] as num).toInt(),
    );

Map<String, dynamic> _$AuctionOwnerResToJson(AuctionOwnerRes instance) =>
    <String, dynamic>{
      'teamId': instance.teamId,
      'teamName': instance.teamName,
      'userId': instance.userId,
      'userName': instance.userName,
      'budget': instance.budget,
    };
```

- [ ] **Step 6: Verify**

Run: `flutter analyze`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
cd cricket-scrorer
git add lib/features/tournament/data/tournament_endpoint.dart lib/features/tournament/data/models/request/update_auction_setup_req.dart lib/features/tournament/data/models/response/auction_setup_res.dart lib/features/tournament/data/models/response/auction_setup_res.g.dart lib/features/tournament/data/data_sources/remote/tournament_api_service.dart
git commit -m "$(cat <<'EOF'
feat: add auction-setup data layer (endpoint, models, api service)

UpdateAuctionSetupReq is hand-written (no build_runner needed) to
match UpdateTournamentReq's own null-omitting toJson pattern —
absent fields are left unchanged server-side, never sent as
explicit null.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Flutter — repository

**Files:**
- Modify: `lib/features/tournament/domain/repositories/tournament_repository.dart`
- Modify: `lib/features/tournament/data/repositories/tournament_repository_impl.dart`

- [ ] **Step 1: Add to the repository interface**

In `lib/features/tournament/domain/repositories/tournament_repository.dart`, add the two new imports
alongside the existing `tournament/data/models/*` imports:
```dart
import 'package:cricket_scorer/features/tournament/data/models/request/update_auction_setup_req.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/auction_setup_res.dart';
```
Add, after `removePoolEntry`:
```dart
  /// `PATCH /v1/tournament/:tournamentId/auction-setup` — owner-only. Each
  /// field applied only if present; `owners` fully replaces the current set
  /// when present. No code path from career stats to any field here.
  Future<Either<CricketResponse<AuctionSetupRes>, CricketFailure>>
  setAuctionSetup({
    required String tournamentId,
    required UpdateAuctionSetupReq params,
  });

  /// `GET /v1/tournament/:tournamentId/auction-setup` — any org member.
  Future<Either<CricketResponse<AuctionSetupRes>, CricketFailure>>
  getAuctionSetup({required String tournamentId});
```

- [ ] **Step 2: Implement in `TournamentRepositoryImpl`**

In `lib/features/tournament/data/repositories/tournament_repository_impl.dart`, add the same two imports,
then add, after `removePoolEntry`:
```dart
  @override
  Future<Either<CricketResponse<AuctionSetupRes>, CricketFailure>>
  setAuctionSetup({
    required String tournamentId,
    required UpdateAuctionSetupReq params,
  }) async {
    final response = await tournamentApiService.setAuctionSetup(
      tournamentId: tournamentId,
      params: params,
    );
    if (response.isResult) {
      return Either.result(
        CricketResponse(
          data: AuctionSetupRes.fromJson(
            response.result.data as Map<String, dynamic>,
          ),
          message: response.result.message,
        ),
      );
    }
    return Either.fallback(response.fallback);
  }

  @override
  Future<Either<CricketResponse<AuctionSetupRes>, CricketFailure>>
  getAuctionSetup({required String tournamentId}) async {
    final response = await tournamentApiService.getAuctionSetup(
      tournamentId: tournamentId,
    );
    if (response.isResult) {
      return Either.result(
        CricketResponse(
          data: AuctionSetupRes.fromJson(
            response.result.data as Map<String, dynamic>,
          ),
          message: response.result.message,
        ),
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
feat: add auction-setup methods to TournamentRepository

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Flutter — usecases + DI

**Files:**
- Create: `lib/features/tournament/domain/usecases/set_auction_setup.dart`
- Create: `lib/features/tournament/domain/usecases/get_auction_setup.dart`
- Modify: `lib/core/di/injection/tournament_injection.dart`

- [ ] **Step 1: Create the two usecases**

`lib/features/tournament/domain/usecases/set_auction_setup.dart`:
```dart
import 'package:cricket_scorer/core/error/cricket_failure.dart';
import 'package:cricket_scorer/core/network/models/cricket_response.dart';
import 'package:cricket_scorer/core/usecase/usecase.dart';
import 'package:cricket_scorer/core/utils/either_util.dart';
import 'package:cricket_scorer/features/tournament/data/models/request/update_auction_setup_req.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/auction_setup_res.dart';
import 'package:cricket_scorer/features/tournament/domain/repositories/tournament_repository.dart';

class SetAuctionSetupParams {
  final String tournamentId;
  final int? minSquadSize;
  final int? maxSquadSize;
  final Map<String, int>? categoryCaps;
  final List<AuctionOwnerInput>? owners;

  SetAuctionSetupParams({
    required this.tournamentId,
    this.minSquadSize,
    this.maxSquadSize,
    this.categoryCaps,
    this.owners,
  });
}

class SetAuctionSetupUseCase
    implements
        UseCase<Either<CricketResponse<AuctionSetupRes>, CricketFailure>,
            SetAuctionSetupParams> {
  final TournamentRepository tournamentRepository;

  SetAuctionSetupUseCase({required this.tournamentRepository});

  @override
  Future<Either<CricketResponse<AuctionSetupRes>, CricketFailure>> call({
    SetAuctionSetupParams? params,
  }) {
    return tournamentRepository.setAuctionSetup(
      tournamentId: params!.tournamentId,
      params: UpdateAuctionSetupReq(
        minSquadSize: params.minSquadSize,
        maxSquadSize: params.maxSquadSize,
        categoryCaps: params.categoryCaps,
        owners: params.owners,
      ),
    );
  }
}
```

`lib/features/tournament/domain/usecases/get_auction_setup.dart`:
```dart
import 'package:cricket_scorer/core/error/cricket_failure.dart';
import 'package:cricket_scorer/core/network/models/cricket_response.dart';
import 'package:cricket_scorer/core/usecase/usecase.dart';
import 'package:cricket_scorer/core/utils/either_util.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/auction_setup_res.dart';
import 'package:cricket_scorer/features/tournament/domain/repositories/tournament_repository.dart';

class GetAuctionSetupParams {
  final String tournamentId;

  GetAuctionSetupParams({required this.tournamentId});
}

class GetAuctionSetupUseCase
    implements
        UseCase<Either<CricketResponse<AuctionSetupRes>, CricketFailure>,
            GetAuctionSetupParams> {
  final TournamentRepository tournamentRepository;

  GetAuctionSetupUseCase({required this.tournamentRepository});

  @override
  Future<Either<CricketResponse<AuctionSetupRes>, CricketFailure>> call({
    GetAuctionSetupParams? params,
  }) {
    return tournamentRepository.getAuctionSetup(tournamentId: params!.tournamentId);
  }
}
```

- [ ] **Step 2: Register both in DI**

In `lib/core/di/injection/tournament_injection.dart`, add the two imports alongside the existing
`tournament/domain/usecases/*` imports:
```dart
import 'package:cricket_scorer/features/tournament/domain/usecases/get_auction_setup.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/set_auction_setup.dart';
```
Add, after `RemovePoolEntryUseCase`'s registration:
```dart
    Get.lazyPut<SetAuctionSetupUseCase>(
      () => SetAuctionSetupUseCase(
        tournamentRepository: Get.find<TournamentRepository>(),
      ),
      fenix: true,
    );

    Get.lazyPut<GetAuctionSetupUseCase>(
      () => GetAuctionSetupUseCase(
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
git add lib/features/tournament/domain/usecases/set_auction_setup.dart lib/features/tournament/domain/usecases/get_auction_setup.dart lib/core/di/injection/tournament_injection.dart
git commit -m "$(cat <<'EOF'
feat: add auction-setup usecases and DI registration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Flutter — controller

**Files:**
- Modify: `lib/features/tournament/presentation/controllers/tournament_detail_controller.dart`
- Modify: `lib/features/tournament/presentation/bindings/tournament_detail_binding.dart`
- Modify: every test file that constructs `TournamentDetailController` directly

*(Same widening-blast-radius situation as the player-pool controller task. Before writing code, run
`grep -rl "TournamentDetailController(" test/ lib/` again — the set may have grown since the player-pool
slice added its own test file, so don't assume it's still the same seven files.)*

**Interfaces:**
- Consumes: Task 9's two usecases.
- Produces: `TournamentDetailController.auctionSetup`/`auctionSetupLoading`/`auctionSetupError`/
  `loadAuctionSetup()`/`updateAuctionSetup(...)`. Task 11's screen consumes these.

- [ ] **Step 1: Write the failing test**

In `test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart`, add fakes
for `SetAuctionSetupUseCase`/`GetAuctionSetupUseCase` mirroring this file's existing
`_FakeRegisterPoolPlayerUseCase`/`_FakeGetPoolUseCase` pattern exactly (settable `response`, capturing
`lastParams`, `noSuchMethod` fallback), wire them into `build()`/`setUp()`, then add:
```dart
AuctionSetupRes auctionSetup({
  int? minSquadSize,
  List<AuctionOwnerRes> owners = const [],
}) => AuctionSetupRes(
  tournamentId: 'tournament-1',
  minSquadSize: minSquadSize,
  maxSquadSize: null,
  categoryCaps: null,
  owners: owners,
);

test('loadAuctionSetup populates auctionSetup on success', () async {
  getAuctionSetupUseCase.response = Either.result(
    CricketResponse(message: 'ok', data: auctionSetup(minSquadSize: 15)),
  );

  await controller.loadAuctionSetup();

  expect(controller.auctionSetup.value?.minSquadSize, 15);
  expect(controller.auctionSetupLoading.value, isFalse);
});

test('loadAuctionSetup sets the backend error message on failure', () async {
  getAuctionSetupUseCase.response = Either.fallback(
    CricketBadRequestFailure(statusCode: 404, message: 'Tournament not found'),
  );

  await controller.loadAuctionSetup();

  expect(controller.auctionSetupError.value, 'Tournament not found');
  expect(controller.auctionSetup.value, isNull);
});

test('updateAuctionSetup sends the given fields and reloads on success', () async {
  setAuctionSetupUseCase.response = Either.result(
    CricketResponse(message: 'ok', data: auctionSetup(minSquadSize: 15)),
  );
  getAuctionSetupUseCase.response = Either.result(
    CricketResponse(message: 'ok', data: auctionSetup(minSquadSize: 15)),
  );

  final result = await controller.updateAuctionSetup(minSquadSize: 15);

  expect(result, isTrue);
  expect(setAuctionSetupUseCase.lastParams?.minSquadSize, 15);
  expect(controller.auctionSetup.value?.minSquadSize, 15);
});

test('updateAuctionSetup returns false on failure without reloading', () async {
  setAuctionSetupUseCase.response = Either.fallback(
    CricketBadRequestFailure(statusCode: 400, message: 'Invalid squad size'),
  );

  final result = await controller.updateAuctionSetup(minSquadSize: 200);

  expect(result, isFalse);
  expect(controller.auctionSetup.value, isNull);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart`
Expected: FAIL — compile error, `auctionSetup`/`loadAuctionSetup`/`updateAuctionSetup` undefined.

- [ ] **Step 3: Widen the controller**

In `lib/features/tournament/presentation/controllers/tournament_detail_controller.dart`, add the imports:
```dart
import 'package:cricket_scorer/features/tournament/data/models/request/update_auction_setup_req.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/auction_setup_res.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/get_auction_setup.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/set_auction_setup.dart';
```
Add two new required constructor fields (`setAuctionSetupUseCase`, `getAuctionSetupUseCase`), then add:
```dart
  // Same lazy-load reasoning as standings/leaderboards/pool above.
  final auctionSetup = Rxn<AuctionSetupRes>();
  final auctionSetupLoading = false.obs;
  final auctionSetupError = Rxn<String>();

  Future<void> loadAuctionSetup() async {
    auctionSetupLoading.value = true;
    auctionSetupError.value = null;

    final response = await getAuctionSetupUseCase(
      params: GetAuctionSetupParams(tournamentId: tournamentId),
    );

    if (!response.isResult) {
      auctionSetupError.value = response.fallback.message;
      auctionSetupLoading.value = false;
      return;
    }

    auctionSetup.value = response.result.data;
    auctionSetupLoading.value = false;
  }

  /// Returns true on success (and reloads), false otherwise — same
  /// boolean-result shape as updateTournament/registerPoolPlayer. The
  /// screen shows its own error on false; this controller never calls
  /// CricketSnackbar directly (see the class doc).
  Future<bool> updateAuctionSetup({
    int? minSquadSize,
    int? maxSquadSize,
    Map<String, int>? categoryCaps,
    List<AuctionOwnerInput>? owners,
  }) async {
    final response = await setAuctionSetupUseCase(
      params: SetAuctionSetupParams(
        tournamentId: tournamentId,
        minSquadSize: minSquadSize,
        maxSquadSize: maxSquadSize,
        categoryCaps: categoryCaps,
        owners: owners,
      ),
    );

    if (!response.isResult) return false;
    await loadAuctionSetup();
    return true;
  }
```

- [ ] **Step 4: Widen the binding**

In `lib/features/tournament/presentation/bindings/tournament_detail_binding.dart`, add the two imports
and constructor arguments (`setAuctionSetupUseCase: Get.find<SetAuctionSetupUseCase>()`,
`getAuctionSetupUseCase: Get.find<GetAuctionSetupUseCase>()`).

- [ ] **Step 5: Fix every other direct construction site**

For each file the Step-0 grep found (besides the controller test, already fixed in Step 1): if it uses
the `_Unused*UseCase` pattern (the player-pool task established this for six sibling files —
`tournament_standings_screen_test.dart`, `tournament_leaderboards_screen_test.dart`,
`tournament_player_pool_screen_test.dart`, `edit_tournament_sheet_test.dart`,
`enroll_team_sheet_test.dart`, `resolve_fixture_sheet_test.dart`, `start_fixture_match_sheet_test.dart`,
`pool_player_sheet_test.dart` — confirm the current list with the grep, don't assume), add
`_UnusedSetAuctionSetupUseCase implements SetAuctionSetupUseCase` /
`_UnusedGetAuctionSetupUseCase implements GetAuctionSetupUseCase` (each a bare `noSuchMethod` throw) and
pass them as the two new constructor arguments — mechanical, same shape already used for every prior
widening of this controller.

- [ ] **Step 6: Run test to verify it passes**

Run: `flutter test test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart`
Expected: PASS (all tests, existing + new)

- [ ] **Step 7: Run `flutter analyze`**

Expected: no new errors — confirms every other construction site was actually fixed.

- [ ] **Step 8: Run the full Flutter suite**

Run: `flutter test`
Expected: all passing, no regressions.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat: wire auction setup into TournamentDetailController

auctionSetup/loadAuctionSetup/updateAuctionSetup, lazy-loaded the
same way pool/standings/leaderboards already are. Widens the
controller's constructor again; every direct construction site
across both lib/ and test/ updated in the same commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Flutter — screen, route, and navigation entry point

One screen: a squad-rules mini-form at the top, then one row per tournament-enrolled team (owner picker
sourced from `organizationDetail.value.members`, already loaded by `loadDetail()` — no new fetch needed
for the candidate list) with a budget field, and a single Save action that submits the whole visible
state in one `updateAuctionSetup` call. This matches the brief's own framing — "the organizer's pre-event
config surface" is one coherent screen, not a sheet-per-concern.

**Files:**
- Modify: `lib/config/routes/app_routes.dart`
- Modify: `lib/config/routes/app_pages.dart`
- Create: `lib/features/tournament/presentation/pages/tournament_auction_setup_screen.dart`
- Modify: `lib/features/tournament/presentation/pages/tournament_detail_screen.dart` (entry point)
- Create: `test/features/tournament/presentation/pages/tournament_auction_setup_screen_test.dart`

- [ ] **Step 1: Add the route**

In `lib/config/routes/app_routes.dart`, add after `tournamentPoolPath`:
```dart

  /// Registered with a GetX path parameter, same shape as [tournamentPool].
  /// Never navigate with this constant directly — use
  /// [tournamentAuctionSetupPath]. No binding of its own, same reasoning as
  /// pool/standings/leaderboards: reuses the tag-registered
  /// `TournamentDetailController`.
  static const String tournamentAuctionSetup =
      '/tournament/:tournamentId/auction-setup';

  static String tournamentAuctionSetupPath(String tournamentId) =>
      '/tournament/$tournamentId/auction-setup';
```

- [ ] **Step 2: Register the page**

In `lib/config/routes/app_pages.dart`, add the import alongside the other `tournament/presentation/pages`
imports:
```dart
import 'package:cricket_scorer/features/tournament/presentation/pages/tournament_auction_setup_screen.dart';
```
Add, after the `tournamentPool` `GetPage`:
```dart
    GetPage(
      name: AppRoutes.tournamentAuctionSetup,
      page: () => const TournamentAuctionSetupScreen(),
    ),
```

- [ ] **Step 3: Write the failing widget test**

Create `test/features/tournament/presentation/pages/tournament_auction_setup_screen_test.dart`, mirroring
`tournament_player_pool_screen_test.dart`'s exact setup shape (same `_StubGetTournamentUseCase`/
`_StubGetOrganizationUseCase` pair, same `_Unused*` classes for every usecase this screen's own code path
never calls) — but seed `_StubGetOrganizationUseCase`'s response with two members and
`_StubGetTournamentUseCase`'s response with two enrolled teams (`teams: [TournamentTeamRef(...), ...]`),
since this screen renders one row per enrolled team and needs the member list to populate the picker.
Read that file in full before writing this one; it is the ground truth for the stub shapes, not this
plan. Cover:
```dart
testWidgets('shows a row for every enrolled team with the current owner and budget prefilled', ...)
testWidgets('shows the squad-rules fields prefilled from the loaded setup', ...)
testWidgets('saving submits squad rules and the owners built from the visible rows', ...)
testWidgets('shows the backend error message and a retry button on failure', ...)
```
For the third test, assert on `setAuctionSetupUseCase.lastParams` — the exact `minSquadSize`/`owners`
values the screen actually sent — not just that *a* call happened.

- [ ] **Step 4: Run test to verify it fails**

Run: `flutter test test/features/tournament/presentation/pages/tournament_auction_setup_screen_test.dart`
Expected: FAIL — `tournament_auction_setup_screen.dart` doesn't exist yet.

- [ ] **Step 5: Create the screen**

`lib/features/tournament/presentation/pages/tournament_auction_setup_screen.dart` — structure:
- `StatefulWidget`, same `Get.parameters['tournamentId']` + `Get.find<TournamentDetailController>(tag:
  ...)` pattern as the pool screen.
- `initState`: call `controller.loadAuctionSetup()`.
- Local, screen-owned mutable state (not on the controller — this is transient form state, same
  reasoning `edit_tournament_sheet.dart` keeps its own `TextEditingController`s rather than pushing
  every keystroke onto the controller): a `TextEditingController` each for min/max squad size, and per
  enrolled team a `String? selectedOwnerId` + a budget `TextEditingController`, all seeded once from
  `controller.auctionSetup.value` and `controller.detail.value.teams` /
  `controller.organizationDetail.value.members` inside `initState` (after `loadDetail`/`loadAuctionSetup`
  both resolve — use `Obx`/`ever` or a one-shot `WidgetsBinding.instance.addPostFrameCallback` guarded by
  a `_seeded` flag, matching how this codebase already avoids re-seeding on every rebuild elsewhere in
  `edit_tournament_sheet.dart`'s own prefill).
- Body: `CricketTextField`s for min/max squad size (numeric), then a `ListView`/`Column` of one row per
  `controller.detail.value!.teams` entry — team name, a `DropdownButton`/picker over
  `controller.organizationDetail.value!.members` (label = member name, value = member id, plus a "no
  owner" option), and a budget `CricketTextField` (numeric) — each row only visually active if the
  organizer `isOwner` (read-only display otherwise, matching the pool screen's owner-only edit
  visibility).
- A single `CricketButton` ("Save"): builds `owners` from every row that currently has *both* a selected
  owner and a non-empty valid budget (a row with neither is simply omitted — that's what "no owner
  assigned yet" looks like), then calls
  `controller.updateAuctionSetup(minSquadSize: ..., maxSquadSize: ..., owners: owners)` — always passing
  `owners` (even as an empty list) since the screen represents the *complete* current state, not a
  partial edit; `minSquadSize`/`maxSquadSize` passed only if their fields are non-empty. On success, show
  a success snackbar; on failure, a generic error snackbar (matching `edit_tournament_sheet.dart`'s own
  fallback message pattern).
- Loading/error/empty states for the initial `loadAuctionSetup()`/`loadDetail()` fetch, matching the pool
  screen's exact `Obx` + `CircularProgressIndicator`/error-with-retry shape.

- [ ] **Step 6: Run test to verify it passes**

Run: `flutter test test/features/tournament/presentation/pages/tournament_auction_setup_screen_test.dart`
Expected: PASS

- [ ] **Step 7: Add the detail-screen entry point**

In `lib/features/tournament/presentation/pages/tournament_detail_screen.dart`, add a fourth `TextButton`
alongside Standings/Leaderboards/Player pool — visible to any org member (read access exists via `GET`),
same as the other three:
```dart
                        TextButton(
                          onPressed: () => Get.toNamed<dynamic>(
                            AppRoutes.tournamentAuctionSetupPath(_tournamentId),
                          ),
                          child: CricketText(text: TranslationKeys.auctionSetup.tr),
                        ),
```

- [ ] **Step 8: Run `flutter analyze` and the full suite**

Run: `flutter analyze` — expect no new errors.
Run: `flutter test` — expect all passing.

- [ ] **Step 9: Commit**

```bash
git add lib/config/routes/app_routes.dart lib/config/routes/app_pages.dart lib/features/tournament/presentation/pages/tournament_auction_setup_screen.dart lib/features/tournament/presentation/pages/tournament_detail_screen.dart test/features/tournament/presentation/pages/tournament_auction_setup_screen_test.dart
git commit -m "$(cat <<'EOF'
feat: add TournamentAuctionSetupScreen and its route

One screen: squad-rules fields plus one row per enrolled team (owner
picker sourced from the already-loaded organization member list, no
new fetch), a single Save submitting the whole visible state in one
updateAuctionSetup call. Reachable from the tournament detail
screen's action row, alongside Standings/Leaderboards/Player pool.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Flutter — translations and CMS upload

**Files:**
- Modify: `lib/core/translations/translation_keys.dart`
- Modify: `lib/core/translations/en.dart`, `hi.dart`, `mr.dart`

- [ ] **Step 1: Add translation keys**

In `lib/core/translations/translation_keys.dart`, add near the existing `playerPool` keys:
```dart
  static const String auctionSetup = 'auction_setup';
  static const String squadRules = 'squad_rules';
  static const String minSquadSize = 'min_squad_size';
  static const String maxSquadSize = 'max_squad_size';
  static const String teamOwner = 'team_owner';
  static const String budget = 'budget';
  static const String noOwnerAssigned = 'no_owner_assigned';
  static const String auctionSetupSaved = 'auction_setup_saved';
```
Add the matching entries to `en.dart`, `hi.dart`, `mr.dart`'s map literals, following whichever exact
key-reference convention (`TranslationKeys.xxx: '...'` vs. raw string keys) each file already uses —
check the file before assuming, per the player-pool task's own note that this varies.

English values: `'Auction setup'`, `'Squad rules'`, `'Min squad size'`, `'Max squad size'`, `'Team
owner'`, `'Budget'`, `'No owner assigned'`, `'Auction setup saved'`. Provide matching Hindi/Marathi
translations following this file's existing tone (short, plain, matching the player-pool slice's own
translated strings for comparable concepts).

- [ ] **Step 2: Verify**

Run: `flutter analyze` — expect no new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/core/translations/translation_keys.dart lib/core/translations/en.dart lib/core/translations/hi.dart lib/core/translations/mr.dart
git commit -m "$(cat <<'EOF'
feat: add auction-setup translation keys

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Upload to the CMS**

Per the workspace CLAUDE.md — a `TranslationKeys` entry plus the local maps is not enough; the CMS map
replaces the local one wholesale on next sync. Bulk-upload the eight keys from Step 1 via `POST
/api/v1/translations/bulk-update` (`verifyAdmin`), body `[{key, translations:{en,hi,mr}}, …]`, using the
exact strings from Step 1. Confirm afterward with `GET /api/v1/translations/all` that all eight keys are
present. (The player-pool task did this via `curl` against the local dev server with an admin account's
access token — same approach applies here; do not start/stop the dev server yourself.)

---

## Task 13: Finishing — full verification, roadmap refresh, code review

**Files:**
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Backend full suite**

```bash
cd cricket-scorer-backend
npm test
```
Expected: no new deterministic failures versus the pre-existing baseline (same verification method used
for the bowler-roster and player-pool features — isolate this feature's own test files and confirm they
pass cleanly there even if the full-suite run shows the project's known flakiness elsewhere).

- [ ] **Step 2: Frontend full suite**

```bash
cd cricket-scrorer
flutter analyze
flutter test
```
Expected: `flutter analyze` clean; `flutter test` all passing.

- [ ] **Step 3: Live verification against the dev server**

```bash
curl -s -m 3 http://localhost:9000/api/v1/tournament/000000000000000000000000/auction-setup -H "Authorization: Bearer bad" -o /dev/null -w "%{http_code}\n"
```
Expected: `401`.

- [ ] **Step 4: Refresh `docs/roadmap.md`'s Phase 4 section**

Phase 4 currently has no per-feature status breakdown the way Phases 1–3 do (a single features table with
no "Status" column, since nothing in Phase 4 was built until now). Add a `Status` column to that table
(mirroring the exact pattern the earlier roadmap-staleness cleanup applied to Phases 1–3), marking
"Player pool registration" and "Auction setup" as **Built**, and every other Phase 4 row (auction room,
server-authoritative bidding, post-auction squad view, auction replay/history) as **Not started**. Update
the top summary table's Phase 4 row from "Not started — the differentiator" to something reflecting
partial progress, e.g. "In progress — setup built, live room not started."

- [ ] **Step 5: Request code review**

Per `superpowers:requesting-code-review` — dispatch a code-reviewer subagent against this branch's full
diff in both repos (base: `origin/development`, head: the tip of `feat-auction-setup` in each), using the
template at `plugin:superpowers:requesting-code-review`'s `code-reviewer.md`. Act on Critical/Important
findings before presenting this feature as complete; note Minor findings without necessarily fixing them
inline.

- [ ] **Step 6: Use `finishing-a-development-branch` in both repos**

Present the merge/PR/keep-as-is menu for `feat-auction-setup` in both `cricket-scorer-backend` and
`cricket-scrorer`, and act on whichever the user chooses. Do not merge or push without that explicit
choice. **Also resurface the still-pending `feat-player-pool-registration` branch decision from the
prior feature** — it was never merged/pushed/kept because the user moved straight to requesting this
feature instead of answering that menu.
