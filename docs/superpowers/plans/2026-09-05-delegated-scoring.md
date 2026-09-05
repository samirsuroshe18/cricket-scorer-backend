# Delegated Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in this session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a match's creator, or the owner of an org that either of its teams belongs to, delegate live-scoring write-access on that one match to a specific org member — without changing who owns the match, without touching abandon/delete, and without any effect on a fully ad-hoc match.

**Architecture:** One nullable `Match.assignedScorer` field. Every scoring-path ownership check (`startInnings`, `selectBowler`, `scoreBall`, `undoBall`, `syncMatch`, `getMatchScorecard`) widens from `createdBy` to `createdBy OR assignedScorer`. A new `canAssignScorer` predicate (creator OR qualifying org owner) gates two new endpoints that set/clear the field and list who's eligible. `abandonMatch`/`deleteMatch` are untouched. Discovery needs no new screen: the scorer's own widened match-history list surfaces matches assigned to them, and an org owner who didn't create a match already reaches it via the existing per-team match list (`GET /v1/team/:teamId/matches`, already open to any org member via `canAccessTeam`).

**Tech Stack:** Node/Express 5/Mongoose (backend), Flutter/GetX (frontend), Jest/Supertest (backend tests), `flutter test` (frontend tests).

**Spec:** [docs/superpowers/specs/2026-09-05-delegated-scoring-design.md](../specs/2026-09-05-delegated-scoring-design.md)

## Global Constraints

- Reuse `MATCH_NOT_OWNED` (403) for both "can't assign" and "can't score" failures — no new code for either.
- Exactly one scorer per match (`Match.assignedScorer` is a single nullable field, never a list).
- Assignable at any `match.status` (upcoming/live/innings_break/completed) — never gated on status.
- Assign authority: `match.createdBy`, or the `owner` of the `Organization` either `teamA` or `teamB` belongs to.
- Assignee pool: must be a member (any role) of one of those same qualifying orgs — never an arbitrary user.
- `abandonMatch` and `deleteMatch` keep their original `createdBy`-only check, byte-for-byte unchanged.
- A match where neither team has an organization can never have a scorer assigned (`MATCH_NOT_ORG_LINKED`, 400) — this is what keeps a fully ad-hoc match's behavior identical before and after this feature.
- Authorization (`canAssignScorer`) is always checked before the org-link check, on both new endpoints.
- New locale keys ship in all three of `src/locales/{en,hi,mr}/common.json` — `tests/locales.test.js` enforces parity.
- Client `TranslationKeys` additions need their local `en`/`hi`/`mr` Dart maps **and** a CMS bulk-update via `POST /api/v1/translations/bulk-update`, or the app renders the raw key once translations next sync (see the workspace CLAUDE.md's "Shared types & keeping them in sync").

---

## Task 1: Contract — update docs/api.md

**Files:**
- Modify: `docs/api.md` (workspace root, not version-controlled by either repo — `cricket-scorer-workspace/docs/api.md`)

**Interfaces:**
- Produces: the exact request/response/error shapes every later task implements against. No code in this task.

- [ ] **Step 1: Add the two new endpoints, right after `## GET /v1/match/history` (before `## GET /v1/match/public/:code`)**

Insert this new section into `docs/api.md`:

````markdown
## PATCH /v1/match/:matchId/scorer

Assigns, reassigns, or clears the one scorer delegated to score this match on
the creator's behalf. Callable by the match's own `createdBy`, or by the
`owner` of the `Organization` that either `teamA` or `teamB` belongs to —
this is the one place authority to act on a match extends beyond
`createdBy`. Works at any `match.status`: the motivating case is a scorer's
phone dying mid-match, where whoever has assign authority needs to hand
scoring to someone else immediately, not just before the toss.

### Request
```json
{ "scorerId": "665f1a2b3c4d5e6f7a8b9c50" }
```
or, to clear the assignment:
```json
{ "scorerId": null }
```
`scorerId` must belong to a member (any role) of an organization that owns
`teamA` or `teamB` — never an arbitrary registered user. A match where
neither team belongs to an organization has no eligible pool at all and
cannot have a scorer assigned, regardless of who's asking.

### Response `200`
```json
{
  "statusCode": 200,
  "data": {
    "matchId": "665f1a2b3c4d5e6f7a8b9c0d",
    "assignedScorer": { "id": "665f1a2b3c4d5e6f7a8b9c50", "name": "Raj Patel" }
  },
  "message": "Scorer assigned",
  "success": true
}
```
`assignedScorer` is `null` in the response after a clear (`"message": "Scorer unassigned"`).

### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `MATCH_NOT_FOUND` | `matchId` doesn't exist or is soft-deleted |
| 403 | `MATCH_NOT_OWNED` | caller is neither `createdBy` nor the owner of teamA's/teamB's org |
| 400 | `MATCH_NOT_ORG_LINKED` | assigning (not clearing) on a match where neither team has an organization |
| 400 | `INVALID_SCORER` | `scorerId` isn't a member of any org that owns `teamA`/`teamB` |
| 400 | `INVALID_ID` | `matchId`/`scorerId` isn't a well-formed ObjectId |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

## GET /v1/match/:matchId/scorer-candidates

The member list a caller with assign-authority can pick from — the
deduplicated members of whichever org(s) actually own `teamA`/`teamB`.
Authorization is checked before the org-link check: someone with no assign
authority gets `MATCH_NOT_OWNED` regardless of whether either team happens
to be org-linked. An authorized caller on a match with no org-linked team
gets an empty list back, not an error — a GET reporting "nobody's eligible"
is a valid answer, unlike a PATCH attempting an actual assignment with
nowhere to point it (`MATCH_NOT_ORG_LINKED`, above).

### Response `200`
```json
{
  "statusCode": 200,
  "data": {
    "candidates": [
      { "id": "665f1a2b3c4d5e6f7a8b9c50", "name": "Raj Patel" },
      { "id": "665f1a2b3c4d5e6f7a8b9c51", "name": "Asha Rao" }
    ]
  },
  "message": "Scorer candidates fetched",
  "success": true
}
```

### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `MATCH_NOT_FOUND` | `matchId` doesn't exist or is soft-deleted |
| 403 | `MATCH_NOT_OWNED` | caller is neither `createdBy` nor the owner of teamA's/teamB's org |
| 400 | `INVALID_ID` | `matchId` isn't a well-formed ObjectId |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

---
````

- [ ] **Step 2: Amend `## GET /v1/match/history`'s response and prose**

In the existing `### Response 200` JSON example for `GET /v1/match/history`, add two fields to the one
example match object, right after `"tossDecision": null,` and before `"createdAt"`:
```json
        "createdBy": { "id": "665f1a2b3c4d5e6f7a8b9c40", "name": "Priya Nair" },
        "assignedScorer": null,
```
Then replace this existing paragraph:
> `result` is `null` for anything that isn't `completed` (never populated for
> `abandoned` — an abandoned match has no winner). `status` is what a client
> uses to route a tapped card: `live`/`innings_break`/`upcoming` back into the
> scoring console, `completed`/`abandoned` to the result screen. Unlike
> `getPublicMatch`/`getMatchScorecard`, `teamA`/`teamB` here carry an `id`, not
> just a `name` — reopening the console for a still-live match needs it, the
> same shape `create` originally returned them in. `joinCode` is `null` for
> matches created before share codes existed. `tossWinner`/`tossDecision` are
> `null` together for a match created without a toss, same as everywhere else
> this pair appears (`create`, `getMatchScorecard`) — reopening the console
> for a still-live match needs these to render the toss line, which is what
> they were missing for until this field was added here.

with the same paragraph plus this new one appended:
> `result` is `null` for anything that isn't `completed` (never populated for
> `abandoned` — an abandoned match has no winner). `status` is what a client
> uses to route a tapped card: `live`/`innings_break`/`upcoming` back into the
> scoring console, `completed`/`abandoned` to the result screen. Unlike
> `getPublicMatch`/`getMatchScorecard`, `teamA`/`teamB` here carry an `id`, not
> just a `name` — reopening the console for a still-live match needs it, the
> same shape `create` originally returned them in. `joinCode` is `null` for
> matches created before share codes existed. `tossWinner`/`tossDecision` are
> `null` together for a match created without a toss, same as everywhere else
> this pair appears (`create`, `getMatchScorecard`) — reopening the console
> for a still-live match needs these to render the toss line, which is what
> they were missing for until this field was added here.
>
> `createdBy` and `assignedScorer` are new for delegated scoring (see the
> `PATCH /v1/match/:matchId/scorer` section). This list now includes matches
> the caller didn't create but is the `assignedScorer` on, alongside matches
> they created themselves — the filter is `$or: [{createdBy}, {assignedScorer}]`,
> not `createdBy` alone. `createdBy` lets a client render "Assigned by X" when
> it differs from the caller's own id; `assignedScorer` (`null` on every match
> with none) lets a creator's own list show who they've delegated a given
> match to. Both are `{id, name}` refs, same shape as `teamA`/`teamB`.

- [ ] **Step 3: Amend `## Team profile`'s `GET /v1/team/:teamId/matches` subsection**

Find the `### GET /v1/team/:teamId/matches` subsection and add this sentence to its prose (it already
says the response is "byte-for-byte the same ... shape" as history — extend that claim):
> Like `GET /v1/match/history`, each entry now also carries `createdBy` and
> `assignedScorer` (see the delegated-scoring contract above) — this is what
> lets an org owner who didn't create a given match still find it here (this
> endpoint is already open to any member of the team's org, via
> `canAccessTeam`) and assign a scorer to it.

- [ ] **Step 4: Add to `## Locale keys`**

Append this paragraph, right after the "Added by the organization contract: ..." paragraph and before
"Every key must exist in all three locale files":
```markdown
Added by the delegated-scoring contract: `MATCH_NOT_ORG_LINKED`, `INVALID_SCORER`,
`SCORER_ASSIGNED`, `SCORER_UNASSIGNED`, `SCORER_CANDIDATES_FETCHED`. `MATCH_NOT_FOUND`
and `MATCH_NOT_OWNED` are reused, unchanged.
```

- [ ] **Step 5: Add to `## Schema state`**

Append this line under "**Applied by this contract:**" bullets (create that heading with this one bullet
if it's not already the active section — otherwise add alongside whatever the most recent contract added):
```markdown
- `match.model.js`: `assignedScorer` (optional, `ref: 'User'`, default `null`) plus a
  `{assignedScorer: 1, createdAt: -1}` index, mirroring the existing `{createdBy: 1, createdAt: -1}`.
```

- [ ] **Step 6: Commit**

```bash
cd cricket-scorer-workspace
git status
```
The workspace root isn't a git repo — `docs/api.md` has no commit of its own. Move on to Task 2, where
the backend commit's message references this doc update.

---

## Task 2: `Match.assignedScorer` field

**Files:**
- Modify: `src/models/match.model.js`
- Test: `tests/matchAssignedScorerField.test.js` (create)

**Interfaces:**
- Produces: `Match.assignedScorer` (nullable `ObjectId`, `ref: 'User'`), defaulting to `null` on every
  match, existing or new.

- [ ] **Step 1: Write the failing test**

```js
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';
import { Team } from '../src/models/team.model.js';
import { User } from '../src/models/user.model.js';

describe('Match.assignedScorer', () => {
  beforeAll(async () => {
    await connectTestDb();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('defaults to null', async () => {
    const user = await User.create({ email: 'a@example.com', password: 'password123', fullName: 'A' });
    const teamA = await Team.create({ name: 'A', createdBy: user._id });
    const teamB = await Team.create({ name: 'B', createdBy: user._id });
    const match = await Match.create({ teamA: teamA._id, teamB: teamB._id, totalOvers: 5, createdBy: user._id });

    expect(match.assignedScorer).toBeNull();
  });

  it('accepts a valid User ObjectId', async () => {
    const user = await User.create({ email: 'a@example.com', password: 'password123', fullName: 'A' });
    const scorer = await User.create({ email: 'b@example.com', password: 'password123', fullName: 'B' });
    const teamA = await Team.create({ name: 'A', createdBy: user._id });
    const teamB = await Team.create({ name: 'B', createdBy: user._id });
    const match = await Match.create({
      teamA: teamA._id, teamB: teamB._id, totalOvers: 5, createdBy: user._id, assignedScorer: scorer._id,
    });

    expect(match.assignedScorer.equals(scorer._id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/matchAssignedScorerField.test.js -v`
Expected: FAIL — `assignedScorer` is `undefined`, not `null`, on the first test (Mongoose has no such
schema path yet, so it's silently dropped on write).

- [ ] **Step 3: Add the field and index**

In `src/models/match.model.js`, add the field to `matchSchema`'s definition, immediately after
`createdBy`:
```js
    createdBy:       { type: Schema.Types.ObjectId, ref: 'User', index: true },
    // The one delegated scorer for this match, distinct from `createdBy` —
    // see docs/api.md's PATCH /v1/match/:matchId/scorer. Null on every
    // match that predates this feature and every ad-hoc match since: it is
    // only ever set via that endpoint, which itself refuses to set it on a
    // match where neither team belongs to an organization.
    assignedScorer:  { type: Schema.Types.ObjectId, ref: 'User', default: null },
```
And add a new index, right after the existing `matchSchema.index({ createdBy: 1, createdAt: -1 });` line:
```js
// Mirrors the createdBy index above — backs GET /v1/match/history's
// widened $or: [{createdBy}, {assignedScorer}] filter.
matchSchema.index({ assignedScorer: 1, createdAt: -1 });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/matchAssignedScorerField.test.js -v`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
cd cricket-scorer-backend
git add src/models/match.model.js tests/matchAssignedScorerField.test.js
git commit -m "$(cat <<'EOF'
feat: add Match.assignedScorer field

Nullable, defaults to null on every existing and new match. Nothing
sets it yet — that's the assignScorer endpoint in a later commit.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `qualifyingOrgOwnerIds` and `canAssignScorer`

**Files:**
- Modify: `src/utils/organizationAccess.js`
- Test: `tests/organizationAccess.test.js` (existing file — add to it)

**Interfaces:**
- Consumes: `Organization.find` (existing model), `Team.organization` (existing field).
- Produces: `qualifyingOrgOwnerIds(teamA, teamB): Promise<string[]>` and
  `canAssignScorer(match, teamA, teamB, userId): Promise<boolean>`, both exported from
  `src/utils/organizationAccess.js`. Task 4 imports both.

- [ ] **Step 1: Write the failing tests**

Append to `tests/organizationAccess.test.js` (it already imports `Organization`, `connectTestDb`, etc. —
match its existing top-of-file setup):
```js
import { qualifyingOrgOwnerIds, canAssignScorer } from '../src/utils/organizationAccess.js';
import { Team } from '../src/models/team.model.js';
import { Match } from '../src/models/match.model.js';
import { User } from '../src/models/user.model.js';

describe('qualifyingOrgOwnerIds', () => {
  it('returns empty when neither team has an organization', async () => {
    const teamA = { organization: null };
    const teamB = { organization: null };

    const ownerIds = await qualifyingOrgOwnerIds(teamA, teamB);

    expect(ownerIds).toEqual([]);
  });

  it('returns the owner of teamA\'s org when only teamA is org-linked', async () => {
    const owner = await User.create({ email: 'owner@example.com', password: 'password123', fullName: 'Owner' });
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }],
    });
    const teamA = { organization: org._id };
    const teamB = { organization: null };

    const ownerIds = await qualifyingOrgOwnerIds(teamA, teamB);

    expect(ownerIds).toEqual([String(owner._id)]);
  });

  it('returns both owners when teamA and teamB belong to different orgs', async () => {
    const ownerA = await User.create({ email: 'ownerA@example.com', password: 'password123', fullName: 'OwnerA' });
    const ownerB = await User.create({ email: 'ownerB@example.com', password: 'password123', fullName: 'OwnerB' });
    const orgA = await Organization.create({
      name: 'Club A', nameLower: 'club a', owner: ownerA._id, members: [{ user: ownerA._id, role: 'owner' }],
    });
    const orgB = await Organization.create({
      name: 'Club B', nameLower: 'club b', owner: ownerB._id, members: [{ user: ownerB._id, role: 'owner' }],
    });

    const ownerIds = await qualifyingOrgOwnerIds({ organization: orgA._id }, { organization: orgB._id });

    expect(ownerIds.sort()).toEqual([String(ownerA._id), String(ownerB._id)].sort());
  });
});

describe('canAssignScorer', () => {
  const makeMatch = (createdBy) => ({ createdBy });

  it('is true for the match creator, regardless of any org', async () => {
    const creator = await User.create({ email: 'creator@example.com', password: 'password123', fullName: 'Creator' });
    const match = makeMatch(creator._id);

    const allowed = await canAssignScorer(match, { organization: null }, { organization: null }, creator._id);

    expect(allowed).toBe(true);
  });

  it('is true for the owner of teamA\'s org, even if they did not create the match', async () => {
    const creator = await User.create({ email: 'creator2@example.com', password: 'password123', fullName: 'Creator' });
    const owner = await User.create({ email: 'owner2@example.com', password: 'password123', fullName: 'Owner' });
    const org = await Organization.create({
      name: 'Riverside CC 2', nameLower: 'riverside cc 2', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }],
    });
    const match = makeMatch(creator._id);

    const allowed = await canAssignScorer(match, { organization: org._id }, { organization: null }, owner._id);

    expect(allowed).toBe(true);
  });

  it('is false for a plain member of teamA\'s org who is not the owner', async () => {
    const creator = await User.create({ email: 'creator3@example.com', password: 'password123', fullName: 'Creator' });
    const owner = await User.create({ email: 'owner3@example.com', password: 'password123', fullName: 'Owner' });
    const member = await User.create({ email: 'member3@example.com', password: 'password123', fullName: 'Member' });
    const org = await Organization.create({
      name: 'Riverside CC 3', nameLower: 'riverside cc 3', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }, { user: member._id, role: 'member' }],
    });
    const match = makeMatch(creator._id);

    const allowed = await canAssignScorer(match, { organization: org._id }, { organization: null }, member._id);

    expect(allowed).toBe(false);
  });

  it('is false for a stranger with no relationship to the match or its teams', async () => {
    const creator = await User.create({ email: 'creator4@example.com', password: 'password123', fullName: 'Creator' });
    const stranger = await User.create({ email: 'stranger4@example.com', password: 'password123', fullName: 'Stranger' });
    const match = makeMatch(creator._id);

    const allowed = await canAssignScorer(match, { organization: null }, { organization: null }, stranger._id);

    expect(allowed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/organizationAccess.test.js -v`
Expected: FAIL — `qualifyingOrgOwnerIds is not a function` / `canAssignScorer is not a function`.

- [ ] **Step 3: Implement both functions**

Append to `src/utils/organizationAccess.js`:
```js
// The org(s), if any, whose owner may assign a scorer for a match between
// these two teams — the owner of teamA's org, the owner of teamB's org, or
// both if they differ. A team with no organization simply contributes
// nothing; if neither has one, the result is empty.
export const qualifyingOrgOwnerIds = async (teamA, teamB) => {
    const orgIds = [teamA.organization, teamB.organization].filter(Boolean);
    if (orgIds.length === 0) {
        return [];
    }
    const orgs = await Organization.find({ _id: { $in: orgIds }, isDeleted: false });
    return orgs.map((org) => String(org.owner));
};

// True if `userId` may assign/reassign/clear the scorer on `match` —
// either they created it, or they own an organization either team belongs
// to. Backs PATCH /v1/match/:matchId/scorer and
// GET /v1/match/:matchId/scorer-candidates.
export const canAssignScorer = async (match, teamA, teamB, userId) => {
    if (match.createdBy?.equals(userId)) {
        return true;
    }
    const ownerIds = await qualifyingOrgOwnerIds(teamA, teamB);
    return ownerIds.includes(String(userId));
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/organizationAccess.test.js -v`
Expected: PASS (all tests in the file, existing + new)

- [ ] **Step 5: Commit**

```bash
git add src/utils/organizationAccess.js tests/organizationAccess.test.js
git commit -m "$(cat <<'EOF'
feat: add qualifyingOrgOwnerIds and canAssignScorer

Pure-ish predicates behind who may assign a scorer: the match's own
creator, or the owner of an org either team belongs to — not any
member, and not anyone with no relationship to the match at all.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `PATCH /v1/match/:matchId/scorer`

**Files:**
- Modify: `src/controllers/match.controller.js` (add `assignScorer`, widen the export list)
- Modify: `src/routes/match.routes.js` (add the route)
- Modify: `src/locales/{en,hi,mr}/common.json` (add `MATCH_NOT_ORG_LINKED`, `INVALID_SCORER`,
  `SCORER_ASSIGNED`, `SCORER_UNASSIGNED`)
- Test: `tests/assignScorer.test.js` (create)

**Interfaces:**
- Consumes: `canAssignScorer` and `isOrgMember` (Task 3 and existing, from `organizationAccess.js`),
  `Organization` model, `User` model.
- Produces: `assignScorer` (exported from `match.controller.js`), mounted as
  `PATCH /v1/match/:matchId/scorer`. Task 5 reuses the same `canAssignScorer` call shape.

- [ ] **Step 1: Write the failing tests**

Create `tests/assignScorer.test.js`:
```js
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';

describe('PATCH /:matchId/scorer', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withOrganization: true });
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

  const createOrgTeam = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

  const assignScorer = (token, matchId, body) =>
    request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${token}`).send(body);

  // teamA belongs to an org with owner + one member; teamB is a plain
  // ad-hoc team. The match is created by the org owner using that org's
  // team, matching the real flow (createMatch with teamAId).
  const setupOrgMatch = async () => {
    const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
    const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'member@example.com' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;
    const matchId = await createMatch(app, ownerToken, { teamAId: teamId, teamBName: 'Visitors' });
    return { ownerToken, owner, memberToken, member, strangerToken, orgId, teamId, matchId };
  };

  it('lets the creator assign a member of the org that owns teamA as scorer', async () => {
    const { ownerToken, member, matchId } = await setupOrgMatch();

    const res = await assignScorer(ownerToken, matchId, { scorerId: String(member._id) });

    expect(res.status).toBe(200);
    expect(res.body.data.assignedScorer).toMatchObject({ id: String(member._id), name: 'Test User' });
    const match = await Match.findById(matchId);
    expect(match.assignedScorer.equals(member._id)).toBe(true);
  });

  it('lets the org owner assign a scorer even on a match they did not create', async () => {
    const { ownerToken, owner, memberToken, member, orgId, teamId } = await setupOrgMatch();
    // A second match, created by the member (not the owner) using the same org team.
    const matchId = await createMatch(app, memberToken, { teamAId: teamId, teamBName: 'Visitors 2' });

    const res = await assignScorer(ownerToken, matchId, { scorerId: String(member._id) });

    expect(res.status).toBe(200);
    expect(res.body.data.assignedScorer.id).toBe(String(member._id));
  });

  it('rejects a plain org member (not owner, not creator) trying to assign', async () => {
    const { memberToken, member, matchId } = await setupOrgMatch();

    const res = await assignScorer(memberToken, matchId, { scorerId: String(member._id) });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });

  it('rejects a stranger with no relationship to the match', async () => {
    const { strangerToken, member, matchId } = await setupOrgMatch();

    const res = await assignScorer(strangerToken, matchId, { scorerId: String(member._id) });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });

  it('rejects assigning a user who is not a member of any qualifying org', async () => {
    const { ownerToken, matchId } = await setupOrgMatch();
    const { user: outsider } = await createTestUser({ email: 'outsider@example.com' });

    const res = await assignScorer(ownerToken, matchId, { scorerId: String(outsider._id) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCORER');
  });

  it('rejects assigning on a match with no org-linked team', async () => {
    const { token } = await createTestUser({ email: 'adhoc@example.com' });
    const { user: other } = await createTestUser({ email: 'other@example.com' });
    const matchId = await createMatch(app, token);

    const res = await assignScorer(token, matchId, { scorerId: String(other._id) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MATCH_NOT_ORG_LINKED');
  });

  it('clears the assignment when scorerId is null', async () => {
    const { ownerToken, member, matchId } = await setupOrgMatch();
    await assignScorer(ownerToken, matchId, { scorerId: String(member._id) });

    const res = await assignScorer(ownerToken, matchId, { scorerId: null });

    expect(res.status).toBe(200);
    expect(res.body.data.assignedScorer).toBeNull();
    const match = await Match.findById(matchId);
    expect(match.assignedScorer).toBeNull();
  });

  it('reassigns to a different member, replacing the previous assignee', async () => {
    const { ownerToken, owner, member, orgId, matchId } = await setupOrgMatch();
    await addMember(ownerToken, orgId, { email: 'owner@example.com' }); // no-op guard, owner already a member
    await assignScorer(ownerToken, matchId, { scorerId: String(member._id) });

    const res = await assignScorer(ownerToken, matchId, { scorerId: String(owner._id) });

    expect(res.status).toBe(200);
    expect(res.body.data.assignedScorer.id).toBe(String(owner._id));
  });

  it('works on a completed match, not just upcoming/live', async () => {
    const { ownerToken, member, matchId } = await setupOrgMatch();
    await Match.updateOne({ _id: matchId }, { $set: { status: 'completed' } });

    const res = await assignScorer(ownerToken, matchId, { scorerId: String(member._id) });

    expect(res.status).toBe(200);
  });

  it('rejects with MATCH_NOT_FOUND for an unknown matchId', async () => {
    const { token } = await createTestUser();

    const res = await assignScorer(token, '000000000000000000000000', { scorerId: null });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MATCH_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/assignScorer.test.js -v`
Expected: FAIL — `PATCH /api/v1/match/:matchId/scorer` 404s (route doesn't exist yet).

- [ ] **Step 3: Add locale keys**

In `src/locales/en/common.json`, add (anywhere alongside the other `MATCH_*`/org keys — order doesn't
matter, just valid JSON):
```json
  "MATCH_NOT_ORG_LINKED": "This match has no organization-linked team to assign a scorer from",
  "INVALID_SCORER": "That user isn't a member of this match's organization",
  "SCORER_ASSIGNED": "Scorer assigned",
  "SCORER_UNASSIGNED": "Scorer unassigned",
```
In `src/locales/hi/common.json`:
```json
  "MATCH_NOT_ORG_LINKED": "इस मैच में स्कोरर असाइन करने के लिए कोई संगठन-लिंक्ड टीम नहीं है",
  "INVALID_SCORER": "वह उपयोगकर्ता इस मैच के संगठन का सदस्य नहीं है",
  "SCORER_ASSIGNED": "स्कोरर असाइन किया गया",
  "SCORER_UNASSIGNED": "स्कोरर हटाया गया",
```
In `src/locales/mr/common.json`:
```json
  "MATCH_NOT_ORG_LINKED": "या सामन्यात स्कोअरर नेमण्यासाठी कोणताही संस्था-लिंक्ड संघ नाही",
  "INVALID_SCORER": "तो वापरकर्ता या सामन्याच्या संस्थेचा सदस्य नाही",
  "SCORER_ASSIGNED": "स्कोअरर नेमला",
  "SCORER_UNASSIGNED": "स्कोअरर काढला",
```

- [ ] **Step 4: Add imports and the `assignScorer` handler to `match.controller.js`**

Widen the existing organization-access import (near the top of the file):
```js
import { canAccessTeam } from '../utils/organizationAccess.js';
```
becomes:
```js
import { canAccessTeam, canAssignScorer, isOrgMember } from '../utils/organizationAccess.js';
```
Add two new imports right after it:
```js
import { Organization } from '../models/organization.model.js';
import { User } from '../models/user.model.js';
```
Add the handler. A good spot is directly above `const getMatchHistory = catchAsync(...)` (search for
`// The first list endpoint in this codebase`):
```js
// Fetches both teams for the shared assign/candidates authorization check
// below — neither assignScorer nor getScorerCandidates can decide anything
// without knowing whether teamA/teamB belong to an organization.
const loadMatchTeams = async (match) => {
    const [teamA, teamB] = await Promise.all([
        Team.findById(match.teamA),
        Team.findById(match.teamB),
    ]);
    return { teamA, teamB };
};

const assignScorer = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const scorerId = req.body.scorerId ?? null;

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    const { teamA, teamB } = await loadMatchTeams(match);

    if (!(await canAssignScorer(match, teamA, teamB, req.user._id))) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }

    if (scorerId === null) {
        match.assignedScorer = null;
        await match.save();
        return res.status(200).json(new ApiResponse(200, {
            matchId: match._id,
            assignedScorer: null,
        }, req.t("SCORER_UNASSIGNED")));
    }

    const orgIds = [teamA.organization, teamB.organization].filter(Boolean);
    if (orgIds.length === 0) {
        throw new ApiError(400, "MATCH_NOT_ORG_LINKED");
    }

    const orgs = await Organization.find({ _id: { $in: orgIds }, isDeleted: false });
    const isEligible = orgs.some((org) => isOrgMember(org, scorerId));
    if (!isEligible) {
        throw new ApiError(400, "INVALID_SCORER");
    }

    match.assignedScorer = scorerId;
    await match.save();

    const scorer = await User.findById(scorerId, 'fullName');

    return res.status(200).json(new ApiResponse(200, {
        matchId: match._id,
        assignedScorer: { id: scorerId, name: scorer?.fullName ?? null },
    }, req.t("SCORER_ASSIGNED")));
});
```
Add `assignScorer` to the file's final `export { ... }` line.

- [ ] **Step 5: Add the route**

In `src/routes/match.routes.js`, widen the controller import:
```js
import { createMatch, startInnings, selectBowler, scoreBall, undoBall, syncMatch, getMatchScorecard, getPublicMatch, abandonMatch, deleteMatch, getMatchHistory } from "../controllers/match.controller.js";
```
becomes:
```js
import { createMatch, startInnings, selectBowler, scoreBall, undoBall, syncMatch, getMatchScorecard, getPublicMatch, abandonMatch, deleteMatch, getMatchHistory, assignScorer } from "../controllers/match.controller.js";
```
Add the route, right after `router.route('/:matchId/scorecard').get(verifyJwt, getMatchScorecard);`:
```js
router.route('/:matchId/scorer').patch(verifyJwt, assignScorer);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/assignScorer.test.js -v`
Expected: PASS (10/10)

- [ ] **Step 7: Run the locale parity test**

Run: `npx jest tests/locales.test.js -v`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/controllers/match.controller.js src/routes/match.routes.js src/locales tests/assignScorer.test.js
git commit -m "$(cat <<'EOF'
feat: add PATCH /v1/match/:matchId/scorer

Lets the match creator, or the owner of an org either team belongs
to, assign/reassign/clear a delegated scorer. Rejects a scorerId
outside the qualifying org(s) and a match with no org-linked team.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `GET /v1/match/:matchId/scorer-candidates`

**Files:**
- Modify: `src/controllers/match.controller.js` (add `getScorerCandidates`)
- Modify: `src/routes/match.routes.js` (add the route)
- Modify: `src/locales/{en,hi,mr}/common.json` (add `SCORER_CANDIDATES_FETCHED`)
- Test: `tests/scorerCandidates.test.js` (create)

**Interfaces:**
- Consumes: `canAssignScorer` (Task 3), `loadMatchTeams` (Task 4, same file).
- Produces: `getScorerCandidates` (exported from `match.controller.js`), mounted as
  `GET /v1/match/:matchId/scorer-candidates`.

- [ ] **Step 1: Write the failing tests**

Create `tests/scorerCandidates.test.js`:
```js
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

describe('GET /:matchId/scorer-candidates', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withOrganization: true });
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

  const createOrgTeam = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

  const getCandidates = (token, matchId) =>
    request(app).get(`/api/v1/match/${matchId}/scorer-candidates`).set('Authorization', `Bearer ${token}`);

  it('lists the org\'s members for a match created with an org-owned team', async () => {
    const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
    const { user: member } = await createTestUser({ email: 'member@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'member@example.com' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });

    const res = await getCandidates(ownerToken, matchId);

    expect(res.status).toBe(200);
    const ids = res.body.data.candidates.map((c) => c.id).sort();
    expect(ids).toEqual([String(owner._id), String(member._id)].sort());
  });

  it('returns an empty list for an authorized caller on a match with no org-linked team', async () => {
    const { token } = await createTestUser({ email: 'adhoc@example.com' });
    const matchId = await createMatch(app, token);

    const res = await getCandidates(token, matchId);

    expect(res.status).toBe(200);
    expect(res.body.data.candidates).toEqual([]);
  });

  it('rejects a caller with no assign-authority, even on a match with no org-linked team', async () => {
    const { token } = await createTestUser({ email: 'creator@example.com' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const matchId = await createMatch(app, token);

    const res = await getCandidates(strangerToken, matchId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });

  it('rejects with MATCH_NOT_FOUND for an unknown matchId', async () => {
    const { token } = await createTestUser();

    const res = await getCandidates(token, '000000000000000000000000');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MATCH_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/scorerCandidates.test.js -v`
Expected: FAIL — route 404s.

- [ ] **Step 3: Add the locale key**

`src/locales/en/common.json`: `"SCORER_CANDIDATES_FETCHED": "Scorer candidates fetched",`
`src/locales/hi/common.json`: `"SCORER_CANDIDATES_FETCHED": "स्कोरर उम्मीदवार प्राप्त हुए",`
`src/locales/mr/common.json`: `"SCORER_CANDIDATES_FETCHED": "स्कोअरर उमेदवार मिळाले",`

- [ ] **Step 4: Add the handler**

In `src/controllers/match.controller.js`, add right after `assignScorer`:
```js
const getScorerCandidates = catchAsync(async (req, res) => {
    const { matchId } = req.params;

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    const { teamA, teamB } = await loadMatchTeams(match);

    if (!(await canAssignScorer(match, teamA, teamB, req.user._id))) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }

    const orgIds = [teamA.organization, teamB.organization].filter(Boolean);
    if (orgIds.length === 0) {
        return res.status(200).json(new ApiResponse(200, { candidates: [] }, req.t("SCORER_CANDIDATES_FETCHED")));
    }

    const orgs = await Organization.find({ _id: { $in: orgIds }, isDeleted: false });
    await Promise.all(orgs.map((org) => org.populate('members.user', 'fullName')));

    // Deduped by user id — the same person can be a member of both teams'
    // orgs (or, once one is set, own both) and should appear once.
    const candidateById = new Map();
    for (const org of orgs) {
        for (const member of org.members) {
            candidateById.set(String(member.user._id), { id: member.user._id, name: member.user.fullName });
        }
    }

    return res.status(200).json(new ApiResponse(200, {
        candidates: [...candidateById.values()],
    }, req.t("SCORER_CANDIDATES_FETCHED")));
});
```
Add `getScorerCandidates` to the file's final `export { ... }` line.

- [ ] **Step 5: Add the route**

In `src/routes/match.routes.js`, widen the import to also bring in `getScorerCandidates`, and add,
right after the `/:matchId/scorer` route:
```js
router.route('/:matchId/scorer-candidates').get(verifyJwt, getScorerCandidates);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/scorerCandidates.test.js -v`
Expected: PASS (4/4)

- [ ] **Step 7: Commit**

```bash
git add src/controllers/match.controller.js src/routes/match.routes.js src/locales tests/scorerCandidates.test.js
git commit -m "$(cat <<'EOF'
feat: add GET /v1/match/:matchId/scorer-candidates

The picker source for assignScorer: whoever has assign-authority on
a match can list the eligible members of its team(s)' organization.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Widen the six scoring-path ownership checks

This is the core "loosens the check only for the specifically assigned scorer" requirement — one test
per endpoint per identity (creator, assigned scorer, plain org member, stranger), not inferred from a
single shared case.

**Files:**
- Modify: `src/controllers/match.controller.js` (6 call sites: `startInnings`, `selectBowler`,
  `scoreBall`, `undoBall`, `syncMatch`, `getMatchScorecard`)
- Modify: `tests/scoringFlow.test.js` (add assigned-scorer-can / plain-member-cannot tests for
  `start-innings`, `select-bowler`, `score-ball`, `undo-ball`)
- Modify: `tests/syncMatch.test.js` (same, for `sync`)
- Test: `tests/scorecardDelegatedScoring.test.js` (create, for `getMatchScorecard`)

**Interfaces:**
- Consumes: `Match.assignedScorer` (Task 2), the `assignScorer` endpoint (Task 4, used by tests to set up
  fixtures) and `PATCH /v1/organization/:orgId/members`/`POST /v1/organization/:orgId/teams` (existing,
  same fixture-building role as Task 4's own tests).

- [ ] **Step 1: Write the failing tests — `scoringFlow.test.js`**

This file already imports `request`, `randomUUID`, `buildTestApp`, `createTestUser`,
`createMatch`/`startLiveInnings`/`scoreDotBall`, `connectTestDb`/`disconnectTestDb`/`clearTestDb`, and
`Inning` — no new imports needed beyond widening `buildTestApp()` to `buildTestApp({ withOrganization: true })`
in its `beforeAll`. Add this shared fixture helper near the top of the file, after the `describe('scoring
flow', () => {` line's own `beforeAll`/`afterEach`/`afterAll` block:
```js
  // Every widened-check test in this file needs the same shape: an
  // org-owned teamA, an owner (the creator), a plain member, an assigned
  // scorer (also a plain member until assigned), and a stranger.
  const setupDelegatedMatch = async (overrides = {}) => {
    const { token: ownerToken, user: owner } = await createTestUser({ email: `owner-${randomUUID()}@example.com` });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: `scorer-${randomUUID()}@example.com` });
    const { token: memberToken, user: member } = await createTestUser({ email: `member-${randomUUID()}@example.com` });
    const { token: strangerToken } = await createTestUser({ email: `stranger-${randomUUID()}@example.com` });

    const orgRes = await request(app)
      .post('/api/v1/organization')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: `Org ${randomUUID()}` });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: member.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team' });
    const teamId = teamRes.body.data.id;

    const matchId = await createMatch(app, ownerToken, { teamAId: teamId, teamBName: 'Visitors', ...overrides });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });

    return { ownerToken, memberToken, scorerToken, strangerToken, matchId };
  };
```
Then add, inside `describe('POST /:matchId/start-innings', () => { ... })`, right after its existing
`'rejects with MATCH_NOT_OWNED for a different user'` test:
```js
    it('lets the assigned scorer start the innings', async () => {
      const { scorerToken, matchId } = await setupDelegatedMatch();

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/start-innings`)
        .set('Authorization', `Bearer ${scorerToken}`)
        .send({ strikerName: 'A', nonStrikerName: 'B', bowlerName: 'C' });

      expect(res.status).toBe(200);
    });

    it('still rejects a plain org member who is not the assigned scorer', async () => {
      const { memberToken, matchId } = await setupDelegatedMatch();

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/start-innings`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ strikerName: 'A', nonStrikerName: 'B', bowlerName: 'C' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });
```
Then, inside `describe('POST /:matchId/select-bowler', ...)`, add:
```js
    it('lets the assigned scorer select the bowler', async () => {
      const { ownerToken, scorerToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/select-bowler`)
        .set('Authorization', `Bearer ${scorerToken}`)
        .send({ bowlerName: 'Bowler Two' });

      expect(res.status).toBe(200);
    });

    it('still rejects a plain org member who is not the assigned scorer', async () => {
      const { ownerToken, memberToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/select-bowler`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ bowlerName: 'Bowler Two' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });
```
Then, inside `describe('POST /:matchId/score-ball', ...)`, add:
```js
    it('lets the assigned scorer score a ball', async () => {
      const { ownerToken, scorerToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/score-ball`)
        .set('Authorization', `Bearer ${scorerToken}`)
        .send({ runs: 1, idempotencyKey: randomUUID() });

      expect(res.status).toBe(200);
    });

    it('still rejects a plain org member who is not the assigned scorer', async () => {
      const { ownerToken, memberToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/score-ball`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ runs: 1, idempotencyKey: randomUUID() });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });
```
Then, inside `describe('POST /:matchId/undo-ball', ...)`, add:
```js
    it('lets the assigned scorer undo a ball', async () => {
      const { ownerToken, scorerToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);
      const scoreRes = await scoreDotBall(app, ownerToken, matchId);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/undo-ball`)
        .set('Authorization', `Bearer ${scorerToken}`)
        .send({ ballEventId: scoreRes.body.data.ballEventId });

      expect(res.status).toBe(200);
    });

    it('still rejects a plain org member who is not the assigned scorer', async () => {
      const { ownerToken, memberToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);
      const scoreRes = await scoreDotBall(app, ownerToken, matchId);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/undo-ball`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ ballEventId: scoreRes.body.data.ballEventId });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });
```
Finally, widen this file's `beforeAll` from `app = buildTestApp();` to `app = buildTestApp({ withOrganization: true });`
— `setupDelegatedMatch` needs `/api/v1/organization/*` mounted.

*(If any exact request-body field name above — e.g. `ballEventId`'s location in `scoreDotBall`'s
response — doesn't match this file's other existing tests once you read them, follow the existing
tests' own shape; they're the ground truth for this file's request/response field names, not this
plan.)*

- [ ] **Step 2: Write the failing test — `syncMatch.test.js`**

This file already has `ballEvent(overrides)` and `sync(token, matchId, body)` helpers, and calls
`buildTestApp()` with no options in its `beforeAll` — widen that call to
`buildTestApp({ withOrganization: true })`. Then add, near its existing
`'rejects with MATCH_NOT_OWNED for a different user'` test:
```js
  it('lets the assigned scorer sync a batch', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: 'scorer@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });
    await startLiveInnings(app, ownerToken, matchId);

    const res = await sync(scorerToken, matchId, {
      inningsNumber: 1,
      baseAbsoluteBallSeq: 0,
      events: [ballEvent({ runs: 1 })],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.appliedCount).toBe(1);
  });

  it('still rejects a plain org member who is not the assigned scorer', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner2@example.com' });
    const { token: memberToken, user: member } = await createTestUser({ email: 'member2@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org 2' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: member.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team 2' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await startLiveInnings(app, ownerToken, matchId);

    const res = await sync(memberToken, matchId, {
      inningsNumber: 1,
      baseAbsoluteBallSeq: 0,
      events: [ballEvent({ runs: 1 })],
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });
```

- [ ] **Step 3: Write the failing test — `scorecardDelegatedScoring.test.js`**

Create `tests/scorecardDelegatedScoring.test.js`:
```js
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

describe('GET /:matchId/scorecard — delegated scoring', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withOrganization: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const setupDelegatedMatch = async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: 'scorer@example.com' });
    const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: member.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });
    await startLiveInnings(app, ownerToken, matchId);
    return { ownerToken, scorerToken, memberToken, matchId };
  };

  it('lets the assigned scorer view the scorecard', async () => {
    const { scorerToken, matchId } = await setupDelegatedMatch();

    const res = await request(app).get(`/api/v1/match/${matchId}/scorecard`).set('Authorization', `Bearer ${scorerToken}`);

    expect(res.status).toBe(200);
  });

  it('still rejects a plain org member who is not the assigned scorer', async () => {
    const { memberToken, matchId } = await setupDelegatedMatch();

    const res = await request(app).get(`/api/v1/match/${matchId}/scorecard`).set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });
});
```

- [ ] **Step 4: Run all three to verify they fail**

Run: `npx jest tests/scoringFlow.test.js tests/syncMatch.test.js tests/scorecardDelegatedScoring.test.js -v`
Expected: FAIL — every new "lets the assigned scorer ..." test gets 403, since the check isn't widened yet.

- [ ] **Step 5: Widen all six call sites in `match.controller.js`**

The check itself — `if (!match.createdBy?.equals(req.user._id)) { throw new ApiError(403,
"MATCH_NOT_OWNED"); }` — is byte-for-byte identical at **eight** locations in this file: the six being
widened here, plus `abandonMatch` and `deleteMatch` (untouched — see Task 7). A find-and-replace on that
line alone is ambiguous and risks silently touching the wrong two. Each block below includes enough of
its function's own unique preceding lines to make the whole block a safe, unambiguous exact-match
replacement — use each one individually, never a blanket replace-all across the file.

**In `startInnings`** (identified by the preceding `OPENER_NAMES_MUST_DIFFER`/`BOWLER_NAME_REQUIRED`
checks, unique to this function):
```js
    if (striker.toLowerCase() === nonStriker.toLowerCase()) {
        throw new ApiError(400, "OPENER_NAMES_MUST_DIFFER");
    }

    const bowler = asString(bowlerName).trim();

    if (!bowler || bowler.length > MAX_PLAYER_NAME_LENGTH) {
        throw new ApiError(400, "BOWLER_NAME_REQUIRED");
    }

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```
becomes (only the last three lines actually change — the rest is included solely to make the match
unique):
```js
    if (striker.toLowerCase() === nonStriker.toLowerCase()) {
        throw new ApiError(400, "OPENER_NAMES_MUST_DIFFER");
    }

    const bowler = asString(bowlerName).trim();

    if (!bowler || bowler.length > MAX_PLAYER_NAME_LENGTH) {
        throw new ApiError(400, "BOWLER_NAME_REQUIRED");
    }

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id) && !match.assignedScorer?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```

**In `selectBowler`** (identified by its own `const selectBowler = catchAsync` opening, a few lines
above):
```js
const selectBowler = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const { bowlerName, bowlerId } = validateBowlerInput(req.body);

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```
becomes:
```js
const selectBowler = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const { bowlerName, bowlerId } = validateBowlerInput(req.body);

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id) && !match.assignedScorer?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```

**In `scoreBall`** (identified by its own opening plus `let match`, not `const match`):
```js
const scoreBall = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const input = validateBallInput(req.body);

    let match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```
becomes:
```js
const scoreBall = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const input = validateBallInput(req.body);

    let match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id) && !match.assignedScorer?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```

**In `undoBall`**:
```js
const undoBall = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const { ballEventId } = validateUndoInput(req.body);

    let match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```
becomes:
```js
const undoBall = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const { ballEventId } = validateUndoInput(req.body);

    let match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id) && !match.assignedScorer?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```

**In `syncMatch`**:
```js
const syncMatch = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const { inningsNumber, baseAbsoluteBallSeq, events, isUndoBatch } = validateSyncRequest(req.body);

    let match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```
becomes:
```js
const syncMatch = catchAsync(async (req, res) => {
    const { matchId } = req.params;
    const { inningsNumber, baseAbsoluteBallSeq, events, isUndoBatch } = validateSyncRequest(req.body);

    let match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id) && !match.assignedScorer?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```

**In `getMatchScorecard`** (identified by its own `const getMatchScorecard = catchAsync` opening — this
one, unlike the previous four, has no intervening validation line between `const { matchId } =
req.params;` and the `Match.findOne` call):
```js
const getMatchScorecard = catchAsync(async (req, res) => {
    const { matchId } = req.params;

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```
becomes:
```js
const getMatchScorecard = catchAsync(async (req, res) => {
    const { matchId } = req.params;

    const match = await Match.findOne({ _id: matchId, isDeleted: false });
    if (!match) {
        throw new ApiError(404, "MATCH_NOT_FOUND");
    }

    if (!match.createdBy?.equals(req.user._id) && !match.assignedScorer?.equals(req.user._id)) {
        throw new ApiError(403, "MATCH_NOT_OWNED");
    }
```

Do **not** touch the matching block inside `abandonMatch` or `deleteMatch` (both also `const match =
await Match.findOne(...)`, both immediately preceded only by `const { matchId } = req.params;`, same as
`getMatchScorecard` — this is exactly why they're easy to hit by accident with a careless replace-all)
— Task 7 adds tests proving those two are deliberately left alone.

- [ ] **Step 6: Run all three files again to verify they pass**

Run: `npx jest tests/scoringFlow.test.js tests/syncMatch.test.js tests/scorecardDelegatedScoring.test.js -v`
Expected: PASS, all tests (existing + new).

- [ ] **Step 7: Run the full existing suite to confirm no regression**

Run: `npx jest --maxWorkers=2`
Expected: every previously-passing test still passes (a `MongoMemoryReplSet` `beforeAll` timeout under
full parallelism is a known pre-existing flake in this suite, not a regression — if you see scattered
`beforeAll` timeouts, rerun with `--maxWorkers=2` before treating anything as a real failure).

- [ ] **Step 8: Commit**

```bash
git add src/controllers/match.controller.js tests/scoringFlow.test.js tests/syncMatch.test.js tests/scorecardDelegatedScoring.test.js
git commit -m "$(cat <<'EOF'
feat: let the assigned scorer score, not just the match creator

Widens startInnings/selectBowler/scoreBall/undoBall/syncMatch/
getMatchScorecard's ownership check to createdBy OR assignedScorer.
One test per endpoint proves a plain org member who isn't the
assigned scorer is still rejected — this only opens the door for the
specific person assigned, not the org at large.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Regression-lock `abandonMatch`/`deleteMatch` stay creator-only

Test-only — no production code changes. This is the explicit proof that Task 6's widening has a hard
boundary.

**Files:**
- Modify: `tests/matchAbandonDelete.test.js` (existing file — add to it)

**Interfaces:**
- Consumes: `assignScorer` (Task 4), the same delegated-match fixture shape as Task 6.

- [ ] **Step 1: Write the tests**

Read `tests/matchAbandonDelete.test.js`'s existing `beforeAll`/fixture setup first — it currently calls
`buildTestApp()` with no options; widen it to `buildTestApp({ withOrganization: true })`. Then add, near
its existing `'rejects with MATCH_NOT_OWNED when abandoned by a different user'` test:
```js
  it('rejects an assigned scorer trying to abandon the match', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: 'scorer@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/abandon`)
      .set('Authorization', `Bearer ${scorerToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });

  it('rejects an assigned scorer trying to delete the match', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner2@example.com' });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: 'scorer2@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org 2' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team 2' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });

    const res = await request(app)
      .delete(`/api/v1/match/${matchId}`)
      .set('Authorization', `Bearer ${scorerToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });
```
*(If this file doesn't already import `request`/`createMatch`/`createTestUser` under those exact names,
match whatever it already imports them as — it already has working abandon/delete tests to copy the
import style from.)*

- [ ] **Step 2: Run to verify it currently fails for the right reason first, then passes**

Run: `npx jest tests/matchAbandonDelete.test.js -v`

Since Task 6 never touched `abandonMatch`/`deleteMatch`, these two new tests should **already pass** as
soon as they're added (no production code change needed here) — this step is verifying that fact, not
watching a red-to-green transition. If either fails, that means Task 6's Step 5 accidentally touched
`abandonMatch` or `deleteMatch` — go back and check `git diff` for this file for changes to those two
functions and revert them.

Expected: PASS (all tests in the file, existing + 2 new).

- [ ] **Step 3: Commit**

```bash
git add tests/matchAbandonDelete.test.js
git commit -m "$(cat <<'EOF'
test: lock abandonMatch/deleteMatch to creator-only

Regression proof that delegated scoring's widened check never
touched these two administrative actions — an assigned scorer still
cannot abandon or delete a match they don't own.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Widen `getMatchHistory` and `getTeamMatches`

**Files:**
- Modify: `src/controllers/match.controller.js` (`getMatchHistory`)
- Modify: `src/controllers/team.controller.js` (`getTeamMatches`)
- Modify: `tests/matchHistory.test.js` (existing — add to it)
- Modify: `tests/teamMatches.test.js` (existing — add to it)

**Interfaces:**
- Consumes: `Match.assignedScorer` (Task 2), `User` model (already imported into `match.controller.js`
  by Task 4; needs adding to `team.controller.js`).

- [ ] **Step 1: Write the failing test — `matchHistory.test.js`**

Add to `tests/matchHistory.test.js` (following whatever import/fixture style it already uses for
`buildTestApp`/`createTestUser`/`createMatch` — widen its `beforeAll`'s `buildTestApp()` call to
`buildTestApp({ withOrganization: true })`):
```js
  it('includes a match the caller is the assigned scorer on, not just ones they created', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: 'scorer@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });

    const res = await request(app).get('/api/v1/match/history').set('Authorization', `Bearer ${scorerToken}`);

    expect(res.status).toBe(200);
    const match = res.body.data.matches.find((m) => m.matchId === matchId);
    expect(match).toBeDefined();
    expect(match.createdBy.id).toBeDefined();
    expect(match.assignedScorer.id).toBe(String(scorer._id));
  });

  it('shows the assignedScorer on the creator\'s own list once delegated', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner2@example.com' });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: 'scorer2@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org 2' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team 2' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });

    const res = await request(app).get('/api/v1/match/history').set('Authorization', `Bearer ${ownerToken}`);

    const match = res.body.data.matches.find((m) => m.matchId === matchId);
    expect(match.assignedScorer).toMatchObject({ id: String(scorer._id) });
  });

  it('still shows assignedScorer as null for a match with no delegation', async () => {
    const { token } = await createTestUser({ email: 'solo@example.com' });
    await createMatch(app, token);

    const res = await request(app).get('/api/v1/match/history').set('Authorization', `Bearer ${token}`);

    expect(res.body.data.matches[0].assignedScorer).toBeNull();
  });
```

- [ ] **Step 2: Write the failing test — `teamMatches.test.js`**

This file has its own local `createMatch(token, body)` helper (note: two args, not three — it doesn't
take `app`, unlike `matchSetup.js`'s shared one) and calls `buildTestApp({ withTeam: true })` in its
`beforeAll` — widen that to `buildTestApp({ withTeam: true, withOrganization: true })`. Then add:
```js
  it('carries createdBy/assignedScorer on each entry', async () => {
    const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
    const { user: scorer } = await createTestUser({ email: 'scorer@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team' });
    const teamId = teamRes.body.data.id;
    const matchRes = await createMatch(ownerToken, { teamAId: teamId, teamBName: 'Visitors' });
    const matchId = matchRes.body.data.matchId;
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });

    const res = await teamMatches(ownerToken, teamId);

    expect(res.status).toBe(200);
    const match = res.body.data.matches.find((m) => m.matchId === matchId);
    expect(match.createdBy).toMatchObject({ id: String(owner._id) });
    expect(match.assignedScorer).toMatchObject({ id: String(scorer._id) });
  });
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx jest tests/matchHistory.test.js tests/teamMatches.test.js -v`
Expected: FAIL — `match.createdBy`/`match.assignedScorer` are `undefined` in the response (fields don't
exist yet), and the first new history test fails outright since the filter doesn't include
`assignedScorer` yet.

- [ ] **Step 4: Widen `getMatchHistory`**

In `src/controllers/match.controller.js`, inside `getMatchHistory`, change:
```js
    const filter = { createdBy: req.user._id, isDeleted: false };
```
to:
```js
    const filter = { $or: [{ createdBy: req.user._id }, { assignedScorer: req.user._id }], isDeleted: false };
```
Then, right after the existing `teamNameById` construction (`const teamNameById = new Map(...)`), add:
```js
    // Same batching reasoning as teamIds above — one lookup for every
    // createdBy/assignedScorer this page needs a display name for.
    const userIds = [...new Set(matches.flatMap((match) => [
        match.createdBy ? String(match.createdBy) : null,
        match.assignedScorer ? String(match.assignedScorer) : null,
    ]).filter(Boolean))];
    const users = await User.find({ _id: { $in: userIds } }, 'fullName');
    const userNameById = new Map(users.map((user) => [String(user._id), user.fullName]));
```
Then, inside the `matches.map((match) => ({ ... }))` object, add two fields right after `tossDecision`:
```js
        createdBy: match.createdBy
            ? { id: match.createdBy, name: userNameById.get(String(match.createdBy)) ?? null }
            : null,
        assignedScorer: match.assignedScorer
            ? { id: match.assignedScorer, name: userNameById.get(String(match.assignedScorer)) ?? null }
            : null,
```
(`User` is already imported into this file from Task 4.)

- [ ] **Step 5: Widen `getTeamMatches`**

In `src/controllers/team.controller.js`, add the import:
```js
import { User } from '../models/user.model.js';
```
Then apply the identical transformation as Step 4 to `getTeamMatches`: no filter change needed here
(it's already `$or: [{teamA}, {teamB}]`, unrelated to who can score), but add the same `userIds`/`users`/
`userNameById` block right after its existing `teamNameById` construction, and add the same two
`createdBy`/`assignedScorer` fields to its `matches.map(...)` response.

- [ ] **Step 6: Run both to verify they pass**

Run: `npx jest tests/matchHistory.test.js tests/teamMatches.test.js -v`
Expected: PASS (all tests in both files, existing + new).

- [ ] **Step 7: Commit**

```bash
git add src/controllers/match.controller.js src/controllers/team.controller.js tests/matchHistory.test.js tests/teamMatches.test.js
git commit -m "$(cat <<'EOF'
feat: widen match-history/team-matches to include delegated matches

GET /v1/match/history and GET /v1/team/:teamId/matches now also
return matches the caller is the assignedScorer on (not just ones
they created), and each entry carries createdBy/assignedScorer refs
so a client can label a delegated match.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Backend verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `npx jest --maxWorkers=2`
Expected: 100% pass. Record the exact pass count.

- [ ] **Step 2: Run lint, if the project has one**

Run: `npm run lint` (check `package.json`'s `scripts` first — if there's no `lint` script, note that and
skip; don't invent one).

- [ ] **Step 3: Confirm locale parity**

Run: `npx jest tests/locales.test.js -v`
Expected: PASS.

- [ ] **Step 4: Confirm the route auth allowlist still passes**

Run: `npx jest tests/routes.auth.test.js -v`
Expected: PASS — the two new routes both carry `verifyJwt`, and `match`'s allowlist entry is unchanged
(only `/public/:code` is public; neither new route is).

- [ ] **Step 5: Produce curl evidence for both delegation paths**

Using a running dev server (ask before starting one — do not start/stop the backend yourself, per this
project's own convention), or by keeping the exact request/response pairs from Task 4/5's passing tests,
write out:
1. A curl sequence: org owner creates an org, adds a member, creates an org team, creates a match with
   that team, assigns the member as scorer, and the member successfully calls `score-ball`.
2. A curl sequence: a plain org member (not owner, not assigned) attempts `score-ball` on that same match
   and receives `403 MATCH_NOT_OWNED`.

Save both as `docs/superpowers/plans/2026-09-05-delegated-scoring-curl-examples.md`, mirroring the format
of the existing `2026-09-05-organizations-curl-examples.md` in the same directory.

- [ ] **Step 6: Report actual evidence**

State the exact test counts, lint result, and locale/allowlist results — per
`superpowers:verification-before-completion`, no completion claim without this evidence having actually
been run in this pass.

---

## Task 10: Frontend — branch, response models, and API wiring

**Files:**
- Create: `cricket-scrorer` branch `feat-delegated-scoring` off up-to-date `development`
- Modify: `lib/features/scoring/data/models/response/match_history_res.dart` (add `MatchUserRef`, widen
  `MatchHistoryItem`)
- Create: `lib/features/scoring/data/models/response/scorer_candidates_res.dart`
- Create: `lib/features/scoring/data/models/response/assign_scorer_res.dart`
- Modify: `lib/features/scoring/data/match_endpoint.dart` (add two paths)
- Modify: `lib/features/scoring/data/data_sources/remote/match_api_service/match_api_service.dart` (add
  two methods)
- Modify: `lib/features/scoring/domain/repositories/match_repository.dart` (add two methods)
- Modify: `lib/features/scoring/data/repositories/match_repository_impl.dart` (implement them)
- Create: `lib/features/scoring/domain/usecases/get_scorer_candidates.dart`
- Create: `lib/features/scoring/domain/usecases/assign_scorer.dart`
- Modify: `lib/core/di/injection/scoring_injection.dart` (register both use cases)
- Create: `lib/core/utils/current_user.dart` (extracted from `organization_detail_binding.dart`)
- Modify: `lib/features/organization/presentation/bindings/organization_detail_binding.dart` (use the
  extracted util instead of its own private copy)
- Modify: 3 fake `MatchRepository` test doubles that implement the full interface (see Step 8)

**Interfaces:**
- Produces: `MatchUserRef {id, name}`, `MatchHistoryItem.createdBy`/`.assignedScorer` (both
  `MatchUserRef?`), `ScorerCandidatesRes {candidates: List<MatchUserRef>}`,
  `AssignScorerRes {matchId, assignedScorer: MatchUserRef?}`, `GetScorerCandidatesUseCase`,
  `AssignScorerUseCase`, `currentUserId(): String`. Task 12 consumes all of these.

- [ ] **Step 1: Create the branch**

```bash
cd cricket-scrorer
git status
git checkout development
git pull --ff-only
git checkout -b feat-delegated-scoring
```

- [ ] **Step 2: Add `MatchUserRef` and widen `MatchHistoryItem`**

In `lib/features/scoring/data/models/response/match_history_res.dart`, add this class right before
`MatchHistoryItem`:
```dart
/// A `{id, name}` reference to a user — `MatchHistoryItem.createdBy`/
/// `.assignedScorer`, `ScorerCandidatesRes`, and `AssignScorerRes` all share
/// this shape since they're the same wire contract from the same feature
/// slice, unlike `OrganizationRef`/`OrganizationUserRef` (kept distinct
/// because those two coincidentally match across unrelated features).
@JsonSerializable()
class MatchUserRef {
  final String id;
  final String name;

  MatchUserRef({required this.id, required this.name});

  factory MatchUserRef.fromJson(Map<String, dynamic> json) =>
      _$MatchUserRefFromJson(json);

  Map<String, dynamic> toJson() => _$MatchUserRefToJson(this);
}
```
Then add two fields to `MatchHistoryItem`, right after `tossDecision`:
```dart
  /// Who created this match — always present. Lets a client render
  /// "Assigned by X" when it differs from the viewer's own id (see
  /// [assignedScorer] below and docs/api.md's delegated-scoring contract).
  final MatchUserRef? createdBy;

  /// Non-null once the creator (or a qualifying org owner) has delegated
  /// scoring for this match to someone else. Null for every match created
  /// before this feature and every ad-hoc match since.
  final MatchUserRef? assignedScorer;
```
Add both to the constructor (as optional named params, matching the file's existing style — e.g.
`this.createdBy,` and `this.assignedScorer,` alongside the existing `this.joinCode,`). Also add a
`copyWith` method (there isn't one today — needed by Task 12's controller methods to update one cached
item's `assignedScorer` in place after a successful assign):
```dart
  MatchHistoryItem copyWith({MatchUserRef? assignedScorer}) => MatchHistoryItem(
    matchId: matchId,
    teamA: teamA,
    teamB: teamB,
    joinCode: joinCode,
    totalOvers: totalOvers,
    status: status,
    result: result,
    tossWinner: tossWinner,
    tossDecision: tossDecision,
    createdBy: createdBy,
    assignedScorer: assignedScorer,
    createdAt: createdAt,
  );
```

- [ ] **Step 3: Regenerate JSON serialization code**

Run: `dart run build_runner build --delete-conflicting-outputs`
Expected: `match_history_res.g.dart` regenerates with `MatchUserRef`'s and the widened
`MatchHistoryItem`'s `fromJson`/`toJson`, no errors.

- [ ] **Step 4: Create the two new response models**

`lib/features/scoring/data/models/response/scorer_candidates_res.dart`:
```dart
import 'package:cricket_scorer/features/scoring/data/models/response/match_history_res.dart'
    show MatchUserRef;
import 'package:json_annotation/json_annotation.dart';

part 'scorer_candidates_res.g.dart';

/// `GET /v1/match/:matchId/scorer-candidates` — the members of whichever
/// org(s) own teamA/teamB, empty when neither team is org-linked.
@JsonSerializable(explicitToJson: true)
class ScorerCandidatesRes {
  final List<MatchUserRef> candidates;

  ScorerCandidatesRes({required this.candidates});

  factory ScorerCandidatesRes.fromJson(Map<String, dynamic> json) =>
      _$ScorerCandidatesResFromJson(json);

  Map<String, dynamic> toJson() => _$ScorerCandidatesResToJson(this);
}
```
`lib/features/scoring/data/models/response/assign_scorer_res.dart`:
```dart
import 'package:cricket_scorer/features/scoring/data/models/response/match_history_res.dart'
    show MatchUserRef;
import 'package:json_annotation/json_annotation.dart';

part 'assign_scorer_res.g.dart';

/// `PATCH /v1/match/:matchId/scorer`'s response. [assignedScorer] is null
/// after a clear (`scorerId: null` in the request).
@JsonSerializable(explicitToJson: true)
class AssignScorerRes {
  final String matchId;
  final MatchUserRef? assignedScorer;

  AssignScorerRes({required this.matchId, this.assignedScorer});

  factory AssignScorerRes.fromJson(Map<String, dynamic> json) =>
      _$AssignScorerResFromJson(json);

  Map<String, dynamic> toJson() => _$AssignScorerResToJson(this);
}
```

- [ ] **Step 5: Regenerate JSON serialization code again**

Run: `dart run build_runner build --delete-conflicting-outputs`
Expected: `scorer_candidates_res.g.dart` and `assign_scorer_res.g.dart` are created, no errors.

- [ ] **Step 6: Add endpoint paths, API service methods, repository methods, and use cases**

In `lib/features/scoring/data/match_endpoint.dart`, add:
```dart
  /// `GET /v1/match/:matchId/scorer-candidates` — who a caller with assign-
  /// authority can pick from.
  String scorerCandidates(String matchId) =>
      '/v1/match/$matchId/scorer-candidates';

  /// `PATCH /v1/match/:matchId/scorer` — assign/reassign (`scorerId`) or
  /// clear (`scorerId: null`) the delegated scorer on this match.
  String assignScorer(String matchId) => '/v1/match/$matchId/scorer';
```
In `lib/features/scoring/data/data_sources/remote/match_api_service/match_api_service.dart`, add:
```dart
  Future<Either<ApiResponseModel, CricketFailure>> getScorerCandidates({
    required String matchId,
  }) async {
    return await apiClient.get(
      endpoint: matchEndpoint.scorerCandidates(matchId),
    );
  }

  Future<Either<ApiResponseModel, CricketFailure>> assignScorer({
    required String matchId,
    required String? scorerId,
  }) async {
    return await apiClient.patch(
      endpoint: matchEndpoint.assignScorer(matchId),
      data: {'scorerId': scorerId},
    );
  }
```
In `lib/features/scoring/domain/repositories/match_repository.dart`, add to the imports:
```dart
import 'package:cricket_scorer/features/scoring/data/models/response/scorer_candidates_res.dart';
import 'package:cricket_scorer/features/scoring/data/models/response/assign_scorer_res.dart';
```
and to the abstract class body:
```dart
  /// `GET /v1/match/:matchId/scorer-candidates` — see docs/api.md's
  /// delegated-scoring contract. Empty when neither team is org-linked;
  /// `CricketForbiddenErrorFailure` when the caller has no assign-authority
  /// at all on this match.
  Future<Either<CricketResponse<ScorerCandidatesRes>, CricketFailure>>
  getScorerCandidates({required String matchId});

  /// `PATCH /v1/match/:matchId/scorer` — assign/reassign (`scorerId`) or
  /// clear (`scorerId: null`) the match's delegated scorer.
  Future<Either<CricketResponse<AssignScorerRes>, CricketFailure>>
  assignScorer({required String matchId, required String? scorerId});
```
In `lib/features/scoring/data/repositories/match_repository_impl.dart`, add the same two imports and
implement both methods, mirroring `updateTeamOrganization`'s existing shape exactly:
```dart
  @override
  Future<Either<CricketResponse<ScorerCandidatesRes>, CricketFailure>>
  getScorerCandidates({required String matchId}) async {
    Either<ApiResponseModel, CricketFailure> response = await matchApiService
        .getScorerCandidates(matchId: matchId);
    if (response.isResult) {
      return Either.result(
        CricketResponse(
          data: ScorerCandidatesRes.fromJson(
            response.result.data as Map<String, dynamic>,
          ),
          message: response.result.message,
        ),
      );
    } else {
      return Either.fallback(response.fallback);
    }
  }

  @override
  Future<Either<CricketResponse<AssignScorerRes>, CricketFailure>>
  assignScorer({required String matchId, required String? scorerId}) async {
    Either<ApiResponseModel, CricketFailure> response = await matchApiService
        .assignScorer(matchId: matchId, scorerId: scorerId);
    if (response.isResult) {
      return Either.result(
        CricketResponse(
          data: AssignScorerRes.fromJson(
            response.result.data as Map<String, dynamic>,
          ),
          message: response.result.message,
        ),
      );
    } else {
      return Either.fallback(response.fallback);
    }
  }
```
Create `lib/features/scoring/domain/usecases/get_scorer_candidates.dart`:
```dart
import 'package:cricket_scorer/core/error/cricket_failure.dart';
import 'package:cricket_scorer/core/network/models/cricket_response.dart';
import 'package:cricket_scorer/core/usecase/usecase.dart';
import 'package:cricket_scorer/core/utils/either_util.dart';
import 'package:cricket_scorer/features/scoring/data/models/response/scorer_candidates_res.dart';
import 'package:cricket_scorer/features/scoring/domain/repositories/match_repository.dart';

class GetScorerCandidatesParams {
  final String matchId;

  const GetScorerCandidatesParams({required this.matchId});
}

class GetScorerCandidatesUseCase
    implements
        UseCase<
          Either<CricketResponse<ScorerCandidatesRes>, CricketFailure>,
          GetScorerCandidatesParams
        > {
  final MatchRepository matchRepository;

  GetScorerCandidatesUseCase({required this.matchRepository});

  @override
  Future<Either<CricketResponse<ScorerCandidatesRes>, CricketFailure>> call({
    GetScorerCandidatesParams? params,
  }) {
    return matchRepository.getScorerCandidates(matchId: params!.matchId);
  }
}
```
Create `lib/features/scoring/domain/usecases/assign_scorer.dart`:
```dart
import 'package:cricket_scorer/core/error/cricket_failure.dart';
import 'package:cricket_scorer/core/network/models/cricket_response.dart';
import 'package:cricket_scorer/core/usecase/usecase.dart';
import 'package:cricket_scorer/core/utils/either_util.dart';
import 'package:cricket_scorer/features/scoring/data/models/response/assign_scorer_res.dart';
import 'package:cricket_scorer/features/scoring/domain/repositories/match_repository.dart';

class AssignScorerParams {
  final String matchId;
  final String? scorerId;

  const AssignScorerParams({required this.matchId, this.scorerId});
}

class AssignScorerUseCase
    implements
        UseCase<
          Either<CricketResponse<AssignScorerRes>, CricketFailure>,
          AssignScorerParams
        > {
  final MatchRepository matchRepository;

  AssignScorerUseCase({required this.matchRepository});

  @override
  Future<Either<CricketResponse<AssignScorerRes>, CricketFailure>> call({
    AssignScorerParams? params,
  }) {
    final resolved = params!;
    return matchRepository.assignScorer(
      matchId: resolved.matchId,
      scorerId: resolved.scorerId,
    );
  }
}
```
In `lib/core/di/injection/scoring_injection.dart`, add the two imports and register both, alongside the
other `Get.lazyPut<...UseCase>` calls:
```dart
    Get.lazyPut<GetScorerCandidatesUseCase>(
      () => GetScorerCandidatesUseCase(
        matchRepository: Get.find<MatchRepository>(),
      ),
      fenix: true,
    );

    Get.lazyPut<AssignScorerUseCase>(
      () => AssignScorerUseCase(matchRepository: Get.find<MatchRepository>()),
      fenix: true,
    );
```

- [ ] **Step 7: Extract the shared `currentUserId()` util**

Create `lib/core/utils/current_user.dart`:
```dart
import 'dart:convert';

import 'package:cricket_scorer/core/constants/shared_pref_key.dart';
import 'package:cricket_scorer/core/services/shared_preference_service.dart';
import 'package:cricket_scorer/features/auth/data/models/user.dart';

/// The signed-in user's id, read synchronously from the same cache
/// `language_service.dart`'s own sync already relies on: the stored value
/// is a `LoggedInUser`'s JSON (written by `login_controller.dart`), decoded
/// here via `User.fromJson` — both map their id from the same `_id` JSON
/// key, so the cross-decode is exactly what that existing call site already
/// depends on working. Synchronous because a `Bindings.dependencies()`
/// override, one of this function's callers, cannot await a network call
/// before returning.
String currentUserId() {
  final userJson =
      SharedPreferenceService.sharedPrefService.get(SharedPrefKey.userDetails)
          as String?;
  if (userJson == null) return '';
  final user = User.fromJson(jsonDecode(userJson) as Map<String, dynamic>);
  return user.id ?? '';
}
```
In `lib/features/organization/presentation/bindings/organization_detail_binding.dart`, delete the
private `_currentUserId()` function and its four imports (`dart:convert`,
`core/constants/shared_pref_key.dart`, `core/services/shared_preference_service.dart`,
`features/auth/data/models/user.dart`), replacing them with:
```dart
import 'package:cricket_scorer/core/utils/current_user.dart';
```
and replace its one call site, `currentUserId: _currentUserId(),`, with `currentUserId: currentUserId(),`.

- [ ] **Step 8: Fix the fake `MatchRepository` test doubles**

`MatchRepository` gained two new abstract methods in Step 6 — every test file with a hand-written fake
implementing the full interface now fails to compile. Run:
```bash
flutter analyze 2>&1 | grep -B2 "must be implemented\|missing_required_argument\|non_abstract_class"
```
For each fake class it flags (expect `test/features/home/presentation/controllers/home_controller_test.dart`,
`test/features/scoring/presentation/controllers/score_ball_controller_test.dart` — likely more than one
fake class in that file — and `test/features/scoring/presentation/controllers/spectator_controller_test.dart`,
based on this codebase's own precedent the last time `MatchRepository` grew a method), add both new
imports and both overrides:
```dart
import 'package:cricket_scorer/features/scoring/data/models/response/scorer_candidates_res.dart';
import 'package:cricket_scorer/features/scoring/data/models/response/assign_scorer_res.dart';
```
```dart
  @override
  Future<Either<CricketResponse<ScorerCandidatesRes>, CricketFailure>>
  getScorerCandidates({required String matchId}) =>
      throw UnimplementedError('Not exercised in this test.');

  @override
  Future<Either<CricketResponse<AssignScorerRes>, CricketFailure>>
  assignScorer({required String matchId, required String? scorerId}) =>
      throw UnimplementedError('Not exercised in this test.');
```
If a fake class in `score_ball_controller_test.dart` is identical across multiple test doubles in that
file, use one `replace_all` edit rather than repeating the insertion by hand, matching how the
Organizations feature handled the same situation.

- [ ] **Step 9: Verify**

Run: `flutter analyze`
Expected: 0 issues.

Run: `flutter test`
Expected: all pre-existing tests still pass (Task 12 adds new tests for the actual new behavior — none
exist yet at this step, since this task is pure plumbing).

- [ ] **Step 10: Commit**

```bash
git add lib/features/scoring lib/core/di/injection/scoring_injection.dart lib/core/utils/current_user.dart lib/features/organization/presentation/bindings/organization_detail_binding.dart test/features/home test/features/scoring
git commit -m "$(cat <<'EOF'
feat: wire up delegated-scoring API client plumbing

MatchUserRef, widened MatchHistoryItem, ScorerCandidatesRes,
AssignScorerRes, and the endpoint/service/repository/usecase chain
for GET scorer-candidates and PATCH scorer — no UI yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Controller methods on `HomeController` and `TeamProfileController`

**Files:**
- Modify: `lib/features/home/presentation/controllers/home_controller.dart`
- Modify: `lib/features/home/presentation/bindings/home_binding.dart`
- Modify: `lib/features/scoring/presentation/controllers/team_profile_controller.dart`
- Modify: `lib/features/scoring/presentation/bindings/team_profile_binding.dart`
- Modify: `test/features/home/presentation/controllers/home_controller_test.dart`
- Modify: `test/features/scoring/presentation/controllers/team_profile_controller_test.dart`

**Interfaces:**
- Consumes: `GetScorerCandidatesUseCase`, `AssignScorerUseCase` (Task 10).
- Produces: `HomeController.loadScorerCandidates(String)`/`.assignScorer(String, String?)` and the same
  two methods on `TeamProfileController` — Task 12's shared sheet widget calls whichever controller owns
  the screen it's opened from.

- [ ] **Step 1: Write the failing test — `HomeController`**

`test/features/home/presentation/controllers/home_controller_test.dart` already defines
`class _FakeMatchRepository implements MatchRepository` with a `historyResponse` field (controlling
`getMatchHistory`'s return) and a `deleteResponse` field (controlling `deleteMatch`'s), plus a shared
`setUp()` inside `void main()` that builds one `repo`/`controller` pair reused by every `test(...)`
in the file, and a top-level `_item(matchId, {status})` helper that builds a minimal `MatchHistoryItem`
fixture. Add two new fields and two new method overrides to `_FakeMatchRepository`:
```dart
  Either<CricketResponse<ScorerCandidatesRes>, CricketFailure>? scorerCandidatesResponse;
  Either<CricketResponse<AssignScorerRes>, CricketFailure>? assignScorerResponse;

  @override
  Future<Either<CricketResponse<ScorerCandidatesRes>, CricketFailure>>
  getScorerCandidates({required String matchId}) async {
    final response = scorerCandidatesResponse;
    if (response == null) throw UnimplementedError('Not exercised in this test.');
    return response;
  }

  @override
  Future<Either<CricketResponse<AssignScorerRes>, CricketFailure>>
  assignScorer({required String matchId, required String? scorerId}) async {
    final response = assignScorerResponse;
    if (response == null) throw UnimplementedError('Not exercised in this test.');
    return response;
  }
```
Widen the shared `setUp()`'s `HomeController(...)` construction:
```dart
  setUp(() {
    repo = _FakeMatchRepository();
    controller = HomeController(
      logoutUseCase: LogoutUseCase(authRepository: _UnusedAuthRepository()),
      getMatchHistoryUseCase: GetMatchHistoryUseCase(matchRepository: repo),
      deleteMatchUseCase: DeleteMatchUseCase(matchRepository: repo),
      getScorerCandidatesUseCase: GetScorerCandidatesUseCase(matchRepository: repo),
      assignScorerUseCase: AssignScorerUseCase(matchRepository: repo),
    );
  });
```
Then add two tests, using the existing `repo`/`controller`/`_item` fixtures:
```dart
  test('loadScorerCandidates returns the candidate list on success', () async {
    repo.scorerCandidatesResponse = Either.result(
      CricketResponse(
        message: 'ok',
        data: ScorerCandidatesRes(
          candidates: [MatchUserRef(id: 'user-1', name: 'Raj')],
        ),
      ),
    );

    final candidates = await controller.loadScorerCandidates('match-1');

    expect(candidates?.length, 1);
    expect(candidates?.first.name, 'Raj');
  });

  test('assignScorer updates the cached match on success', () async {
    repo.historyResponse = Either.result(
      CricketResponse(
        message: 'ok',
        data: MatchHistoryRes(
          matches: [_item('match-1')],
          page: 1,
          limit: 20,
          total: 1,
        ),
      ),
    );
    await controller.loadHistory();
    repo.assignScorerResponse = Either.result(
      CricketResponse(
        message: 'ok',
        data: AssignScorerRes(
          matchId: 'match-1',
          assignedScorer: MatchUserRef(id: 'user-1', name: 'Raj'),
        ),
      ),
    );

    final success = await controller.assignScorer('match-1', 'user-1');

    expect(success, isTrue);
    expect(controller.matches.first.assignedScorer?.name, 'Raj');
  });
```
Add the two new use-case imports (`get_scorer_candidates.dart`, `assign_scorer.dart`) and the two new
response-model imports (`scorer_candidates_res.dart`, `assign_scorer_res.dart`) to the top of the file.

- [ ] **Step 2: Run to verify it fails**

Run: `flutter test test/features/home/presentation/controllers/home_controller_test.dart`
Expected: FAIL — `getScorerCandidatesUseCase`/`assignScorerUseCase` aren't constructor params yet, and
`loadScorerCandidates`/`assignScorer` don't exist on `HomeController`.

- [ ] **Step 3: Implement on `HomeController`**

Add two constructor params and fields:
```dart
  final GetScorerCandidatesUseCase getScorerCandidatesUseCase;
  final AssignScorerUseCase assignScorerUseCase;

  HomeController({
    required this.logoutUseCase,
    required this.getMatchHistoryUseCase,
    required this.deleteMatchUseCase,
    required this.getScorerCandidatesUseCase,
    required this.assignScorerUseCase,
  });
```
Add two methods (import `MatchUserRef` from `match_history_res.dart`, already imported for
`MatchHistoryItem`; import `CricketSnackbar` — already imported):
```dart
  /// The picker source for the assign-scorer sheet. Returns `null` (with
  /// the server's own error already shown) on failure — a 403 here means
  /// the viewer has no assign-authority on this match at all, which the
  /// sheet caller treats the same as any other failure: don't open it.
  Future<List<MatchUserRef>?> loadScorerCandidates(String matchId) async {
    final response = await getScorerCandidatesUseCase(
      params: GetScorerCandidatesParams(matchId: matchId),
    );
    if (response.isResult) {
      return response.result.data?.candidates ?? [];
    }
    CricketSnackbar.showErrorMessage(response.fallback.message);
    return null;
  }

  /// Assigns/reassigns (`scorerId`) or clears (`null`) the delegated
  /// scorer, and patches the cached list entry in place so the card's
  /// label updates without a full reload.
  Future<bool> assignScorer(String matchId, String? scorerId) async {
    final response = await assignScorerUseCase(
      params: AssignScorerParams(matchId: matchId, scorerId: scorerId),
    );
    if (!response.isResult) {
      CricketSnackbar.showErrorMessage(response.fallback.message);
      return false;
    }
    final index = matches.indexWhere((item) => item.matchId == matchId);
    if (index != -1) {
      matches[index] = matches[index].copyWith(
        assignedScorer: response.result.data?.assignedScorer,
      );
    }
    return true;
  }
```
Add the two new use-case imports and `GetScorerCandidatesParams`/`AssignScorerParams` imports to the top
of the file.

- [ ] **Step 4: Update `HomeBinding`**

```dart
    Get.lazyPut(
      () => HomeController(
        logoutUseCase: Get.find<LogoutUseCase>(),
        getMatchHistoryUseCase: Get.find<GetMatchHistoryUseCase>(),
        deleteMatchUseCase: Get.find<DeleteMatchUseCase>(),
        getScorerCandidatesUseCase: Get.find<GetScorerCandidatesUseCase>(),
        assignScorerUseCase: Get.find<AssignScorerUseCase>(),
      ),
    );
```
with the matching two new imports.

- [ ] **Step 5: Run to verify the `HomeController` tests pass**

Run: `flutter test test/features/home/presentation/controllers/home_controller_test.dart`
Expected: PASS (all tests, existing + 2 new).

- [ ] **Step 6: Repeat for `TeamProfileController`**

Same production-code shape as Steps 3–4: add `getScorerCandidatesUseCase`/`assignScorerUseCase`
constructor params and fields to `TeamProfileController`, and the same two methods
(`loadScorerCandidates`/`assignScorer`, operating on `this.matches` — already the field name on this
controller too), then widen `TeamProfileBinding` the same way Step 4 widened `HomeBinding`.

`test/features/scoring/presentation/controllers/team_profile_controller_test.dart` uses a different test
double shape than `home_controller_test.dart` — it fakes each **use case** directly (implementing
`noSuchMethod` for anything not exercised), not a shared repository, and already has a top-level
`_item(matchId)` fixture helper and a `setUp()` that builds `profileUseCase`/`matchesUseCase`/`controller`
once per test. Add two new fake use-case classes, matching the file's existing two exactly:
```dart
class _FakeGetScorerCandidatesUseCase implements GetScorerCandidatesUseCase {
  Either<CricketResponse<ScorerCandidatesRes>, CricketFailure>? response;

  @override
  Future<Either<CricketResponse<ScorerCandidatesRes>, CricketFailure>> call({
    GetScorerCandidatesParams? params,
  }) async {
    final result = response;
    if (result == null) throw UnimplementedError('Not exercised in this test.');
    return result;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Not exercised in this test.');
}

class _FakeAssignScorerUseCase implements AssignScorerUseCase {
  Either<CricketResponse<AssignScorerRes>, CricketFailure>? response;

  @override
  Future<Either<CricketResponse<AssignScorerRes>, CricketFailure>> call({
    AssignScorerParams? params,
  }) async {
    final result = response;
    if (result == null) throw UnimplementedError('Not exercised in this test.');
    return result;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Not exercised in this test.');
}
```
Widen the shared `setUp()`:
```dart
  setUp(() {
    Get.testMode = true;
    profileUseCase = _FakeGetTeamProfileUseCase();
    matchesUseCase = _FakeGetTeamMatchesUseCase();
    scorerCandidatesUseCase = _FakeGetScorerCandidatesUseCase();
    assignScorerUseCase = _FakeAssignScorerUseCase();
    controller = TeamProfileController(
      teamId: 'team-1',
      getTeamProfileUseCase: profileUseCase,
      getTeamMatchesUseCase: matchesUseCase,
      getScorerCandidatesUseCase: scorerCandidatesUseCase,
      assignScorerUseCase: assignScorerUseCase,
    );
  });
```
(add the matching `late _FakeGetScorerCandidatesUseCase scorerCandidatesUseCase;` and
`late _FakeAssignScorerUseCase assignScorerUseCase;` declarations alongside the file's existing two).
Then add two tests, mirroring Step 1's `HomeController` tests exactly:
```dart
  test('loadScorerCandidates returns the candidate list on success', () async {
    scorerCandidatesUseCase.response = Either.result(
      CricketResponse(
        message: 'ok',
        data: ScorerCandidatesRes(
          candidates: [MatchUserRef(id: 'user-1', name: 'Raj')],
        ),
      ),
    );

    final candidates = await controller.loadScorerCandidates('match-1');

    expect(candidates?.length, 1);
    expect(candidates?.first.name, 'Raj');
  });

  test('assignScorer updates the cached match on success', () async {
    matchesUseCase.response = Either.result(
      CricketResponse(
        message: 'ok',
        data: MatchHistoryRes(
          matches: [_item('match-1')],
          page: 1,
          limit: 20,
          total: 1,
        ),
      ),
    );
    await controller.loadMatches();
    assignScorerUseCase.response = Either.result(
      CricketResponse(
        message: 'ok',
        data: AssignScorerRes(
          matchId: 'match-1',
          assignedScorer: MatchUserRef(id: 'user-1', name: 'Raj'),
        ),
      ),
    );

    final success = await controller.assignScorer('match-1', 'user-1');

    expect(success, isTrue);
    expect(controller.matches.first.assignedScorer?.name, 'Raj');
  });
```
Add the four matching imports (two use cases, two response models) to the top of the file.

- [ ] **Step 7: Run both controllers' full test files**

Run: `flutter test test/features/home/presentation/controllers/home_controller_test.dart test/features/scoring/presentation/controllers/team_profile_controller_test.dart`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/features/home lib/features/scoring/presentation/controllers/team_profile_controller.dart lib/features/scoring/presentation/bindings/team_profile_binding.dart test/features/home test/features/scoring/presentation/controllers/team_profile_controller_test.dart
git commit -m "$(cat <<'EOF'
feat: add scorer-candidates/assign methods to Home and TeamProfile

Both controllers duplicate the same two small methods rather than
share a mixin — matches this codebase's existing precedent
(TeamProfileController already duplicates HomeController's own
pagination shape for the same reason).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Assign-scorer bottom sheet, card label, and screen wiring

**Files:**
- Create: `lib/features/scoring/presentation/widget/assign_scorer_sheet.dart`
- Modify: `lib/features/scoring/presentation/widget/match_history_card.dart`
- Modify: `lib/features/home/presentation/pages/home_page.dart`
- Modify: `lib/features/scoring/presentation/pages/team_profile_screen.dart`
- Modify: `lib/core/translations/translation_keys.dart`, `en.dart`, `hi.dart`, `mr.dart`

**Interfaces:**
- Consumes: `HomeController.loadScorerCandidates`/`.assignScorer`,
  `TeamProfileController.loadScorerCandidates`/`.assignScorer` (Task 11).

This task ships functionally correct but visually plain UI — Task 13 (frontend-design pass, REQUIRED) is
what makes it look like it belongs in this app, mirroring how the Organizations feature's team-profile
screen shipped its baseline first and was restyled in its own dedicated task.

- [ ] **Step 1: Add translation keys**

In `lib/core/translations/translation_keys.dart`, add a new section:
```dart
  // Delegated scoring
  static const String assignScorer = 'assignScorer';
  static const String removeAssignment = 'removeAssignment';
  static const String noScorerCandidates = 'noScorerCandidates';
  static const String scorerAssigned = 'scorerAssigned';
  static const String scorerUnassigned = 'scorerUnassigned';
  static const String assignedByName = 'assignedByName';
  static const String assignedToName = 'assignedToName';
```
In `lib/core/translations/en.dart`:
```dart
  TranslationKeys.assignScorer: 'Assign scorer',
  TranslationKeys.removeAssignment: 'Remove assignment',
  TranslationKeys.noScorerCandidates: 'No organization-linked team on this match',
  TranslationKeys.scorerAssigned: 'Scorer assigned',
  TranslationKeys.scorerUnassigned: 'Scorer unassigned',
  TranslationKeys.assignedByName: 'Assigned by @name',
  TranslationKeys.assignedToName: 'Assigned to @name',
```
In `lib/core/translations/hi.dart`:
```dart
  TranslationKeys.assignScorer: 'स्कोरर नियुक्त करें',
  TranslationKeys.removeAssignment: 'नियुक्ति हटाएं',
  TranslationKeys.noScorerCandidates: 'इस मैच में कोई संगठन-लिंक्ड टीम नहीं है',
  TranslationKeys.scorerAssigned: 'स्कोरर नियुक्त किया गया',
  TranslationKeys.scorerUnassigned: 'स्कोरर हटाया गया',
  TranslationKeys.assignedByName: '@name द्वारा नियुक्त',
  TranslationKeys.assignedToName: '@name को सौंपा गया',
```
In `lib/core/translations/mr.dart`:
```dart
  TranslationKeys.assignScorer: 'स्कोअरर नेमा',
  TranslationKeys.removeAssignment: 'नेमणूक काढा',
  TranslationKeys.noScorerCandidates: 'या सामन्यात कोणताही संस्था-लिंक्ड संघ नाही',
  TranslationKeys.scorerAssigned: 'स्कोअरर नेमला',
  TranslationKeys.scorerUnassigned: 'स्कोअरर काढला',
  TranslationKeys.assignedByName: '@name यांनी नेमले',
  TranslationKeys.assignedToName: '@name कडे सोपवले',
```

- [ ] **Step 2: Create the shared bottom sheet widget**

`lib/features/scoring/presentation/widget/assign_scorer_sheet.dart`:
```dart
import 'package:cricket_scorer/core/extensions/space_extension.dart';
import 'package:cricket_scorer/core/extensions/theme_x.dart';
import 'package:cricket_scorer/core/global/widgets/bootom_sheets/custom_bottomsheet.dart';
import 'package:cricket_scorer/core/global/widgets/cricket_outlined_button.dart';
import 'package:cricket_scorer/core/global/widgets/cricket_text.dart';
import 'package:cricket_scorer/core/global/widgets/snackbars/cricket_snackbar.dart';
import 'package:cricket_scorer/core/translations/translation_keys.dart';
import 'package:cricket_scorer/features/scoring/data/models/response/match_history_res.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

/// Opens the assign/reassign/remove sheet for [item] — shared by
/// `HomePage` and `TeamProfileScreen` so the sheet itself isn't duplicated,
/// only the thin controller methods it calls (same duplication boundary
/// `TeamProfileController` already draws against `HomeController`).
///
/// [loadCandidates] returning `null` means an error was already shown by
/// the caller (e.g. the viewer has no assign-authority on this match) —
/// this function opens nothing in that case. An empty, non-null list means
/// the match has no organization-linked team to draw candidates from.
Future<void> showAssignScorerSheet({
  required MatchHistoryItem item,
  required Future<List<MatchUserRef>?> Function(String matchId) loadCandidates,
  required Future<bool> Function(String matchId, String? scorerId) onAssign,
}) async {
  final candidates = await loadCandidates(item.matchId);
  if (candidates == null) return;
  if (candidates.isEmpty) {
    CricketSnackbar.showErrorMessage(TranslationKeys.noScorerCandidates.tr);
    return;
  }

  final assigned = await CustomBottomSheet.wrapBottomSheet<bool>(
    headlineText: TranslationKeys.assignScorer.tr,
    child: SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final candidate in candidates)
            _CandidateRow(
              candidate: candidate,
              isCurrentlyAssigned: candidate.id == item.assignedScorer?.id,
              onTap: () async {
                final success = await onAssign(item.matchId, candidate.id);
                if (success) Get.back<bool>(result: true);
              },
            ),
          if (item.assignedScorer != null) ...[
            12.h,
            CricketOutlinedButton(
              buttonName: TranslationKeys.removeAssignment.tr,
              onPressed: () async {
                final success = await onAssign(item.matchId, null);
                if (success) Get.back<bool>(result: true);
              },
            ),
          ],
        ],
      ),
    ),
  );

  if (assigned == true) {
    CricketSnackbar.showSuccessMessage(TranslationKeys.scorerAssigned.tr);
  }
}

class _CandidateRow extends StatelessWidget {
  const _CandidateRow({
    required this.candidate,
    required this.isCurrentlyAssigned,
    required this.onTap,
  });

  final MatchUserRef candidate;
  final bool isCurrentlyAssigned;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: 8.radius,
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(
            children: [
              Expanded(
                child: CricketText(
                  text: candidate.name,
                  style: context.textTheme.bodyMedium?.copyWith(
                    color: context.colorScheme.secondary,
                  ),
                ),
              ),
              if (isCurrentlyAssigned)
                Icon(
                  Icons.check_circle,
                  size: 18,
                  color: context.colors.statusSuccess,
                ),
            ],
          ),
        ),
      ),
    );
  }
}
```

- [ ] **Step 3: Widen `MatchHistoryCard`**

Add two new constructor params:
```dart
  const MatchHistoryCard({
    super.key,
    required this.item,
    required this.onTap,
    required this.currentUserId,
    this.onDelete,
    this.onAssignScorer,
    this.isDeleting,
    this.highlightTeamId,
  });

  // ...existing fields...

  /// Needed to tell "assigned by someone else" apart from "assigned by me"
  /// for [_delegationLabel] — see docs/api.md's delegated-scoring contract.
  final String currentUserId;

  /// Null hides the assign-scorer icon entirely — neither screen that uses
  /// this card should pass null in practice (both wire it up in this task),
  /// but keeping it optional matches [onDelete]'s own nullable shape rather
  /// than forcing every future caller of this widget to have an opinion.
  final VoidCallback? onAssignScorer;
```
Add a label-computing method:
```dart
  String? _delegationLabel() {
    final creator = item.createdBy;
    if (creator != null && creator.id != currentUserId) {
      return TranslationKeys.assignedByName.trParams({'name': creator.name});
    }
    final scorer = item.assignedScorer;
    if (scorer != null) {
      return TranslationKeys.assignedToName.trParams({'name': scorer.name});
    }
    return null;
  }
```
In `build()`, add the assign-scorer icon into the existing `Row` alongside the delete icon (right after
the `if (delete != null) Obx(...)` block, before its closing `],`):
```dart
                  if (onAssignScorer != null)
                    IconButton(
                      tooltip: TranslationKeys.assignScorer.tr,
                      visualDensity: VisualDensity.compact,
                      icon: Icon(
                        Icons.person_add_alt,
                        size: 20,
                        color: context.colorScheme.onSurfaceVariant,
                      ),
                      onPressed: onAssignScorer,
                    ),
```
And add the label below the existing overs/date `CricketText`, inside the same `Column`:
```dart
              if (_delegationLabel() != null) ...[
                4.h,
                CricketText(
                  text: _delegationLabel()!,
                  style: context.textTheme.bodySmall?.copyWith(
                    color: context.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
```

- [ ] **Step 4: Wire up `HomePage`**

Update its `MatchHistoryCard(...)` call site:
```dart
                  return MatchHistoryCard(
                    item: item,
                    currentUserId: _currentUserId,
                    onTap: () => controller.openMatch(item),
                    onDelete: () => unawaited(_confirmDelete(controller, item)),
                    onAssignScorer: () => unawaited(
                      showAssignScorerSheet(
                        item: item,
                        loadCandidates: controller.loadScorerCandidates,
                        onAssign: controller.assignScorer,
                      ),
                    ),
                    isDeleting: () =>
                        controller.deletingMatchIds.contains(item.matchId),
                  );
```
Add `late final String _currentUserId = currentUserId();` to the `State` class (import
`current_user.dart`), and import `assign_scorer_sheet.dart`.

- [ ] **Step 5: Wire up `TeamProfileScreen`**

Same shape:
```dart
                          MatchHistoryCard(
                            item: item,
                            currentUserId: _currentUserId,
                            onTap: () => controller.openMatch(item),
                            onAssignScorer: () => unawaited(
                              showAssignScorerSheet(
                                item: item,
                                loadCandidates: controller.loadScorerCandidates,
                                onAssign: controller.assignScorer,
                              ),
                            ),
                            highlightTeamId: controller.teamId,
                          ),
```
Add the same `late final String _currentUserId = currentUserId();` field and the same two imports.

- [ ] **Step 6: Regenerate and analyze**

Run: `dart run build_runner build --delete-conflicting-outputs` (only needed if any model changed —
nothing did in this task, but confirm no stale generated-file drift)
Run: `flutter analyze`
Expected: 0 issues.

- [ ] **Step 7: Manual functional check in the running app**

Ask before starting/using a device or emulator, per this project's own convention (never start a device
yourself) — once one is available: create an org, add a member, create an org team, create a match with
it, tap the new person-add icon on that match's history card, confirm the sheet lists the member, assign
them, confirm the card now shows "Assigned to <name>". This is a functional smoke check; Task 15 is the
real on-device verification with evidence.

- [ ] **Step 8: Commit**

```bash
git add lib/features/scoring/presentation/widget/assign_scorer_sheet.dart lib/features/scoring/presentation/widget/match_history_card.dart lib/features/home/presentation/pages/home_page.dart lib/features/scoring/presentation/pages/team_profile_screen.dart lib/core/translations
git commit -m "$(cat <<'EOF'
feat: add assign-scorer bottom sheet and match-card labels

Functionally complete, visually plain — the design pass is a
dedicated follow-up task, matching how team-profile shipped in this
codebase's Organizations feature.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Upload new translation keys to the CMS

Per this workspace's own CLAUDE.md ("Shared types & keeping them in sync"): a new client-facing string
needs a `TranslationKeys` entry, the local `en`/`hi`/`mr` maps (Task 12), **and** a CMS record — the CMS
map replaces the local one wholesale per language on next sync, so a key present locally but absent from
the CMS renders as the raw key the moment translations refresh.

**Files:** none (a runtime POST, not a code change)

- [ ] **Step 1: Confirm the seven new keys and their three-language text**

From Task 12 Step 1: `assignScorer`, `removeAssignment`, `noScorerCandidates`, `scorerAssigned`,
`scorerUnassigned`, `assignedByName`, `assignedToName` — the same English/Hindi/Marathi strings already
written into `en.dart`/`hi.dart`/`mr.dart`.

- [ ] **Step 2: Call the bulk-update endpoint**

Using a logged-in test account's access token (see `test_credentials.md` at the workspace root — never
put credentials in memory or in this plan), call:
```bash
curl -X POST http://<LAN-IP>:9000/api/v1/translations/bulk-update \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '[
    {"key": "assignScorer", "translations": {"en": "Assign scorer", "hi": "स्कोरर नियुक्त करें", "mr": "स्कोअरर नेमा"}},
    {"key": "removeAssignment", "translations": {"en": "Remove assignment", "hi": "नियुक्ति हटाएं", "mr": "नेमणूक काढा"}},
    {"key": "noScorerCandidates", "translations": {"en": "No organization-linked team on this match", "hi": "इस मैच में कोई संगठन-लिंक्ड टीम नहीं है", "mr": "या सामन्यात कोणताही संस्था-लिंक्ड संघ नाही"}},
    {"key": "scorerAssigned", "translations": {"en": "Scorer assigned", "hi": "स्कोरर नियुक्त किया गया", "mr": "स्कोअरर नेमला"}},
    {"key": "scorerUnassigned", "translations": {"en": "Scorer unassigned", "hi": "स्कोरर हटाया गया", "mr": "स्कोअरर काढला"}},
    {"key": "assignedByName", "translations": {"en": "Assigned by @name", "hi": "@name द्वारा नियुक्त", "mr": "@name यांनी नेमले"}},
    {"key": "assignedToName", "translations": {"en": "Assigned to @name", "hi": "@name को सौंपा गया", "mr": "@name कडे सोपवले"}}
  ]'
```
Expected: `200`, and `LanguageService.incrementGlobalVersion()` fires server-side so every client's next
`GET /v1/translations/version` check picks up the change.

- [ ] **Step 3: Confirm on-device**

With the app running and a hard-refresh of translations (or after the normal version-poll interval),
confirm the assign-scorer sheet and card labels show the real strings, not raw keys like `assignScorer`.

---

## Task 14: Frontend design pass (REQUIRED — do not skip)

Task 12 shipped stock `IconButton`/`InkWell` rows with no aesthetic judgment applied — exactly the
pattern the Organizations feature's own plan flagged once already ("team-profile shipped once without a
design pass and needed a follow-up"). Do not consider Phase 3 done until this task runs.

**Files:**
- Modify: `lib/features/scoring/presentation/widget/assign_scorer_sheet.dart`
- Modify: `lib/features/scoring/presentation/widget/match_history_card.dart` (the new icon + label only —
  don't restyle the rest of a card that already shipped a design pass)

- [ ] **Step 1: Invoke the `frontend-design` skill**

Brief: "Apply a real aesthetic design pass to the delegated-scoring UI in `cricket-scrorer` — the
`showAssignScorerSheet` candidate-picker sheet (`lib/features/scoring/presentation/widget/
assign_scorer_sheet.dart`) and the new person-add icon plus 'Assigned by/to' label on
`MatchHistoryCard` (`lib/features/scoring/presentation/widget/match_history_card.dart`). Ground it in
this app's existing visual vocabulary — `lib/core/global/widgets/`, and how `OrganizationDetailScreen`'s
own member-row/add-member-sheet pattern already established a monogram/role-pill/bottom-sheet language
for 'pick or manage a person' — so this reads as belonging to the same app, not a bolted-on generic
Material list. Branch: `feat-delegated-scoring`, already checked out."

- [ ] **Step 2: Verify after the design pass**

Run: `flutter analyze` (expect 0 issues) and `flutter test` (expect all passing) again — a design pass
that changes widget structure can break a golden/widget test if one exists for either file; there isn't
one today, so this step is confirming that fact stays true, not fixing one.

- [ ] **Step 3: Commit**

```bash
git add lib/features/scoring/presentation/widget/assign_scorer_sheet.dart lib/features/scoring/presentation/widget/match_history_card.dart
git commit -m "$(cat <<'EOF'
style: apply design pass to delegated-scoring UI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Frontend verification

**Files:** none (verification only)

- [ ] **Step 1: Full analyze**

Run: `flutter analyze`
Expected: 0 issues. Record the actual output.

- [ ] **Step 2: Full test suite**

Run: `flutter test`
Expected: 100% pass. Record the actual pass count.

- [ ] **Step 3: Report actual evidence**

Per `superpowers:verification-before-completion` — state the exact command output for both, not "should
pass."

---

## Task 16: On-device negative-case verification

The user's own requirement: prove, with real evidence, that a non-assigned org member genuinely cannot
score a delegated match — not just that the assigned one can.

**Files:** none (manual verification, evidence-gathering only)

- [ ] **Step 1: Set up the scenario on a real device or already-running emulator**

Ask before starting a device — never boot one yourself (physical device > already-running emulator >
ask, per this project's own convention). Using two accounts (an org owner and a plain org member, plus a
third "assigned scorer" account if a third is available — reuse the same throwaway test accounts from
the Organizations feature's own on-device verification if they're still usable, checking
`test_credentials.md` first): create an org, add both as members, create an org team, create a match with
it, assign one member as scorer via the new UI.

- [ ] **Step 2: Confirm the positive case**

Log in as the assigned scorer, open the match from the history list, score at least one ball
successfully. Screenshot the scoring console mid-delivery as evidence.

- [ ] **Step 3: Confirm the negative case with real evidence**

Log in as the plain (non-assigned) org member. Since that match won't appear in their own "my matches"
list (they didn't create it and aren't the assigned scorer — per this plan's own discovery design, they
would only reach it via the org's team profile), navigate to it via the organization's team → team
profile → past matches list, and attempt to open/score it. Capture one of:
- A screenshot of the error snackbar/state the app shows when the score-ball (or scorecard/start-innings)
  call comes back `403 MATCH_NOT_OWNED`, or
- The actual HTTP response logged by `PrettyDioLogger` in the running app's console (`flutter run`'s own
  log output), showing the `403`/`MATCH_NOT_OWNED` body — whichever is more directly available given
  Task 12's UI doesn't yet route a plain member into the scoring console at all (if the UI itself has no
  path for them to even attempt it, that absence — confirmed by reading the actual route/controller
  logic, not assumed — is itself the evidence: report exactly what was checked and why no UI path exists).

- [ ] **Step 4: Report**

State plainly what was checked, what the actual server response or UI behavior was, and attach/quote the
captured evidence. Do not report this task complete on the basis of "the backend tests already prove
this" — Task 6's tests are the backend proof; this task is the frontend/on-device proof the user
explicitly asked for.

---

## Task 17: Commit each repo per its own conventions

Both repos already have commits per task above. This task is the final housekeeping check before
declaring the branch ready to merge or PR — matching the process the user's own instructions established
for the Organizations feature (verify tests, then present merge/PR/keep options via
`superpowers:finishing-a-development-branch`, once for each repo).

- [ ] **Step 1: Backend — confirm branch state**

```bash
cd cricket-scorer-backend
git log --oneline development..feat-delegated-scoring
git status
```
Expected: a clean tree, and the commit list matches Tasks 1(doc note)–9's commits.

- [ ] **Step 2: Frontend — confirm branch state**

```bash
cd cricket-scrorer
git log --oneline development..feat-delegated-scoring
git status
```
Expected: a clean tree, and the commit list matches Tasks 10–14's commits.

- [ ] **Step 3: Hand off**

Do not merge, push, or open a PR without the user's explicit go-ahead in chat, per this project's own
established pattern from the Organizations feature (the user said "yes merge it" and "yes offcourse push
it" as separate, explicit approvals after reviewing the completed work). Report both branches ready and
wait.
