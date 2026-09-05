# Tournament Model (Contract-Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the `Tournament` Mongoose model and document it in `docs/api.md`. No controllers, no routes, no sockets, no client-side work — those are separate follow-up prompts.

**Architecture:** One new model file, `src/models/tournament.model.js`, following the exact schema/index/naming conventions of `organization.model.js` and `team.model.js`. One new `docs/api.md` section, in the same hand-written voice as the existing `## Organization` section, plus a `## Schema state` entry recording what's new.

**Tech Stack:** Mongoose 9, ESM. Jest for the model-only unit test (mirrors `tests/organizationModel.test.js` — ODM validation/index behavior against a real `mongodb-memory-server`, no HTTP layer).

**Spec:** Design decisions were resolved directly via `AskUserQuestion` during the brainstorming pass (no separate spec file, given the small, contract-only scope):
- `format`: three distinct enum values `['knockout', 'round_robin', 'league']`.
- `teams`: embedded array of `{team: ObjectId ref Team, joinedAt: Date}` subdocuments (same shape as `Organization.members`).
- `organization`: **required** `ObjectId` ref `Organization` (tournaments are an org-tier feature per `docs/roadmap.md` Phase 3 — no standalone-tournament use case exists).
- `status`: enum `['upcoming', 'ongoing', 'completed']`, default `'upcoming'`, added now even though no controller sets it yet.

## Global Constraints

- ESM imports with `.js` extensions; `import mongoose, { Schema } from "mongoose"` (match existing model files' import style).
- Model exported as `export const Tournament = mongoose.model('Tournament', tournamentSchema)` from `tournament.model.js` (lowercase file, PascalCase singular export — per backend CLAUDE.md's Naming Conventions).
- No service/repository layer, no validation library — not applicable here (no controller in this pass) but keep the model itself free of any business logic beyond schema-level constraints.
- Soft delete via `isDeleted: { type: Boolean, default: false }`, matching `Match`/`Team`/`Player`/`Organization`.
- `timestamps: true` on the schema, matching every other model.
- No migration — new collection, no prior writer, nothing to migrate (same reasoning `docs/api.md`'s Schema state section gives for every other addition).
- Do NOT touch `match.model.js`, any controller, any route, or any file under `cricket-scrorer/` — strictly the new model file plus `docs/api.md`.

---

### Task 1: Tournament model

**Files:**
- Create: `src/models/tournament.model.js`
- Test: `tests/tournamentModel.test.js`

**Interfaces:**
- Consumes: `Organization` (ref, from `src/models/organization.model.js`), `Team` (ref, from `src/models/team.model.js`), `User` (ref, from `src/models/user.model.js`) — referenced by name string in `ref:`, no import of those model files needed (Mongoose resolves refs by registered model name at populate time, same as every other cross-model ref in this codebase).
- Produces: `export const Tournament = mongoose.model('Tournament', tournamentSchema)` — a document with fields `name` (String), `nameLower` (String), `organization` (ObjectId), `format` (String enum), `teams` (Array of `{team, joinedAt}`), `status` (String enum), `createdBy` (ObjectId), `isDeleted` (Boolean), `createdAt`/`updatedAt` (Date, via `timestamps`).

- [ ] **Step 1: Write the failing test**

Create `tests/tournamentModel.test.js`:

```javascript
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';

describe('Tournament model', () => {
  beforeAll(async () => {
    await connectTestDb();
    // Indexes are created asynchronously on connect; wait for them so the
    // uniqueness test below isn't racing index creation.
    await Tournament.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const objectId = () => new mongoose.Types.ObjectId();

  it('requires name, organization, format, and createdBy', async () => {
    await expect(Tournament.create({})).rejects.toThrow();
  });

  it('defaults status to upcoming, isDeleted to false, and teams to empty', async () => {
    const organization = objectId();
    const createdBy = objectId();
    const tournament = await Tournament.create({
      name: 'Riverside Summer T20',
      nameLower: 'riverside summer t20',
      organization,
      format: 'knockout',
      createdBy,
    });

    expect(tournament.status).toBe('upcoming');
    expect(tournament.isDeleted).toBe(false);
    expect(tournament.teams).toEqual([]);
  });

  it('rejects a format outside the enum', async () => {
    const organization = objectId();
    const createdBy = objectId();

    await expect(
      Tournament.create({
        name: 'Riverside Summer T20',
        nameLower: 'riverside summer t20',
        organization,
        format: 'swiss',
        createdBy,
      })
    ).rejects.toThrow();
  });

  it('stamps joinedAt when a team subdocument is added', async () => {
    const organization = objectId();
    const createdBy = objectId();
    const team = objectId();

    const tournament = await Tournament.create({
      name: 'Riverside Summer T20',
      nameLower: 'riverside summer t20',
      organization,
      format: 'round_robin',
      createdBy,
      teams: [{ team }],
    });

    expect(tournament.teams[0].team).toEqual(team);
    expect(tournament.teams[0].joinedAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate {organization, nameLower} pair', async () => {
    const organization = objectId();
    const createdBy = objectId();

    await Tournament.create({
      name: 'Riverside Summer T20',
      nameLower: 'riverside summer t20',
      organization,
      format: 'league',
      createdBy,
    });

    await expect(
      Tournament.create({
        name: 'Riverside Summer T20',
        nameLower: 'riverside summer t20',
        organization,
        format: 'league',
        createdBy: objectId(),
      })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows two different organizations to use the same tournament name', async () => {
    const createdBy = objectId();

    await Tournament.create({
      name: 'Summer T20',
      nameLower: 'summer t20',
      organization: objectId(),
      format: 'knockout',
      createdBy,
    });

    await expect(
      Tournament.create({
        name: 'Summer T20',
        nameLower: 'summer t20',
        organization: objectId(),
        format: 'knockout',
        createdBy,
      })
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournamentModel.test.js`
Expected: FAIL — `Cannot find module '../src/models/tournament.model.js'` (file doesn't exist yet).

- [ ] **Step 3: Write the model**

Create `src/models/tournament.model.js`:

```javascript
import mongoose, { Schema } from "mongoose";

const TOURNAMENT_FORMATS = ['knockout', 'round_robin', 'league'];
const TOURNAMENT_STATUS  = ['upcoming', 'ongoing', 'completed'];

const tournamentSchema = new Schema(
  {
    name:         { type: String, required: true, trim: true, maxlength: 100 },
    // Derived from `name` by whichever controller creates a tournament, same
    // convention as Organization.nameLower and Player.nameLower — see
    // organization.model.js's comment on why a schema hook isn't used
    // instead (findOrCreate-style upserts bypass document middleware).
    nameLower:    { type: String, required: true, trim: true },
    // Required, unlike Team.organization — tournament hosting is an
    // org-tier feature (docs/roadmap.md Phase 3), so there is no
    // standalone-tournament case to leave room for.
    organization: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    format:       { type: String, enum: TOURNAMENT_FORMATS, required: true },
    // Many-to-many: a Team persists across tournaments and can join more
    // than one. Embedded rather than a join collection — tournament scale
    // is tens of teams, not thousands, same reasoning as
    // Organization.members. `joinedAt` mirrors Organization.members'
    // `addedAt`.
    teams: [
      {
        team:     { type: Schema.Types.ObjectId, ref: 'Team', required: true },
        joinedAt: { type: Date, default: Date.now },
      },
    ],
    status:    { type: String, default: 'upcoming', enum: TOURNAMENT_STATUS },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Unique per organization, same shape as Organization's own {owner,
// nameLower} — one organization can't run two tournaments with the same
// name (case-insensitive via nameLower). Deliberately not global
// uniqueness: two different organizations naming a tournament "Summer T20"
// is expected, not a collision.
tournamentSchema.index({ organization: 1, nameLower: 1 }, { unique: true });
// Supports "which tournaments does this org run" listings.
tournamentSchema.index({ organization: 1, createdAt: -1 });
// Supports "which tournaments is this team entered in."
tournamentSchema.index({ 'teams.team': 1 });

export const Tournament = mongoose.model('Tournament', tournamentSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournamentModel.test.js`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Run the full backend suite**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --maxWorkers=2`
Expected: PASS — the new file adds tests without touching any existing model, controller, or route, so the full suite's prior count plus 6 should be green with zero regressions.

- [ ] **Step 6: Commit**

```bash
git add src/models/tournament.model.js tests/tournamentModel.test.js
git commit -m "feat: add Tournament model (contract-only, no controllers/routes yet)"
```

---

### Task 2: Document the contract in docs/api.md

**Files:**
- Modify: `docs/api.md` (workspace root — not version-controlled by this repo, per the workspace's own root `CLAUDE.md`)

**Interfaces:**
- Consumes: the finished `Tournament` schema from Task 1 (field names, types, enum values, index shape) — this section must describe that schema exactly, not a paraphrase of it.
- Produces: nothing consumed by later tasks — this is the last task in this plan.

- [ ] **Step 1: Add a `## Tournament` section**

Insert a new `## Tournament` section into `docs/api.md`, placed directly after the existing `## Organization` section (before the `---` that currently follows it, i.e. before the `## POST /v1/user/update-profile` section) — tournaments build on organizations, so this keeps the document's read order matching the dependency order.

Write the section in the same hand-written voice as `## Organization`: prose framing paragraph(s), then the schema itself in a table, then an explicit "not covered here" list. Content:

```markdown
## Tournament

The container Phase 3's auto-generated fixtures, points table, and
delegated-scoring-per-match will attach to. **This section is contract-only:
it defines the `Tournament` model so later work has a stable shape to build
against, and documents nothing else.** There is no `POST`/`GET`/`PATCH`
endpoint for tournaments yet, no socket event, no client DTO, and no
controller anywhere in this codebase touches the `Tournament` collection —
those are separate, later contracts.

A tournament always belongs to exactly one `Organization` — unlike `Team`,
there is no standalone/ad-hoc tournament, matching this feature's framing in
`docs/roadmap.md` Phase 3 as an organization-tier capability. A `Team` can
belong to more than one tournament over its lifetime (and to none), so the
relationship is modeled many-to-many: `Tournament.teams` is an embedded list
of `{team, joinedAt}` entries, the same shape `Organization.members` already
uses for its own many-to-many with `User`.

### Schema

| Field | Type | Notes |
|---|---|---|
| `name` | string | required, trimmed, max 100 chars |
| `nameLower` | string | required; lowercased `name`, maintained by whichever future controller writes this collection — same convention as `Organization.nameLower` |
| `organization` | ObjectId (ref `Organization`) | required |
| `format` | string enum | required; `knockout` \| `round_robin` \| `league` — three distinct values, not two, so a league's season-long, points-table-driven shape isn't forced to share a value with a single-pass round-robin |
| `teams` | array of `{team: ObjectId (ref \`Team\`), joinedAt: Date}` | defaults to `[]`; `joinedAt` defaults to the time the subdocument is created |
| `status` | string enum | `upcoming` \| `ongoing` \| `completed`, default `upcoming`; present now, unwritten until the tournament-lifecycle controller exists |
| `createdBy` | ObjectId (ref `User`) | required |
| `isDeleted` | boolean | default `false`, same soft-delete convention as `Match`/`Team`/`Player`/`Organization` |
| `createdAt` / `updatedAt` | Date | via `timestamps` |

### Indexes

- `{organization: 1, nameLower: 1}`, **unique** — one organization can't run
  two tournaments with the same name (case-insensitive). Two different
  organizations naming a tournament the same thing is expected, not a
  collision — same reasoning as `Organization`'s own `{owner, nameLower}`
  index.
- `{organization: 1, createdAt: -1}` — an org's tournament list, newest
  first.
- `{'teams.team': 1}` — "which tournaments is this team entered in."

### What this pass does NOT cover

- Any endpoint (create/list/read/update/delete a tournament, add/remove a
  team, set `status`).
- Any socket event.
- Fixture generation, points table / standings, or tournament leaderboards
  — all listed separately in `docs/roadmap.md` Phase 3 and none of them can
  be built on this model alone.
- Any change to `Match` — `Match` does not yet reference `Tournament` in any
  way; wiring a match to the tournament it belongs to is a future contract,
  not this one.
- Any client-side (`cricket-scrorer`) model, endpoint, or UI.
```

- [ ] **Step 2: Add a Schema state entry**

In `docs/api.md`'s `## Schema state` section, insert a new entry immediately after the existing "**Applied by the delegated-scoring contract:**" block (i.e., right before `## Open items (not settled by this contract)`), matching that section's established voice:

```markdown
**Applied by the tournament contract:**
- `tournament.model.js` (new): `name`, `nameLower`, `organization` (required,
  ref `Organization`), `format` (enum `knockout`/`round_robin`/`league`),
  `teams: [{team, joinedAt}]` (ref `Team`), `status` (enum, default
  `upcoming`), `createdBy` (ref `User`), `isDeleted`. Unique
  `{organization, nameLower}` index (same pattern as `Organization`'s own
  per-owner uniqueness); `{organization: 1, createdAt: -1}` for an org's
  tournament list; `{'teams.team': 1}` for a team's tournament list.
- No other model changes: `Match` does not reference `Tournament`, and
  `Organization`/`Team` are read-only from this contract's perspective —
  nothing here writes to either.

New collection, no prior writer — nothing to migrate.
```

- [ ] **Step 3: Commit**

The workspace root (`cricket-scorer-workspace`) is not itself a git repository — `docs/api.md` lives there but is not version-controlled by this repo or tracked by any git command here. No commit step applies to this file; the edit itself is the deliverable. (Confirm this is still true before skipping the commit: `git -C /Users/samirsuroshe/Projects/Cricket-Scorer-Project/cricket-scorer-workspace status` should report "not a git repository".)

---

## Self-Review Notes

- **Spec coverage:** Task 1 covers every field/index decision from the brainstorming Q&A (format enum values, teams shape, required organization, status field). Task 2 documents all of it plus the explicit non-coverage list the original task asked for.
- **Placeholder scan:** no TBD/TODO; all code blocks are complete and copy-pasteable.
- **Type consistency:** `Tournament.teams[].team` (ObjectId ref `Team`) matches the docs table exactly; `format`/`status` enum value spellings match between the model code, the test file, and the docs table (`round_robin` with an underscore throughout, not `roundRobin` or `round-robin`).
