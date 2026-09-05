# Organizations and Persistent Teams — Design

**Status:** Approved, ready for implementation planning.
**Repos affected:** `cricket-scorer-backend` (this spec), `cricket-scrorer` (Flutter, Phase 3 — separate plan).
**Contract doc:** [docs/api.md](../../../docs/api.md) — the `## Organization` section and the modified
`## POST /v1/match/create` / `## Team profile` sections are the finalized, binding
version of everything below. This file is the reasoning behind that contract;
if the two ever disagree, `docs/api.md` wins and this file is stale.

## 1. Motivation

The existing team-profile feature (see `docs/api.md`'s "Team profile"
section) already gives every scorer
persistent `Team` documents: a roster that accumulates across matches, a
profile screen, and past results. What it does not have is any notion of
*sharing* a team with another scorer. Today, `Team.createdBy` is the only
access-control fact in the system — one scorer, one team, forever.

A club or league scenario breaks that: several people scoring matches for the
same real-world team need to see and use the same `Team` document, not each
maintain their own copy. **Organization** is the smallest addition that makes
that possible without touching the ad-hoc, single-scorer path at all.

## 2. Scope decisions (from brainstorming)

These were confirmed explicitly before design work started; each is a real
fork, not a detail:

1. **Use case:** a club/league managing multiple teams and scorers together —
   not just shared roster editing between two people, and not a pure label.
   This is what justifies a `Member` role that can actually *act* (create
   matches), not just view.
2. **Roles:** two tiers, `owner` and `member`. No `admin` tier for v1 — one
   fewer state to reason about, and nothing in the brief calls for a
   secretary-distinct-from-founder split yet.
3. **Team/Org relationship: opt-in, not mandatory.** `Team.organization` is
   nullable. This is the load-bearing decision for backward compatibility:
   every ad-hoc and reuse-by-id code path that exists today keeps producing
   `organization: null` teams, unchanged. Organizations are additive.
4. **Member match rights:** any member (not just the owner) can use the org's
   teams to create and score matches. This is the one place org membership
   expands access beyond today's `createdBy`-only model — see §4.
5. **Adding members:** owner adds an existing user by exact email, no invite
   record, no acceptance step. There is no notification/invite infrastructure
   anywhere in this codebase yet, and building one is out of scope here.
6. **Multi-org:** a user may own multiple orgs and belong to others as a
   member, with no cap either way.
7. **`GET /v1/team` scope:** merges the caller's own teams with every team
   belonging to every org they're a member of. This is what makes the
   existing "reuse a team" picker on match creation immediately useful for
   the club case — it already shows exactly the set of teams a scorer is now
   allowed to act on.

## 3. Data model

### `Organization` (new: `src/models/organization.model.js`)

```js
{
  name:      { type: String, required: true, trim: true, maxlength: 100 },
  nameLower: { type: String, required: true },
  owner:     { type: Schema.Types.ObjectId, ref: 'User', required: true },
  members: [{
    user:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role:    { type: String, enum: ['owner', 'member'], required: true },
    addedAt: { type: Date, default: Date.now },
  }],
  isDeleted: { type: Boolean, default: false },
}
```
`{ timestamps: true }`.

Indexes:
- `{ owner: 1, nameLower: 1 }`, **unique** — one owner can't create two orgs
  with the same name (case-insensitively). This mirrors `Player`'s existing
  `{createdBy, nameLower}` pattern, deliberately not `Team`'s now-removed
  `{createdBy, name}` uniqueness (that one was reverted for a reason unrelated
  to naming — see `docs/api.md`'s "Open items" — but the *mechanism*, a
  lowercased shadow field with a unique compound index, is the established
  house pattern for "no duplicate names per owner" and Organization's naming
  collision risk is exactly what `Player` already solved this way).
- `{ 'members.user': 1 }` — supports "which orgs am I a member of."

**Owner is duplicated into `members`** (role `'owner'`) at creation time, so
every "can this user see/use this org's stuff" check is one shape: "is
`userId` present in `members`, regardless of role." Owner-*gated* actions
(rename, delete, add/remove member, create/attach/detach a team) check
`org.owner.equals(userId)` directly instead. This avoids two different
membership representations for the same person.

### `Team` (modify existing `src/models/team.model.js`)

One new field, nothing else touched:
```js
organization: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
```
New index: `{ organization: 1, createdAt: -1 }` (org-scoped team listing, same
shape as the existing `{ createdBy: 1, createdAt: -1 }`).

`createdBy` keeps its current meaning unconditionally — "who made this
document" — regardless of whether the team is later attached to, or detached
from, an org. Attaching a team to an org never rewrites `createdBy`.

### `Match` — no changes

`Match.teamA`/`teamB` are unchanged. Organization access is entirely mediated
through the `Team` document a match references; `Match` itself never needs to
know an org exists. This is deliberate: it keeps the blast radius of this
feature to two models instead of three, and means none of the scoring
hot-path code (`score-ball`, `select-bowler`, sync) needs to change at all.

## 4. Access control

One new predicate, `canAccessTeam(team, org, userId)`, replacing the plain
`team.createdBy.equals(userId)` check in exactly three places. `org` is
`null` when `team.organization` is `null`; the caller fetches the org
document once and passes it in (no redundant lookups inside the predicate).

```js
const isOrgMember = (org, userId) =>
  org.members.some((m) => m.user.equals(userId));

const canAccessTeam = (team, org, userId) =>
  team.createdBy?.equals(userId) || (org != null && isOrgMember(org, userId));
```

**Sites this replaces:**

1. **`resolveTeamSide`** (`match.controller.js`, only the `existingTeamId`
   branch — the name-only branch is untouched, see §5). An org member can now
   use an org-owned team on either side of a match they create.
2. **`findOwnedTeam`** (`team.controller.js`, backs `GET /v1/team/:teamId` and
   `GET /v1/team/:teamId/matches`). An org member can now view an org-owned
   team's profile and match history, not just its creator.
3. **`GET /v1/team`** ("my teams"). The query becomes:
   ```js
   Team.find({
     isDeleted: false,
     $or: [{ createdBy: userId }, { organization: { $in: myOrgIds } }],
   })
   ```
   where `myOrgIds` comes from one `Organization.find({ 'members.user': userId, isDeleted: false }, '_id')` query run first.

**Not changed:** roster mutation. Nothing in the current codebase mutates a
`Team`'s roster outside of match-scoring flows (players are found-or-created
against the team during `start-innings`/`select-bowler`/`score-ball`'s
incoming-batsman path). Since match-scoring access is already covered by
`canAccessTeam` via `resolveTeamSide`'s widening, any org member scoring a
match against an org team already gets exactly the roster-mutation access
they need, with no separate check to add.

## 5. The ad-hoc guarantee

This is the concrete answer to "confirm ad-hoc match creation still works
unchanged": `resolveTeamSide`'s no-id branch is untouched by this feature.

```js
// Untouched — no organization concept enters this branch at all.
if (!asString(name).trim()) {
  throw new ApiError(400, "TEAM_NAMES_REQUIRED");
}
return { existing: null, resolvedName: name.trim() };
```
and
```js
// Untouched.
const createTeam = (name, createdBy) => Team.create({ name, createdBy });
```

A team created this way has `organization: null` by the new field's default
— no code path sets it to anything else unless the scorer later explicitly
calls `PATCH /v1/team/:teamId/organization`. Typing two fresh team names and
hitting create behaves identically before and after this feature ships.

## 6. New/modified endpoints

Full request/response/error contracts live in `docs/api.md`'s `## Organization`
section. Summary:

| Method & path | Access | Purpose |
|---|---|---|
| `POST /v1/organization` | any authenticated user | create; caller becomes owner |
| `GET /v1/organization` | any authenticated user | list orgs I own or belong to |
| `GET /v1/organization/:orgId` | member (any role) | profile: members, teams |
| `POST /v1/organization/:orgId/members` | owner | add a member by exact email |
| `DELETE /v1/organization/:orgId/members/:userId` | owner, or that member removing themselves | remove/leave (never the owner) |
| `POST /v1/organization/:orgId/teams` | owner | create a **new** team directly under the org |
| `PATCH /v1/team/:teamId/organization` | team owner (+ target org owner, if attaching) | attach/detach an existing team |
| `DELETE /v1/organization/:orgId` | owner | soft-delete; owned teams orphan back to standalone |

`POST /v1/organization/:orgId/teams` is the first "create a team" endpoint
independent of match creation in this codebase — today, every `Team`
document is created as a side effect of `POST /v1/match/create`. It reuses
the same `Team.create({ name, shortName, createdBy, organization: orgId })`
shape, just without a match attached.

**Org deletion is soft-delete plus orphan, never cascade.** Deleting an org
sets `isDeleted: true` on the `Organization` and, in the same transaction,
`organization: null` on every `Team` currently pointing at it. Matches are
never touched — they reference `Team`, not `Organization`, so an org's
deletion has zero effect on match history. This mirrors the existing
`Match`/`BallEvent` philosophy in this codebase (soft-delete over hard
delete, orphan over cascade) rather than inventing a new deletion
philosophy for one feature.

## 7. New error codes

Following the existing `TEAM_NOT_FOUND`/`TEAM_NOT_OWNED` naming precedent:

- `ORG_NOT_FOUND` (404) — id doesn't resolve to a non-deleted `Organization`.
- `ORG_NOT_OWNED` (403) — an owner-gated action, caller isn't `org.owner`.
- `NOT_ORG_MEMBER` (403) — `GET /v1/organization/:orgId` by a non-member (not
  reused for team-access checks — those fall through to the existing
  `TEAM_NOT_FOUND`/`TEAM_NOT_OWNED` pair, since from the team endpoint's
  perspective a non-member is indistinguishable from "doesn't own this team,"
  and inventing a second error vocabulary for the same fact from a different
  entry point isn't worth it).
- `ORG_NAME_REQUIRED` (400) — empty/missing `name`.
- `ORG_NAME_TAKEN` (409) — `{owner, nameLower}` collision.
- `ALREADY_ORG_MEMBER` (409) — adding an email already a member.
- `CANNOT_REMOVE_OWNER` (400) — `DELETE .../members/:userId` where `userId`
  is the owner — including the owner targeting themselves. An org always
  needs exactly one owner; removing them must go through `DELETE
  /v1/organization/:orgId` (which requires being the owner in the first
  place), never through the members endpoint.
- `ORG_NOT_OWNED` (403, reused meaning) — `DELETE .../members/:userId` where
  the caller is neither the owner nor `userId` themselves (a member cannot
  remove a *different* member; they can only remove themselves).
- `TEAM_ALREADY_IN_ORGANIZATION` (409) — attaching a team that already has a
  non-null `organization` (must detach first — no implicit reassignment).

`USER_NOT_FOUND` (404, adding a member by an email with no matching account)
is **reused**, not new — it already exists in `src/locales/en/common.json`
and is thrown the same way elsewhere in `user.controller.js`.

All new keys ship in `src/locales/{en,hi,mr}/common.json`, enforced by the
existing `tests/locales.test.js` parity check.

## 8. Routes and the auth-allowlist test

New router `src/routes/organization.routes.js`, mounted as
`app.use("/api/v1/organization", organizationRouter)` in `src/app.js`,
alongside the existing five. Every route on it carries `verifyJwt` — there is
no public organization endpoint in this contract, so its
`tests/routes.auth.test.js` allowlist entry is `organization: []`, same shape
as `team: []` today. The `PATCH /v1/team/:teamId/organization` addition lives
on the existing `team` router and needs no new allowlist entry (it's private,
same as every other team route).

## 9. Testing scope (detail for the Phase 2 plan)

New, TDD from scratch:
- `organization.model.js` — schema validation, unique-index behavior.
- `organization.controller.js` — create, list, get, addMember, removeMember,
  createTeam, delete (incl. the orphan-on-delete transaction).
- `team.controller.js` changes — `attachOrganization`/`detachOrganization`
  (or a single handler branching on `organizationId` presence, decided in
  the plan), plus `canAccessTeam` widening in `resolveTeamSide`,
  `findOwnedTeam`, and the `GET /v1/team` query.
- `match.controller.js` — one new test class confirming an org member (not
  the team's `createdBy`) can create a match using an org-owned team, and
  that a non-member of that org still gets `TEAM_NOT_OWNED`.
- `tests/routes.auth.test.js` — add `organization` to `ROUTERS`/`PUBLIC_ROUTES`.
- `tests/locales.test.js` — passes automatically once all three locale files
  gain the new keys; no test changes needed, just don't forget a locale file.
- **Regression, not new:** re-run the full existing suite (506 tests as of
  the last full run) to confirm the ad-hoc match-creation and existing
  team-profile tests are unaffected — §5's guarantee is only real if nothing
  in the untouched branch's existing test coverage changes behavior.

## 10. Explicitly out of scope for this spec

- Any `admin` role tier, ownership transfer, or invite-by-email-for-unregistered-users
  flow — all deferred; §2 items 2 and 5 record why.
- Team-level or organization-level aggregate stats (matches played, win
  rate) — the existing team-profile contract already deferred this for
  `Team`; the same reasoning applies to `Organization` and isn't
  re-litigated here.
- Any frontend work — covered by a separate Phase 3 plan in the `cricket-scrorer`
  repo, once this backend contract is implemented and merged.
