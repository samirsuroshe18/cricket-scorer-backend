# Player Pool Registration & Base Price — Design

**Status:** Approved, ready for implementation planning.
**Repos affected:** `cricket-scorer-backend` (this spec), `cricket-scrorer` (Flutter, same plan — this
feature is small enough for one phased plan spanning both, matching the delegated-scoring precedent).
**Contract doc:** [docs/api.md](../../../docs/api.md) — the new `## Player pool` subsection under
`## Tournament` is the finalized, binding version of everything below. This file is the reasoning; if
the two disagree, `docs/api.md` wins and this file is stale.
**Builds on:** [2026-09-05-organizations-and-persistent-teams-design.md](2026-09-05-organizations-and-persistent-teams-design.md),
[2026-09-05-tournament-model.md](../plans/2026-09-05-tournament-model.md) (the plan that shipped
`Tournament`/`Fixture`), and `docs/roadmap.md`'s "Decisions settled before Phase 4" section (play-money
only, no real-currency type or payout path; auction access control keyed on paid-Organization status).

## 1. Motivation

Phase 4's differentiator is the live player auction, and the roadmap frames it as building the tool for
something local leagues already do informally: an organizer sets a base price per player, team owners
bid, someone gets bought. Before any bidding mechanics can exist, a tournament needs a **pool** —
which players are up for auction at all, and what they start at. This pass builds exactly that:
registration and base price. It does not build the live bid room, budgets, or sold/unsold resolution —
see §11.

This decision was deferred twice already (`docs/plan-remaining-development-2026-09-02.md`'s Phase C note,
and the roadmap's own "Open decisions" section before this session settled the other two Phase 4
questions). It cannot be deferred a third time without blocking Phase 4 entirely, since base price is the
one piece of pool registration with a real exploit surface.

## 2. The identity constraint that shapes everything below

**`Player` has no link to `User`, and that is a standing, twice-confirmed decision** — see
`docs/api.md`'s "Player has no link to User" note. A `Player` document is scorer-scoped
(`{createdBy, nameLower}`, unique), created only as a side effect of someone typing a name during
match-scoring (`findOrCreatePlayer`/`resolveBowler`). There is no player-facing account, login, consent
step, or self-service action anywhere in this codebase, for anyone. Any design assuming a player can
register themselves, approve their own registration, or declare their own price is not implementable on
top of the current data model — not a policy choice being made here, a structural fact already decided
by the (deliberately deferred) claim-flow question.

## 3. Scope decisions (from brainstorming)

Each of these was confirmed explicitly before design work started:

1. **Who registers:** the tournament's organizer only — the owner of the organization the tournament
   belongs to, the exact same authority tier `addTournamentTeam`/`generateFixtures` already require
   (`findOwnedTournament`). Not any org member, and not the player. There is no separate approval step:
   the organizer's act of registering a player *is* the decision, because there is no submission from
   the player's side to approve.
2. **Identity resolution:** a pool entry references an existing `Player` (`findOrCreatePlayer`-style, by
   name, optionally by id) resolved under **the organizer's own `createdBy` scope** — mirroring
   `start-innings`'s `bowlerName`/optional `bowlerId` pattern exactly. This does not require the player to
   have appeared in any match yet (the common real case: an auction runs *before* a season's matches are
   scored, so `Team.players` is typically still empty). A `playerId` reference is honored only when that
   `Player`'s `createdBy` is the requesting organizer — no cross-scorer lookup exists or is needed.
3. **State: existence is the only state, in this pass.** A pool entry is a plain join record
   (`{tournament, player, basePrice}`), created by registering and physically removed by withdrawing —
   the same hard-add/hard-remove shape `addTournamentTeam`/`removeTournamentTeam` already use, not a soft
   status field. `registered`/`in_auction`/`sold`/`unsold` are **not** modeled now: nothing in this pass
   can ever set the latter three (no live auction room exists to produce those transitions), and an enum
   value nothing reaches is dead code, not forward-compatibility. When the live auction room is built, it
   adds a real `status` field and the transitions that belong to it, to this same collection.
4. **Withdrawal has no cutoff in this pass.** There is no "auction started" event yet to gate against, so
   `DELETE` is unrestricted while the entry exists. A real cutoff (e.g. locked once the live room opens
   that player's bidding) is that later feature's own decision, deliberately not invented ahead of it.
5. **Pool membership is independent of `Team.players`.** A player already rostered on some team (from a
   prior season, or a team the organizer separately manages) is neither blocked from nor required to be
   in the pool — the pool is the pre-assignment candidate list; `Team.players` is post-assignment state.
   This pass does not touch `Team.players` at all.
6. **Base price: organizer-set, mandatory, and — this is the part that closes the exploit — stats are
   never read by this feature, at all, in any form, including as a suggested band.** See §4 for why.
7. **Access control:** identical to every other tournament-admin mutation (`findOwnedTournament`), **not**
   a new auction-specific entitlement system, per the roadmap's settled decision. The roadmap's
   "paid Organization" gate cannot be implemented here: `Organization` has no tier/paid field at all yet
   (Phase 6 is unbuilt). This spec does not stub one in speculatively — see §11.

## 4. Why base price is organizer-set, not stats-derived, and why that's not a compromise

The instinct to derive base price from Phase 2's career stats is reasonable on its face — better players
should command higher prices, and the stats already exist. It was considered and rejected, deliberately,
not for lack of engineering effort but because it cannot actually close the risk it would be built to
close.

The exploit isn't "can a player pad their stats" in the abstract — it's "can this system verify that a
`Player` document's stats were produced by, and reflect, one specific real person who did not control how
those numbers were generated." Because `Player`↔`User` is permanently unlinked (§2), **that verification
is impossible today, full stop** — not harder for ad-hoc matches and safer for organization-run ones, just
uniformly impossible, because nothing anywhere ties a `Player` to a `User` account regardless of which
matches it appears in.

Restricting eligible stats to "organization-verified" matches — concretely buildable, since `Match` already
carries `tournament`/`fixture` refs set by `start-fixture-match` — narrows the *surface*: faking a number
would require standing up an org, a tournament, fixtures, and scoring real ball-by-ball deliveries instead
of just typing a total. But it does not close the *risk*, because nothing prevents the org owner from
being the delegated scorer, or from colluding with one — Phase 3's delegated-scoring spec authorizes
exactly that pairing without restriction, and a small real league is exactly the setting where the
organizer, a scorer, and a bidding-favorite player are often the same handful of people who know each
other. A "verified-matches-only" filter, or a hybrid where stats propose a band an organizer merely
confirms, would launder a self-servable number with the appearance of objectivity — worse than no
filter, because "the app calculated this from real matches" reads as authoritative when it structurally
isn't.

**Base price is therefore a plain, organizer-entered integer, with no code path from any `Player`'s stats
— real, fabricated, or verified-match-only — to that number.** Inflating stats, however achieved, has
zero effect on auction economics, because this feature never reads `CareerStats` or `PlayerMatchStats` at
all. This is closed by construction: there is nothing to bypass, not a check that could theoretically be
defeated. If a future pass wants to *display* a player's career stats alongside their pool listing purely
as informational context for bidders (the roadmap's "current player on the block" bid-room feature is the
natural place for this) — that is a display concern, not a pricing one, and this spec does not build it
(see §11).

Validation: `basePrice` is a whole number, `1`–`100000000` inclusive. That upper bound is a sanity/overflow
guard, not a business rule — organizers set their own league's economy scale (10s, 1000s, or crores,
matching whatever number range feels right for their group), the same way `totalOvers`'s 1–50 bound exists
to catch fat-fingering, not to encode cricket law.

## 5. Data model

### New collection: `playerPoolEntry.model.js`

A separate collection, not an embedded array on `Tournament` — the same reasoning `Fixture` used over
`Tournament.teams`: this needs its own lifecycle once the live auction room adds real states, its own
document identity for independent updates (editing one player's base price shouldn't re-save the whole
`Tournament`), and clean growth (a pool can plausibly outgrow the "tens" scale `Tournament.teams` was
sized for — a league auctioning 60 players across 8 teams is a normal case).

```js
import mongoose, { Schema } from "mongoose";

const playerPoolEntrySchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true },
    player:     { type: Schema.Types.ObjectId, ref: 'Player', required: true },
    basePrice:  { type: Number, required: true, min: 1, max: 100000000 },
    createdBy:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// One registration per player per tournament — re-registering an already-
// pooled player is a base-price edit (PATCH), not a second entry.
playerPoolEntrySchema.index({ tournament: 1, player: 1 }, { unique: true });
// Supports the pool listing's natural read order (registration order).
playerPoolEntrySchema.index({ tournament: 1, createdAt: 1 });

export const PlayerPoolEntry = mongoose.model('PlayerPoolEntry', playerPoolEntrySchema);
```

No `isDeleted` — `DELETE` physically removes the document, mirroring `removeTournamentTeam`/
`removeOrganizationMember`'s hard-removal of join-table-shaped records, not the soft-delete convention
reserved for `Match`/`Team`/`Player`/`Tournament` themselves.

No changes to `Player`, `Team`, `Tournament`, or `Organization`'s own schemas. `Player`'s existing
`role`/`jerseyNumber`/`battingStyle`/`bowlingStyle`/`bio` fields (Phase 2) are reused as-is for the pool
listing's display fields — editable via the existing `PATCH /v1/player/:playerId`, no new profile-editing
surface needed.

## 6. Identity resolution: `findOrCreatePoolPlayer`

A local helper in `playerPool.controller.js`, deliberately **not** `match.controller.js`'s
`findOrCreatePlayer` — that function's signature and body are about roster-side-effects and
opposing-team collision checks (`rosterPlayer`, `PLAYER_ON_OPPOSING_TEAM`) that have no meaning here;
there is no "team" or "opposing side" at pool-registration time. This mirrors only the identity-resolution
half:

```js
// Resolves `playerId` (must belong to the caller's own scorer-scope) or
// find-or-creates by `playerName` under it — same {createdBy, nameLower}
// upsert primitive as findOrCreatePlayer, without that function's
// roster/opposing-team side effects, which don't apply before a player has
// a team at all.
const findOrCreatePoolPlayer = async (playerName, playerId, createdBy) => {
    if (playerId) {
        const player = await Player.findOne({ _id: playerId, createdBy, isDeleted: false });
        if (!player) throw new ApiError(400, "INVALID_PLAYER_ID");
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
```

`MAX_PLAYER_NAME_LENGTH = 50` is a local const in the new controller, matching `match.controller.js`'s own
un-shared local constant — no cross-controller constant extraction, consistent with the flat/no-service-
layer architecture.

## 7. Access control

Reuses `tournament.controller.js`'s existing `findOwnedTournament`/`findAccessibleTournament` exactly as
written — no new predicate needed:

- `POST .../pool`, `PATCH .../pool/:playerId`, `DELETE .../pool/:playerId` → `findOwnedTournament` (org
  owner only), same tier as `addTournamentTeam`/`removeTournamentTeam`/`generateFixtures`.
- `GET .../pool` → `findAccessibleTournament` (any org member), same tier as `getTournament`/
  `listFixtures`/`getStandings`.

**No paid-tier check exists in this pass.** The roadmap's settled "auction access control" decision (an
auction under a paid Organization is the paid tier; ad-hoc/casual stays free) cannot be implemented here
because `Organization` carries no tier/subscription field at all — Phase 6 hasn't shipped. This spec does
not add a placeholder field or a stubbed check; whichever endpoint ends up representing "the auction" for
billing purposes (plausibly the live bid room rather than registration, but genuinely undecided) gets that
gate once Phase 6 defines what "paid" means on an `Organization` document. Flagged, not guessed at.

## 8. New/modified endpoints

Full request/response/error contracts live in `docs/api.md`. Summary:

| Method & path | Access | Purpose |
|---|---|---|
| `POST /v1/tournament/:tournamentId/pool` | org owner | register a player with a base price |
| `GET /v1/tournament/:tournamentId/pool` | any org member | list the pool, registration order |
| `PATCH /v1/tournament/:tournamentId/pool/:playerId` | org owner | edit `basePrice` only |
| `DELETE /v1/tournament/:tournamentId/pool/:playerId` | org owner | withdraw (hard remove) |

`POST` body: `{ "playerName": "Rohit Sharma", "playerId": null, "basePrice": 5000 }` — `playerId` optional,
per §6. `PATCH` body: `{ "basePrice": 6000 }`. Both responses echo the resolved entry:
```json
{
  "playerId": "665f…30", "playerName": "Rohit Sharma",
  "role": "batsman", "jerseyNumber": 45, "battingStyle": "right_handed",
  "bowlingStyle": null, "bio": null,
  "basePrice": 5000, "registeredAt": "2026-09-07T10:00:00.000Z"
}
```
`registeredAt` is the entry's own `createdAt`, renamed in the response for readability — the same
convention `joinedAt`/`addedAt` already use elsewhere for a plain timestamp field on a join-shaped record.

`GET` response: `{ "tournamentId": "…", "entries": [ <same shape>, … ] }`, ordered by registration
(`createdAt` asc) — the order an auction would naturally work through the pool, and a stable, boring
default absent any auction-order concept yet.

## 9. New error codes

- `POOL_PLAYER_NAME_REQUIRED` (400) — neither a usable `playerId` nor a non-blank `playerName` given.
- `INVALID_PLAYER_ID` (400) — `playerId` given but doesn't resolve to a `Player` owned by the requesting
  organizer.
- `BASE_PRICE_REQUIRED` (400) — `basePrice` missing on `POST` or `PATCH`.
- `INVALID_BASE_PRICE` (400) — not a whole number in `1`–`100000000`.
- `PLAYER_ALREADY_IN_POOL` (409) — the `{tournament, player}` unique index rejected a duplicate
  registration; the resolved `Player` (by id or by name) is already pooled for this tournament. The
  client-facing remedy is `PATCH` to change the price, not re-`POST`.
- `POOL_ENTRY_NOT_FOUND` (404) — `PATCH`/`DELETE` target `playerId` has no pool entry for this tournament.

`TOURNAMENT_NOT_FOUND` (404), `TOURNAMENT_NOT_OWNED` (403), `NOT_ORG_MEMBER` (403) are reused verbatim
from `findOwnedTournament`/`findAccessibleTournament` — no new meaning, same codes every other tournament
endpoint already returns for the same conditions.

All six new keys ship in `src/locales/{en,hi,mr}/common.json`, enforced by `tests/locales.test.js`.

## 10. Routes and the auth-allowlist test

Mounts on the existing `src/routes/tournament.routes.js` router, which already carries `verifyJwt` on
every route:
```js
router.route('/:tournamentId/pool')
    .post(verifyJwt, registerPoolPlayer)
    .get(verifyJwt, listPoolEntries);
router.route('/:tournamentId/pool/:playerId')
    .patch(verifyJwt, updatePoolEntry)
    .delete(verifyJwt, removePoolEntry);
```
No `tests/routes.auth.test.js` allowlist changes — `tournament` has no public-route exceptions and none
of these four routes are public.

## 11. Testing scope (detail for the implementation plan)

New, TDD from scratch, following `tests/helpers/matchSetup.js`-style shared setup where a
tournament/org/team fixture is needed:

- `playerPoolEntry.model.js` — unique `{tournament, player}` constraint rejects a duplicate insert.
- `findOrCreatePoolPlayer` (or the controller behavior it drives) — creates a new `Player` under the
  organizer's `createdBy` for a fresh name; resolves the same `Player` on a repeated name (case-
  insensitive); accepts an existing `playerId` owned by the organizer; rejects a `playerId` owned by a
  different user with `INVALID_PLAYER_ID`; rejects a blank name with `POOL_PLAYER_NAME_REQUIRED`.
- `registerPoolPlayer`: org owner can register; a non-owner org member cannot (`TOURNAMENT_NOT_OWNED`); a
  non-member cannot; registering the same resolved player twice for the same tournament fails
  `PLAYER_ALREADY_IN_POOL`; `basePrice` validation (`BASE_PRICE_REQUIRED`, `INVALID_BASE_PRICE` for zero,
  negative, non-integer, and above the cap); registering the same player across two *different*
  tournaments succeeds (the unique index is per-tournament, not global).
- `listPoolEntries`: any org member can list; a non-member cannot (`NOT_ORG_MEMBER`); returns entries in
  registration order with each `Player` profile field embedded; empty list for a tournament with nothing
  registered — not an error.
- `updatePoolEntry`: org owner can change `basePrice`; a non-owner cannot; a `playerId` with no pool entry
  for this tournament fails `POOL_ENTRY_NOT_FOUND`.
- `removePoolEntry`: org owner can withdraw; a non-owner cannot; removing a non-existent entry fails
  `POOL_ENTRY_NOT_FOUND`; the underlying `Player` document is untouched (not soft-deleted) — only the pool
  entry is removed.
- **Regression, not new:** confirm `Team.players`, match-scoring, and the rest of the tournament suite are
  unaffected — this feature reads `Tournament`/`Player` and writes only the new collection.

## 12. Frontend surface (scope for the same plan, Flutter side)

- A "Player pool" tab/section on the tournament detail screen (alongside the existing fixtures/standings/
  leaderboards tabs), visible to any org member; an "Add player" action visible only when the caller is
  the org owner (same visibility rule the fixtures screen already applies to "Generate fixtures").
- Add-player sheet: a name field (find-or-create, matching `NextBowlerBottomSheet`'s "type a name, no
  closed roster" pattern — there usually is no existing roster to pick from at auction time) plus a base
  price field. No stats, no career-stats display, no price suggestion anywhere in this UI — nothing in
  this pass reads `CareerStats`, and the UI should not imply otherwise.
- Each pool row shows name, role (badge, reusing whatever label styling `player_stats_screen.dart`
  already uses for role), and base price; an edit action (base price only) and a remove action, both
  gated on org-owner visibility, mirroring the tournament-teams-list pattern.
- No changes to the scoring console, match creation, or any existing screen — this is a net-new
  tournament-detail surface only.

## 13. Explicitly out of scope for this spec

- **All live-auction/bid-room mechanics** — current-player-on-the-block, live bid ticker, countdown,
  sold/unsold resolution, server-authoritative bid acceptance, budgets, team-owner invites. This spec is
  registration and base price only, per the brief.
- **`sold`/`unsold`/`in_auction` states and any transition between them** — §3 decision 3; these belong to
  the live-auction-room feature, added to this same collection when that feature is designed.
- **A withdrawal cutoff tied to "the auction has started"** — §3 decision 4; no such event exists yet to
  gate against.
- **Paid-Organization access-control enforcement** — §7; blocked on Phase 6 defining what "paid" means on
  an `Organization` document.
- **Displaying career stats alongside a pool listing** — a display-only enhancement the live bid room is
  the more natural home for; deliberately not built here so it can't be mistaken for pricing input (§4).
- **Reconciling a pool-registered `Player` (owned by the organizer) with the same real person's `Player`
  document under a delegated scorer's own scorer-scope**, if that person is later added to a team's live
  roster post-auction. A real seam created by `Player`'s scorer-scoped identity model, deliberately not
  resolved here — squad assignment (the roadmap's "Post-auction squad view") is the pass that has to face
  it.
- **Any change to `Player`, `Team`, `Tournament`, or `Organization`'s existing schemas or endpoints.**
