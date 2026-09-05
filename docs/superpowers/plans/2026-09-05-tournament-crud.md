# Tournament CRUD Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend CRUD + team-enrollment endpoints for `Tournament`, on top of the model landed in `docs/superpowers/plans/2026-09-05-tournament-model.md`. No client-side (`cricket-scrorer`) work — that is a separate follow-up.

**Architecture:** Follows `organization.controller.js`'s established shape exactly: creation nested under the owning resource (`POST /v1/organization/:orgId/tournaments`, handled in `organization.controller.js`), everything else in a new sibling pair `tournament.controller.js` / `tournament.routes.js` mounted at `/api/v1/tournament`. Same `catchAsync`/`ApiError`/`ApiResponse` conventions, same manual-enum-pre-check pattern `updateProfile` uses for `battingStyle`/`bowlingStyle` (a bare Mongoose `ValidationError` falls through to an unhelpful `500`, so `format`/`status` are checked against their exported enum arrays before every write).

**Tech Stack:** Express 5, Mongoose 9, Jest + supertest against a real `mongodb-memory-server` replica set (existing `tests/setup/testDb.js`, `tests/helpers/authTestUser.js`, `tests/helpers/buildTestApp.js`).

**Spec:** Design decisions were resolved via `AskUserQuestion` during the brainstorming pass for this feature (no separate spec file, given the close precedent this follows):
- **Write access**: org-owner-only for create/update/delete/enroll/remove — matches `createOrganizationTeam`'s own owner-gating.
- **Team enrollment**: dedicated `POST .../teams` / `DELETE .../teams/:teamId` endpoints, not a create-time-only list.
- **Eligible teams**: only teams already belonging to the tournament's own organization.
- **Update scope**: `name`, `format`, and `status` are all PATCH-able, any subset, with no business-rule gating on status transitions yet (that logic arrives with fixture generation, a later phase).
- **Necessary side effect found while designing**: `Tournament.organization` is required — there is no standalone tournament the way there's a standalone `Team`. `DELETE /v1/organization/:orgId` currently only orphans the org's teams; it must also soft-delete the org's tournaments in the same transaction, or a deleted org would leave a live, org-less tournament behind.
- **Deliberately out of scope**: if a team is later detached from its org (`PATCH /v1/team/:teamId/organization`) while still enrolled in one of that org's tournaments, this pass does not retroactively remove it from the tournament roster. Recorded as an open item in `docs/api.md`, not solved here.

## Global Constraints

- ESM imports with `.js` extensions, matching every existing controller/route file.
- No service/repository layer, no validation library — manual inline checks only (`if (!name) throw new ApiError(400, "KEY")`), per backend `CLAUDE.md`.
- `ApiError(status, key, options)` — the message argument is always a bare i18n key, never `req.t(...)`. Every new key added to **all three** `src/locales/{en,hi,mr}/common.json` files in the same task that introduces it — `tests/locales.test.js` fails the build on drift.
- Every new route carries `verifyJwt`. `tests/routes.auth.test.js` fails the build if a route is added without it and without an explicit allowlist entry — Task 3 adds the new `tournament` router to that suite's `ROUTERS`/`PUBLIC_ROUTES` maps (empty allowlist: every tournament route is private).
- `Object.hasOwn(err.keyPattern ?? {}, 'nameLower')` is the established way to distinguish a `{organization, nameLower}` duplicate-key error from any other `11000`, matching `createOrganization`'s own pattern — never match on `err.code === 11000` alone.
- A malformed ObjectId in any route param throws a Mongoose `CastError`, which `errorHandler.js` already turns into `400 INVALID_ID` globally — do not add per-controller ObjectId format checks.
- `Team.findOne({ _id, isDeleted: false })` / `Organization.findOne({ _id, isDeleted: false })` — always filter soft-deleted records out of a lookup, matching every existing read in `organization.controller.js`.
- Do NOT touch `match.model.js`, `match.controller.js`, or any file under `cricket-scrorer/` — backend CRUD only.

---

### Task 1: Export enums + create tournament under an organization

**Files:**
- Modify: `src/models/tournament.model.js` (export the two enum arrays)
- Modify: `src/controllers/organization.controller.js` (add `createOrgTournament`)
- Modify: `src/routes/organization.routes.js` (wire the new route)
- Modify: `src/locales/{en,hi,mr}/common.json` (5 new keys)
- Create: `tests/tournament.test.js`

**Interfaces:**
- Consumes: `Tournament` model (Task 1 of the model plan), `findOwnedOrganization` (existing local helper in `organization.controller.js`).
- Produces: `export const TOURNAMENT_FORMATS` / `export const TOURNAMENT_STATUS` from `tournament.model.js` — every later task in this plan imports these for validation. `createOrgTournament` exported from `organization.controller.js`, routed as `POST /:orgId/tournaments` in `organization.routes.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/tournament.test.js`:

```javascript
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';

let app;

beforeAll(async () => {
  await connectTestDb();
  await Tournament.init();
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

const createTournament = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/tournaments`).set('Authorization', `Bearer ${token}`).send(body);

describe('POST /v1/organization/:orgId/tournaments', () => {
  it('creates a tournament under the organization', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const res = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Summer T20',
      organization: orgId,
      format: 'knockout',
      status: 'upcoming',
      teams: [],
    });
  });

  it("404s for an orgId that doesn't exist", async () => {
    const { token } = await createTestUser();

    const res = await createTournament(token, '665f3b1c2d3e4f5a6b7c8d90', { name: 'Summer T20', format: 'knockout' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ORG_NOT_FOUND');
  });

  it('403s when a non-owner tries to create a tournament', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await createTournament(strangerToken, orgId, { name: 'Summer T20', format: 'knockout' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });

  it('400s for an empty name', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const res = await createTournament(token, orgId, { name: '  ', format: 'knockout' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOURNAMENT_NAME_REQUIRED');
  });

  it('400s for a missing format', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const res = await createTournament(token, orgId, { name: 'Summer T20' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOURNAMENT_FORMAT_REQUIRED');
  });

  it('400s for a format outside the enum', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const res = await createTournament(token, orgId, { name: 'Summer T20', format: 'swiss' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TOURNAMENT_FORMAT');
  });

  it('409s when the same org reuses a tournament name, case-insensitively', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });

    const res = await createTournament(token, orgId, { name: 'summer t20', format: 'league' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TOURNAMENT_NAME_TAKEN');
  });

  it('allows two different organizations to use the same tournament name', async () => {
    const { token: token1 } = await createTestUser({ email: 'owner1@example.com' });
    const { token: token2 } = await createTestUser({ email: 'owner2@example.com' });
    const org1 = await createOrg(token1, { name: 'Riverside CC' });
    const org2 = await createOrg(token2, { name: 'Downtown CC' });

    await createTournament(token1, org1.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const res = await createTournament(token2, org2.body.data.id, { name: 'Summer T20', format: 'knockout' });

    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js`
Expected: FAIL — `404` (route doesn't exist / falls through to no matching route, or a locale-key lookup failure), since `POST /:orgId/tournaments` isn't wired yet.

- [ ] **Step 3: Export the enums**

In `src/models/tournament.model.js`, change:
```javascript
const TOURNAMENT_FORMATS = ['knockout', 'round_robin', 'league'];
const TOURNAMENT_STATUS  = ['upcoming', 'ongoing', 'completed'];
```
to:
```javascript
export const TOURNAMENT_FORMATS = ['knockout', 'round_robin', 'league'];
export const TOURNAMENT_STATUS  = ['upcoming', 'ongoing', 'completed'];
```
(Everything else in that file is unchanged — the schema already references these by their local names, which still resolve after adding `export`.)

- [ ] **Step 4: Add the 5 new locale keys**

In `src/locales/en/common.json`, insert immediately after the `"ORGANIZATION_DELETED"` line:
```json
  "TOURNAMENT_NAME_REQUIRED": "Tournament name is required",
  "TOURNAMENT_FORMAT_REQUIRED": "Tournament format is required",
  "INVALID_TOURNAMENT_FORMAT": "That isn't a valid tournament format",
  "TOURNAMENT_NAME_TAKEN": "This organization already has a tournament with this name",
  "TOURNAMENT_CREATED": "Tournament created",
```

In `src/locales/hi/common.json`, same position:
```json
  "TOURNAMENT_NAME_REQUIRED": "टूर्नामेंट का नाम आवश्यक है",
  "TOURNAMENT_FORMAT_REQUIRED": "टूर्नामेंट का प्रारूप आवश्यक है",
  "INVALID_TOURNAMENT_FORMAT": "यह एक मान्य टूर्नामेंट प्रारूप नहीं है",
  "TOURNAMENT_NAME_TAKEN": "इस संगठन में पहले से ही इस नाम का एक टूर्नामेंट है",
  "TOURNAMENT_CREATED": "टूर्नामेंट बनाया गया",
```

In `src/locales/mr/common.json`, same position:
```json
  "TOURNAMENT_NAME_REQUIRED": "स्पर्धेचे नाव आवश्यक आहे",
  "TOURNAMENT_FORMAT_REQUIRED": "स्पर्धेचा प्रकार आवश्यक आहे",
  "INVALID_TOURNAMENT_FORMAT": "हा वैध स्पर्धा प्रकार नाही",
  "TOURNAMENT_NAME_TAKEN": "या संस्थेत या नावाची स्पर्धा आधीच आहे",
  "TOURNAMENT_CREATED": "स्पर्धा तयार झाली",
```

- [ ] **Step 5: Add `createOrgTournament` to organization.controller.js**

Add the import at the top of `src/controllers/organization.controller.js`:
```javascript
import { Tournament, TOURNAMENT_FORMATS } from '../models/tournament.model.js';
```

Add the handler (place it after `createOrganizationTeam`, before `deleteOrganization`):
```javascript
const createOrgTournament = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findOwnedOrganization(orgId, req.user._id);

    const name = asString(req.body.name).trim();
    if (!name) {
        throw new ApiError(400, "TOURNAMENT_NAME_REQUIRED");
    }
    const format = asString(req.body.format);
    if (!format) {
        throw new ApiError(400, "TOURNAMENT_FORMAT_REQUIRED");
    }
    if (!TOURNAMENT_FORMATS.includes(format)) {
        throw new ApiError(400, "INVALID_TOURNAMENT_FORMAT");
    }

    let tournament;
    try {
        tournament = await Tournament.create({
            name,
            nameLower: name.toLowerCase(),
            organization: org._id,
            format,
            createdBy: req.user._id,
        });
    } catch (err) {
        const isNameCollision = err.code === 11000 && Object.hasOwn(err.keyPattern ?? {}, 'nameLower');
        if (isNameCollision) {
            throw new ApiError(409, "TOURNAMENT_NAME_TAKEN");
        }
        throw err;
    }

    return res.status(200).json(new ApiResponse(200, {
        id: tournament._id,
        name: tournament.name,
        organization: tournament.organization,
        format: tournament.format,
        status: tournament.status,
        teams: [],
        createdAt: tournament.createdAt,
    }, req.t("TOURNAMENT_CREATED")));
});
```

Add `createOrgTournament` to the file's final `export { ... }` list.

- [ ] **Step 6: Wire the route**

In `src/routes/organization.routes.js`, add `createOrgTournament` to the import from `../controllers/organization.controller.js`, and add:
```javascript
router.route('/:orgId/tournaments').post(verifyJwt, createOrgTournament);
```
(placed after the existing `router.route('/:orgId/teams').post(...)` line).

- [ ] **Step 7: Run test to verify it passes**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js`
Expected: PASS — all 8 tests green.

- [ ] **Step 8: Run the full backend suite**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --maxWorkers=2`
Expected: PASS, zero regressions (locale-parity test included).

- [ ] **Step 9: Commit**

```bash
git add src/models/tournament.model.js src/controllers/organization.controller.js src/routes/organization.routes.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json tests/tournament.test.js
git commit -m "feat: add POST /v1/organization/:orgId/tournaments"
```

---

### Task 2: Widen GET /v1/organization/:orgId with a tournaments list

**Files:**
- Modify: `src/controllers/organization.controller.js` (`getOrganization`)
- Modify: `tests/organization.test.js`

**Interfaces:**
- Consumes: `Tournament` model (already imported in Task 1).
- Produces: `GET /v1/organization/:orgId` response gains a `tournaments: [{id, name, format, status, teamCount}]` array — no other task depends on this field, it is a leaf read.

- [ ] **Step 1: Write the failing test**

In `tests/organization.test.js`, add `import { Tournament } from '../src/models/tournament.model.js';` at the top (used by a later task's cascade test too — safe to add now), and add this test inside the existing `describe('GET /v1/organization/:orgId', ...)` block, after the `'returns members and teams for the owner'` test:

```javascript
  it("includes the organization's tournaments", async () => {
    const { token } = await createTestUser();
    const createRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    await request(app)
      .post(`/api/v1/organization/${orgId}/tournaments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Summer T20', format: 'knockout' });

    const res = await getOrg(token, orgId);

    expect(res.status).toBe(200);
    expect(res.body.data.tournaments).toMatchObject([
      { name: 'Summer T20', format: 'knockout', status: 'upcoming', teamCount: 0 },
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/organization.test.js -t "includes the organization's tournaments"`
Expected: FAIL — `res.body.data.tournaments` is `undefined`.

- [ ] **Step 3: Widen `getOrganization`**

In `src/controllers/organization.controller.js`, replace the `getOrganization` handler:
```javascript
const getOrganization = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findAccessibleOrganization(orgId, req.user._id);
    await org.populate('owner', 'fullName');
    await org.populate('members.user', 'fullName');

    const teams = await Team.find({ organization: org._id, isDeleted: false });
    const tournaments = await Tournament.find({ organization: org._id, isDeleted: false }).sort({ createdAt: -1 });

    return res.status(200).json(new ApiResponse(200, {
        id: org._id,
        name: org.name,
        owner: { id: org.owner._id, name: org.owner.fullName },
        members: org.members.map((m) => ({ id: m.user._id, name: m.user.fullName, role: m.role })),
        teams: teams.map((team) => ({ id: team._id, name: team.name, shortName: team.shortName ?? null })),
        tournaments: tournaments.map((t) => ({
            id: t._id,
            name: t.name,
            format: t.format,
            status: t.status,
            teamCount: t.teams.length,
        })),
    }, req.t("ORGANIZATION_FETCHED")));
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/organization.test.js`
Expected: PASS — all tests in this file green, including the two pre-existing `getOrganization` tests (their `toMatchObject` assertions don't list `tournaments`, so an added field doesn't break them).

- [ ] **Step 5: Commit**

```bash
git add src/controllers/organization.controller.js tests/organization.test.js
git commit -m "feat: include tournaments in GET /v1/organization/:orgId"
```

---

### Task 3: Scaffolding + GET /v1/tournament/:tournamentId

**Files:**
- Create: `src/controllers/tournament.controller.js`
- Create: `src/routes/tournament.routes.js`
- Modify: `src/app.js` (mount the router)
- Modify: `tests/helpers/buildTestApp.js` (add `withTournament` option)
- Modify: `tests/routes.auth.test.js` (register the new router)
- Modify: `src/locales/{en,hi,mr}/common.json` (2 new keys: `TOURNAMENT_NOT_FOUND`, `TOURNAMENT_FETCHED`)
- Modify: `tests/tournament.test.js`

**Interfaces:**
- Consumes: `Tournament`, `Organization` (import fresh in the new controller file), `Team` (needed by Task 6), `isOrgMember` from `src/utils/organizationAccess.js`.
- Produces: `findAccessibleTournament(tournamentId, userId)` and `findOwnedTournament(tournamentId, userId)` — local helpers in `tournament.controller.js`, both returning `{ tournament, org }`, reused by every task from here on. `getTournament` exported and routed as `GET /:tournamentId`.

- [ ] **Step 1: Write the failing test**

Add to `tests/tournament.test.js` (new imports at top: `import { Team } from '../src/models/team.model.js';` — needed by this and later tasks):

```javascript
const createOrgTeam = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

const getTournament = (token, tournamentId) =>
  request(app).get(`/api/v1/tournament/${tournamentId}`).set('Authorization', `Bearer ${token}`).send();

describe('GET /v1/tournament/:tournamentId', () => {
  it("404s for a tournamentId that doesn't exist", async () => {
    const { token } = await createTestUser();

    const res = await getTournament(token, '665f3b1c2d3e4f5a6b7c8d90');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });

  it('403s for a caller who is not a member of the owning organization', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(ownerToken, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await getTournament(strangerToken, tournamentRes.body.data.id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('returns the tournament with its organization for an org member', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });

    const res = await getTournament(token, tournamentRes.body.data.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Summer T20',
      format: 'knockout',
      status: 'upcoming',
      organization: { id: orgId, name: 'Riverside CC' },
      teams: [],
    });
  });
});
```

Also update the `beforeAll` in `tests/tournament.test.js` to mount the new router:
```javascript
  app = buildTestApp({ withOrganization: true, withTournament: true });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js`
Expected: FAIL — `buildTestApp` doesn't recognize `withTournament` yet (option is silently ignored, so the route 404s at the Express layer, not from the controller).

- [ ] **Step 3: Add the 2 new locale keys**

In all three `src/locales/{en,hi,mr}/common.json`, insert after the 5 keys added in Task 1:

`en`:
```json
  "TOURNAMENT_NOT_FOUND": "That tournament couldn't be found",
  "TOURNAMENT_FETCHED": "Tournament fetched",
```
`hi`:
```json
  "TOURNAMENT_NOT_FOUND": "वह टूर्नामेंट नहीं मिल सका",
  "TOURNAMENT_FETCHED": "टूर्नामेंट प्राप्त हुआ",
```
`mr`:
```json
  "TOURNAMENT_NOT_FOUND": "ती स्पर्धा सापडली नाही",
  "TOURNAMENT_FETCHED": "स्पर्धा मिळाली",
```

- [ ] **Step 4: Create `tournament.controller.js`**

Create `src/controllers/tournament.controller.js`:
```javascript
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Tournament } from '../models/tournament.model.js';
import { Organization } from '../models/organization.model.js';
import { isOrgMember } from '../utils/organizationAccess.js';

const asString = (value) => (typeof value === 'string' ? value : '');

// Shared by every tournament endpoint in this file — mirrors
// organization.controller.js's findAccessibleOrganization/
// findOwnedOrganization pair, but derived from the tournament's own
// `organization` field rather than a route param.
const findAccessibleTournament = async (tournamentId, userId) => {
    const tournament = await Tournament.findOne({ _id: tournamentId, isDeleted: false });
    if (!tournament) {
        throw new ApiError(404, "TOURNAMENT_NOT_FOUND");
    }
    // Every non-deleted Tournament has a non-deleted Organization —
    // deleteOrganization cascades to soft-delete its tournaments in the
    // same transaction (see organization.controller.js), so there is no
    // "orphaned tournament" case to guard against here.
    const org = await Organization.findOne({ _id: tournament.organization, isDeleted: false });
    if (!isOrgMember(org, userId)) {
        throw new ApiError(403, "NOT_ORG_MEMBER");
    }
    return { tournament, org };
};

const findOwnedTournament = async (tournamentId, userId) => {
    const { tournament, org } = await findAccessibleTournament(tournamentId, userId);
    if (!org.owner.equals(userId)) {
        throw new ApiError(403, "TOURNAMENT_NOT_OWNED");
    }
    return { tournament, org };
};

const getTournament = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament, org } = await findAccessibleTournament(tournamentId, req.user._id);

    await tournament.populate('teams.team', 'name shortName');

    return res.status(200).json(new ApiResponse(200, {
        id: tournament._id,
        name: tournament.name,
        format: tournament.format,
        status: tournament.status,
        organization: { id: org._id, name: org.name },
        teams: tournament.teams.map((entry) => ({
            id: entry.team._id,
            name: entry.team.name,
            shortName: entry.team.shortName ?? null,
            joinedAt: entry.joinedAt,
        })),
        createdAt: tournament.createdAt,
    }, req.t("TOURNAMENT_FETCHED")));
});

export {
    findAccessibleTournament,
    findOwnedTournament,
    getTournament,
};
```

- [ ] **Step 5: Create `tournament.routes.js`**

Create `src/routes/tournament.routes.js`:
```javascript
import { Router } from "express";
import { getTournament } from "../controllers/tournament.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/:tournamentId').get(verifyJwt, getTournament);

export default router;
```

- [ ] **Step 6: Mount the router**

In `src/app.js`, add the import alongside the other routers:
```javascript
import tournamentRouter from './routes/tournament.routes.js';
```
and the mount line alongside `app.use("/api/v1/organization", organizationRouter);`:
```javascript
app.use("/api/v1/tournament", tournamentRouter);
```

- [ ] **Step 7: Add `withTournament` to buildTestApp.js**

In `tests/helpers/buildTestApp.js`, add the import:
```javascript
import tournamentRouter from '../../src/routes/tournament.routes.js';
```
Widen the destructured options and add the conditional mount, matching the existing `withOrganization` shape:
```javascript
export const buildTestApp = ({ withTranslations = false, withPlayer = false, withTeam = false, withOrganization = false, withTournament = false } = {}) => {
  const app = express();
  app.use(express.json());
  app.use(sanitizeMiddleware);
  app.use(localeMiddleware);
  app.use('/api/v1/match', matchRouter);
  if (withTranslations) {
    app.use('/api/v1/translations', translationRouter);
  }
  if (withPlayer) {
    app.use('/api/v1/player', playerRouter);
  }
  if (withTeam) {
    app.use('/api/v1/team', teamRouter);
  }
  if (withOrganization) {
    app.use('/api/v1/organization', organizationRouter);
  }
  if (withTournament) {
    app.use('/api/v1/tournament', tournamentRouter);
  }
  app.use(errorHandler);
  return app;
};
```

- [ ] **Step 8: Register the router in the auth allowlist suite**

In `tests/routes.auth.test.js`, add the import:
```javascript
import tournamentRouter from '../src/routes/tournament.routes.js';
```
Add to `PUBLIC_ROUTES`, after the `organization: [],` line:
```javascript
    // Every tournament route reads or manages a specific org's tournament,
    // same reasoning as organization above.
    tournament: [],
```
Add to `ROUTERS`, after the `organization: organizationRouter,` line:
```javascript
    tournament: tournamentRouter,
```

- [ ] **Step 9: Run test to verify it passes**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js tests/routes.auth.test.js`
Expected: PASS — all tests green, including the new `tournament router` / `tournament allowlist has no stale entries` cases the `it.each` in `routes.auth.test.js` now generates automatically.

- [ ] **Step 10: Run the full backend suite**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --maxWorkers=2`
Expected: PASS, zero regressions.

- [ ] **Step 11: Commit**

```bash
git add src/controllers/tournament.controller.js src/routes/tournament.routes.js src/app.js tests/helpers/buildTestApp.js tests/routes.auth.test.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json tests/tournament.test.js
git commit -m "feat: add GET /v1/tournament/:tournamentId"
```

---

### Task 4: PATCH /v1/tournament/:tournamentId

**Files:**
- Modify: `src/controllers/tournament.controller.js`
- Modify: `src/routes/tournament.routes.js`
- Modify: `src/locales/{en,hi,mr}/common.json` (4 new keys)
- Modify: `tests/tournament.test.js`

**Interfaces:**
- Consumes: `findOwnedTournament` (Task 3), `TOURNAMENT_FORMATS`/`TOURNAMENT_STATUS` (Task 1, imported fresh into this file).
- Produces: `updateTournament`, exported and routed as `PATCH /:tournamentId`.

- [ ] **Step 1: Write the failing test**

Add to `tests/tournament.test.js`:
```javascript
const updateTournament = (token, tournamentId, body) =>
  request(app).patch(`/api/v1/tournament/${tournamentId}`).set('Authorization', `Bearer ${token}`).send(body);

describe('PATCH /v1/tournament/:tournamentId', () => {
  it('updates name, format, and status together', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const tournamentId = tournamentRes.body.data.id;

    const res = await updateTournament(token, tournamentId, { name: 'Winter T20', format: 'league', status: 'ongoing' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Winter T20', format: 'league', status: 'ongoing' });
  });

  it('403s when a non-owner tries to update', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(ownerToken, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await updateTournament(strangerToken, tournamentRes.body.data.id, { name: 'Winter T20' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it('400s when no field is provided', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });

    const res = await updateTournament(token, tournamentRes.body.data.id, {});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOURNAMENT_UPDATE_FIELDS_REQUIRED');
  });

  it('400s for an invalid status', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });

    const res = await updateTournament(token, tournamentRes.body.data.id, { status: 'finished' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TOURNAMENT_STATUS');
  });

  it('409s when renaming into a name collision within the same organization', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await createTournament(token, orgId, { name: 'Winter T20', format: 'knockout' });
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });

    const res = await updateTournament(token, tournamentRes.body.data.id, { name: 'winter t20' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TOURNAMENT_NAME_TAKEN');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js -t "PATCH"`
Expected: FAIL — no route matches `PATCH /:tournamentId` yet (404).

- [ ] **Step 3: Add the 4 new locale keys**

`en`, after the two added in Task 3:
```json
  "TOURNAMENT_NOT_OWNED": "That tournament doesn't belong to your account",
  "TOURNAMENT_UPDATE_FIELDS_REQUIRED": "Provide at least one field to update",
  "INVALID_TOURNAMENT_STATUS": "That isn't a valid tournament status",
  "TOURNAMENT_UPDATED": "Tournament updated",
```
`hi`:
```json
  "TOURNAMENT_NOT_OWNED": "वह टूर्नामेंट आपके खाते से संबंधित नहीं है",
  "TOURNAMENT_UPDATE_FIELDS_REQUIRED": "अपडेट करने के लिए कम से कम एक फ़ील्ड दर्ज करें",
  "INVALID_TOURNAMENT_STATUS": "यह एक मान्य टूर्नामेंट स्थिति नहीं है",
  "TOURNAMENT_UPDATED": "टूर्नामेंट अपडेट किया गया",
```
`mr`:
```json
  "TOURNAMENT_NOT_OWNED": "ती स्पर्धा तुमच्या खात्याशी संबंधित नाही",
  "TOURNAMENT_UPDATE_FIELDS_REQUIRED": "अद्ययावत करण्यासाठी किमान एक फील्ड द्या",
  "INVALID_TOURNAMENT_STATUS": "ही वैध स्पर्धा स्थिती नाही",
  "TOURNAMENT_UPDATED": "स्पर्धा अद्ययावत केली",
```

- [ ] **Step 4: Add `updateTournament`**

In `src/controllers/tournament.controller.js`, widen the import line:
```javascript
import { Tournament, TOURNAMENT_FORMATS, TOURNAMENT_STATUS } from '../models/tournament.model.js';
```
Add the handler after `getTournament`:
```javascript
const updateTournament = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    const updates = {};

    if (req.body.name !== undefined) {
        const name = asString(req.body.name).trim();
        if (!name) {
            throw new ApiError(400, "TOURNAMENT_NAME_REQUIRED");
        }
        updates.name = name;
        updates.nameLower = name.toLowerCase();
    }
    if (req.body.format !== undefined) {
        const format = asString(req.body.format);
        if (!TOURNAMENT_FORMATS.includes(format)) {
            throw new ApiError(400, "INVALID_TOURNAMENT_FORMAT");
        }
        updates.format = format;
    }
    if (req.body.status !== undefined) {
        const status = asString(req.body.status);
        if (!TOURNAMENT_STATUS.includes(status)) {
            throw new ApiError(400, "INVALID_TOURNAMENT_STATUS");
        }
        updates.status = status;
    }
    if (Object.keys(updates).length === 0) {
        throw new ApiError(400, "TOURNAMENT_UPDATE_FIELDS_REQUIRED");
    }

    Object.assign(tournament, updates);
    try {
        await tournament.save();
    } catch (err) {
        const isNameCollision = err.code === 11000 && Object.hasOwn(err.keyPattern ?? {}, 'nameLower');
        if (isNameCollision) {
            throw new ApiError(409, "TOURNAMENT_NAME_TAKEN");
        }
        throw err;
    }

    return res.status(200).json(new ApiResponse(200, {
        id: tournament._id,
        name: tournament.name,
        format: tournament.format,
        status: tournament.status,
    }, req.t("TOURNAMENT_UPDATED")));
});
```
Add `updateTournament` to the file's `export { ... }` list.

- [ ] **Step 5: Wire the route**

In `src/routes/tournament.routes.js`, import `updateTournament` and chain it onto the existing route:
```javascript
router.route('/:tournamentId')
    .get(verifyJwt, getTournament)
    .patch(verifyJwt, updateTournament);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js`
Expected: PASS — all tests in the file green.

- [ ] **Step 7: Run the full backend suite**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --maxWorkers=2`
Expected: PASS, zero regressions.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/tournament.controller.js src/routes/tournament.routes.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json tests/tournament.test.js
git commit -m "feat: add PATCH /v1/tournament/:tournamentId"
```

---

### Task 5: DELETE /v1/tournament/:tournamentId

**Files:**
- Modify: `src/controllers/tournament.controller.js`
- Modify: `src/routes/tournament.routes.js`
- Modify: `src/locales/{en,hi,mr}/common.json` (1 new key)
- Modify: `tests/tournament.test.js`

**Interfaces:**
- Consumes: `findOwnedTournament` (Task 3).
- Produces: `deleteTournament`, exported and routed as `DELETE /:tournamentId`.

- [ ] **Step 1: Write the failing test**

Add to `tests/tournament.test.js`:
```javascript
const deleteTournament = (token, tournamentId) =>
  request(app).delete(`/api/v1/tournament/${tournamentId}`).set('Authorization', `Bearer ${token}`).send();

describe('DELETE /v1/tournament/:tournamentId', () => {
  it('soft-deletes the tournament', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const tournamentId = tournamentRes.body.data.id;

    const res = await deleteTournament(token, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tournamentId });

    const after = await getTournament(token, tournamentId);
    expect(after.status).toBe(404);
    expect(after.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });

  it('403s when a non-owner tries to delete', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(ownerToken, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await deleteTournament(strangerToken, tournamentRes.body.data.id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js -t "DELETE /v1/tournament/:tournamentId"`
Expected: FAIL — no route matches `DELETE /:tournamentId` yet (404, not the expected `200`/`403`).

- [ ] **Step 3: Add the 1 new locale key**

`en`: `"TOURNAMENT_DELETED": "Tournament deleted",`
`hi`: `"TOURNAMENT_DELETED": "टूर्नामेंट हटाया गया",`
`mr`: `"TOURNAMENT_DELETED": "स्पर्धा हटवली",`

(each inserted after the `TOURNAMENT_UPDATED` key added in Task 4, in its respective file)

- [ ] **Step 4: Add `deleteTournament`**

In `src/controllers/tournament.controller.js`, add after `updateTournament`:
```javascript
const deleteTournament = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    tournament.isDeleted = true;
    await tournament.save();

    return res.status(200).json(new ApiResponse(200, { tournamentId: tournament._id }, req.t("TOURNAMENT_DELETED")));
});
```
Add `deleteTournament` to the `export { ... }` list.

- [ ] **Step 5: Wire the route**

In `src/routes/tournament.routes.js`:
```javascript
router.route('/:tournamentId')
    .get(verifyJwt, getTournament)
    .patch(verifyJwt, updateTournament)
    .delete(verifyJwt, deleteTournament);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full backend suite**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --maxWorkers=2`
Expected: PASS, zero regressions.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/tournament.controller.js src/routes/tournament.routes.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json tests/tournament.test.js
git commit -m "feat: add DELETE /v1/tournament/:tournamentId"
```

---

### Task 6: POST /v1/tournament/:tournamentId/teams (enroll)

**Files:**
- Modify: `src/controllers/tournament.controller.js`
- Modify: `src/routes/tournament.routes.js`
- Modify: `src/locales/{en,hi,mr}/common.json` (4 new keys)
- Modify: `tests/tournament.test.js`

**Interfaces:**
- Consumes: `findOwnedTournament` (Task 3), `Team` model (imported fresh into this file).
- Produces: `addTournamentTeam`, exported and routed as `POST /:tournamentId/teams`.

- [ ] **Step 1: Write the failing test**

Add to `tests/tournament.test.js`:
```javascript
const addTeam = (token, tournamentId, body) =>
  request(app).post(`/api/v1/tournament/${tournamentId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

describe('POST /v1/tournament/:tournamentId/teams', () => {
  it("enrolls a team already in the tournament's organization", async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(token, orgId, { name: 'Riverside U19' });

    const res = await addTeam(token, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tournamentId: tournamentRes.body.data.id,
      team: { id: teamRes.body.data.id, name: 'Riverside U19' },
    });
  });

  it("400s for a team that doesn't belong to this tournament's organization", async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const otherOrgRes = await createOrg(token, { name: 'Downtown CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const outsideTeamRes = await createOrgTeam(token, otherOrgRes.body.data.id, { name: 'Downtown XI' });

    const res = await addTeam(token, tournamentRes.body.data.id, { teamId: outsideTeamRes.body.data.id });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NOT_IN_ORGANIZATION');
  });

  it('409s when the team is already enrolled', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(token, orgId, { name: 'Riverside U19' });
    await addTeam(token, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });

    const res = await addTeam(token, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEAM_ALREADY_IN_TOURNAMENT');
  });

  it('403s when a non-owner tries to enroll a team', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await addTeam(strangerToken, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it('404s for a nonexistent teamId', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });

    const res = await addTeam(token, tournamentRes.body.data.id, { teamId: '665f3b1c2d3e4f5a6b7c8d90' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js -t "POST /v1/tournament/:tournamentId/teams"`
Expected: FAIL — no route matches yet (404).

- [ ] **Step 3: Add the 4 new locale keys**

`en`, after `TOURNAMENT_DELETED`:
```json
  "TEAM_ID_REQUIRED": "The team to add must be specified",
  "TEAM_NOT_IN_ORGANIZATION": "That team doesn't belong to this tournament's organization",
  "TEAM_ALREADY_IN_TOURNAMENT": "That team is already in this tournament",
  "TEAM_ADDED_TO_TOURNAMENT": "Team added to tournament",
```
`hi`:
```json
  "TEAM_ID_REQUIRED": "जोड़ी जाने वाली टीम निर्दिष्ट करनी होगी",
  "TEAM_NOT_IN_ORGANIZATION": "वह टीम इस टूर्नामेंट के संगठन से संबंधित नहीं है",
  "TEAM_ALREADY_IN_TOURNAMENT": "वह टीम पहले से ही इस टूर्नामेंट में है",
  "TEAM_ADDED_TO_TOURNAMENT": "टीम को टूर्नामेंट में जोड़ा गया",
```
`mr`:
```json
  "TEAM_ID_REQUIRED": "जोडायचा संघ निर्दिष्ट करणे आवश्यक आहे",
  "TEAM_NOT_IN_ORGANIZATION": "तो संघ या स्पर्धेच्या संस्थेशी संबंधित नाही",
  "TEAM_ALREADY_IN_TOURNAMENT": "तो संघ आधीच या स्पर्धेत आहे",
  "TEAM_ADDED_TO_TOURNAMENT": "संघ स्पर्धेत जोडला",
```

`TEAM_NOT_FOUND` already exists in all three files (reused from `team.controller.js`'s own errors) — nothing to add for it.

- [ ] **Step 4: Add `addTournamentTeam`**

In `src/controllers/tournament.controller.js`, add the import:
```javascript
import { Team } from '../models/team.model.js';
```
Add the handler after `deleteTournament`:
```javascript
const addTournamentTeam = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament, org } = await findOwnedTournament(tournamentId, req.user._id);

    const teamId = asString(req.body.teamId).trim();
    if (!teamId) {
        throw new ApiError(400, "TEAM_ID_REQUIRED");
    }

    const team = await Team.findOne({ _id: teamId, isDeleted: false });
    if (!team) {
        throw new ApiError(404, "TEAM_NOT_FOUND");
    }
    if (!team.organization?.equals(org._id)) {
        throw new ApiError(400, "TEAM_NOT_IN_ORGANIZATION");
    }
    if (tournament.teams.some((entry) => entry.team.equals(team._id))) {
        throw new ApiError(409, "TEAM_ALREADY_IN_TOURNAMENT");
    }

    tournament.teams.push({ team: team._id });
    await tournament.save();

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        team: { id: team._id, name: team.name, shortName: team.shortName ?? null },
    }, req.t("TEAM_ADDED_TO_TOURNAMENT")));
});
```
Add `addTournamentTeam` to the `export { ... }` list.

- [ ] **Step 5: Wire the route**

In `src/routes/tournament.routes.js`, add the import and a new route:
```javascript
router.route('/:tournamentId/teams').post(verifyJwt, addTournamentTeam);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js`
Expected: PASS.

- [ ] **Step 7: Run the full backend suite**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --maxWorkers=2`
Expected: PASS, zero regressions.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/tournament.controller.js src/routes/tournament.routes.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json tests/tournament.test.js
git commit -m "feat: add POST /v1/tournament/:tournamentId/teams"
```

---

### Task 7: DELETE /v1/tournament/:tournamentId/teams/:teamId (remove)

**Files:**
- Modify: `src/controllers/tournament.controller.js`
- Modify: `src/routes/tournament.routes.js`
- Modify: `src/locales/{en,hi,mr}/common.json` (2 new keys)
- Modify: `tests/tournament.test.js`

**Interfaces:**
- Consumes: `findOwnedTournament` (Task 3).
- Produces: `removeTournamentTeam`, exported and routed as `DELETE /:tournamentId/teams/:teamId`.

- [ ] **Step 1: Write the failing test**

Add to `tests/tournament.test.js`:
```javascript
const removeTeam = (token, tournamentId, teamId) =>
  request(app).delete(`/api/v1/tournament/${tournamentId}/teams/${teamId}`).set('Authorization', `Bearer ${token}`).send();

describe('DELETE /v1/tournament/:tournamentId/teams/:teamId', () => {
  it('removes an enrolled team', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });
    const tournamentId = tournamentRes.body.data.id;
    const teamRes = await createOrgTeam(token, orgId, { name: 'Riverside U19' });
    await addTeam(token, tournamentId, { teamId: teamRes.body.data.id });

    const res = await removeTeam(token, tournamentId, teamRes.body.data.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tournamentId, teamId: teamRes.body.data.id });

    const after = await getTournament(token, tournamentId);
    expect(after.body.data.teams).toEqual([]);
  });

  it("404s when the team isn't enrolled", async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(token, orgId, { name: 'Riverside U19' });

    const res = await removeTeam(token, tournamentRes.body.data.id, teamRes.body.data.id);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_IN_TOURNAMENT');
  });

  it('403s when a non-owner tries to remove a team', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    await addTeam(ownerToken, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await removeTeam(strangerToken, tournamentRes.body.data.id, teamRes.body.data.id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js -t "DELETE /v1/tournament/:tournamentId/teams/:teamId"`
Expected: FAIL — no route matches yet (404).

- [ ] **Step 3: Add the 2 new locale keys**

`en`, after `TEAM_ADDED_TO_TOURNAMENT`:
```json
  "TEAM_NOT_IN_TOURNAMENT": "That team isn't in this tournament",
  "TEAM_REMOVED_FROM_TOURNAMENT": "Team removed from tournament",
```
`hi`:
```json
  "TEAM_NOT_IN_TOURNAMENT": "वह टीम इस टूर्नामेंट में नहीं है",
  "TEAM_REMOVED_FROM_TOURNAMENT": "टीम को टूर्नामेंट से हटाया गया",
```
`mr`:
```json
  "TEAM_NOT_IN_TOURNAMENT": "तो संघ या स्पर्धेत नाही",
  "TEAM_REMOVED_FROM_TOURNAMENT": "संघ स्पर्धेतून काढला",
```

- [ ] **Step 4: Add `removeTournamentTeam`**

In `src/controllers/tournament.controller.js`, add after `addTournamentTeam`:
```javascript
const removeTournamentTeam = catchAsync(async (req, res) => {
    const { tournamentId, teamId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    const wasEnrolled = tournament.teams.some((entry) => entry.team.equals(teamId));
    if (!wasEnrolled) {
        throw new ApiError(404, "TEAM_NOT_IN_TOURNAMENT");
    }

    tournament.teams = tournament.teams.filter((entry) => !entry.team.equals(teamId));
    await tournament.save();

    return res.status(200).json(new ApiResponse(200, { tournamentId: tournament._id, teamId }, req.t("TEAM_REMOVED_FROM_TOURNAMENT")));
});
```
Add `removeTournamentTeam` to the `export { ... }` list.

- [ ] **Step 5: Wire the route**

In `src/routes/tournament.routes.js`:
```javascript
router.route('/:tournamentId/teams/:teamId').delete(verifyJwt, removeTournamentTeam);
```

The complete file after this task:
```javascript
import { Router } from "express";
import { getTournament, updateTournament, deleteTournament, addTournamentTeam, removeTournamentTeam } from "../controllers/tournament.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/:tournamentId')
    .get(verifyJwt, getTournament)
    .patch(verifyJwt, updateTournament)
    .delete(verifyJwt, deleteTournament);
router.route('/:tournamentId/teams').post(verifyJwt, addTournamentTeam);
router.route('/:tournamentId/teams/:teamId').delete(verifyJwt, removeTournamentTeam);

export default router;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/tournament.test.js`
Expected: PASS — every describe block in the file green.

- [ ] **Step 7: Run the full backend suite**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --maxWorkers=2`
Expected: PASS, zero regressions.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/tournament.controller.js src/routes/tournament.routes.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json tests/tournament.test.js
git commit -m "feat: add DELETE /v1/tournament/:tournamentId/teams/:teamId"
```

---

### Task 8: Cascade — deleting an organization soft-deletes its tournaments

**Files:**
- Modify: `src/controllers/organization.controller.js` (`deleteOrganization`)
- Modify: `tests/organization.test.js`

**Interfaces:**
- Consumes: `Tournament` model (already imported in Task 1).
- Produces: no new export — behavior change only, closing the invariant gap `Tournament.organization` being required creates (see this plan's header).

- [ ] **Step 1: Write the failing test**

In `tests/organization.test.js`, add this test inside the existing `describe('DELETE /v1/organization/:orgId', ...)` block, after the `'soft-deletes the organization and orphans its teams back to standalone'` test:

```javascript
  it('soft-deletes tournaments under the organization (they cannot be orphaned like teams)', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await request(app)
      .post(`/api/v1/organization/${orgId}/tournaments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Summer T20', format: 'knockout' });
    const tournamentId = tournamentRes.body.data.id;

    await deleteOrg(token, orgId);

    const tournament = await Tournament.findById(tournamentId);
    expect(tournament.isDeleted).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/organization.test.js -t "soft-deletes tournaments under the organization"`
Expected: FAIL — `tournament.isDeleted` is still `false`, since `deleteOrganization` doesn't touch `Tournament` yet.

- [ ] **Step 3: Widen the transaction**

In `src/controllers/organization.controller.js`, replace `deleteOrganization`:
```javascript
const deleteOrganization = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findOwnedOrganization(orgId, req.user._id);

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await Organization.updateOne({ _id: org._id }, { $set: { isDeleted: true } }, { session });
            await Team.updateMany({ organization: org._id }, { $set: { organization: null } }, { session });
            // Unlike Team, a Tournament can't be orphaned back to standalone —
            // `organization` is required (tournament.model.js) since
            // tournament hosting has no ad-hoc/standalone case. The only way
            // to keep "every non-deleted Tournament has a non-deleted
            // Organization" true is to soft-delete them along with the org.
            await Tournament.updateMany({ organization: org._id }, { $set: { isDeleted: true } }, { session });
        });
    } finally {
        await session.endSession();
    }

    return res.status(200).json(new ApiResponse(200, { orgId: org._id }, req.t("ORGANIZATION_DELETED")));
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest tests/organization.test.js`
Expected: PASS — all tests in the file green, including the pre-existing team-orphaning test (unaffected — teams still get `organization: null`, not deleted).

- [ ] **Step 5: Run the full backend suite**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --maxWorkers=2`
Expected: PASS, zero regressions.

- [ ] **Step 6: Commit**

```bash
git add src/controllers/organization.controller.js tests/organization.test.js
git commit -m "fix: cascade-delete an org's tournaments when the org is deleted"
```

---

### Task 9: Document the endpoints in docs/api.md, final verification

**Files:**
- Modify: `docs/api.md` (workspace root — not version-controlled by this repo)

**Interfaces:**
- Consumes: the finished endpoint set from Tasks 1–8 — this section documents the actual shipped behavior, not a plan of it.
- Produces: nothing consumed by later tasks — this is the last task in this plan.

- [ ] **Step 1: Replace the `## Tournament` section's "not covered" framing**

The existing `## Tournament` section (added by the earlier contract-only plan) opens with "This section is contract-only... There is no `POST`/`GET`/`PATCH` endpoint for tournaments yet." That's now false. Replace the whole `## Tournament` section with:

```markdown
## Tournament

Built on top of the model the earlier contract-only pass defined. A
tournament always belongs to exactly one `Organization` — there is no
standalone/ad-hoc tournament — and only that organization's **owner** may
create, update, delete, or manage the team roster of a tournament under it;
any member of the organization may read it. This mirrors
`organization.controller.js`'s own owner-vs-member split for teams.

### POST /v1/organization/:orgId/tournaments

Owner-only. Creates a tournament under the organization.

```json
{ "name": "Summer T20", "format": "knockout" }
```

| Field | Type | Rules |
|---|---|---|
| `name` | string | required, non-empty, trimmed, max 100 (same as `Tournament.name`) |
| `format` | string | required, one of `knockout` \| `round_robin` \| `league` |

### Response `200`
```json
{
  "statusCode": 200,
  "data": {
    "id": "665f1a2b3c4d5e6f7a8b9c50",
    "name": "Summer T20",
    "organization": "665f1a2b3c4d5e6f7a8b9c99",
    "format": "knockout",
    "status": "upcoming",
    "teams": [],
    "createdAt": "2026-09-05T10:00:00.000Z"
  },
  "message": "Tournament created",
  "success": true
}
```

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `ORG_NOT_FOUND` | `orgId` doesn't exist or is soft-deleted |
| 403 | `ORG_NOT_OWNED` | caller isn't the org's owner |
| 400 | `TOURNAMENT_NAME_REQUIRED` | `name` missing or empty after trim |
| 400 | `TOURNAMENT_FORMAT_REQUIRED` | `format` missing |
| 400 | `INVALID_TOURNAMENT_FORMAT` | `format` isn't one of the three enum values |
| 409 | `TOURNAMENT_NAME_TAKEN` | this organization already has a non-deleted tournament with this name (case-insensitive) |
| 400 | `INVALID_ID` | `orgId` is not a well-formed ObjectId |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

`GET /v1/organization/:orgId`'s existing response is widened with a
`tournaments: [{id, name, format, status, teamCount}]` array — the same
"summary list on the parent's profile" treatment already given to `teams`
there. No new endpoint for listing; see that section above.

### GET /v1/tournament/:tournamentId

Any member of the owning organization. Full detail, including the enrolled
team roster.

### Response `200`
```json
{
  "statusCode": 200,
  "data": {
    "id": "665f1a2b3c4d5e6f7a8b9c50",
    "name": "Summer T20",
    "format": "knockout",
    "status": "upcoming",
    "organization": { "id": "665f1a2b3c4d5e6f7a8b9c99", "name": "Riverside Cricket Club" },
    "teams": [
      { "id": "665f1a2b3c4d5e6f7a8b9c05", "name": "Riverside U19", "shortName": "RU19", "joinedAt": "2026-09-05T10:05:00.000Z" }
    ],
    "createdAt": "2026-09-05T10:00:00.000Z"
  },
  "message": "Tournament fetched",
  "success": true
}
```

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `NOT_ORG_MEMBER` | tournament exists but the caller isn't a member of its organization |
| 400 | `INVALID_ID` | `tournamentId` is not a well-formed ObjectId |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

### PATCH /v1/tournament/:tournamentId

Owner-only. Updates any subset of `name`, `format`, `status`. No
business-rule gating on status transitions in this pass (e.g. requiring a
minimum team count before `ongoing`) — that logic arrives with fixture
generation, a later phase; for now this is a plain field-level update.

```json
{ "status": "ongoing" }
```

### Response `200`
```json
{ "statusCode": 200, "data": { "id": "…", "name": "Summer T20", "format": "knockout", "status": "ongoing" }, "message": "Tournament updated", "success": true }
```

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `TOURNAMENT_NOT_OWNED` | caller isn't the owner of the tournament's organization |
| 400 | `TOURNAMENT_UPDATE_FIELDS_REQUIRED` | body contains none of `name`/`format`/`status` |
| 400 | `TOURNAMENT_NAME_REQUIRED` | `name` present but empty after trim |
| 400 | `INVALID_TOURNAMENT_FORMAT` | `format` present but not one of the enum values |
| 400 | `INVALID_TOURNAMENT_STATUS` | `status` present but not one of the enum values |
| 409 | `TOURNAMENT_NAME_TAKEN` | renaming into a collision within the same organization |
| 400 | `INVALID_ID` | `tournamentId` is not a well-formed ObjectId |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

### DELETE /v1/tournament/:tournamentId

Owner-only. Soft-deletes the tournament. Enrolled teams are untouched —
`Team` never references `Tournament`, only the reverse.

### Response `200`
```json
{ "statusCode": 200, "data": { "tournamentId": "…" }, "message": "Tournament deleted", "success": true }
```

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is already soft-deleted |
| 403 | `TOURNAMENT_NOT_OWNED` | caller isn't the owner of the tournament's organization |
| 400 | `INVALID_ID` | `tournamentId` is not a well-formed ObjectId |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

**Deleting the owning organization cascades here too**: `DELETE
/v1/organization/:orgId` soft-deletes every tournament under it in the same
transaction that orphans its teams. Unlike `Team`, a `Tournament` cannot be
orphaned back to standalone — `organization` is required — so cascade-delete
is the only option that keeps "every non-deleted tournament has a
non-deleted organization" true.

### POST /v1/tournament/:tournamentId/teams

Owner-only. Enrolls a team — which must already belong to this tournament's
own organization — into the tournament.

```json
{ "teamId": "665f1a2b3c4d5e6f7a8b9c05" }
```

### Response `200`
```json
{ "statusCode": 200, "data": { "tournamentId": "…", "team": { "id": "665f1a2b3c4d5e6f7a8b9c05", "name": "Riverside U19", "shortName": "RU19" } }, "message": "Team added to tournament", "success": true }
```

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `TOURNAMENT_NOT_OWNED` | caller isn't the owner of the tournament's organization |
| 400 | `TEAM_ID_REQUIRED` | `teamId` missing or empty |
| 404 | `TEAM_NOT_FOUND` | `teamId` doesn't exist or is soft-deleted |
| 400 | `TEAM_NOT_IN_ORGANIZATION` | the team's `organization` isn't this tournament's organization |
| 409 | `TEAM_ALREADY_IN_TOURNAMENT` | that team is already enrolled |
| 400 | `INVALID_ID` | `tournamentId`/`teamId` is not a well-formed ObjectId |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

### DELETE /v1/tournament/:tournamentId/teams/:teamId

Owner-only. Removes a team from the tournament roster. Enrollment history
isn't kept — the subdocument is simply removed, not soft-deleted.

### Response `200`
```json
{ "statusCode": 200, "data": { "tournamentId": "…", "teamId": "…" }, "message": "Team removed from tournament", "success": true }
```

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `TOURNAMENT_NOT_OWNED` | caller isn't the owner of the tournament's organization |
| 404 | `TEAM_NOT_IN_TOURNAMENT` | `teamId` isn't currently enrolled in this tournament |
| 400 | `INVALID_ID` | `tournamentId`/`teamId` is not a well-formed ObjectId |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |

### What this pass does NOT cover

- Fixture generation, points table / standings, or tournament leaderboards
  — all listed separately in `docs/roadmap.md` Phase 3 and none of them can
  be built on CRUD alone.
- Any change to `Match` — `Match` does not yet reference `Tournament` in any
  way.
- Any client-side (`cricket-scrorer`) model, endpoint, or UI.
```

This replaces the section between the `---` after `## Organization` and the
`---` before `## Locale keys`.

- [ ] **Step 2: Update the Schema state entry**

Replace the existing "**Applied by the tournament contract:**" paragraph
(in `## Schema state`) with:

```markdown
**Applied by the tournament contract:**
- `tournament.model.js`: `name`, `nameLower`, `organization` (required,
  ref `Organization`), `format` (enum `knockout`/`round_robin`/`league`,
  now exported as `TOURNAMENT_FORMATS` for controller-side validation),
  `teams: [{team, joinedAt}]` (ref `Team`), `status` (enum, default
  `upcoming`, exported as `TOURNAMENT_STATUS`), `createdBy` (ref `User`),
  `isDeleted`. Unique `{organization, nameLower}` index;
  `{organization: 1, createdAt: -1}`; `{'teams.team': 1}`.
- `organization.controller.js`: `deleteOrganization`'s transaction now also
  soft-deletes every `Tournament` under the org being deleted, alongside the
  existing team-orphaning — `Tournament.organization` is required, so
  cascade-delete (not orphaning) is what keeps every non-deleted tournament
  pointing at a non-deleted organization.
- No changes to `Match`, `Team`, or `Organization`'s own schemas — the CRUD
  layer reads `Organization`/`Team` and writes only `Tournament`.

New collection had no prior writer before this contract; now it does. No
migration — every field is either new-with-default or written for the
first time by these endpoints.
```

- [ ] **Step 3: Add an open item**

At the end of `## Open items (not settled by this contract)`, add:
```markdown
- **A team detached from its organization stays enrolled in that
  organization's tournaments.** `PATCH /v1/team/:teamId/organization` (the
  organization contract) lets a team's owner detach it back to standalone
  at any time; `POST /v1/tournament/:tournamentId/teams` only checks
  membership at enroll time, so a team removed from the org afterward is
  not retroactively dropped from any tournament it had already joined.
  Deliberately not solved here — it's a rare admin sequence (detach a team
  that's mid-tournament), and the fix would need a decision about whether
  that even should cascade before code is written for it.
```

- [ ] **Step 4: Final full-suite verification**

Run: `NODE_ENV=test NODE_OPTIONS=--experimental-vm-modules npx jest --maxWorkers=2`
Expected: PASS, full count with zero regressions — this is the number to
report as the plan's completion evidence.

Confirm the workspace root still isn't a git repo (so this step's edit needs
no commit): `git -C /Users/samirsuroshe/Projects/Cricket-Scorer-Project/cricket-scorer-workspace status` should report "not a git repository".

---

## Self-Review Notes

- **Spec coverage:** every endpoint from the approved design (create, widened org-profile read, get, update, delete, enroll, remove) has its own task; the cascade-delete side effect found during design has its own task (8); the deliberately-out-of-scope team-detach gap is recorded in `docs/api.md`'s open items (Task 9), not silently dropped.
- **Placeholder scan:** no TBD/TODO; every code block is complete and copy-pasteable, including all locale-file insertions in all three languages for every task that adds a key.
- **Type consistency:** `findAccessibleTournament`/`findOwnedTournament` return `{ tournament, org }` consistently from Task 3 onward; every handler that needs the org (`getTournament`, `addTournamentTeam`) destructures `org` from that same shape rather than re-fetching it. `TOURNAMENT_FORMATS`/`TOURNAMENT_STATUS` are imported with those exact names in every task that validates against them, matching the export names introduced in Task 1. Response field names (`tournamentId`, `teamId`, `team: {id, name, shortName}`) are consistent between the controller code and the `docs/api.md` examples in Task 9.
