# Points Table / Standings — Design

**Status:** Confirmed with the user 2026-09-06. Backend-only; a Phase 3 spec
will cover the `cricket-scrorer` standings screen against the endpoint this
document defines.

## Problem

Round-robin and league tournaments have no points table today — nothing
computes points, ranks teams, or breaks ties. `docs/api.md`'s Fixture
section explicitly lists this as not covered.

## Decisions

**Points per outcome:** Win = 2, Loss = 0, Tie = 1, No-result = 1. Fixed
constants, not configurable per tournament (YAGNI — no tournament has asked
for a different scheme).

**Tiebreaker:** Net run rate (NRR) only. No head-to-head fallback — NRR is a
single deterministic number per team regardless of how many teams share a
points total, whereas head-to-head breaks down the moment three or more
teams are tied (it needs a mini-league sub-comparison) or the schedule is
uneven. An exact points-and-NRR tie is reported as a genuine tie; the API
still needs a stable order for it (see Sort order below), but that order is
not itself a tiebreaker.

**Format scope:** `round_robin` and `league` only. `knockout` is a bracket,
not a table — requesting standings for one 400s with `STANDINGS_NOT_APPLICABLE`.

**Computation model:** Recomputed fresh on every `GET`, from `Match` +
`Inning` documents directly — no persisted standings state on `Tournament`.
This sidesteps a whole class of drift bugs an incremental/event-driven model
would need to handle explicitly (e.g. an `undo` of the last ball
un-completing a match after its points were already applied).

**Source of truth is `Match`, never `Fixture.winner`.** `Fixture.winner` is
forced onto every unresolved fixture (tie, no-result, or abandoned) by the
existing manual-resolve endpoint, because the fixture layer exists to answer
"who advances" for knockout brackets — not to record a round-robin/league
result. Reading `Fixture.winner` for points would turn a genuine tie into a
fabricated win for whichever team the owner happened to click. Standings are
computed from `Match.status`/`Match.result` instead.

**Abandoned matches count as no-result**, for both teams, independent of
whatever winner the owner later force-assigns to the linked fixture.
`Match.status === 'abandoned'` never carries a `result` (confirmed: the
`abandon` endpoint doesn't set one) — this is the only reachable no-result
case today; `Match.result.winner === 'no_result'` is modeled in the schema
but unreachable through any current endpoint, per `docs/api.md`.

## NRR formula

Aggregated across every one of a team's NRR-eligible matches in the
tournament (summed, not averaged per match):

```
NRR = (total runs scored / total overs faced) − (total runs conceded / total overs bowled)
```

- **Overs faced/bowled** is normally the actual balls played
  (`legalBalls / 6`). Exception: if the batting side was bowled out
  (`Inning.completionReason === 'all_out'`), its overs for that innings count
  as the full match quota (`Match.totalOvers`) instead of the balls it
  actually faced — the standard rule that stops a team skittled out cheaply
  from getting an inflated rate. A team that chases a target down early
  (`target_achieved`) keeps its real, smaller over count — finishing faster
  should improve NRR, and does under this rule since only `all_out` is
  special-cased.
- **Abandoned matches are excluded entirely** from the NRR aggregate (no
  valid run-rate data), though they still count toward Played and points.
- **Ties are included normally** — only "abandoned" is special-cased out.
- A team with no NRR-eligible matches yet (zero overs faced and bowled) has
  NRR = 0, not `NaN`/`Infinity`.

## Table contents & ordering

- Every currently-enrolled team appears, including one with 0 matches
  played (all columns zero) — the table is driven by `Tournament.teams`,
  not by which teams happen to have a completed match.
- Columns: `played`, `won`, `lost`, `tied`, `noResult`, `points`, `nrr`.
- Sort: points desc → NRR desc → team name asc. The name-based fallback
  exists purely so the API's output order is deterministic; it is not
  presented as a real tiebreaker.
- `nrr` is returned as an exact (unrounded) number; the endpoint rounds to 3
  decimal places for display. Sorting always happens on the unrounded value
  so display rounding can never flip an order.

## Endpoint

`GET /v1/tournament/:tournamentId/standings` — same nesting and access
control as `GET /v1/tournament/:tournamentId/fixtures` (any org member, via
`findAccessibleTournament`, not owner-only).

```json
{
  "statusCode": 200,
  "data": {
    "tournamentId": "665f1a2b3c4d5e6f7a8b9c01",
    "format": "round_robin",
    "standings": [
      { "teamId": "665f…05", "teamName": "Harbor CC", "played": 3, "won": 2, "lost": 1, "tied": 0, "noResult": 0, "points": 4, "nrr": 0.85 }
    ]
  },
  "message": "Standings fetched",
  "success": true
}
```

Errors: `404 TOURNAMENT_NOT_FOUND`, `403 NOT_ORG_MEMBER`,
`400 STANDINGS_NOT_APPLICABLE` (format is `knockout`), plus the usual
`401` trio via `verifyJwt`.

## Out of scope

- Head-to-head as any part of the tiebreaker.
- A persisted/incremental standings table.
- Configurable points schemes.
- The `cricket-scrorer` standings screen (Phase 3 of this feature, separate
  plan).
- Any change to how `Fixture.winner`/`resolveFixture` works — standings
  read `Match` directly and don't touch that flow.
