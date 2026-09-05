# Organizations and Persistent Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every task in this plan (tests before implementation). Execution is inline in this session, task-by-task, not subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let persistent `Team` documents optionally belong to a new `Organization` (owner + members), so several scorers can share the same teams, without changing any ad-hoc/single-scorer match-creation behavior.

**Architecture:** One new model (`Organization`) and one new controller/router (`organization.*`), following the exact conventions `team.controller.js`/`team.routes.js` already establish. Three existing access-control sites (`resolveTeamSide`, `findOwnedTeam`, `listMyTeams`) are widened via one new shared utility, `canAccessTeam`/`getMemberOrgIds`, so a team's creator and its organization's members are both granted access through a single code path.

**Tech Stack:** Node, Express 5, Mongoose, Jest + Supertest, `mongodb-memory-server` (`MongoMemoryReplSet`, required for the one task that uses a transaction).

**Spec:** [docs/superpowers/specs/2026-09-05-organizations-and-persistent-teams-design.md](../specs/2026-09-05-organizations-and-persistent-teams-design.md) — the finalized wire contract is [docs/api.md](../../../../docs/api.md)'s `## Organization` section (workspace root, outside version control).

## Global Constraints

- Ad-hoc match creation (`POST /v1/match/create` with no `teamAId`/`teamBId`) must not change behavior at all — `resolveTeamSide`'s no-id branch and `createTeam` are never touched.
- Every `Team` document defaults to `organization: null` — standalone is the unaffected default, not a special case.
- Two roles only: `owner`, `member`. No `admin` tier, no ownership transfer.
- Error codes follow the existing `TEAM_NOT_FOUND`/`TEAM_NOT_OWNED` naming shape: 404 for "doesn't exist", 403 for "exists but you can't touch it".
- Response envelope is always `new ApiResponse(200, data, req.t(KEY))` — this codebase uses `200`, never `201`, for every creation endpoint (see `createMatch`).
- Every new locale key ships in **all three** of `src/locales/en/common.json`, `src/locales/hi/common.json`, `src/locales/mr/common.json` — `tests/locales.test.js` fails the whole suite on any mismatch.
- `tests/routes.auth.test.js` fails the build if any new route lacks `verifyJwt` and isn't in that route's `PUBLIC_ROUTES` allowlist entry.
- Test DB helpers (`tests/setup/testDb.js`: `connectTestDb`, `disconnectTestDb`, `clearTestDb`) and test app builder (`tests/helpers/buildTestApp.js`) already exist — extend, don't reinvent.
- Run tests with `npm test` (full suite) or `npm test -- <path>` (one file). No `.env.test` or external MongoDB needed — `mongodb-memory-server` is self-contained.

---

## Task 1: `Organization` model

**Files:**
- Create: `src/models/organization.model.js`
- Test: `tests/organizationModel.test.js`

**Interfaces:**
- Produces: `Organization` (default export is named, `export const Organization = mongoose.model('Organization', organizationSchema)`), with fields `name`, `nameLower`, `owner` (`ObjectId` ref `User`), `members: [{user, role, addedAt}]`, `isDeleted`, `createdAt`/`updatedAt` (via `timestamps: true`). Unique index on `{owner, nameLower}`.

- [ ] **Step 1: Write the failing test**

```js
// tests/organizationModel.test.js
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';

describe('Organization model', () => {
  beforeAll(async () => {
    await connectTestDb();
    // Indexes are created asynchronously on connect; wait for them so the
    // uniqueness tests below aren't racing index creation.
    await Organization.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const ownerId = () => new mongoose.Types.ObjectId();

  it('requires name and owner', async () => {
    await expect(Organization.create({})).rejects.toThrow();
  });

  it('defaults isDeleted to false and stamps addedAt on a member', async () => {
    const owner = ownerId();
    const org = await Organization.create({
      name: 'Riverside Cricket Club',
      nameLower: 'riverside cricket club',
      owner,
      members: [{ user: owner, role: 'owner' }],
    });

    expect(org.isDeleted).toBe(false);
    expect(org.members[0].role).toBe('owner');
    expect(org.members[0].addedAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate {owner, nameLower} pair', async () => {
    const owner = ownerId();
    await Organization.create({
      name: 'Riverside CC',
      nameLower: 'riverside cc',
      owner,
      members: [{ user: owner, role: 'owner' }],
    });

    await expect(
      Organization.create({
        name: 'Riverside CC',
        nameLower: 'riverside cc',
        owner,
        members: [{ user: owner, role: 'owner' }],
      })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows two different owners to use the same name', async () => {
    const ownerA = ownerId();
    const ownerB = ownerId();
    await Organization.create({
      name: 'Riverside CC',
      nameLower: 'riverside cc',
      owner: ownerA,
      members: [{ user: ownerA, role: 'owner' }],
    });

    await expect(
      Organization.create({
        name: 'Riverside CC',
        nameLower: 'riverside cc',
        owner: ownerB,
        members: [{ user: ownerB, role: 'owner' }],
      })
    ).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- organizationModel`
Expected: `FAIL` — `Cannot find module '../src/models/organization.model.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/models/organization.model.js
import mongoose, { Schema } from "mongoose";

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    // Derived from `name` by organization.controller.js on every write,
    // same convention as Player.nameLower (see that model's own comment on
    // why a schema hook isn't used instead — findOrCreate-style upserts
    // bypass document middleware).
    nameLower: { type: String, required: true, trim: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    members: [
      {
        user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        role: { type: String, enum: ['owner', 'member'], required: true },
        addedAt: { type: Date, default: Date.now },
      },
    ],
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Unique per owner, same shape as Player's {createdBy, nameLower} — one
// owner can't create two organizations with the same name (case-insensitive
// via nameLower). Deliberately not global uniqueness: two different owners
// naming their club the same real-world name is expected, not a collision.
organizationSchema.index({ owner: 1, nameLower: 1 }, { unique: true });
// Supports "which organizations am I a member of" — GET /v1/organization
// and getMemberOrgIds (used by the widened GET /v1/team query).
organizationSchema.index({ 'members.user': 1 });

export const Organization = mongoose.model('Organization', organizationSchema);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- organizationModel`
Expected: `PASS`, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/models/organization.model.js tests/organizationModel.test.js
git commit -m "feat: add Organization model"
```

---

## Task 2: `organizationAccess` utility

**Files:**
- Create: `src/utils/organizationAccess.js`
- Modify: `src/models/team.model.js` (add the `organization` field and index)
- Test: `tests/organizationAccess.test.js`

**Interfaces:**
- Consumes: `Organization` from Task 1.
- Produces: `isOrgMember(org, userId) => boolean`, `canAccessTeam(team, userId) => Promise<boolean>`, `getMemberOrgIds(userId) => Promise<ObjectId[]>` — all three are imported by Tasks 5–11.

The spec's pseudocode (`canAccessTeam(team, org, userId)`, org fetched by the caller) is simplified here to `canAccessTeam(team, userId)`, which fetches the organization itself when `team.organization` is set. This removes a redundant fetch at every call site without changing the contract — none of the three real call sites (Task 11) already has the org loaded.

- [ ] **Step 1: Write the failing test**

```js
// tests/organizationAccess.test.js
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';
import { Team } from '../src/models/team.model.js';
import { canAccessTeam, getMemberOrgIds } from '../src/utils/organizationAccess.js';

describe('organizationAccess', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Organization.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('canAccessTeam is true for the team creator, even with no organization', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const team = await Team.create({ name: 'A', createdBy: ownerId });

    await expect(canAccessTeam(team, ownerId)).resolves.toBe(true);
  });

  it('canAccessTeam is false for a stranger to a standalone team', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const strangerId = new mongoose.Types.ObjectId();
    const team = await Team.create({ name: 'A', createdBy: ownerId });

    await expect(canAccessTeam(team, strangerId)).resolves.toBe(false);
  });

  it('canAccessTeam is true for an org member on an org-owned team, even if they did not create it', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId();
    const org = await Organization.create({
      name: 'Riverside CC',
      nameLower: 'riverside cc',
      owner: ownerId,
      members: [
        { user: ownerId, role: 'owner' },
        { user: memberId, role: 'member' },
      ],
    });
    const team = await Team.create({ name: 'Riverside U19', createdBy: ownerId, organization: org._id });

    await expect(canAccessTeam(team, memberId)).resolves.toBe(true);
  });

  it('canAccessTeam is false for a non-member even when the team belongs to an organization', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const strangerId = new mongoose.Types.ObjectId();
    const org = await Organization.create({
      name: 'Riverside CC',
      nameLower: 'riverside cc',
      owner: ownerId,
      members: [{ user: ownerId, role: 'owner' }],
    });
    const team = await Team.create({ name: 'Riverside U19', createdBy: ownerId, organization: org._id });

    await expect(canAccessTeam(team, strangerId)).resolves.toBe(false);
  });

  it('getMemberOrgIds returns every non-deleted org the user belongs to, owner or member', async () => {
    const userId = new mongoose.Types.ObjectId();
    const otherId = new mongoose.Types.ObjectId();
    const orgOwned = await Organization.create({
      name: 'Owned', nameLower: 'owned', owner: userId, members: [{ user: userId, role: 'owner' }],
    });
    const orgMemberOf = await Organization.create({
      name: 'Joined', nameLower: 'joined', owner: otherId,
      members: [{ user: otherId, role: 'owner' }, { user: userId, role: 'member' }],
    });
    await Organization.create({
      name: 'Unrelated', nameLower: 'unrelated', owner: otherId, members: [{ user: otherId, role: 'owner' }],
    });

    const ids = await getMemberOrgIds(userId);

    expect(ids.map(String).sort()).toEqual([String(orgOwned._id), String(orgMemberOf._id)].sort());
  });

  it('getMemberOrgIds excludes a soft-deleted organization', async () => {
    const userId = new mongoose.Types.ObjectId();
    const org = await Organization.create({
      name: 'Deleted', nameLower: 'deleted', owner: userId,
      members: [{ user: userId, role: 'owner' }], isDeleted: true,
    });

    const ids = await getMemberOrgIds(userId);

    expect(ids.map(String)).not.toContain(String(org._id));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- organizationAccess`
Expected: `FAIL` — `Cannot find module '../src/utils/organizationAccess.js'` (and `Team.create` will also reject `organization` as an unknown path until Step 3's model edit lands, but that edit ships in the same step below since both are needed for this test to mean anything).

- [ ] **Step 3: Write minimal implementation**

First, add the `organization` field to `Team` — modify `src/models/team.model.js`:

```js
import mongoose, {Schema} from "mongoose";

const teamSchema = new Schema(
  {
    name:       { type: String, required: true, trim: true, maxlength: 50 },
    shortName:  { type: String, trim: true, maxlength: 5, uppercase: true },
    players:    [{ type: Schema.Types.ObjectId, ref: 'Player' }],
    createdBy:  { type: Schema.Types.ObjectId, ref: 'User' },
    // Optional — null is the default and the only value every team created
    // before this feature, or created ad-hoc since, ever has. Set only via
    // POST /v1/organization/:orgId/teams (create-under-org) or
    // PATCH /v1/team/:teamId/organization (attach an existing team).
    organization: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    isDeleted:  { type: Boolean, default: false },
  },
  { timestamps: true }
);

teamSchema.index({ name: 'text' });
teamSchema.index({ createdBy: 1, createdAt: -1 });
teamSchema.index({ organization: 1, createdAt: -1 });

export const Team = mongoose.model('Team', teamSchema);
```

Then create `src/utils/organizationAccess.js`:

```js
import { Organization } from '../models/organization.model.js';

// True when `userId` is present in `org.members`, regardless of role — an
// owner is always also a member entry (see organization.controller.js's
// createOrganization), so this single check covers both roles.
export const isOrgMember = (org, userId) =>
    org.members.some((m) => m.user.equals(userId));

// True if `userId` can view/use `team` — either they created it directly,
// or it belongs to an organization they're a member of. Backs the widened
// resolveTeamSide (match.controller.js) and findOwnedTeam (team.controller.js).
export const canAccessTeam = async (team, userId) => {
    if (team.createdBy?.equals(userId)) {
        return true;
    }
    if (!team.organization) {
        return false;
    }
    const org = await Organization.findOne({ _id: team.organization, isDeleted: false });
    return org != null && isOrgMember(org, userId);
};

// Every non-deleted organization `userId` belongs to, owner or member —
// backs the widened GET /v1/team query in listMyTeams.
export const getMemberOrgIds = async (userId) => {
    const orgs = await Organization.find(
        { 'members.user': userId, isDeleted: false },
        '_id'
    );
    return orgs.map((org) => org._id);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- organizationAccess`
Expected: `PASS`, 6 tests.

Also re-run the existing team test suite to confirm the additive schema field breaks nothing:
Run: `npm test -- teamProfile matchTeamScoping`
Expected: `PASS`, all pre-existing tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/models/team.model.js src/utils/organizationAccess.js tests/organizationAccess.test.js
git commit -m "feat: add Team.organization field and organizationAccess utility"
```

---

## Task 3: `POST /v1/organization` (create)

**Files:**
- Create: `src/controllers/organization.controller.js`
- Create: `src/routes/organization.routes.js`
- Modify: `src/app.js` (mount the new router)
- Modify: `tests/helpers/buildTestApp.js` (add `withOrganization` flag)
- Modify: `src/locales/en/common.json`, `src/locales/hi/common.json`, `src/locales/mr/common.json`
- Test: `tests/organization.test.js`

**Interfaces:**
- Consumes: `Organization` (Task 1).
- Produces: `createOrganization` (exported from `organization.controller.js`) — every later task in this plan adds one more export to this same file and one more route to this same router.

- [ ] **Step 1: Write the failing test**

```js
// tests/organization.test.js
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';

describe('POST /v1/organization', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    await Organization.init();
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

  it('creates an organization with the caller as owner and sole member', async () => {
    const { token, user } = await createTestUser({ fullName: 'Asha' });

    const res = await createOrg(token, { name: 'Riverside Cricket Club' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Riverside Cricket Club',
      owner: { id: String(user._id), name: 'Asha' },
      members: [{ id: String(user._id), name: 'Asha', role: 'owner' }],
      teams: [],
    });
  });

  it('400s for an empty name', async () => {
    const { token } = await createTestUser();

    const res = await createOrg(token, { name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORG_NAME_REQUIRED');
  });

  it("409s when the same owner reuses a name, case-insensitively", async () => {
    const { token } = await createTestUser();
    await createOrg(token, { name: 'Riverside CC' });

    const res = await createOrg(token, { name: 'riverside cc' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORG_NAME_TAKEN');
  });

  it('allows two different owners to use the same name', async () => {
    const { token: token1 } = await createTestUser({ email: 'owner1@example.com' });
    const { token: token2 } = await createTestUser({ email: 'owner2@example.com' });
    await createOrg(token1, { name: 'Riverside CC' });

    const res = await createOrg(token2, { name: 'Riverside CC' });

    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- organization.test`
Expected: `FAIL` — `buildTestApp` doesn't recognize `withOrganization` yet, and `organization.controller.js`/`organization.routes.js` don't exist.

- [ ] **Step 3: Write minimal implementation**

`src/controllers/organization.controller.js`:

```js
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Organization } from '../models/organization.model.js';

const asString = (value) => (typeof value === 'string' ? value : '');

const createOrganization = catchAsync(async (req, res) => {
    const name = asString(req.body.name).trim();
    if (!name) {
        throw new ApiError(400, "ORG_NAME_REQUIRED");
    }

    let org;
    try {
        org = await Organization.create({
            name,
            nameLower: name.toLowerCase(),
            owner: req.user._id,
            members: [{ user: req.user._id, role: 'owner' }],
        });
    } catch (err) {
        const isNameCollision = err.code === 11000 && Object.hasOwn(err.keyPattern ?? {}, 'nameLower');
        if (isNameCollision) {
            throw new ApiError(409, "ORG_NAME_TAKEN");
        }
        throw err;
    }

    return res.status(200).json(new ApiResponse(200, {
        id: org._id,
        name: org.name,
        owner: { id: req.user._id, name: req.user.fullName },
        members: [{ id: req.user._id, name: req.user.fullName, role: 'owner' }],
        teams: [],
        createdAt: org.createdAt,
    }, req.t("ORGANIZATION_CREATED")));
});

export { createOrganization };
```

`src/routes/organization.routes.js`:

```js
import { Router } from "express";
import { createOrganization } from "../controllers/organization.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/').post(verifyJwt, createOrganization);

export default router;
```

Modify `src/app.js` — add the import alongside the other four, and the mount alongside the other five:

```js
import teamRouter from './routes/team.routes.js';
import organizationRouter from './routes/organization.routes.js';

//Routes declaration
app.use("/api/v1/user", userRouter);
app.use("/api/v1/translations", translationRouter);
app.use("/api/v1/match", matchRouter);
app.use("/api/v1/player", playerRouter);
app.use("/api/v1/team", teamRouter);
app.use("/api/v1/organization", organizationRouter);
```

Modify `tests/helpers/buildTestApp.js` — add the `withOrganization` flag next to `withTeam`:

```js
import organizationRouter from '../../src/routes/organization.routes.js';

export const buildTestApp = ({ withTranslations = false, withPlayer = false, withTeam = false, withOrganization = false } = {}) => {
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
  app.use(errorHandler);
  return app;
};
```

Add these three keys to `src/locales/en/common.json` (near the existing `TEAM_*`/`MY_TEAMS_FETCHED` keys):

```json
  "ORG_NAME_REQUIRED": "Organization name is required",
  "ORG_NAME_TAKEN": "You already have an organization with this name",
  "ORGANIZATION_CREATED": "Organization created",
```

Add the matching keys to `src/locales/hi/common.json`:

```json
  "ORG_NAME_REQUIRED": "संगठन का नाम आवश्यक है",
  "ORG_NAME_TAKEN": "इस नाम का संगठन आपके पास पहले से मौजूद है",
  "ORGANIZATION_CREATED": "संगठन बनाया गया",
```

And to `src/locales/mr/common.json`:

```json
  "ORG_NAME_REQUIRED": "संस्थेचे नाव आवश्यक आहे",
  "ORG_NAME_TAKEN": "या नावाची संस्था तुमच्याकडे आधीच आहे",
  "ORGANIZATION_CREATED": "संस्था तयार झाली",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- organization.test`
Expected: `PASS`, 4 tests.

Also run: `npm test -- locales` — confirms the three new keys keep en/hi/mr parity.
Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/organization.controller.js src/routes/organization.routes.js src/app.js tests/helpers/buildTestApp.js tests/organization.test.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json
git commit -m "feat: add POST /v1/organization"
```

---

## Task 4: `GET /v1/organization` (list mine)

**Files:**
- Modify: `src/controllers/organization.controller.js` (add `listMyOrganizations`)
- Modify: `src/routes/organization.routes.js` (add the route)
- Modify: locale files (add `ORGANIZATIONS_FETCHED`)
- Modify: `tests/organization.test.js` (add a new `describe` block)

**Interfaces:**
- Consumes: `Organization` (Task 1), `Team` (for `teamCount`, already imported by other controllers — `import { Team } from '../models/team.model.js';`).
- Produces: `listMyOrganizations`.

- [ ] **Step 1: Write the failing test**

Append to `tests/organization.test.js`:

```js
describe('GET /v1/organization', () => {
  let app;

  beforeAll(async () => {
    app = buildTestApp({ withOrganization: true });
  });

  const listOrgs = (token) =>
    request(app).get('/api/v1/organization').set('Authorization', `Bearer ${token}`).send();

  const createOrg = (token, body) =>
    request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

  it('lists an organization the caller owns', async () => {
    const { token } = await createTestUser();
    await createOrg(token, { name: 'Riverside CC' });

    const res = await listOrgs(token);

    expect(res.status).toBe(200);
    expect(res.body.data.organizations).toMatchObject([
      { name: 'Riverside CC', myRole: 'owner', memberCount: 1, teamCount: 0 },
    ]);
  });

  it('returns an empty list for a caller in no organizations', async () => {
    const { token } = await createTestUser();

    const res = await listOrgs(token);

    expect(res.status).toBe(200);
    expect(res.body.data.organizations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- organization.test`
Expected: `FAIL` — `GET /api/v1/organization` 404s (no route registered).

- [ ] **Step 3: Write minimal implementation**

Add to `src/controllers/organization.controller.js`:

```js
import { Team } from '../models/team.model.js';

const listMyOrganizations = catchAsync(async (req, res) => {
    const orgs = await Organization.find({ 'members.user': req.user._id, isDeleted: false }).sort({ createdAt: -1 });

    const orgIds = orgs.map((org) => org._id);
    const teamCounts = await Team.aggregate([
        { $match: { organization: { $in: orgIds }, isDeleted: false } },
        { $group: { _id: '$organization', count: { $sum: 1 } } },
    ]);
    const teamCountByOrgId = new Map(teamCounts.map((row) => [String(row._id), row.count]));

    return res.status(200).json(new ApiResponse(200, {
        organizations: orgs.map((org) => ({
            id: org._id,
            name: org.name,
            myRole: org.members.find((m) => m.user.equals(req.user._id))?.role ?? 'member',
            memberCount: org.members.length,
            teamCount: teamCountByOrgId.get(String(org._id)) ?? 0,
        })),
    }, req.t("ORGANIZATIONS_FETCHED")));
});

export { createOrganization, listMyOrganizations };
```

Add to `src/routes/organization.routes.js`:

```js
import { createOrganization, listMyOrganizations } from "../controllers/organization.controller.js";

router.route('/')
    .post(verifyJwt, createOrganization)
    .get(verifyJwt, listMyOrganizations);
```

Add to all three locale files (en/hi/mr):

```json
  "ORGANIZATIONS_FETCHED": "Organizations fetched",
```
```json
  "ORGANIZATIONS_FETCHED": "संगठन प्राप्त हुए",
```
```json
  "ORGANIZATIONS_FETCHED": "संस्था मिळाल्या",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- organization.test`
Expected: `PASS`, 6 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/organization.controller.js src/routes/organization.routes.js tests/organization.test.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json
git commit -m "feat: add GET /v1/organization"
```

---

## Task 5: `GET /v1/organization/:orgId` (profile)

**Files:**
- Modify: `src/controllers/organization.controller.js` (add `findAccessibleOrganization`, `findOwnedOrganization`, `getOrganization`)
- Modify: `src/routes/organization.routes.js`
- Modify: locale files (`ORG_NOT_FOUND`, `NOT_ORG_MEMBER`, `ORGANIZATION_FETCHED`)
- Modify: `tests/organization.test.js`

**Interfaces:**
- Produces: `findAccessibleOrganization(orgId, userId)` and `findOwnedOrganization(orgId, userId)` — both are reused by every remaining task in this plan (Tasks 6–10), mirroring `team.controller.js`'s `findOwnedTeam` shape. `getOrganization`.

- [ ] **Step 1: Write the failing test**

Append to `tests/organization.test.js`:

```js
describe('GET /v1/organization/:orgId', () => {
  let app;

  beforeAll(async () => {
    app = buildTestApp({ withOrganization: true });
  });

  const createOrg = (token, body) =>
    request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

  const getOrg = (token, orgId) =>
    request(app).get(`/api/v1/organization/${orgId}`).set('Authorization', `Bearer ${token}`).send();

  it("404s for an orgId that doesn't exist", async () => {
    const { token } = await createTestUser();

    const res = await getOrg(token, '665f3b1c2d3e4f5a6b7c8d90');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ORG_NOT_FOUND');
  });

  it('403s for a caller who is not a member', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const res = await getOrg(strangerToken, orgId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('returns members and teams for the owner', async () => {
    const { token } = await createTestUser({ fullName: 'Asha' });
    const createRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await getOrg(token, orgId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Riverside CC',
      owner: { name: 'Asha' },
      members: [{ name: 'Asha', role: 'owner' }],
      teams: [],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- organization.test`
Expected: `FAIL` — `GET /api/v1/organization/:orgId` 404s (no route registered).

- [ ] **Step 3: Write minimal implementation**

Add to `src/controllers/organization.controller.js`:

```js
// Shared by every remaining org endpoint in this file — mirrors
// team.controller.js's findOwnedTeam shape exactly, but with two variants:
// "any member can view" vs "only the owner can act."
const findAccessibleOrganization = async (orgId, userId) => {
    const org = await Organization.findOne({ _id: orgId, isDeleted: false });
    if (!org) {
        throw new ApiError(404, "ORG_NOT_FOUND");
    }
    if (!isOrgMember(org, userId)) {
        throw new ApiError(403, "NOT_ORG_MEMBER");
    }
    return org;
};

const findOwnedOrganization = async (orgId, userId) => {
    const org = await Organization.findOne({ _id: orgId, isDeleted: false });
    if (!org) {
        throw new ApiError(404, "ORG_NOT_FOUND");
    }
    if (!org.owner.equals(userId)) {
        throw new ApiError(403, "ORG_NOT_OWNED");
    }
    return org;
};

const getOrganization = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findAccessibleOrganization(orgId, req.user._id);
    await org.populate('owner', 'fullName');
    await org.populate('members.user', 'fullName');

    const teams = await Team.find({ organization: org._id, isDeleted: false });

    return res.status(200).json(new ApiResponse(200, {
        id: org._id,
        name: org.name,
        owner: { id: org.owner._id, name: org.owner.fullName },
        members: org.members.map((m) => ({ id: m.user._id, name: m.user.fullName, role: m.role })),
        teams: teams.map((team) => ({ id: team._id, name: team.name, shortName: team.shortName ?? null })),
    }, req.t("ORGANIZATION_FETCHED")));
});

export { createOrganization, listMyOrganizations, getOrganization };
```

Add the import needed at the top of the file:

```js
import { isOrgMember } from '../utils/organizationAccess.js';
```

Add to `src/routes/organization.routes.js`:

```js
import { createOrganization, listMyOrganizations, getOrganization } from "../controllers/organization.controller.js";

router.route('/:orgId').get(verifyJwt, getOrganization);
```

Add to all three locale files:

```json
  "ORG_NOT_FOUND": "That organization couldn't be found",
  "NOT_ORG_MEMBER": "You are not a member of that organization",
  "ORGANIZATION_FETCHED": "Organization fetched",
```
```json
  "ORG_NOT_FOUND": "वह संगठन नहीं मिला",
  "NOT_ORG_MEMBER": "आप उस संगठन के सदस्य नहीं हैं",
  "ORGANIZATION_FETCHED": "संगठन प्राप्त हुआ",
```
```json
  "ORG_NOT_FOUND": "ती संस्था सापडली नाही",
  "NOT_ORG_MEMBER": "तुम्ही त्या संस्थेचे सदस्य नाही",
  "ORGANIZATION_FETCHED": "संस्था मिळाली",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- organization.test`
Expected: `PASS`, 9 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/organization.controller.js src/routes/organization.routes.js tests/organization.test.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json
git commit -m "feat: add GET /v1/organization/:orgId"
```

---

## Task 6: `POST /v1/organization/:orgId/members` (add member)

**Files:**
- Modify: `src/controllers/organization.controller.js` (add `addOrganizationMember`)
- Modify: `src/routes/organization.routes.js`
- Modify: locale files (`ALREADY_ORG_MEMBER`, `ORG_MEMBER_ADDED`; `ORG_NOT_OWNED` and `USER_NOT_FOUND` are reused, already present)
- Modify: `tests/organization.test.js`

**Interfaces:**
- Consumes: `findOwnedOrganization`, `isOrgMember` (Task 5/2), `User` model.
- Produces: `addOrganizationMember`.

- [ ] **Step 1: Write the failing test**

Append to `tests/organization.test.js`:

```js
describe('POST /v1/organization/:orgId/members', () => {
  let app;

  beforeAll(async () => {
    app = buildTestApp({ withOrganization: true });
  });

  const createOrg = (token, body) =>
    request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

  const addMember = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${token}`).send(body);

  it('adds an existing user as a member', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { user: vikram } = await createTestUser({ email: 'vikram@example.com', fullName: 'Vikram' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await addMember(ownerToken, orgId, { email: 'vikram@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: String(vikram._id), name: 'Vikram', role: 'member' });
  });

  it('403s when a non-owner tries to add a member', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    await createTestUser({ email: 'vikram@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await addMember(strangerToken, orgId, { email: 'vikram@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });

  it("404s for an email with no matching account", async () => {
    const { token } = await createTestUser();
    const createRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await addMember(token, orgId, { email: 'nobody@example.com' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('409s when adding someone already a member', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    await createTestUser({ email: 'vikram@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'vikram@example.com' });

    const res = await addMember(ownerToken, orgId, { email: 'vikram@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ORG_MEMBER');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- organization.test`
Expected: `FAIL` — `POST /api/v1/organization/:orgId/members` 404s.

- [ ] **Step 3: Write minimal implementation**

Add to `src/controllers/organization.controller.js`:

```js
import { User } from '../models/user.model.js';

const addOrganizationMember = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findOwnedOrganization(orgId, req.user._id);

    const email = asString(req.body.email).trim().toLowerCase();
    const user = await User.findOne({ email });
    if (!user) {
        throw new ApiError(404, "USER_NOT_FOUND");
    }
    if (isOrgMember(org, user._id)) {
        throw new ApiError(409, "ALREADY_ORG_MEMBER");
    }

    org.members.push({ user: user._id, role: 'member' });
    await org.save();

    return res.status(200).json(new ApiResponse(200, {
        id: user._id,
        name: user.fullName,
        role: 'member',
    }, req.t("ORG_MEMBER_ADDED")));
});

export { createOrganization, listMyOrganizations, getOrganization, addOrganizationMember };
```

Add to `src/routes/organization.routes.js`:

```js
import { createOrganization, listMyOrganizations, getOrganization, addOrganizationMember } from "../controllers/organization.controller.js";

router.route('/:orgId/members').post(verifyJwt, addOrganizationMember);
```

Add to all three locale files:

```json
  "ALREADY_ORG_MEMBER": "That user is already a member of this organization",
  "ORG_MEMBER_ADDED": "Member added",
```
```json
  "ALREADY_ORG_MEMBER": "वह उपयोगकर्ता पहले से ही इस संगठन का सदस्य है",
  "ORG_MEMBER_ADDED": "सदस्य जोड़ा गया",
```
```json
  "ALREADY_ORG_MEMBER": "तो वापरकर्ता आधीच या संस्थेचा सदस्य आहे",
  "ORG_MEMBER_ADDED": "सदस्य जोडला गेला",
```

`ORG_NOT_OWNED` doesn't exist in the locale files yet either — it's introduced here for the first time (Task 5 only needed `ORG_NOT_FOUND`/`NOT_ORG_MEMBER`, not this one). Add it alongside the two above:

```json
  "ORG_NOT_OWNED": "That organization doesn't belong to your account",
```
```json
  "ORG_NOT_OWNED": "वह संगठन आपके खाते का नहीं है",
```
```json
  "ORG_NOT_OWNED": "ती संस्था तुमच्या खात्याची नाही",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- organization.test`
Expected: `PASS`, 13 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/organization.controller.js src/routes/organization.routes.js tests/organization.test.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json
git commit -m "feat: add POST /v1/organization/:orgId/members"
```

---

## Task 7: `DELETE /v1/organization/:orgId/members/:userId` (remove/leave)

**Files:**
- Modify: `src/controllers/organization.controller.js` (add `removeOrganizationMember`)
- Modify: `src/routes/organization.routes.js`
- Modify: locale files (`CANNOT_REMOVE_OWNER`, `ORG_MEMBER_REMOVED`)
- Modify: `tests/organization.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/organization.test.js`:

```js
describe('DELETE /v1/organization/:orgId/members/:userId', () => {
  let app;

  beforeAll(async () => {
    app = buildTestApp({ withOrganization: true });
  });

  const createOrg = (token, body) =>
    request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

  const addMember = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${token}`).send(body);

  const removeMember = (token, orgId, userId) =>
    request(app).delete(`/api/v1/organization/${orgId}/members/${userId}`).set('Authorization', `Bearer ${token}`).send();

  it('lets the owner remove a member', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { user: vikram } = await createTestUser({ email: 'vikram@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'vikram@example.com' });

    const res = await removeMember(ownerToken, orgId, vikram._id);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orgId, userId: String(vikram._id) });
  });

  it('lets a member remove themselves', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: vikramToken, user: vikram } = await createTestUser({ email: 'vikram@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'vikram@example.com' });

    const res = await removeMember(vikramToken, orgId, vikram._id);

    expect(res.status).toBe(200);
  });

  it('403s when a member (not the owner) tries to remove someone else', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: vikramToken } = await createTestUser({ email: 'vikram@example.com' });
    const { user: raj } = await createTestUser({ email: 'raj@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'vikram@example.com' });
    await addMember(ownerToken, orgId, { email: 'raj@example.com' });

    const res = await removeMember(vikramToken, orgId, raj._id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });

  it('400s when anyone, including the owner, targets the owner', async () => {
    const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await removeMember(ownerToken, orgId, owner._id);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANNOT_REMOVE_OWNER');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- organization.test`
Expected: `FAIL` — `DELETE /api/v1/organization/:orgId/members/:userId` 404s.

- [ ] **Step 3: Write minimal implementation**

Add to `src/controllers/organization.controller.js`:

```js
const removeOrganizationMember = catchAsync(async (req, res) => {
    const { orgId, userId } = req.params;
    const org = await Organization.findOne({ _id: orgId, isDeleted: false });
    if (!org) {
        throw new ApiError(404, "ORG_NOT_FOUND");
    }
    if (org.owner.equals(userId)) {
        throw new ApiError(400, "CANNOT_REMOVE_OWNER");
    }
    const isSelf = req.user._id.equals(userId);
    if (!org.owner.equals(req.user._id) && !isSelf) {
        throw new ApiError(403, "ORG_NOT_OWNED");
    }
    if (!isOrgMember(org, userId)) {
        throw new ApiError(404, "NOT_ORG_MEMBER");
    }

    org.members = org.members.filter((m) => !m.user.equals(userId));
    await org.save();

    return res.status(200).json(new ApiResponse(200, { orgId: org._id, userId }, req.t("ORG_MEMBER_REMOVED")));
});

export { createOrganization, listMyOrganizations, getOrganization, addOrganizationMember, removeOrganizationMember };
```

Add to `src/routes/organization.routes.js`:

```js
import { createOrganization, listMyOrganizations, getOrganization, addOrganizationMember, removeOrganizationMember } from "../controllers/organization.controller.js";

router.route('/:orgId/members/:userId').delete(verifyJwt, removeOrganizationMember);
```

Add to all three locale files:

```json
  "CANNOT_REMOVE_OWNER": "The organization's owner cannot be removed",
  "ORG_MEMBER_REMOVED": "Member removed",
```
```json
  "CANNOT_REMOVE_OWNER": "संगठन के स्वामी को हटाया नहीं जा सकता",
  "ORG_MEMBER_REMOVED": "सदस्य हटाया गया",
```
```json
  "CANNOT_REMOVE_OWNER": "संस्थेच्या मालकाला काढता येत नाही",
  "ORG_MEMBER_REMOVED": "सदस्य काढला गेला",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- organization.test`
Expected: `PASS`, 17 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/organization.controller.js src/routes/organization.routes.js tests/organization.test.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json
git commit -m "feat: add DELETE /v1/organization/:orgId/members/:userId"
```

---

## Task 8: `POST /v1/organization/:orgId/teams` (create team under org)

**Files:**
- Modify: `src/controllers/organization.controller.js` (add `createOrganizationTeam`)
- Modify: `src/routes/organization.routes.js`
- Modify: locale files (`TEAM_CREATED`; `TEAM_NAMES_REQUIRED` is reused)
- Modify: `tests/organization.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/organization.test.js`:

```js
describe('POST /v1/organization/:orgId/teams', () => {
  let app;

  beforeAll(async () => {
    app = buildTestApp({ withOrganization: true });
  });

  const createOrg = (token, body) =>
    request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

  const createOrgTeam = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

  it('creates a new team directly under the organization', async () => {
    const { token } = await createTestUser();
    const createRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await createOrgTeam(token, orgId, { name: 'Riverside U19', shortName: 'ru19' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Riverside U19',
      shortName: 'RU19',
      organization: orgId,
    });
  });

  it('403s when a non-owner tries to create a team under the org', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await createOrgTeam(strangerToken, orgId, { name: 'Riverside U19' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });

  it('400s for an empty name', async () => {
    const { token } = await createTestUser();
    const createRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await createOrgTeam(token, orgId, { name: '  ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NAMES_REQUIRED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- organization.test`
Expected: `FAIL` — `POST /api/v1/organization/:orgId/teams` 404s.

- [ ] **Step 3: Write minimal implementation**

Add to `src/controllers/organization.controller.js`:

```js
const createOrganizationTeam = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findOwnedOrganization(orgId, req.user._id);

    const name = asString(req.body.name).trim();
    if (!name) {
        throw new ApiError(400, "TEAM_NAMES_REQUIRED");
    }

    const team = await Team.create({
        name,
        shortName: req.body.shortName,
        createdBy: req.user._id,
        organization: org._id,
    });

    return res.status(200).json(new ApiResponse(200, {
        id: team._id,
        name: team.name,
        shortName: team.shortName ?? null,
        organization: team.organization,
    }, req.t("TEAM_CREATED")));
});

export { createOrganization, listMyOrganizations, getOrganization, addOrganizationMember, removeOrganizationMember, createOrganizationTeam };
```

Add to `src/routes/organization.routes.js`:

```js
import { createOrganization, listMyOrganizations, getOrganization, addOrganizationMember, removeOrganizationMember, createOrganizationTeam } from "../controllers/organization.controller.js";

router.route('/:orgId/teams').post(verifyJwt, createOrganizationTeam);
```

Add to all three locale files:

```json
  "TEAM_CREATED": "Team created",
```
```json
  "TEAM_CREATED": "टीम बनाई गई",
```
```json
  "TEAM_CREATED": "टीम तयार झाली",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- organization.test`
Expected: `PASS`, 20 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/organization.controller.js src/routes/organization.routes.js tests/organization.test.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json
git commit -m "feat: add POST /v1/organization/:orgId/teams"
```

---

## Task 9: `PATCH /v1/team/:teamId/organization` (attach/detach)

**Files:**
- Modify: `src/controllers/team.controller.js` (add `updateTeamOrganization`, import `Organization`)
- Modify: `src/routes/team.routes.js`
- Modify: locale files (`TEAM_ALREADY_IN_ORGANIZATION`, `TEAM_ORGANIZATION_UPDATED`)
- Test: `tests/teamOrganization.test.js`

This is the one new endpoint that lives on the existing `team` router, not the new `organization` one — see the spec's §6 table.

**Interfaces:**
- Consumes: `findOwnedTeam` (already in `team.controller.js`, will be widened by Task 11 — this task doesn't depend on that widening since it only ever needs plain `createdBy` ownership of the *team*, per the spec's "Detaching requires only team ownership" rule), `Organization` model.

- [ ] **Step 1: Write the failing test**

```js
// tests/teamOrganization.test.js
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';

describe('PATCH /v1/team/:teamId/organization', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    await Organization.init();
    app = buildTestApp({ withTeam: true, withOrganization: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const createOrg = (token, body) =>
    request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

  const updateTeamOrg = (token, teamId, body) =>
    request(app).patch(`/api/v1/team/${teamId}/organization`).set('Authorization', `Bearer ${token}`).send(body);

  const createTeamViaMatch = async (token) => {
    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings', totalOvers: 5 });
    return res.body.data.teamA.id;
  };

  it('attaches a standalone team the caller owns to an org the caller owns', async () => {
    const { token } = await createTestUser();
    const teamId = await createTeamViaMatch(token);
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const res = await updateTeamOrg(token, teamId, { organizationId: orgId });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: teamId, organization: orgId });
  });

  it('detaches an org-owned team back to standalone', async () => {
    const { token } = await createTestUser();
    const teamId = await createTeamViaMatch(token);
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await updateTeamOrg(token, teamId, { organizationId: orgId });

    const res = await updateTeamOrg(token, teamId, { organizationId: null });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: teamId, organization: null });
  });

  it("403s when attaching a team the caller doesn't own", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const teamId = await createTeamViaMatch(ownerToken);
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await updateTeamOrg(strangerToken, teamId, { organizationId: orgId });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_OWNED');
  });

  it("403s when attaching to an org the caller doesn't own", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const teamId = await createTeamViaMatch(ownerToken);
    const { token: otherOwnerToken } = await createTestUser({ email: 'other@example.com' });
    const orgRes = await createOrg(otherOwnerToken, { name: 'Other CC' });
    const orgId = orgRes.body.data.id;

    const res = await updateTeamOrg(ownerToken, teamId, { organizationId: orgId });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });

  it('409s when attaching a team that already belongs to an organization', async () => {
    const { token } = await createTestUser();
    const teamId = await createTeamViaMatch(token);
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await updateTeamOrg(token, teamId, { organizationId: orgId });
    const secondOrgRes = await createOrg(token, { name: 'Second CC' });

    const res = await updateTeamOrg(token, teamId, { organizationId: secondOrgRes.body.data.id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEAM_ALREADY_IN_ORGANIZATION');
  });

  it("404s when attaching to an organizationId that doesn't exist", async () => {
    const { token } = await createTestUser();
    const teamId = await createTeamViaMatch(token);

    const res = await updateTeamOrg(token, teamId, { organizationId: '665f3b1c2d3e4f5a6b7c8d90' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ORG_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- teamOrganization`
Expected: `FAIL` — `PATCH /api/v1/team/:teamId/organization` 404s.

- [ ] **Step 3: Write minimal implementation**

Modify `src/controllers/team.controller.js` — add the `Organization` import and the new handler:

```js
import { Organization } from '../models/organization.model.js';

// ...

const updateTeamOrganization = catchAsync(async (req, res) => {
    const { teamId } = req.params;
    const team = await findOwnedTeam(teamId, req.user._id);

    const organizationId = req.body.organizationId ?? null;

    if (organizationId === null) {
        team.organization = null;
        await team.save();
        return res.status(200).json(new ApiResponse(200, {
            id: team._id,
            organization: null,
        }, req.t("TEAM_ORGANIZATION_UPDATED")));
    }

    if (team.organization != null) {
        throw new ApiError(409, "TEAM_ALREADY_IN_ORGANIZATION");
    }

    const org = await Organization.findOne({ _id: organizationId, isDeleted: false });
    if (!org) {
        throw new ApiError(404, "ORG_NOT_FOUND");
    }
    if (!org.owner.equals(req.user._id)) {
        throw new ApiError(403, "ORG_NOT_OWNED");
    }

    team.organization = org._id;
    await team.save();

    return res.status(200).json(new ApiResponse(200, {
        id: team._id,
        organization: team.organization,
    }, req.t("TEAM_ORGANIZATION_UPDATED")));
});

export { getTeamProfile, getTeamMatches, listMyTeams, updateTeamOrganization };
```

Modify `src/routes/team.routes.js`:

```js
import { getTeamProfile, getTeamMatches, listMyTeams, updateTeamOrganization } from "../controllers/team.controller.js";

router.route('/').get(verifyJwt, listMyTeams);
router.route('/:teamId').get(verifyJwt, getTeamProfile);
router.route('/:teamId/matches').get(verifyJwt, getTeamMatches);
router.route('/:teamId/organization').patch(verifyJwt, updateTeamOrganization);
```

Add to all three locale files:

```json
  "TEAM_ALREADY_IN_ORGANIZATION": "That team already belongs to an organization",
  "TEAM_ORGANIZATION_UPDATED": "Team organization updated",
```
```json
  "TEAM_ALREADY_IN_ORGANIZATION": "वह टीम पहले से ही किसी संगठन से जुड़ी है",
  "TEAM_ORGANIZATION_UPDATED": "टीम का संगठन अपडेट किया गया",
```
```json
  "TEAM_ALREADY_IN_ORGANIZATION": "ती टीम आधीच एका संस्थेशी जोडलेली आहे",
  "TEAM_ORGANIZATION_UPDATED": "टीमची संस्था अद्ययावत केली",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- teamOrganization`
Expected: `PASS`, 6 tests.

Also run the existing team suite to confirm the new import/export doesn't break anything already there:
Run: `npm test -- teamProfile`
Expected: `PASS`, unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/team.controller.js src/routes/team.routes.js tests/teamOrganization.test.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json
git commit -m "feat: add PATCH /v1/team/:teamId/organization"
```

---

## Task 10: `DELETE /v1/organization/:orgId` (delete + orphan teams)

**Files:**
- Modify: `src/controllers/organization.controller.js` (add `deleteOrganization`, import `mongoose`)
- Modify: `src/routes/organization.routes.js`
- Modify: locale files (`ORGANIZATION_DELETED`)
- Modify: `tests/organization.test.js`

This is the one handler in this plan that uses a transaction — mirroring `match.controller.js`'s `startInnings` shape (`mongoose.startSession()` → `session.withTransaction(...)` → `finally { session.endSession() }`).

- [ ] **Step 1: Write the failing test**

Append to `tests/organization.test.js`:

```js
import { Team } from '../src/models/team.model.js';

describe('DELETE /v1/organization/:orgId', () => {
  let app;

  beforeAll(async () => {
    app = buildTestApp({ withOrganization: true });
  });

  const createOrg = (token, body) =>
    request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

  const createOrgTeam = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

  const deleteOrg = (token, orgId) =>
    request(app).delete(`/api/v1/organization/${orgId}`).set('Authorization', `Bearer ${token}`).send();

  const getOrg = (token, orgId) =>
    request(app).get(`/api/v1/organization/${orgId}`).set('Authorization', `Bearer ${token}`).send();

  it('soft-deletes the organization and orphans its teams back to standalone', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const teamRes = await createOrgTeam(token, orgId, { name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;

    const res = await deleteOrg(token, orgId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orgId });

    const team = await Team.findById(teamId);
    expect(team.organization).toBeNull();

    const afterDelete = await getOrg(token, orgId);
    expect(afterDelete.status).toBe(404);
    expect(afterDelete.body.code).toBe('ORG_NOT_FOUND');
  });

  it('403s when a non-owner tries to delete', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await deleteOrg(strangerToken, orgId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- organization.test`
Expected: `FAIL` — `DELETE /api/v1/organization/:orgId` 404s.

- [ ] **Step 3: Write minimal implementation**

Add to `src/controllers/organization.controller.js`:

```js
import mongoose from 'mongoose';

const deleteOrganization = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findOwnedOrganization(orgId, req.user._id);

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await Organization.updateOne({ _id: org._id }, { $set: { isDeleted: true } }, { session });
            await Team.updateMany({ organization: org._id }, { $set: { organization: null } }, { session });
        });
    } finally {
        await session.endSession();
    }

    return res.status(200).json(new ApiResponse(200, { orgId: org._id }, req.t("ORGANIZATION_DELETED")));
});

export {
    createOrganization,
    listMyOrganizations,
    getOrganization,
    addOrganizationMember,
    removeOrganizationMember,
    createOrganizationTeam,
    deleteOrganization,
};
```

Add to `src/routes/organization.routes.js`:

```js
import {
    createOrganization,
    listMyOrganizations,
    getOrganization,
    addOrganizationMember,
    removeOrganizationMember,
    createOrganizationTeam,
    deleteOrganization,
} from "../controllers/organization.controller.js";

router.route('/:orgId').get(verifyJwt, getOrganization).delete(verifyJwt, deleteOrganization);
```

Add to all three locale files:

```json
  "ORGANIZATION_DELETED": "Organization deleted",
```
```json
  "ORGANIZATION_DELETED": "संगठन हटाया गया",
```
```json
  "ORGANIZATION_DELETED": "संस्था हटवली",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- organization.test`
Expected: `PASS`, 24 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/organization.controller.js src/routes/organization.routes.js tests/organization.test.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json
git commit -m "feat: add DELETE /v1/organization/:orgId"
```

---

## Task 11: Widen match creation, team profile, and my-teams to org members

**Files:**
- Modify: `src/controllers/match.controller.js` (`resolveTeamSide`)
- Modify: `src/controllers/team.controller.js` (`findOwnedTeam`, `listMyTeams`, `getTeamProfile`)
- Test: `tests/organizationMatchAccess.test.js`

This is the task that makes the ad-hoc guarantee (spec §5) verifiable: it changes exactly three access-control call sites, none of which is the no-id branch of `resolveTeamSide` or `createTeam`. It also adds the `organization` field to the two response payloads `docs/api.md` documents as carrying it (`GET /v1/team`, `GET /v1/team/:teamId`) — populated as `{id, name}` per the contract, not the bare `ObjectId` `Team.organization` holds.

**Interfaces:**
- Consumes: `canAccessTeam`, `getMemberOrgIds` (Task 2).

- [ ] **Step 1: Write the failing test**

```js
// tests/organizationMatchAccess.test.js
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';

describe('organization membership widens team access', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    await Organization.init();
    app = buildTestApp({ withTeam: true, withOrganization: true });
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

  const setupOrgWithTeamAndMember = async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'member@example.com' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;
    return { ownerToken, memberToken, member, orgId, teamId };
  };

  it('lets an org member create a match using an org-owned team', async () => {
    const { memberToken, teamId } = await setupOrgWithTeamAndMember();

    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ teamAId: teamId, teamBName: 'Visitors', totalOvers: 5 });

    expect(res.status).toBe(200);
    expect(res.body.data.teamA).toMatchObject({ id: teamId, name: 'Riverside U19' });
  });

  it('still 403s a non-member trying to use an org-owned team', async () => {
    const { teamId } = await setupOrgWithTeamAndMember();
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ teamAId: teamId, teamBName: 'Visitors', totalOvers: 5 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_OWNED');
  });

  it('lets an org member view an org-owned team profile, with the organization populated', async () => {
    const { memberToken, teamId, orgId } = await setupOrgWithTeamAndMember();

    const res = await request(app)
      .get(`/api/v1/team/${teamId}`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Riverside U19',
      organization: { id: orgId, name: 'Riverside CC' },
    });
  });

  it('returns organization: null on a standalone team profile', async () => {
    const { token } = await createTestUser();
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Standalone A', teamBName: 'Standalone B', totalOvers: 5 });
    const teamId = createRes.body.data.teamA.id;

    const res = await request(app)
      .get(`/api/v1/team/${teamId}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.body.data.organization).toBeNull();
  });

  it('lets an org member view an org-owned team\'s match history', async () => {
    const { memberToken, teamId } = await setupOrgWithTeamAndMember();

    const res = await request(app)
      .get(`/api/v1/team/${teamId}/matches`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.matches).toEqual([]);
  });

  it("includes an org's teams in GET /v1/team for every member, alongside their own, with organization populated", async () => {
    const { memberToken, teamId, orgId } = await setupOrgWithTeamAndMember();
    // The member's own standalone team, created ad-hoc — must still appear.
    const standaloneRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ teamAName: "Member's Own Team", teamBName: 'Someone Else', totalOvers: 5 });
    const standaloneTeamId = standaloneRes.body.data.teamA.id;

    const res = await request(app)
      .get('/api/v1/team')
      .set('Authorization', `Bearer ${memberToken}`)
      .send();

    expect(res.status).toBe(200);
    const byId = new Map(res.body.data.teams.map((t) => [t.id, t]));
    expect(byId.get(teamId)).toMatchObject({ organization: { id: orgId, name: 'Riverside CC' } });
    expect(byId.get(standaloneTeamId)).toMatchObject({ organization: null });
  });

  it("does not include an org's teams for a non-member", async () => {
    const { teamId } = await setupOrgWithTeamAndMember();
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await request(app)
      .get('/api/v1/team')
      .set('Authorization', `Bearer ${strangerToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.teams.map((t) => t.id)).not.toContain(teamId);
  });

  it('ad-hoc match creation with two typed names is completely unaffected — both teams remain standalone', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Ad Hoc A', teamBName: 'Ad Hoc B', totalOvers: 5 });

    expect(res.status).toBe(200);
    const teamsRes = await request(app)
      .get('/api/v1/team')
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(teamsRes.body.data.teams.every((t) => t.organization === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- organizationMatchAccess`
Expected: `FAIL` — the member-access tests get `403 TEAM_NOT_OWNED`/`TEAM_NOT_OWNED` instead of success, since `resolveTeamSide`/`findOwnedTeam` still check plain `createdBy` equality; the `GET /v1/team` test is missing the org's team from the list.

- [ ] **Step 3: Write minimal implementation**

Modify `src/controllers/match.controller.js` — add the import and widen `resolveTeamSide`:

```js
import { canAccessTeam } from '../utils/organizationAccess.js';

const resolveTeamSide = async (name, existingTeamId, createdBy) => {
    if (existingTeamId != null) {
        const team = await Team.findOne({ _id: existingTeamId, isDeleted: false });
        if (!team) {
            throw new ApiError(404, "TEAM_NOT_FOUND");
        }
        if (!(await canAccessTeam(team, createdBy))) {
            throw new ApiError(403, "TEAM_NOT_OWNED");
        }
        return { existing: team, resolvedName: team.name };
    }

    if (!asString(name).trim()) {
        throw new ApiError(400, "TEAM_NAMES_REQUIRED");
    }
    return { existing: null, resolvedName: name.trim() };
};
```

Modify `src/controllers/team.controller.js` — add the import and widen `findOwnedTeam`, `getTeamProfile`, and `listMyTeams`. `docs/api.md` documents `organization` as a populated `{id, name}` object (or `null`) on both `GET /v1/team` and `GET /v1/team/:teamId` — a bare `ObjectId` is not this contract's shape, so both responses `.populate('organization', 'name')` and map it themselves rather than passing the field through raw:

```js
import { canAccessTeam, getMemberOrgIds } from '../utils/organizationAccess.js';

const findOwnedTeam = async (teamId, requesterId) => {
    const team = await Team.findOne({ _id: teamId, isDeleted: false });
    if (!team) {
        throw new ApiError(404, "TEAM_NOT_FOUND");
    }
    if (!(await canAccessTeam(team, requesterId))) {
        throw new ApiError(403, "TEAM_NOT_OWNED");
    }
    return team;
};

// A team's organization is populated here (name only — this endpoint has
// no use for its members/owner) so the response can carry {id, name} per
// docs/api.md, not the bare ObjectId Team.organization actually stores.
const toOrganizationSummary = (organization) =>
    organization ? { id: organization._id, name: organization.name } : null;

const getTeamProfile = catchAsync(async (req, res) => {
    const { teamId } = req.params;

    const team = await findOwnedTeam(teamId, req.user._id);
    await team.populate('players');
    await team.populate('organization', 'name');

    return res.status(200).json(new ApiResponse(200, {
        teamId: team._id,
        name: team.name,
        shortName: team.shortName ?? null,
        organization: toOrganizationSummary(team.organization),
        roster: team.players.filter((player) => !player.isDeleted).map((player) => ({
            playerId: player._id,
            playerName: player.name,
            jerseyNumber: player.jerseyNumber ?? null,
            role: player.role,
        })),
    }, req.t("TEAM_PROFILE_FETCHED")));
});

// ...

const listMyTeams = catchAsync(async (req, res) => {
    const orgIds = await getMemberOrgIds(req.user._id);
    const teams = await Team.find({
        isDeleted: false,
        $or: [{ createdBy: req.user._id }, { organization: { $in: orgIds } }],
    })
        .sort({ createdAt: -1 })
        .populate('organization', 'name');

    return res.status(200).json(new ApiResponse(200, {
        teams: teams.map((team) => ({
            id: team._id,
            name: team.name,
            shortName: team.shortName ?? null,
            organization: toOrganizationSummary(team.organization),
        })),
    }, req.t("MY_TEAMS_FETCHED")));
});
```

`getTeamMatches` is unaffected — `docs/api.md`'s `GET /v1/team/:teamId/matches` response never carries an `organization` field (past results are about the match, not the team), so no change is needed there beyond the `findOwnedTeam` widening already covers its access check.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- organizationMatchAccess`
Expected: `PASS`, 8 tests.

Run the full pre-existing regression set for everything this task touches:
Run: `npm test -- teamProfile matchTeamScoping organization teamOrganization`
Expected: `PASS`, all green — confirms the widening didn't change behavior for standalone teams or break any earlier task.

- [ ] **Step 5: Commit**

```bash
git add src/controllers/match.controller.js src/controllers/team.controller.js tests/organizationMatchAccess.test.js
git commit -m "feat: let organization members act on org-owned teams"
```

---

## Task 12: Auth allowlist, full regression, and curl commands

**Files:**
- Modify: `tests/routes.auth.test.js`
- Create: `docs/superpowers/plans/2026-09-05-organizations-curl-examples.md` (in this repo, for hand testing — not part of the shipped contract, which is `docs/api.md`)

**Interfaces:** none — this task is verification-only, closing out Phase 2.

- [ ] **Step 1: Write the failing test**

Modify `tests/routes.auth.test.js` — add the import, the `PUBLIC_ROUTES` entry, and the `ROUTERS` entry:

```js
import organizationRouter from '../src/routes/organization.routes.js';

const PUBLIC_ROUTES = {
    match: [
        'GET /public/:code',
    ],
    user: [
        'POST /register',
        'POST /login',
        'POST /forgot-password',
        'POST /verify-otp',
        'POST /resend-otp',
        'POST /set-password',
        'GET /refresh-token',
        'GET /logout',
    ],
    translation: [
        'GET /all',
        'GET /version',
        'GET /:lang',
    ],
    player: [],
    team: [],
    organization: [],
};

const ROUTERS = {
    match: matchRouter,
    user: userRouter,
    translation: translationRouter,
    player: playerRouter,
    team: teamRouter,
    organization: organizationRouter,
};
```

Run this file *before* Task 3's route existed and it would already fail once `organization` is added to `ROUTERS` with nothing behind it — but by this point in the plan `organization.routes.js` is fully built (Tasks 3–10), so this step is really "confirm what's already true," not a genuine red step. Run it anyway per TDD discipline: temporarily comment out one route's `verifyJwt` in `organization.routes.js`, confirm the test fails, then restore it.

- [ ] **Step 2: Run test to verify it fails (regression check on the allowlist mechanism itself)**

Temporarily edit `src/routes/organization.routes.js`'s `/:orgId` GET route to drop `verifyJwt`:
```js
router.route('/:orgId').get(getOrganization).delete(verifyJwt, deleteOrganization);
```
Run: `npm test -- routes.auth`
Expected: `FAIL` — `organization router` test reports `['GET /:orgId']` as unprotected and not allowlisted.

Restore the line to `router.route('/:orgId').get(verifyJwt, getOrganization).delete(verifyJwt, deleteOrganization);`.

- [ ] **Step 3: No implementation change needed**

The `organization.routes.js` file from Tasks 3–10 already puts `verifyJwt` on every route. This step confirms that via the restored file, not by writing new code.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- routes.auth`
Expected: `PASS`.

Then run the **entire suite**:
Run: `npm test`
Expected: `PASS`, every test green — this is the regression check for the whole feature, confirming Task 11's widening and every earlier task's additions haven't broken anything pre-existing (team-profile, match creation, scoring, sync, etc.).

Then run lint if this repo has one configured — check `package.json` for a `lint` script (`npm run lint` if present) and confirm it exits 0. If no lint script exists, note that explicitly rather than skipping silently.

- [ ] **Step 5: Commit**

```bash
git add tests/routes.auth.test.js
git commit -m "test: add organization to the route auth allowlist"
```

- [ ] **Step 6: Write curl examples for both the org-owned and standalone team paths**

Create `docs/superpowers/plans/2026-09-05-organizations-curl-examples.md`:

````markdown
# Organizations — curl walkthrough

Assumes the server is running locally on port 9000 and you have two logged-in
users' access tokens (`$OWNER_TOKEN`, `$MEMBER_TOKEN`) from `POST /api/v1/user/login`.

## Standalone path (unaffected by this feature)

```bash
curl -s -X POST http://localhost:9000/api/v1/match/create \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"teamAName":"Mumbai Indians","teamBName":"Chennai Super Kings","totalOvers":20}'
```

## Org-owned path

```bash
# 1. Create an organization (caller becomes owner)
curl -s -X POST http://localhost:9000/api/v1/organization \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Riverside Cricket Club"}'
# => note the returned "id" as $ORG_ID

# 2. Add a second scorer as a member (must already have an account)
curl -s -X POST http://localhost:9000/api/v1/organization/$ORG_ID/members \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"member@example.com"}'

# 3. Create a team directly under the org
curl -s -X POST http://localhost:9000/api/v1/organization/$ORG_ID/teams \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Riverside U19","shortName":"RU19"}'
# => note the returned "id" as $TEAM_ID

# 4. The member (not the owner) creates a match using the org's team
curl -s -X POST http://localhost:9000/api/v1/match/create \
  -H "Authorization: Bearer $MEMBER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"teamAId\":\"$TEAM_ID\",\"teamBName\":\"Visitors\",\"totalOvers\":20}"

# 5. The member can also view the org's team profile and past results
curl -s http://localhost:9000/api/v1/team/$TEAM_ID -H "Authorization: Bearer $MEMBER_TOKEN"
curl -s http://localhost:9000/api/v1/team/$TEAM_ID/matches -H "Authorization: Bearer $MEMBER_TOKEN"

# 6. GET /v1/team for the member now includes this org team alongside their own
curl -s http://localhost:9000/api/v1/team -H "Authorization: Bearer $MEMBER_TOKEN"

# 7. Attach an existing standalone team the owner made earlier to the org
curl -s -X PATCH http://localhost:9000/api/v1/team/$SOME_OTHER_TEAM_ID/organization \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"organizationId\":\"$ORG_ID\"}"

# 8. Detach it back to standalone
curl -s -X PATCH http://localhost:9000/api/v1/team/$SOME_OTHER_TEAM_ID/organization \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"organizationId":null}'

# 9. A member leaves voluntarily
curl -s -X DELETE http://localhost:9000/api/v1/organization/$ORG_ID/members/$MEMBER_USER_ID \
  -H "Authorization: Bearer $MEMBER_TOKEN"

# 10. The owner deletes the org — its remaining teams orphan back to standalone
curl -s -X DELETE http://localhost:9000/api/v1/organization/$ORG_ID \
  -H "Authorization: Bearer $OWNER_TOKEN"
```
````

```bash
git add docs/superpowers/plans/2026-09-05-organizations-curl-examples.md
git commit -m "docs: add curl walkthrough for the organizations feature"
```

---

## Verification checklist for Phase 2 completion

Before declaring Phase 2 done (per `superpowers:verification-before-completion` — run these fresh, don't rely on earlier task output):

- [ ] `npm test` — full suite passes, 0 failures.
- [ ] `npm run lint` (if the script exists) — exits 0.
- [ ] `npm test -- locales` — en/hi/mr key parity holds.
- [ ] `npm test -- routes.auth` — every organization route is protected or allowlisted.
- [ ] Manually run at least the org-owned curl sequence above against a running dev server (`npm run dev`) and confirm each step's response shape matches `docs/api.md`'s `## Organization` section.
