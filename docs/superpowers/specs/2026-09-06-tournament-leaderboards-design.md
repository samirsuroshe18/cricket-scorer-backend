# Tournament Leaderboards — Design Spec

**Status:** Approved for planning
**Scope:** Backend (`cricket-scorer-backend`) + Frontend (`cricket-scrorer`)
**Roadmap item:** Phase 3 — "Tournament leaderboards: Leading run-scorer / wicket-taker of the tournament"

## Problem

Phase 2 built career stats: a running, all-time total per player (`CareerStats`,
incrementally `$inc`-updated) plus the per-match contribution row it's built
from (`PlayerMatchStats`, one row per `(playerId, matchId)`). Neither is
scoped to a tournament. This feature adds a `GET` endpoint that computes a
batting and bowling leaderboard for one tournament's completed matches, and a
Flutter screen that displays it.

## Data model investigation (required first step)

**Finding: no retrofit is needed.** The brief for this work assumed a gap
might exist — "if [`CareerStats`] doesn't tag each match's contribution with
a tournament reference, that's a retrofit needed now." Investigation found:

- `PlayerMatchStats` (`src/models/playerMatchStats.model.js`) already carries
  `matchId` — it *is* the per-match-contribution row (`CareerStats` is the
  wrong table to filter; it has no per-match granularity at all, by design).
- `Match.tournament` (`src/models/match.model.js:36`) already exists, set by
  `POST /v1/tournament/:tournamentId/fixtures/:fixtureId/start-match` on
  every tournament match, `null` on every non-tournament match. This field
  was added in Phase 3 and is already the source of truth `computeStandings`
  reads.
- Therefore a tournament-scoped leaderboard is a plain two-step join —
  `Match.find({tournament, status:'completed'})` → collect `_id`s →
  `PlayerMatchStats.find({matchId: {$in: ids}})` — structurally identical to
  how `standings.controller.js` already joins `Match` → `Inning`. This is
  the existing convention, not a workaround around a missing field.
- Bonus invariant: `applyCareerStatsIncrement` (`src/utils/careerStats.js`)
  is called only from the genuine-completion path, never from `abandonMatch`
  (see `src/controllers/match.controller.js:1387`, "Completed matches only,
  never abandoned"). So `PlayerMatchStats` rows are already guaranteed to
  come only from matches with real scorecards — no extra exclusion logic is
  needed for abandoned matches, unlike standings (which has to explicitly
  exclude `abandoned` from NRR while still counting it toward `played`).

No schema change, no migration, no write-path change. This spec is entirely
new read-path code plus three small export changes to already-correct logic.

## Reuse contract (Phase 2 logic, not duplicated)

Three things move from private implementation detail of
`src/utils/careerStats.js` to exported, shared logic:

1. `battingAverage(runs, timesOut)`, `strikeRate(runs, ballsFaced)`,
   `economy(runsConceded, legalDeliveries)` — already exported and pure.
   Used as-is; no change.
2. `BATTING_SUM_FIELDS` / `BOWLING_SUM_FIELDS` — currently private consts
   inside `careerStats.js`, used only by `computeDelta`. **Export them.**
   The new leaderboard summation uses the same `[careerField, lineField]`
   pairs, so a field added to one aggregation is never silently missing
   from the other.
3. `isBetterHighScore(candidate, current)` / `isBetterBowling(candidate,
   current)` — currently private, used by `rescanHighScore` /
   `rescanBestBowling`. **Export them.** The leaderboard's per-tournament
   `highScore` / `bestBowling` fold uses the identical "what counts as
   better" rule career stats already uses (bowling tiebreak: more wickets,
   or same wickets with fewer runs conceded).

## Backend: pure computation — `src/utils/computeLeaderboards.js`

```js
computeLeaderboards({ contributions })
```

`contributions` is an array, one entry per `PlayerMatchStats` row already
loaded into memory:

```js
{ playerId: string, playerName: string, battingLine: BattingLine | null, bowlingLine: BowlingLine | null }
```

(`BattingLine`/`BowlingLine` shapes match `PlayerMatchStats`' own embedded
schema exactly — `{runs, balls, fours, sixes, isNotOut, wasFifty,
wasHundred}` and `{legalDeliveries, runs, wickets, maidens, wides,
noBalls}`.)

Returns:

```js
{ battingLeaderboard: BattingRow[], bowlingLeaderboard: BowlingRow[] }
```

Algorithm:

1. Group contributions by `playerId`.
2. For each player with at least one non-null `battingLine`: sum
   `inningsBatted` (count of rows with a `battingLine`), `timesOut` (rows
   where `!isNotOut`), `notOuts` (rows where `isNotOut`), and every
   `BATTING_SUM_FIELDS` pair (`runs`, `ballsFaced`←`balls`, `fours`,
   `sixes`, `fifties`←`wasFifty`, `hundreds`←`wasHundred`) across that
   player's rows. Compute `average`/`strikeRate` from the sums via the
   imported pure functions. Fold `highScore` across the player's own
   `battingLine`s using `isBetterHighScore`, tagging the winning row's
   `matchId`.
3. Mirror step 2 for bowling: `inningsBowled`, `BOWLING_SUM_FIELDS`
   (`legalDeliveries`, `runsConceded`←`runs`, `wickets`, `maidens`),
   `economy` via the imported pure function, `bestBowling` via
   `isBetterBowling`.
4. A player absent from `battingLine` on every row is absent from
   `battingLeaderboard` entirely (and symmetrically for bowling) — no
   zero-value rows. This differs deliberately from `computeStandings`,
   which pads every *enrolled team* to a zero row; there is no fixed
   "roster of players" a tournament enrolls, only players who actually
   appear in `PlayerMatchStats` rows for its matches.
5. Sort `battingLeaderboard` by `runs` desc → `average` desc (`null`
   sorts last) → `playerName` asc. Sort `bowlingLeaderboard` by `wickets`
   desc → `runsConceded` asc (same tiebreak direction as
   `isBetterBowling`) → `playerName` asc. The final `playerName` fallback
   exists purely for deterministic output, matching `computeStandings`'
   own convention — it is not a real tiebreaker.

Fully unit-testable without Mongo, same as `computeStandings`.

## Backend: endpoint — `GET /v1/tournament/:tournamentId/leaderboards`

New `src/controllers/leaderboard.controller.js`, `getLeaderboards`:

1. `findAccessibleTournament(tournamentId, req.user._id)` — same
   org-membership guard `standings.controller.js` uses. **No format
   gate** — unlike standings (round_robin/league only), leaderboards are
   player-level and meaningful for knockout tournaments too, so every
   format is allowed through.
2. `Match.find({tournament: tournament._id, isDeleted: false, status:
   'completed'}, '_id')` → `matchIds`.
3. `PlayerMatchStats.find({matchId: {$in: matchIds}}, 'playerId
   battingLine bowlingLine')`.
4. Resolve player names: `Player.find({_id: {$in: uniquePlayerIds},
   isDeleted: false}, 'name')`, build a `Map`. A row whose player was
   since soft-deleted is defensively labelled the same way other
   already-established "unknown" fallbacks in this codebase are — this
   is expected to be effectively unreachable in practice, since Player
   deletion is a separate, rare admin action, but the map lookup must not
   throw.
5. Build `contributions`, call `computeLeaderboards`, respond:

```json
{
  "statusCode": 200,
  "data": {
    "tournamentId": "665f...",
    "battingLeaderboard": [
      {
        "playerId": "665f...", "playerName": "Rahul",
        "inningsBatted": 3, "runs": 145, "ballsFaced": 98,
        "timesOut": 2, "notOuts": 1,
        "average": 72.5, "strikeRate": 147.96,
        "fours": 12, "sixes": 8, "fifties": 1, "hundreds": 0,
        "highScore": { "runs": 82, "isNotOut": true, "matchId": "665f..." }
      }
    ],
    "bowlingLeaderboard": [
      {
        "playerId": "665f...", "playerName": "Suresh",
        "inningsBowled": 3, "legalDeliveries": 72, "runsConceded": 88,
        "wickets": 7, "maidens": 1, "economy": 7.33,
        "bestBowling": { "wickets": 3, "runs": 21, "matchId": "665f..." }
      }
    ]
  },
  "message": "Leaderboards fetched successfully",
  "success": true
}
```

New route in `src/routes/tournament.routes.js`:
`router.route('/:tournamentId/leaderboards').get(verifyJwt, getLeaderboards);`

New locale key across `src/locales/{en,hi,mr}/common.json`:
`LEADERBOARDS_FETCHED`. No new error code — an unstarted or all-abandoned
tournament is not an error, it returns `{battingLeaderboard: [],
bowlingLeaderboard: []}`. Existing errors from `findAccessibleTournament`
(`TOURNAMENT_NOT_FOUND`, org-access ones) cover the rest, unchanged.

## Frontend (`cricket-scrorer`)

Mirrors the standings screen's wiring, established in
`lib/features/tournament/`:

- `data/models/response/leaderboard_row_res.dart` (+ generated `.g.dart`):
  `BattingLeaderboardRowRes` and `BowlingLeaderboardRowRes`, field names
  matching the JSON above exactly.
- `tournament_endpoint.dart`: `leaderboards(String tournamentId) =>
  '/v1/tournament/$tournamentId/leaderboards'`.
- `tournament_api_service.dart`: `getLeaderboards({required tournamentId})`.
- `tournament_repository.dart` / `_impl.dart`: `getLeaderboards` returning
  `Either<CricketResponse<TournamentLeaderboardsRes>, CricketFailure>`
  where `TournamentLeaderboardsRes` bundles both lists.
- `domain/usecases/get_leaderboards.dart`: `GetLeaderboardsParams` /
  `GetLeaderboardsUseCase`, following `get_standings.dart`'s exact pattern.
- `tournament_injection.dart`: register the new use case.
- `TournamentDetailController`: add `getLeaderboardsUseCase` (required
  constructor param, like `getStandingsUseCase`), plus
  `battingLeaderboard`/`bowlingLeaderboard` obs lists,
  `leaderboardsLoading`, `leaderboardsError`, and a `loadLeaderboards()`
  method mirroring `loadStandings()` — lazy, not called from `loadDetail()`.
- `TournamentDetailBinding`: wire the new use case via `Get.find()`.
- `app_routes.dart` / `app_pages.dart`: `tournamentLeaderboards` route, no
  dedicated `binding:` (reuses the tag-registered
  `TournamentDetailController`, same as the standings screen).
- New `TournamentLeaderboardsScreen`: two tabs (Batting / Bowling) or a
  segmented toggle over the two `DataTable`s (implementation detail decided
  during planning — the design constraint is that both lists come from one
  fetch, no per-tab re-fetch). Reached via a button on
  `TournamentDetailScreen` next to the Standings button, **shown for every
  tournament format** (not gated on non-knockout the way Standings is).
- Translation keys for new column headers/labels, plus the mandatory CMS
  bulk-upload (`POST /v1/translations/bulk-update`) for all of them before
  calling this done — the standings work hit this exact gotcha live; it is
  not optional, not a follow-up.

## Testing plan (TDD, both repos)

Backend:
1. `tests/computeLeaderboards.test.js` — pure function, no Mongo. Cases:
   empty input; bat-only player excluded from bowling and vice versa;
   multi-match summation for one player; `average` is `null` when a player
   has never been out (reusing `battingAverage`'s own null rule);
   `highScore`/`bestBowling` folded correctly across multiple matches,
   including the bowling tiebreak (fewer runs wins on equal wickets);
   sort order for both leaderboards including the tiebreak and final
   name-fallback cases.
2. `tests/leaderboard.test.js` — supertest integration. Cases: 401 with no
   token; 404 for a nonexistent tournament; empty leaderboards before any
   match is played; a completed match's players appear correctly
   aggregated; an **abandoned** match's players do not contribute any
   stats (proving the `PlayerMatchStats`-only-on-completion invariant
   holds end-to-end, not just in the pure function); a **knockout**
   tournament is allowed (200, not the 400 standings would give).
3. `scripts/verify-leaderboards.sh` — manual verification script, same
   curl+jq style as `scripts/verify-standings.sh`.

Frontend: controller tests for `loadLeaderboards()` success/failure
(following the `loadStandings` test pattern), a widget test for
`TournamentLeaderboardsScreen` verified against a hand-computed small
scenario (at least one player with multi-match aggregation and one
tiebreak), plus the existing `_Unused.../_Fake...GetLeaderboardsUseCase`
additions needed in every other widget test that constructs
`TournamentDetailController` directly.

## Docs and cross-repo coupling

- `docs/api.md` gets a new `### GET /v1/tournament/:tournamentId/leaderboards`
  section, in the same place/style as the standings section, in the same
  commit as the controller/route.
- **This does not introduce a new cross-repo coupling category.** It's
  another instance of the workspace CLAUDE.md's already-documented
  "endpoint paths: backend routers vs `*_endpoint.dart`" item. Following
  the standings precedent: no change to either repo's own `CLAUDE.md`;
  only `docs/api.md` (committed, backend repo) and a short bullet appended
  to the workspace-root `CLAUDE.md`'s cross-repo summary paragraph
  (uncommitted — the workspace root isn't a git repo) once implementation
  lands.

## Out of scope

- Team affiliation per leaderboard row (`Player` has no stable team field;
  see design-chat discussion — deferred, not a gap being silently ignored).
- Any leaderboard scoped to something other than one tournament (global,
  per-organization) — that's Phase 2's own separate, still-unbuilt "Scoped
  leaderboards" roadmap item, not this feature.
- Minimum-innings qualification thresholds (e.g. real cricket's "must have
  batted N times to qualify for the average leaderboard") — sort is by raw
  `runs`/`wickets`, not by rate stats, so this doesn't arise here.
- Pagination — the full list is returned, same as standings; a tournament's
  player count is small enough that this is not a real concern at current
  scale.
