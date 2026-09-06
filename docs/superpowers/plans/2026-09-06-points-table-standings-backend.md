# Points Table / Standings (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GET /v1/tournament/:tournamentId/standings` endpoint that
computes a points table (points, played/won/lost/tied/no-result, NRR) for
`round_robin` and `league` tournaments, recomputed fresh from `Match`/
`Inning` data on every request.

**Architecture:** A pure function (`computeStandings`), tested in isolation
with plain objects — no Mongoose, no DB — carries every scoring/tiebreak/NRR
rule. A thin controller queries `Tournament`, `Match`, and `Inning`, reshapes
the documents into that function's plain-object input, and serializes the
result. This mirrors the existing `resolveFixtureOutcome.js` /
`fixture.controller.js` split in this codebase: decision logic stays free of
persistence concerns, and is fully unit-testable without spinning up Mongo.

**Tech Stack:** Node/Express 5, Mongoose, Jest + Supertest (existing stack;
no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-06-points-table-standings-design.md`

## Global Constraints

- Points: Win = 2, Loss = 0, Tie = 1, No-result = 1. Fixed constants, not
  configurable.
- Tiebreaker: NRR only. No head-to-head. An exact points+NRR tie is real —
  it is not broken further except for a name-based sort key that exists
  purely to make API output deterministic.
- Formats with a standings table: `round_robin`, `league`. `knockout`
  returns `400 STANDINGS_NOT_APPLICABLE`.
- Standings are computed fresh on every `GET` from `Match`/`Inning`
  documents — no persisted standings state is added to `Tournament`.
- Standings read `Match.status`/`Match.result` directly. They never read
  `Fixture.winner` (which is force-assigned even for a tie/no-result/
  abandoned match, for bracket-advancement purposes unrelated to points).
- `Match.status === 'abandoned'` is the no-result case. It carries no
  `result` field. `Match.result.winner === 'no_result'` is schema-modeled
  but unreachable through any current endpoint — do not special-case it.
- NRR overs rule: use `legalBalls / 6` normally; substitute the match's
  `totalOvers` instead, for that innings only, when
  `Inning.completionReason === 'all_out'`.
- NRR excludes abandoned matches entirely (no valid overs data) but those
  matches still count toward `played` and points.
- Sort order: `points` desc, then `nrr` desc, then `teamName` asc
  (`localeCompare`). Sort on the unrounded `nrr`; round only at the API
  boundary (3 decimal places).
- Test command: `npm test` (from `cricket-scorer-backend/`). Jest is ESM
  (`NODE_OPTIONS=--experimental-vm-modules`, already wired into the `test`
  script — just run `npm test <path>` to scope a run).
- Locale keys: added to all three of `src/locales/{en,hi,mr}/common.json`.
  `tests/locales.test.js` fails the suite if any key is missing from one of
  the three files.
- Route file: `src/routes/tournament.routes.js`. Auth: `verifyJwt`,
  imported from `../middlewares/auth.middleware.js` (already imported in
  that file).
- Branch: `feat-points-table-standings`, already created off
  `origin/development`. Commit after every task.

---

### Task 1: `computeStandings` — zero rows, win/loss points, deterministic sort

**Files:**
- Create: `src/utils/computeStandings.js`
- Test: `tests/computeStandings.test.js`

**Interfaces:**
- Produces: `computeStandings({ teams, matches })` — `teams` is
  `Array<{ id: string, name: string }>`; `matches` is
  `Array<{ teamAId: string, teamBId: string, status: 'completed' | 'abandoned', resultWinner: 'teamA' | 'teamB' | 'tie' | null, totalOvers: number, innings: Array<{ battingSide: 'teamA' | 'teamB', runs: number, legalBalls: number, allOut: boolean }> }>`.
  Returns `Array<{ teamId, teamName, played, won, lost, tied, noResult, points, nrr }>`,
  sorted points desc → nrr desc → teamName asc. Every later task extends
  this same function and shares this exact shape — do not rename any field.

- [ ] **Step 1: Write the failing tests**

```javascript
// tests/computeStandings.test.js
import { computeStandings } from '../src/utils/computeStandings.js';

describe('computeStandings — zero rows and sort', () => {
    it('gives every enrolled team a zero row when no matches have been played, sorted by name', () => {
        const teams = [{ id: 't2', name: 'Bravo' }, { id: 't1', name: 'Alpha' }];
        const result = computeStandings({ teams, matches: [] });
        expect(result).toEqual([
            { teamId: 't1', teamName: 'Alpha', played: 0, won: 0, lost: 0, tied: 0, noResult: 0, points: 0, nrr: 0 },
            { teamId: 't2', teamName: 'Bravo', played: 0, won: 0, lost: 0, tied: 0, noResult: 0, points: 0, nrr: 0 },
        ]);
    });
});

describe('computeStandings — win/loss points', () => {
    it('awards 2 points and a win to teamA, 0 points and a loss to teamB', () => {
        const teams = [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Bravo' }];
        const matches = [{
            teamAId: 't1', teamBId: 't2', status: 'completed', resultWinner: 'teamA',
            totalOvers: 20, innings: [],
        }];
        const result = computeStandings({ teams, matches });
        expect(result[0]).toEqual({ teamId: 't1', teamName: 'Alpha', played: 1, won: 1, lost: 0, tied: 0, noResult: 0, points: 2, nrr: 0 });
        expect(result[1]).toEqual({ teamId: 't2', teamName: 'Bravo', played: 1, won: 0, lost: 1, tied: 0, noResult: 0, points: 0, nrr: 0 });
    });

    it('sorts the team with more points first, regardless of team name', () => {
        const teams = [{ id: 't1', name: 'Zulu' }, { id: 't2', name: 'Alpha' }];
        const matches = [{
            teamAId: 't1', teamBId: 't2', status: 'completed', resultWinner: 'teamA',
            totalOvers: 20, innings: [],
        }];
        const result = computeStandings({ teams, matches });
        expect(result.map((r) => r.teamId)).toEqual(['t1', 't2']);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test tests/computeStandings.test.js`
Expected: FAIL — `Cannot find module '../src/utils/computeStandings.js'` (or similar "not defined").

- [ ] **Step 3: Write the implementation**

```javascript
// src/utils/computeStandings.js
//
// Pure decision logic for turning a tournament's completed/abandoned matches
// into a ranked points table. No Mongoose here — the standings controller is
// what loads real documents and reshapes them into the plain objects this
// function expects. Mirrors resolveFixtureOutcome.js's split between pure
// logic and the controller that touches the database.

export const STANDINGS_FORMATS = ['round_robin', 'league'];

const POINTS = { win: 2, loss: 0, tie: 1, noResult: 1 };

const oversOf = (innings, totalOvers) => (innings.allOut ? totalOvers : innings.legalBalls / 6);

// `teams` is every currently-enrolled team — the table always lists all of
// them, even one with zero matches played. `matches` is only matches that
// have reached a terminal state (`completed` or `abandoned`); the caller is
// responsible for filtering to that and for attributing `teamAId`/`teamBId`
// as real team ids (not the match-relative 'teamA'/'teamB' side labels the
// Match/Inning models use internally — those live in `resultWinner` and
// `innings[].battingSide` instead, exactly as the Mongoose documents store
// them).
export const computeStandings = ({ teams, matches }) => {
    const rows = new Map(teams.map((t) => [t.id, {
        teamId: t.id,
        teamName: t.name,
        played: 0, won: 0, lost: 0, tied: 0, noResult: 0, points: 0,
        runsFor: 0, oversFor: 0, runsAgainst: 0, oversAgainst: 0,
    }]));

    for (const match of matches) {
        const a = rows.get(match.teamAId);
        const b = rows.get(match.teamBId);

        a.played += 1;
        b.played += 1;

        if (match.status === 'abandoned') {
            a.noResult += 1;
            b.noResult += 1;
            a.points += POINTS.noResult;
            b.points += POINTS.noResult;
            continue;
        }

        if (match.resultWinner === 'tie') {
            a.tied += 1;
            b.tied += 1;
            a.points += POINTS.tie;
            b.points += POINTS.tie;
        } else if (match.resultWinner === 'teamA') {
            a.won += 1;
            a.points += POINTS.win;
            b.lost += 1;
            b.points += POINTS.loss;
        } else if (match.resultWinner === 'teamB') {
            b.won += 1;
            b.points += POINTS.win;
            a.lost += 1;
            a.points += POINTS.loss;
        }

        for (const innings of match.innings) {
            const overs = oversOf(innings, match.totalOvers);
            const battingRow = innings.battingSide === 'teamA' ? a : b;
            const bowlingRow = innings.battingSide === 'teamA' ? b : a;
            battingRow.runsFor += innings.runs;
            battingRow.oversFor += overs;
            bowlingRow.runsAgainst += innings.runs;
            bowlingRow.oversAgainst += overs;
        }
    }

    const table = [...rows.values()].map((r) => ({
        teamId: r.teamId,
        teamName: r.teamName,
        played: r.played,
        won: r.won,
        lost: r.lost,
        tied: r.tied,
        noResult: r.noResult,
        points: r.points,
        nrr: (r.oversFor === 0 || r.oversAgainst === 0) ? 0 : (r.runsFor / r.oversFor) - (r.runsAgainst / r.oversAgainst),
    }));

    table.sort((x, y) => y.points - x.points || y.nrr - x.nrr || x.teamName.localeCompare(y.teamName));
    return table;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test tests/computeStandings.test.js`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/utils/computeStandings.js tests/computeStandings.test.js
git commit -m "feat: add computeStandings with zero rows, win/loss points, and sort"
```

---

### Task 2: `computeStandings` — tie and no-result (abandoned) points

**Files:**
- Modify: `src/utils/computeStandings.js` (no change expected — already handled; this task proves it)
- Modify: `tests/computeStandings.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
describe('computeStandings — tie and no-result points', () => {
    it('awards 1 point each and a tied result for a tie, no win/loss on either side', () => {
        const teams = [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Bravo' }];
        const matches = [{
            teamAId: 't1', teamBId: 't2', status: 'completed', resultWinner: 'tie',
            totalOvers: 20, innings: [],
        }];
        const result = computeStandings({ teams, matches });
        expect(result.find((r) => r.teamId === 't1')).toEqual(
            { teamId: 't1', teamName: 'Alpha', played: 1, won: 0, lost: 0, tied: 1, noResult: 0, points: 1, nrr: 0 },
        );
        expect(result.find((r) => r.teamId === 't2')).toEqual(
            { teamId: 't2', teamName: 'Bravo', played: 1, won: 0, lost: 0, tied: 1, noResult: 0, points: 1, nrr: 0 },
        );
    });

    it('awards 1 point each and a no-result for an abandoned match, not a win/loss/tie', () => {
        const teams = [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Bravo' }];
        const matches = [{
            teamAId: 't1', teamBId: 't2', status: 'abandoned', resultWinner: null,
            totalOvers: 20, innings: [],
        }];
        const result = computeStandings({ teams, matches });
        expect(result.find((r) => r.teamId === 't1')).toEqual(
            { teamId: 't1', teamName: 'Alpha', played: 1, won: 0, lost: 0, tied: 0, noResult: 1, points: 1, nrr: 0 },
        );
        expect(result.find((r) => r.teamId === 't2')).toEqual(
            { teamId: 't2', teamName: 'Bravo', played: 1, won: 0, lost: 0, tied: 0, noResult: 1, points: 1, nrr: 0 },
        );
    });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test tests/computeStandings.test.js`
Expected: PASS, 5/5 — Task 1's implementation already handles both branches
correctly. This is expected: Task 1 wrote the full points/no-result logic in
one pass because both branches were needed to make the type signature
coherent. These tests exist as permanent regression coverage for behavior
that's already correct, not to drive new code. Do not modify the
implementation to force a failure first — that would violate "no
implementation without a reason," not TDD.

- [ ] **Step 3: Commit**

```bash
git add tests/computeStandings.test.js
git commit -m "test: cover tie and no-result points in computeStandings"
```

---

### Task 3: `computeStandings` — NRR from normal overs

**Files:**
- Modify: `tests/computeStandings.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
describe('computeStandings — NRR from normal overs', () => {
    it('computes NRR from runs and overs faced/bowled across a completed match', () => {
        const teams = [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Bravo' }];
        // Alpha bats first: 120 runs off 20 overs (all legal, no all-out).
        // Bravo chases: 100 runs off 20 overs (all legal, no all-out).
        // Alpha: for 120/20=6.0, against 100/20=5.0 -> NRR = 1.0
        // Bravo: for 100/20=5.0, against 120/20=6.0 -> NRR = -1.0
        const matches = [{
            teamAId: 't1', teamBId: 't2', status: 'completed', resultWinner: 'teamA',
            totalOvers: 20,
            innings: [
                { battingSide: 'teamA', runs: 120, legalBalls: 120, allOut: false },
                { battingSide: 'teamB', runs: 100, legalBalls: 120, allOut: false },
            ],
        }];
        const result = computeStandings({ teams, matches });
        expect(result.find((r) => r.teamId === 't1').nrr).toBeCloseTo(1.0, 10);
        expect(result.find((r) => r.teamId === 't2').nrr).toBeCloseTo(-1.0, 10);
    });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test tests/computeStandings.test.js`
Expected: PASS, 6/6 — the innings-accumulation loop and `nrr` formula were
already written in Task 1 (the return shape required an `nrr` field from
the start). This test is the first one to exercise it with non-empty
innings and prove the arithmetic is right.

- [ ] **Step 3: Commit**

```bash
git add tests/computeStandings.test.js
git commit -m "test: cover NRR calculation from normal overs in computeStandings"
```

---

### Task 4: `computeStandings` — NRR all-out overs-entitled substitution

**Files:**
- Modify: `tests/computeStandings.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
describe('computeStandings — NRR all-out overs-entitled substitution', () => {
    it('uses the match totalOvers, not legalBalls, for an all-out innings', () => {
        const teams = [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Bravo' }];
        // Alpha is bowled out for 60 off just 10 overs (60 legal balls) of a
        // 20-over match — NRR must charge Alpha with facing the full 20
        // overs it was entitled to, not the 10 it actually used. Without the
        // substitution Alpha's for-rate would be 60/10=6.0; with it, 60/20=3.0.
        // Bravo chases: 61 off 20 overs, not bowled out.
        // Alpha: for 60/20=3.0, against 61/20=3.05 -> NRR = -0.05
        // Bravo: for 61/20=3.05, against 60/20=3.0 -> NRR = 0.05
        const matches = [{
            teamAId: 't1', teamBId: 't2', status: 'completed', resultWinner: 'teamB',
            totalOvers: 20,
            innings: [
                { battingSide: 'teamA', runs: 60, legalBalls: 60, allOut: true },
                { battingSide: 'teamB', runs: 61, legalBalls: 120, allOut: false },
            ],
        }];
        const result = computeStandings({ teams, matches });
        expect(result.find((r) => r.teamId === 't1').nrr).toBeCloseTo(-0.05, 10);
        expect(result.find((r) => r.teamId === 't2').nrr).toBeCloseTo(0.05, 10);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/computeStandings.test.js`
Expected: FAIL — without the substitution, Alpha's `oversFor` would be
`60/6=10`, giving `nrr = (60/10) - (61/20) = 6.0 - 3.05 = 2.95`, not `-0.05`.

Note: this only fails if the implementation doesn't yet special-case
`allOut`. `oversOf` in Task 1's implementation already includes the
`innings.allOut ? totalOvers : innings.legalBalls / 6` ternary, since the
final function shape was written in one pass. If this test passes
immediately, skip to Step 4 — it's still valuable, permanent proof of the
rule; do not modify working code to manufacture a failure.

- [ ] **Step 3: If it failed, fix `oversOf` in `src/utils/computeStandings.js`** (should already read as shown in Task 1 — this step is a no-op if Step 2 passed)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test tests/computeStandings.test.js`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add tests/computeStandings.test.js
git commit -m "test: cover NRR all-out overs-entitled substitution in computeStandings"
```

---

### Task 5: `computeStandings` — tiebreak, exclusion, and full-tie scenarios

This task covers the three scenarios the design explicitly called out by
name: a points tie broken by NRR, an abandoned match excluded from NRR
while still counting toward played/points, and a genuine points+NRR tie
falling back to alphabetical order.

**Files:**
- Modify: `tests/computeStandings.test.js`

- [ ] **Step 1: Write the failing tests**

```javascript
describe('computeStandings — tiebreak and exclusion scenarios', () => {
    it('ranks two teams level on points by NRR', () => {
        // Three teams, round-robin-shaped: Alpha beats Charlie big, Bravo
        // beats Charlie small. Alpha and Bravo are both 1-0 (2 points each)
        // but Alpha's NRR is higher.
        const teams = [
            { id: 'a', name: 'Alpha' }, { id: 'b', name: 'Bravo' }, { id: 'c', name: 'Charlie' },
        ];
        const matches = [
            {
                teamAId: 'a', teamBId: 'c', status: 'completed', resultWinner: 'teamA', totalOvers: 20,
                innings: [
                    { battingSide: 'teamA', runs: 150, legalBalls: 120, allOut: false },
                    { battingSide: 'teamB', runs: 100, legalBalls: 120, allOut: false },
                ],
            },
            {
                teamAId: 'b', teamBId: 'c', status: 'completed', resultWinner: 'teamA', totalOvers: 20,
                innings: [
                    { battingSide: 'teamA', runs: 121, legalBalls: 120, allOut: false },
                    { battingSide: 'teamB', runs: 120, legalBalls: 120, allOut: false },
                ],
            },
        ];
        const result = computeStandings({ teams, matches });
        const alpha = result.find((r) => r.teamId === 'a');
        const bravo = result.find((r) => r.teamId === 'b');
        expect(alpha.points).toBe(bravo.points);
        expect(alpha.nrr).toBeGreaterThan(bravo.nrr);
        expect(result.map((r) => r.teamId).indexOf('a')).toBeLessThan(result.map((r) => r.teamId).indexOf('b'));
    });

    it('excludes an abandoned match from NRR while still counting it as played with no-result points', () => {
        const teams = [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Bravo' }];
        const matches = [
            {
                teamAId: 't1', teamBId: 't2', status: 'completed', resultWinner: 'teamA', totalOvers: 20,
                innings: [
                    { battingSide: 'teamA', runs: 120, legalBalls: 120, allOut: false },
                    { battingSide: 'teamB', runs: 100, legalBalls: 120, allOut: false },
                ],
            },
            {
                // A second, abandoned meeting between the same two teams —
                // must add to played/points but leave NRR exactly as the
                // first match alone would produce.
                teamAId: 't1', teamBId: 't2', status: 'abandoned', resultWinner: null, totalOvers: 20,
                innings: [],
            },
        ];
        const result = computeStandings({ teams, matches });
        const alpha = result.find((r) => r.teamId === 't1');
        expect(alpha.played).toBe(2);
        expect(alpha.won).toBe(1);
        expect(alpha.noResult).toBe(1);
        expect(alpha.points).toBe(3); // 2 for the win + 1 for the no-result
        expect(alpha.nrr).toBeCloseTo(1.0, 10); // unchanged from the single decisive match
    });

    it('falls back to alphabetical team name when points and NRR are both exactly equal', () => {
        const teams = [{ id: 't1', name: 'Zulu' }, { id: 't2', name: 'Alpha' }];
        // Identical results for both teams against a common baseline isn't
        // needed here — with no matches at all, both are 0 points / 0 NRR,
        // which is the simplest exact tie to construct.
        const result = computeStandings({ teams, matches: [] });
        expect(result.map((r) => r.teamName)).toEqual(['Alpha', 'Zulu']);
    });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test tests/computeStandings.test.js`
Expected: PASS, 10/10 — all three scenarios already fall out of the
implementation written in Task 1 (the sort comparator and the abandoned
branch's early `continue` before the innings loop). These are the
headline regression tests for the tiebreak design decisions; keep them even
though they don't force new code.

- [ ] **Step 3: Commit**

```bash
git add tests/computeStandings.test.js
git commit -m "test: cover NRR tiebreak, abandoned-match exclusion, and full-tie ordering"
```

---

### Task 6: `GET /v1/tournament/:tournamentId/standings` endpoint

**Files:**
- Create: `src/controllers/standings.controller.js`
- Modify: `src/routes/tournament.routes.js`
- Modify: `src/locales/en/common.json`, `src/locales/hi/common.json`, `src/locales/mr/common.json`
- Modify: `docs/api.md` (workspace root, not inside this repo — see note in Step 6)
- Test: `tests/standings.test.js`

**Interfaces:**
- Consumes: `computeStandings`, `STANDINGS_FORMATS` from
  `../utils/computeStandings.js` (Task 1); `findAccessibleTournament`
  exported from `./tournament.controller.js`; `Match` from
  `../models/match.model.js`; `Inning` from `../models/inning.model.js`.

- [ ] **Step 1: Write the failing integration tests**

```javascript
// tests/standings.test.js
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Fixture } from '../src/models/fixture.model.js';
import { startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';

let app;

beforeAll(async () => {
    await connectTestDb();
    await Tournament.init();
    await Fixture.init();
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

const createTournament = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/tournaments`).set('Authorization', `Bearer ${token}`).send(body);

const createOrgTeam = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

const addTeamToTournament = (token, tournamentId, teamId) =>
    request(app).post(`/api/v1/tournament/${tournamentId}/teams`).set('Authorization', `Bearer ${token}`).send({ teamId });

const generateFixtures = (token, tournamentId) =>
    request(app).post(`/api/v1/tournament/${tournamentId}/fixtures`).set('Authorization', `Bearer ${token}`).send();

const listFixtures = (token, tournamentId) =>
    request(app).get(`/api/v1/tournament/${tournamentId}/fixtures`).set('Authorization', `Bearer ${token}`).send();

const startFixtureMatch = (token, tournamentId, fixtureId, body) =>
    request(app)
        .post(`/api/v1/tournament/${tournamentId}/fixtures/${fixtureId}/start-match`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

const abandonMatch = (token, matchId) =>
    request(app).post(`/api/v1/match/${matchId}/abandon`).set('Authorization', `Bearer ${token}`).send();

const getStandings = (token, tournamentId) =>
    request(app).get(`/api/v1/tournament/${tournamentId}/standings`).set('Authorization', `Bearer ${token}`).send();

// Plays out a 1-over-per-side match with a fixed first-innings total, so the
// margin (and therefore each team's NRR contribution) is controlled by the
// caller rather than always 6 runs. `firstInningsRuns` must be reachable in
// 6 legal balls without a wicket (e.g. a run a ball, or sixes).
const playOutMatch = async (token, matchId, firstInningsRuns, secondInningsRuns) => {
    const suffix = matchId.slice(-6);
    const perBall1 = Math.floor(firstInningsRuns / 6);
    await startLiveInnings(app, token, matchId, {
        strikerName: `A1-${suffix}`, nonStrikerName: `A2-${suffix}`, bowlerName: `B1-${suffix}`,
    });
    for (let i = 0; i < 6; i += 1) {
        await scoreDotBall(app, token, matchId, { runs: perBall1 });
    }
    const perBall2 = Math.floor(secondInningsRuns / 6);
    await startLiveInnings(app, token, matchId, {
        strikerName: `B1-${suffix}`, nonStrikerName: `B2-${suffix}`, bowlerName: `A1-${suffix}`,
    });
    for (let i = 0; i < 6; i += 1) {
        await scoreDotBall(app, token, matchId, { runs: perBall2 });
    }
};

const setupTournamentWithTeams = async (format, names) => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer Cup', format });
    const tournamentId = tournamentRes.body.data.id;

    const teamIds = [];
    for (const name of names) {
        const teamRes = await createOrgTeam(token, orgId, { name });
        const teamId = teamRes.body.data.id;
        await addTeamToTournament(token, tournamentId, teamId);
        teamIds.push(teamId);
    }
    return { token, orgId, tournamentId, teamIds };
};

describe('GET /v1/tournament/:tournamentId/standings', () => {
    it('400s for a knockout tournament', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', ['A', 'B']);
        const res = await getStandings(token, tournamentId);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('STANDINGS_NOT_APPLICABLE');
    });

    it('404s for a tournament that does not exist', async () => {
        const { token } = await setupTournamentWithTeams('round_robin', ['A', 'B', 'C']);
        const res = await getStandings(token, '665f1a2b3c4d5e6f7a8b9c99');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
    });

    it('401s with no token', async () => {
        const { tournamentId } = await setupTournamentWithTeams('round_robin', ['A', 'B', 'C']);
        const res = await request(app).get(`/api/v1/tournament/${tournamentId}/standings`).send();
        expect(res.status).toBe(401);
    });

    it('lists every enrolled team at zero before any fixture is played', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo', 'Charlie']);
        const res = await getStandings(token, tournamentId);
        expect(res.status).toBe(200);
        expect(res.body.data.format).toBe('round_robin');
        expect(res.body.data.standings).toHaveLength(3);
        expect(res.body.data.standings.every((r) => r.played === 0 && r.points === 0)).toBe(true);
    });

    it('ranks a bigger win above a smaller win when both teams are level on points (NRR tiebreak)', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo', 'Charlie']);
        await generateFixtures(token, tournamentId);
        const fixtures = (await listFixtures(token, tournamentId)).body.data.fixtures;

        const alphaVsCharlie = fixtures.find((f) =>
            [f.teamA.name, f.teamB.name].includes('Alpha') && [f.teamA.name, f.teamB.name].includes('Charlie'));
        const bravoVsCharlie = fixtures.find((f) =>
            [f.teamA.name, f.teamB.name].includes('Bravo') && [f.teamA.name, f.teamB.name].includes('Charlie'));

        const started1 = await startFixtureMatch(token, tournamentId, alphaVsCharlie.id, { totalOvers: 1 });
        await playOutMatch(token, started1.body.data.matchId, 30, 0); // Alpha smashes it, wins by 30

        const started2 = await startFixtureMatch(token, tournamentId, bravoVsCharlie.id, { totalOvers: 1 });
        await playOutMatch(token, started2.body.data.matchId, 6, 0); // Bravo wins narrowly

        const res = await getStandings(token, tournamentId);
        expect(res.status).toBe(200);
        const rows = res.body.data.standings;
        const alpha = rows.find((r) => r.teamName === 'Alpha');
        const bravo = rows.find((r) => r.teamName === 'Bravo');
        expect(alpha.points).toBe(bravo.points);
        expect(alpha.nrr).toBeGreaterThan(bravo.nrr);
        expect(rows.indexOf(alpha)).toBeLessThan(rows.indexOf(bravo));
    });

    it('counts an abandoned match as a no-result, excluded from NRR, even after the fixture is force-resolved to a winner', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo', 'Charlie']);
        await generateFixtures(token, tournamentId);
        const fixtures = (await listFixtures(token, tournamentId)).body.data.fixtures;
        const alphaVsBravo = fixtures.find((f) =>
            [f.teamA.name, f.teamB.name].includes('Alpha') && [f.teamA.name, f.teamB.name].includes('Bravo'));
        const alphaId = alphaVsBravo.teamA.name === 'Alpha' ? alphaVsBravo.teamA.id : alphaVsBravo.teamB.id;

        const started = await startFixtureMatch(token, tournamentId, alphaVsBravo.id, { totalOvers: 20 });
        await abandonMatch(token, started.body.data.matchId);

        // Force-resolve the now-unresolved fixture, picking Alpha as the
        // "advancing" team — this only matters for knockout brackets, and
        // must NOT turn into a win/loss in the points table, which reads
        // Match, not Fixture.winner.
        await request(app)
            .patch(`/api/v1/tournament/${tournamentId}/fixtures/${alphaVsBravo.id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ winner: alphaId });

        const res = await getStandings(token, tournamentId);
        const rows = res.body.data.standings;
        const alpha = rows.find((r) => r.teamName === 'Alpha');
        const bravo = rows.find((r) => r.teamName === 'Bravo');
        expect(alpha.played).toBe(1);
        expect(alpha.won).toBe(0);
        expect(alpha.noResult).toBe(1);
        expect(alpha.points).toBe(1);
        expect(alpha.nrr).toBe(0);
        expect(bravo.played).toBe(1);
        expect(bravo.lost).toBe(0);
        expect(bravo.noResult).toBe(1);
        expect(bravo.points).toBe(1);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test tests/standings.test.js`
Expected: FAIL — `404`/`Cannot GET /api/v1/tournament/.../standings` (route
doesn't exist yet).

- [ ] **Step 3: Write the controller**

```javascript
// src/controllers/standings.controller.js
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Match } from '../models/match.model.js';
import { Inning } from '../models/inning.model.js';
import { findAccessibleTournament } from './tournament.controller.js';
import { computeStandings, STANDINGS_FORMATS } from '../utils/computeStandings.js';

const roundNrr = (value) => Math.round(value * 1000) / 1000;

export const getStandings = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);

    if (!STANDINGS_FORMATS.includes(tournament.format)) {
        throw new ApiError(400, "STANDINGS_NOT_APPLICABLE");
    }

    await tournament.populate('teams.team', 'name');
    const teams = tournament.teams.map((entry) => ({
        id: String(entry.team._id),
        name: entry.team.name,
    }));

    const matches = await Match.find(
        { tournament: tournament._id, isDeleted: false, status: { $in: ['completed', 'abandoned'] } },
        'teamA teamB status result totalOvers',
    );

    const innings = await Inning.find(
        { matchId: { $in: matches.map((m) => m._id) } },
        'matchId battingTeam totalRuns legalBalls completionReason',
    );
    const inningsByMatch = innings.reduce((acc, inn) => {
        const key = String(inn.matchId);
        (acc[key] ??= []).push(inn);
        return acc;
    }, {});

    const matchInputs = matches.map((m) => ({
        teamAId: String(m.teamA),
        teamBId: String(m.teamB),
        status: m.status,
        resultWinner: m.result?.winner ?? null,
        totalOvers: m.totalOvers,
        innings: (inningsByMatch[String(m._id)] ?? []).map((inn) => ({
            battingSide: inn.battingTeam,
            runs: inn.totalRuns,
            legalBalls: inn.legalBalls,
            allOut: inn.completionReason === 'all_out',
        })),
    }));

    const standings = computeStandings({ teams, matches: matchInputs })
        .map((row) => ({ ...row, nrr: roundNrr(row.nrr) }));

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        format: tournament.format,
        standings,
    }, req.t("STANDINGS_FETCHED")));
});
```

- [ ] **Step 4: Wire the route**

Edit `src/routes/tournament.routes.js`:

```javascript
import { Router } from "express";
import { getTournament, updateTournament, deleteTournament, addTournamentTeam, removeTournamentTeam } from "../controllers/tournament.controller.js";
import { generateFixtures, listFixtures, startFixtureMatch, resolveFixture } from "../controllers/fixture.controller.js";
import { getStandings } from "../controllers/standings.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/:tournamentId')
    .get(verifyJwt, getTournament)
    .patch(verifyJwt, updateTournament)
    .delete(verifyJwt, deleteTournament);
router.route('/:tournamentId/teams').post(verifyJwt, addTournamentTeam);
router.route('/:tournamentId/teams/:teamId').delete(verifyJwt, removeTournamentTeam);
router.route('/:tournamentId/fixtures')
    .post(verifyJwt, generateFixtures)
    .get(verifyJwt, listFixtures);
router.route('/:tournamentId/fixtures/:fixtureId')
    .patch(verifyJwt, resolveFixture);
router.route('/:tournamentId/fixtures/:fixtureId/start-match').post(verifyJwt, startFixtureMatch);
router.route('/:tournamentId/standings').get(verifyJwt, getStandings);

export default router;
```

- [ ] **Step 5: Add locale keys**

In `src/locales/en/common.json`, change line 180 from:
```json
  "FIXTURE_RESOLVED": "Fixture resolved",
```
to:
```json
  "FIXTURE_RESOLVED": "Fixture resolved",
  "STANDINGS_NOT_APPLICABLE": "Standings aren't available for a knockout tournament",
  "STANDINGS_FETCHED": "Standings fetched",
```

In `src/locales/hi/common.json`, after the line matching `"FIXTURE_RESOLVED": "फिक्स्चर तय किया गया",` add:
```json
  "STANDINGS_NOT_APPLICABLE": "नॉकआउट टूर्नामेंट के लिए स्टैंडिंग उपलब्ध नहीं है",
  "STANDINGS_FETCHED": "स्टैंडिंग प्राप्त की गई",
```

In `src/locales/mr/common.json`, after the line matching `"FIXTURE_RESOLVED": "फिक्स्चर निकाली काढला",` add:
```json
  "STANDINGS_NOT_APPLICABLE": "नॉकआउट स्पर्धेसाठी गुणतालिका उपलब्ध नाही",
  "STANDINGS_FETCHED": "गुणतालिका मिळाली",
```

- [ ] **Step 6: Update docs/api.md**

`docs/api.md` lives at the workspace root
(`/Users/samirsuroshe/Projects/Cricket-Scorer-Project/cricket-scorer-workspace/docs/api.md`),
outside this git repo (the workspace root isn't a git repo — it's a shared,
untracked reference file per the workspace `CLAUDE.md`). Edit it directly;
there is no commit step for this file.

Insert a new `### GET /v1/tournament/:tournamentId/standings` subsection
right after the existing `### PATCH /v1/tournament/:tournamentId/fixtures/:fixtureId`
subsection's error table (before `### What this pass does NOT cover`, around
line 3615 as of this plan):

```markdown
### GET /v1/tournament/:tournamentId/standings

Any org member. Round_robin/league only — `knockout` is a bracket, not a
table, and 400s. Recomputed fresh from `Match`/`Inning` documents on every
call; nothing is persisted. Reads `Match.status`/`Match.result` directly,
never `Fixture.winner` — the fixture's winner is force-assigned even for a
tie/no-result/abandoned match, for bracket-advancement purposes unrelated to
points.

Points: win = 2, loss = 0, tie = 1, no-result = 1 (an abandoned match is the
no-result case). Tiebreaker is net run rate only — no head-to-head. NRR
aggregates runs/overs across every NRR-eligible match; an all-out innings
counts as having used the match's full over quota rather than the balls it
actually faced. Abandoned matches are excluded from NRR but still count
toward `played` and points.

### Response `200`
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

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `NOT_ORG_MEMBER` | caller isn't a member of the owning organization |
| 400 | `STANDINGS_NOT_APPLICABLE` | tournament's format is `knockout` |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |
```

Also update the `### What this pass does NOT cover` list right below (around
line 3616): remove the bullet `Points table / standings, or tournament
leaderboards — listed separately in \`docs/roadmap.md\` Phase 3.` since it's
now covered.

In the `## Locale keys` section, after the `Added by the delegated-scoring
contract` paragraph (around line 3713), add:

```markdown
Added by the standings contract: `STANDINGS_FETCHED`,
`STANDINGS_NOT_APPLICABLE`.
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test tests/standings.test.js`
Expected: PASS, 7/7.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, no new failures. (If a handful of unrelated suites fail due
to parallel-worker contention against the shared dev Mongo Atlas cluster —
a known, pre-existing flake in this environment — re-run just those files
individually to confirm they're not real regressions.)

- [ ] **Step 9: Commit**

```bash
git add src/controllers/standings.controller.js src/routes/tournament.routes.js tests/standings.test.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json
git commit -m "feat: add GET /v1/tournament/:tournamentId/standings endpoint"
```

(`docs/api.md` is outside this repo — it has no commit step.)

---

### Task 7: Manual verification script

**Files:**
- Create: `scripts/verify-standings.sh`

This repo already has a convention for manual end-to-end verification
scripts (`scripts/verify-match-completion.sh`,
`scripts/verify-over-completion.sh`, `scripts/verify-undo.sh`) — bash +
curl + jq, hitting a running dev server, printing `PASS`/`FAIL` per
assertion. This task follows the exact same shape, for standings.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
#
# End-to-end check for the points table (docs/api.md ->
# "GET /v1/tournament/:tournamentId/standings").
#
# Creates an organization, a round_robin tournament, and 3 teams; generates
# fixtures; plays two matches with controlled margins so one pair of teams
# ends up level on points and must be split by NRR; abandons a third match
# to prove it counts as a no-result excluded from NRR. Prints the resulting
# table for a human to eyeball, plus the specific assertions that make the
# tiebreak and exclusion rules visible rather than just "it returned 200".
#
#   npm run dev                     # in another terminal, Mongo must be a replica set
#   TOKEN=<accessToken> ./scripts/verify-standings.sh
#
# or let it log in for you:
#   EMAIL=you@example.com PASSWORD=secret ./scripts/verify-standings.sh
#
# BASE defaults to the dev flavor's base URL, which already ends in /api.
set -uo pipefail

BASE="${BASE:-http://localhost:9000/api}"
PASSES=0

command -v jq >/dev/null || { echo "jq is required (brew install jq)"; exit 1; }

call() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -w '\n%{http_code}' -X "$method" "$BASE$path"
              -H 'Content-Type: application/json'
              -H 'accept-language: en')
  [ -n "${TOKEN:-}" ] && args+=(-H "Authorization: Bearer $TOKEN")
  [ -n "$data" ] && args+=(-d "$data")

  local raw; raw="$(curl "${args[@]}")"
  CODE="${raw##*$'\n'}"
  BODY="${raw%$'\n'*}"
}

fail() {
  echo
  echo "FAIL: $1"
  echo "  HTTP $CODE"
  echo "  $BODY" | head -c 2000
  echo
  exit 1
}

pass() { PASSES=$((PASSES + 1)); printf 'PASS  %s\n' "$1"; }

expect() {
  local label="$1" want="$2"; shift 2
  [ "$CODE" = "$want" ] || fail "$label — expected HTTP $want"
  while [ $# -gt 0 ]; do
    local got; got="$(echo "$BODY" | jq -r "$1")"
    [ "$got" = "$2" ] || fail "$label — $1 was '$got', expected '$2'"
    shift 2
  done
  pass "$label"
}

uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

if [ -z "${TOKEN:-}" ]; then
  [ -n "${EMAIL:-}" ] && [ -n "${PASSWORD:-}" ] || {
    echo "Set TOKEN, or EMAIL and PASSWORD so this can log in."; exit 1; }
  call POST /v1/user/login "$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" \
      '{email:$e, password:$p}')"
  [ "$CODE" = "200" ] || fail "login"
  TOKEN="$(echo "$BODY" | jq -r '.data.accessToken')"
  pass "logged in"
fi

STAMP="$(date +%s)"

call POST /v1/organization "$(jq -nc --arg n "Standings Verify $STAMP" '{name:$n}')"
expect "create organization" 200
ORG_ID="$(echo "$BODY" | jq -r '.data.id')"

call POST "/v1/organization/$ORG_ID/tournaments" "$(jq -nc --arg n "Cup $STAMP" '{name:$n, format:"round_robin"}')"
expect "create round_robin tournament" 200
TOURNAMENT_ID="$(echo "$BODY" | jq -r '.data.id')"

newTeam() { # newTeam <name> -> sets TEAM
  call POST "/v1/organization/$ORG_ID/teams" "$(jq -nc --arg n "$1 $STAMP" '{name:$n}')"
  expect "create team $1" 200
  TEAM="$(echo "$BODY" | jq -r '.data.id')"
}

newTeam "Alpha"; ALPHA="$TEAM"
newTeam "Bravo"; BRAVO="$TEAM"
newTeam "Charlie"; CHARLIE="$TEAM"

for T in "$ALPHA" "$BRAVO" "$CHARLIE"; do
  call POST "/v1/tournament/$TOURNAMENT_ID/teams" "$(jq -nc --arg t "$T" '{teamId:$t}')"
  expect "enroll team" 200
done

call POST "/v1/tournament/$TOURNAMENT_ID/fixtures" ""
expect "generate fixtures" 200
FIXTURES_JSON="$BODY"

fixtureBetween() { # fixtureBetween <teamId> <teamId>
  echo "$FIXTURES_JSON" | jq -r --arg a "$1" --arg b "$2" \
    '.data.fixtures[] | select((.teamA.id==$a and .teamB.id==$b) or (.teamA.id==$b and .teamB.id==$a)) | .id'
}

startMatch() { # startMatch <fixtureId> <overs> -> sets MATCH
  call POST "/v1/tournament/$TOURNAMENT_ID/fixtures/$1/start-match" "$(jq -nc --argjson o "$2" '{totalOvers:$o}')"
  expect "start match" 200
  MATCH="$(echo "$BODY" | jq -r '.data.matchId')"
}

startInnings() { # startInnings <striker> <nonStriker> <bowler>
  call POST "/v1/match/$MATCH/start-innings" \
      "$(jq -nc --arg s "$1" --arg n "$2" --arg b "$3" '{strikerName:$s, nonStrikerName:$n, bowlerName:$b}')"
  expect "start innings" 200
}

ball() { call POST "/v1/match/$MATCH/score-ball" "$(jq -nc --argjson r "$1" --arg k "$(uuid)" '{runs:$r, idempotencyKey:$k}')"; }

# playOut <firstInningsRunPerBall> <secondInningsRunPerBall>
playOut() {
  startInnings "S1-$STAMP" "S2-$STAMP" "B1-$STAMP"
  for i in 1 2 3 4 5 6; do ball "$1"; expect "score ball (innings 1)" 200; done
  startInnings "S3-$STAMP" "S4-$STAMP" "B2-$STAMP"
  for i in 1 2 3 4 5 6; do ball "$2"; expect "score ball (innings 2)" 200; done
}

echo
echo "== Alpha vs Charlie: Alpha wins big (30 vs 0) =="
startMatch "$(fixtureBetween "$ALPHA" "$CHARLIE")" 1
playOut 5 0

echo
echo "== Bravo vs Charlie: Bravo wins narrowly (6 vs 0) =="
startMatch "$(fixtureBetween "$BRAVO" "$CHARLIE")" 1
playOut 1 0

echo
echo "== Alpha vs Bravo: abandoned (counts as no-result, excluded from NRR) =="
startMatch "$(fixtureBetween "$ALPHA" "$BRAVO")" 20
call POST "/v1/match/$MATCH/abandon" ""
expect "abandon match" 200

echo
echo "== Fetching standings =="
call GET "/v1/tournament/$TOURNAMENT_ID/standings"
expect "get standings" 200 '.data.format' 'round_robin'

echo "$BODY" | jq '.data.standings'

ALPHA_POINTS="$(echo "$BODY" | jq -r --arg id "$ALPHA" '.data.standings[] | select(.teamId==$id) | .points')"
BRAVO_POINTS="$(echo "$BODY" | jq -r --arg id "$BRAVO" '.data.standings[] | select(.teamId==$id) | .points')"
ALPHA_NRR="$(echo "$BODY" | jq -r --arg id "$ALPHA" '.data.standings[] | select(.teamId==$id) | .nrr')"
BRAVO_NRR="$(echo "$BODY" | jq -r --arg id "$BRAVO" '.data.standings[] | select(.teamId==$id) | .nrr')"

[ "$ALPHA_POINTS" = "3" ] || fail "Alpha should have 3 points (2 for the win + 1 for the no-result), got $ALPHA_POINTS"
pass "Alpha has 3 points"
[ "$BRAVO_POINTS" = "3" ] || fail "Bravo should have 3 points (2 for the win + 1 for the no-result), got $BRAVO_POINTS"
pass "Bravo has 3 points"

python3 -c "import sys; sys.exit(0 if float('$ALPHA_NRR') > float('$BRAVO_NRR') else 1)" \
  || fail "Alpha's NRR ($ALPHA_NRR) should be higher than Bravo's ($BRAVO_NRR) — Alpha's win margin was bigger"
pass "Alpha's NRR ($ALPHA_NRR) beats Bravo's ($BRAVO_NRR) despite equal points — tiebreak confirmed"

ALPHA_ORDER="$(echo "$BODY" | jq -r --arg id "$ALPHA" '[.data.standings[].teamId] | index($id)')"
BRAVO_ORDER="$(echo "$BODY" | jq -r --arg id "$BRAVO" '[.data.standings[].teamId] | index($id)')"
[ "$ALPHA_ORDER" -lt "$BRAVO_ORDER" ] || fail "Alpha should rank above Bravo"
pass "Alpha ranks above Bravo in the table"

echo
echo "$PASSES checks passed."
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/verify-standings.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-standings.sh
git commit -m "test: add manual verify-standings.sh script"
```

Do not run this script yourself against the user's dev server — it's a
tool for them to run (`npm run dev` in one terminal, the script in
another). Hand it to them; do not start their backend to try it out.

---

### Task 8: Final verification

Per `superpowers:verification-before-completion` — run every check with
fresh evidence before declaring this done, and show the actual output.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Show the pass/fail summary. If any suite fails, investigate — this
environment has known parallel-worker contention against the shared Mongo
Atlas dev cluster (documented in prior sessions), so re-run any failing
file individually (`npm test tests/<file>.test.js`) before concluding
anything is a real regression.

- [ ] **Step 2: Locale parity**

Run: `npm test tests/locales.test.js`
Expected: PASS — confirms `STANDINGS_FETCHED`/`STANDINGS_NOT_APPLICABLE`
exist in all three of en/hi/mr.

- [ ] **Step 3: Route auth allowlist**

Run: `npm test tests/routes.auth.test.js`
Expected: PASS — the new route uses `verifyJwt` like every sibling route in
`tournament.routes.js`, so it needs no allowlist entry; this just confirms
that.

- [ ] **Step 4: Report**

Summarize to the user: test counts, confirmation that `docs/api.md` was
updated, confirmation that the manual verification script exists and how to
run it, and the branch name for the eventual PR (`feat-points-table-standings`).
