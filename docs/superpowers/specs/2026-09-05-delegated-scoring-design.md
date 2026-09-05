# Delegated Scoring — Design

**Status:** Approved, ready for implementation planning.
**Repos affected:** `cricket-scorer-backend` (this spec), `cricket-scrorer` (Flutter, same plan — this
feature is small enough for one phased plan spanning both, unlike Organizations' two-plan split).
**Contract doc:** [docs/api.md](../../../docs/api.md) — the modified `## POST /v1/match/create`-adjacent
match endpoints, the new `PATCH /v1/match/:matchId/scorer` and `GET /v1/match/:matchId/scorer-candidates`
sections, and the amended `## GET /v1/match/history` are the finalized, binding version of everything
below. This file is the reasoning; if the two disagree, `docs/api.md` wins and this file is stale.
**Builds on:** [2026-09-05-organizations-and-persistent-teams-design.md](2026-09-05-organizations-and-persistent-teams-design.md)
— delegated scoring only exists where a match's team is org-linked; it has no meaning for a fully ad-hoc match.

## 1. Motivation

Today a match can only ever be scored by whoever created it — `match.createdBy` is the sole write-access
fact, checked identically in `startInnings`, `selectBowler`, `scoreBall`, `undoBall`, `syncMatch`, and
`getMatchScorecard`. For a club running Organizations (see the linked spec), that's a real limitation:
the person who sets a match up — books the ground, decides the toss, is an org owner or admin — is
frequently not the person standing at the boundary with a phone tapping out every ball. Delegated scoring
lets that org owner hand live-scoring write-access for one specific match to one specific person, without
transferring `createdBy` and without granting that person, or any other org member, broader access to
anything else.

## 2. Scope decisions (from brainstorming)

Each of these was confirmed explicitly before design work started:

1. **Who can assign:** the match's own `createdBy`, **or** the owner of the organization that either
   `teamA` or `teamB` belongs to. Not any org member — assignment is an owner-level action, the same tier
   `POST /v1/organization/:orgId/members` and `DELETE /v1/organization/:orgId` already require.
2. **Which org, when the two teams differ:** either team's org qualifies. If `teamA` belongs to org X and
   `teamB` to org Y (or one side is a plain ad-hoc team with no org), the owner of X and the owner of Y are
   both authorized to assign — inter-club matches don't need special-casing.
3. **Cardinality:** exactly one scorer per match. `Match.assignedScorer` is a single nullable field, not a
   list. Assigning someone new replaces whoever was assigned before; there is no "co-scoring."
4. **Assignee pool:** must be an existing member (owner or member role) of one of the qualifying orgs from
   decision 2 — not an arbitrary registered user by email. This keeps delegation inside the club's own
   roster and reuses `Organization.members` directly, no new invite/lookup flow.
5. **Revocability:** assignment can be set, changed, or cleared at any time regardless of `match.status` —
   upcoming, live, innings-break, or completed. This is deliberate: the motivating scenario is a scorer's
   phone dying or losing signal mid-match, where the org owner needs to hand scoring to someone else on
   the spot, not just before the toss.
6. **Which endpoints widen:** the scoring path only — `startInnings`, `selectBowler`, `scoreBall`,
   `undoBall`, `syncMatch`, `getMatchScorecard`. `abandonMatch` and `deleteMatch` stay `createdBy`-only,
   unchanged. Those are administrative/destructive actions on the match as a record, not scoring actions,
   and delegation to a scorer was never meant to hand out the power to abandon or delete someone else's
   match.
7. **Discovery:** the assigned scorer's own `GET /v1/match/history` widens to include matches assigned to
   them, alongside matches they created — one list, not a separate "assigned to me" screen. Each entry
   gains enough information (`createdBy` name, `assignedScorer` presence) for the client to label an
   assigned-not-created match distinctly.

## 3. Data model

### `Match` (modify existing `src/models/match.model.js`)

One new field:
```js
assignedScorer: { type: Schema.Types.ObjectId, ref: 'User', default: null },
```
New index, mirroring the existing `{ createdBy: 1, createdAt: -1 }` shape for the same reason (the
widened history query needs an efficient path for the `assignedScorer` half of its `$or`):
```js
matchSchema.index({ assignedScorer: 1, createdAt: -1 });
```

No changes to `Organization` or `Team` — decision 4 reuses `Organization.members` exactly as-is, and
decision 1's "owner of teamA's or teamB's org" reuses `Team.organization` and `Organization.owner` exactly
as the Organizations feature already defined them.

## 4. Access control

### New predicate: `qualifyingOrgOwnerIds(teamA, teamB)`

```js
// The org(s), if any, whose owner may assign a scorer for a match between
// these two teams — the owner of teamA's org, the owner of teamB's org, or
// both if they differ. Either team lacking an org simply contributes nothing.
const qualifyingOrgOwnerIds = async (teamA, teamB) => {
    const orgIds = [teamA.organization, teamB.organization].filter(Boolean);
    if (orgIds.length === 0) return [];
    const orgs = await Organization.find({ _id: { $in: orgIds }, isDeleted: false });
    return orgs.map((org) => String(org.owner));
};
```

### New predicate: `canAssignScorer(match, teamA, teamB, userId)`

```js
const canAssignScorer = async (match, teamA, teamB, userId) => {
    if (match.createdBy?.equals(userId)) return true;
    const ownerIds = await qualifyingOrgOwnerIds(teamA, teamB);
    return ownerIds.includes(String(userId));
};
```

Gates the new `PATCH /v1/match/:matchId/scorer` only. Reuses the existing `MATCH_NOT_OWNED` error code on
failure — the meaning ("you don't have write authority over this match") already covers this; there is no
client-breaking rename since the *code* stays identical, only its true condition widens.

### Widened check: scoring authority

The identical six-line block —
```js
if (!match.createdBy?.equals(req.user._id)) {
    throw new ApiError(403, "MATCH_NOT_OWNED");
}
```
— in `startInnings`, `selectBowler`, `scoreBall`, `undoBall`, `syncMatch`, and `getMatchScorecard` becomes:
```js
if (!match.createdBy?.equals(req.user._id) && !match.assignedScorer?.equals(req.user._id)) {
    throw new ApiError(403, "MATCH_NOT_OWNED");
}
```
`abandonMatch` and `deleteMatch` keep the original unwidened check verbatim — this is the concrete answer
to decision 6, and the regression tests in §9 exist specifically to prove it.

### Assignee validation (inside the assign endpoint itself)

The endpoint never trusts a client-supplied `scorerId` on faith, even though the frontend picker only ever
offers qualifying members. It re-derives the qualifying orgs from `teamA`/`teamB` and checks the target
user is a member (any role) of at least one:
```js
const orgIds = [teamA.organization, teamB.organization].filter(Boolean);
const orgs = await Organization.find({ _id: { $in: orgIds }, isDeleted: false });
const isEligible = orgs.some((org) => isOrgMember(org, scorerId));
if (!isEligible) throw new ApiError(400, "INVALID_SCORER");
```
If `orgIds` is empty (neither team has an organization), the endpoint rejects before this check with
`MATCH_NOT_ORG_LINKED` — there is no member pool to validate against, and decision 4 ties delegated
scoring to org membership by construction.

## 5. The ad-hoc guarantee

A fully ad-hoc match — both teams created by name at match-creation time, neither ever attached to an
org — has `teamA.organization === null` and `teamB.organization === null` forever (per the Organizations
spec's own §5 guarantee, which this feature does not touch). For such a match:

- `PATCH /v1/match/:matchId/scorer` always fails with `MATCH_NOT_ORG_LINKED`, for anyone, including the
  creator. There is no assignee pool and no org-owner authority to draw on.
- `match.assignedScorer` stays `null` forever — nothing else ever sets it.
- Every scoring endpoint's widened check therefore degrades to exactly the original `createdBy`-only
  check (`match.assignedScorer?.equals(...)` is `null?.equals(...)`, always `false`).

Scoring, undo, sync, and history behavior for an ad-hoc match is provably identical before and after this
feature ships — the regression test in §9 confirms this directly rather than by inspection alone.

## 6. New/modified endpoints

Full request/response/error contracts live in `docs/api.md`. Summary:

| Method & path | Access | Purpose |
|---|---|---|
| `PATCH /v1/match/:matchId/scorer` | `createdBy`, or owner of teamA's/teamB's org | assign, reassign, or clear (`scorerId: null`) |
| `GET /v1/match/:matchId/scorer-candidates` | same as above | list of eligible assignees, for the picker |
| `GET /v1/match/history` (existing, widened) | `verifyJwt` (unchanged) | now also returns matches where I'm `assignedScorer`, and each entry gains `createdBy`/`assignedScorer` refs |

`GET /v1/match/:matchId/scorer-candidates` returns the deduplicated member list of whichever org(s)
actually own `teamA`/`teamB` (each `{id, name}`, owner included) — computed the same way §4's
`qualifyingOrgOwnerIds` derives orgs, just returning members instead of owner ids. A match with no
org-linked team returns an empty list (the frontend simply doesn't show an assign action in that case,
per §5).

**Authorization runs before the org-link check, on both endpoints, in that order.** `canAssignScorer`
is evaluated first regardless of whether either team is org-linked — someone with no assign authority at
all gets `MATCH_NOT_OWNED` (403) whether or not an org happens to be attached. Only once authorized does
the handler look at `teamA.organization`/`teamB.organization`: `scorer-candidates` returns `[]` for "no
org link" (a valid, non-error answer to "who could I assign"), while `PATCH .../scorer` raises
`MATCH_NOT_ORG_LINKED` (400) for the same condition — a GET reporting an empty option set is normal; a
PATCH actually attempting a mutation with no valid target is a client error.

`PATCH /v1/match/:matchId/scorer` request body: `{ "scorerId": "<userId>" | null }`. Response echoes the
resolved state: `{ matchId, assignedScorer: {id, name} | null }`.

`GET /v1/match/history`'s existing filter:
```js
const filter = { createdBy: req.user._id, isDeleted: false };
```
becomes:
```js
const filter = { $or: [{ createdBy: req.user._id }, { assignedScorer: req.user._id }], isDeleted: false };
```
Each returned match gains two fields: `createdBy: { id, name }` (new — lets the client render "Assigned by
X" whenever `createdBy.id !== <my id>`) and `assignedScorer: { id, name } | null` (new — lets the creator's
own list show who they've delegated a given match to). Fetching the creator's/scorer's display name needs
one batched `User.find({_id: {$in: ...}}, 'name')` alongside the existing batched `Team.find`, same
N+1-avoidance shape already used for team names in this handler.

## 7. New error codes

- `INVALID_SCORER` (400) — `scorerId` in the assign request doesn't resolve to a member of any org that
  owns `teamA` or `teamB`.
- `MATCH_NOT_ORG_LINKED` (400) — neither `teamA` nor `teamB` belongs to an organization; there is no
  assignee pool and delegated scoring is not available for this match.

`MATCH_NOT_OWNED` (403, reused meaning) covers both "you can't assign a scorer here" (§4's
`canAssignScorer` failure) and the widened "you can't score this match" — same code, two call sites,
same underlying meaning ("you lack write authority over this match"), consistent with how the
Organizations spec reused `ORG_NOT_OWNED` across multiple owner-gated actions rather than minting a new
code per site.

`MATCH_NOT_FOUND` (404, reused) covers a missing/deleted `matchId` on both new endpoints, identical to
every existing match-scoped endpoint.

All new keys ship in `src/locales/{en,hi,mr}/common.json`, enforced by the existing `tests/locales.test.js`
parity check.

## 8. Routes and the auth-allowlist test

Both new endpoints mount on the existing `src/routes/match.routes.js` router, which already carries
`verifyJwt` on every scoring route:
```js
router.route('/:matchId/scorer').patch(verifyJwt, assignScorer);
router.route('/:matchId/scorer-candidates').get(verifyJwt, getScorerCandidates);
```
No `tests/routes.auth.test.js` allowlist changes — `match` already has no public-route exceptions besides
`/public/:code`, and neither new route is public.

## 9. Testing scope (detail for the implementation plan)

New, TDD from scratch:
- `match.model.js` — `assignedScorer` field defaults to `null`; accepts a valid `User` ObjectId.
- `organizationAccess.js` (or a new sibling util) — `qualifyingOrgOwnerIds`, `canAssignScorer` as pure/thin
  units against fixture teams and orgs.
- `match.controller.js` — `assignScorer`: creator can assign; qualifying org owner can assign; a
  non-owner org member cannot; a random unrelated user cannot; clearing with `scorerId: null` works;
  assigning a `scorerId` who isn't a member of any qualifying org fails `INVALID_SCORER`; assigning on a
  match with no org-linked team fails `MATCH_NOT_ORG_LINKED`; works identically regardless of
  `match.status` (upcoming/live/completed), per decision 5.
- `match.controller.js` — `getScorerCandidates`: returns deduped members across both teams' orgs; empty
  list when neither team is org-linked; a caller with no assign-authority gets `MATCH_NOT_OWNED` even when
  the match has no org link at all (authorization is checked before the org-link check, per §6).
- `match.controller.js` — **the core regression suite for the widened checks**, one class per widened
  endpoint (`startInnings`, `selectBowler`, `scoreBall`, `undoBall`, `syncMatch`, `getMatchScorecard`):
  the assigned scorer can call it; the creator still can; a plain org member who is neither creator nor
  assigned scorer gets `MATCH_NOT_OWNED`; a user with no relationship to the match at all gets
  `MATCH_NOT_OWNED`. This is the "explicitly re-verify it loosens the check only for the specifically
  assigned scorer" requirement — one test per endpoint per identity, not inferred from a single shared
  case.
- `match.controller.js` — confirm `abandonMatch` and `deleteMatch` still reject an assigned scorer who is
  not the creator (`MATCH_NOT_OWNED`) — the explicit proof that decision 6's boundary holds.
- `match.controller.js` — `getMatchHistory`: an assigned-but-not-created match appears in the scorer's
  list with `createdBy` populated; the creator's own list shows `assignedScorer` populated for a match
  they've delegated.
- **Regression, not new:** re-run the full existing suite to confirm ad-hoc match creation/scoring and the
  entire Organizations feature are unaffected — §5's guarantee is only real if nothing in the untouched
  ad-hoc path's existing test coverage changes behavior.

## 10. Frontend surface (scope for the same plan, Flutter side)

- Match-history list card: when viewing a match where `createdBy.id !== me`, show a small subtitle
  "Assigned by {createdBy.name}". No change to a card for a match I created myself, unless it has an
  `assignedScorer`, in which case show "Assigned to {assignedScorer.name}".
- An overflow/action on a match card I have assign-authority over (creator, or qualifying org owner) —
  "Assign scorer" — opens a bottom sheet listing `GET /v1/match/:matchId/scorer-candidates`, tap to call
  `PATCH .../scorer`. If a scorer is already assigned, the sheet also offers "Remove assignment"
  (`scorerId: null`). A match with no org-linked team (empty candidate list) does not show this action at
  all, per §5/§6 — no dead-end sheet with nothing to pick.
- No changes to the scoring console screens themselves — an assigned scorer opens and uses the exact same
  scoring UI as a creator; the only frontend-visible difference is which matches appear in their list and
  the small label on each.

## 11. Explicitly out of scope for this spec

- Multiple scorers per match, or any "co-scoring" — decision 3.
- Assigning a scorer who isn't already an org member (email invite, guest scorer) — decision 4.
- Time-boxed or single-use assignment (e.g. "for today's match only, auto-revoked at completion") —
  assignment is a plain persistent field with no expiry; decision 5's revoke-anytime already covers the
  practical need without adding a scheduling concept.
- Letting an assigned scorer abandon or delete the match themselves — decision 6.
- Any notification to the assigned scorer that they've been assigned — matches the Organizations spec's
  own precedent of no invite/notification infrastructure existing yet; discovery is purely "check your
  match list."
