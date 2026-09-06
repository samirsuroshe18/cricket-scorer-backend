# Tournament Leaderboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GET /v1/tournament/:tournamentId/leaderboards` endpoint (batting + bowling, full ranked tables, every tournament format) and a matching Flutter screen, reusing Phase 2's career-stats aggregation logic rather than duplicating it.

**Architecture:** Backend: a pure `computeLeaderboards` function (mirrors `computeStandings`'s shape) fed by a `Match` → `PlayerMatchStats` join (mirrors `computeStandings`'s own `Match` → `Inning` join), reusing exported pure functions/consts from `src/utils/careerStats.js`. Frontend: the exact clean-architecture wiring the standings feature already established (endpoint constant → API service → repository → use case → lazily-loaded controller state → screen reusing the tag-registered `TournamentDetailController`).

**Tech Stack:** Node + Express 5 + Mongoose (backend), Flutter + GetX + json_serializable (frontend), Jest + supertest (backend tests), flutter_test (frontend tests).

**Spec:** `docs/superpowers/specs/2026-09-06-tournament-leaderboards-design.md` (this repo).

## Global Constraints

- No schema/migration changes — `Match.tournament` and `PlayerMatchStats.matchId` already exist; this plan is entirely new read-path code plus three export changes to existing, already-correct logic.
- No format gate on the new endpoint — every tournament format (including `knockout`) returns 200.
- No zero-value rows — a player absent from every `battingLine`/`bowlingLine` in the tournament is simply absent from that leaderboard, unlike standings' full-roster padding.
- No team field on a leaderboard row (confirmed out of scope in the design chat — `Player` has no stable team affiliation to attribute one from).
- Sort: batting by `runs` desc → `average` desc (`null` last) → `playerName` asc. Bowling by `wickets` desc → `runsConceded` asc → `playerName` asc. The final `playerName` step exists only for deterministic output on an exact tie, not as a real tiebreaker — same convention `computeStandings` already uses.
- `docs/api.md` gets updated in the same task as the controller/route (workspace CLAUDE.md's "Shared types & keeping them in sync" rule).
- This does not introduce a new cross-repo coupling category (see spec's "Docs and cross-repo coupling" section) — no edits to either repo's own `CLAUDE.md`.
- Backend locale keys need en/hi/mr parity or `tests/locales.test.js` fails the suite.
- Frontend: any new `TranslationKeys` entry needs the local `en`/`hi`/`mr` maps **and** a CMS bulk-upload (`POST /v1/translations/bulk-update`) before it's actually done — `Get.addTranslations` replaces a language's map wholesale on sync, so a key missing from the CMS renders as its raw key the moment translations sync. This bit the standings work live; do not skip it here.
- Don't bump the pinned codegen versions in `pubspec.yaml`; regenerate `.g.dart` files with `build_runner`, never hand-edit them.

---

### Task 1: Export reusable career-stats helpers

**Files:**
- Modify: `cricket-scorer-backend/src/utils/careerStats.js`
- Test: `cricket-scorer-backend/tests/careerStats.test.js` (existing — must stay green, no new test needed for this task; the new import in Task 2's test file is what proves these are now reachable)

**Interfaces:**
- Produces: `BATTING_SUM_FIELDS`, `BOWLING_SUM_FIELDS` (arrays of `[careerField, lineField]` pairs), `isBetterHighScore(candidate, current)`, `isBetterBowling(candidate, current)`, `num(v)` — all now exported from `src/utils/careerStats.js` for Task 2 to import.

This is a mechanical, behavior-preserving change: add the `export` keyword to five already-correct, already-tested private declarations. Nothing about `computeDelta`, `rescanHighScore`, `rescanBestBowling`, or `applyCareerStatsIncrement` changes.

- [ ] **Step 1: Add `export` to the five declarations**

In `src/utils/careerStats.js`, change:

```js
const BATTING_SUM_FIELDS = [
```
to:
```js
export const BATTING_SUM_FIELDS = [
```

Change:
```js
const BOWLING_SUM_FIELDS = [
```
to:
```js
export const BOWLING_SUM_FIELDS = [
```

Change:
```js
const num = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? 0));
```
to:
```js
export const num = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? 0));
```

Change:
```js
const isBetterHighScore = (candidate, current) =>
    !current || candidate.runs > current.runs;
```
to:
```js
export const isBetterHighScore = (candidate, current) =>
    !current || candidate.runs > current.runs;
```

Change:
```js
const isBetterBowling = (candidate, current) =>
    !current || candidate.wickets > current.wickets
        || (candidate.wickets === current.wickets && candidate.runs < current.runs);
```
to:
```js
export const isBetterBowling = (candidate, current) =>
    !current || candidate.wickets > current.wickets
        || (candidate.wickets === current.wickets && candidate.runs < current.runs);
```

- [ ] **Step 2: Run the existing career-stats suite to confirm nothing broke**

Run: `npm test -- tests/careerStats.test.js tests/careerStatsIntegration.test.js tests/careerStatsEndpoint.test.js`
Expected: all still pass (this is a pure export-visibility change, no logic touched).

- [ ] **Step 3: Commit**

```bash
git add src/utils/careerStats.js
git commit -m "refactor: export career-stats helpers for reuse by tournament leaderboards"
```

---

### Task 2: `computeLeaderboards` pure function

**Files:**
- Create: `cricket-scorer-backend/src/utils/computeLeaderboards.js`
- Test: `cricket-scorer-backend/tests/computeLeaderboards.test.js`

**Interfaces:**
- Consumes (from Task 1): `battingAverage`, `strikeRate`, `economy` (already exported), `BATTING_SUM_FIELDS`, `BOWLING_SUM_FIELDS`, `num`, `isBetterHighScore`, `isBetterBowling` — all from `../src/utils/careerStats.js`.
- Produces: `computeLeaderboards({ contributions })` where `contributions: Array<{ playerId: string, playerName: string, matchId: string, battingLine: {runs,balls,fours,sixes,isNotOut,wasFifty,wasHundred} | null, bowlingLine: {legalDeliveries,runs,wickets,maidens,wides,noBalls} | null }>`, returning `{ battingLeaderboard: BattingRow[], bowlingLeaderboard: BowlingRow[] }`. Task 3's controller builds `contributions` and calls this.

- [ ] **Step 1: Write the failing test file**

Create `tests/computeLeaderboards.test.js`:

```js
import { computeLeaderboards } from '../src/utils/computeLeaderboards.js';

const battingLine = (overrides = {}) => ({
    runs: 0, balls: 0, fours: 0, sixes: 0, isNotOut: false,
    wasFifty: false, wasHundred: false,
    ...overrides,
});

const bowlingLine = (overrides = {}) => ({
    legalDeliveries: 0, runs: 0, wickets: 0, maidens: 0, wides: 0, noBalls: 0,
    ...overrides,
});

describe('computeLeaderboards — empty input', () => {
    it('returns empty leaderboards for no contributions', () => {
        const result = computeLeaderboards({ contributions: [] });
        expect(result).toEqual({ battingLeaderboard: [], bowlingLeaderboard: [] });
    });
});

describe('computeLeaderboards — bat-only and bowl-only players are excluded from the other list', () => {
    it('a bowler-only contribution never appears in battingLeaderboard', () => {
        const contributions = [
            { playerId: 'p1', playerName: 'Vijay', matchId: 'm1', battingLine: null, bowlingLine: bowlingLine({ legalDeliveries: 24, runs: 30, wickets: 2 }) },
        ];
        const result = computeLeaderboards({ contributions });
        expect(result.battingLeaderboard).toEqual([]);
        expect(result.bowlingLeaderboard).toHaveLength(1);
        expect(result.bowlingLeaderboard[0].playerId).toBe('p1');
    });

    it('a batter-only contribution never appears in bowlingLeaderboard', () => {
        const contributions = [
            { playerId: 'p2', playerName: 'Rahul', matchId: 'm1', battingLine: battingLine({ runs: 40, balls: 30 }), bowlingLine: null },
        ];
        const result = computeLeaderboards({ contributions });
        expect(result.bowlingLeaderboard).toEqual([]);
        expect(result.battingLeaderboard).toHaveLength(1);
        expect(result.battingLeaderboard[0].playerId).toBe('p2');
    });
});

describe('computeLeaderboards — an all-rounder\'s single-match row contributes to both leaderboards', () => {
    it('reads battingLine and bowlingLine independently from the same contribution', () => {
        const contributions = [
            {
                playerId: 'p3', playerName: 'Imran', matchId: 'm1',
                battingLine: battingLine({ runs: 25, balls: 20 }),
                bowlingLine: bowlingLine({ legalDeliveries: 24, runs: 18, wickets: 3 }),
            },
        ];
        const result = computeLeaderboards({ contributions });
        expect(result.battingLeaderboard).toHaveLength(1);
        expect(result.battingLeaderboard[0].runs).toBe(25);
        expect(result.bowlingLeaderboard).toHaveLength(1);
        expect(result.bowlingLeaderboard[0].wickets).toBe(3);
    });
});

describe('computeLeaderboards — summation across multiple matches', () => {
    it('sums batting fields across two matches for the same player, recomputing average/strikeRate from the sums', () => {
        const contributions = [
            { playerId: 'p1', playerName: 'Rahul', matchId: 'm1', battingLine: battingLine({ runs: 40, balls: 30, fours: 4, sixes: 1, isNotOut: false }), bowlingLine: null },
            { playerId: 'p1', playerName: 'Rahul', matchId: 'm2', battingLine: battingLine({ runs: 60, balls: 40, fours: 6, sixes: 2, isNotOut: true, wasFifty: true }), bowlingLine: null },
        ];
        const result = computeLeaderboards({ contributions });
        const row = result.battingLeaderboard[0];
        expect(row.inningsBatted).toBe(2);
        expect(row.runs).toBe(100);
        expect(row.ballsFaced).toBe(70);
        expect(row.timesOut).toBe(1);
        expect(row.notOuts).toBe(1);
        expect(row.fours).toBe(10);
        expect(row.sixes).toBe(3);
        expect(row.fifties).toBe(1);
        expect(row.average).toBeCloseTo(100, 10); // runs / timesOut = 100 / 1
        expect(row.strikeRate).toBeCloseTo((100 / 70) * 100, 2); // 2dp, same rounding contract as career stats
    });

    it('sums bowling fields across two matches for the same player, recomputing economy from the sums', () => {
        const contributions = [
            { playerId: 'p1', playerName: 'Vijay', matchId: 'm1', battingLine: null, bowlingLine: bowlingLine({ legalDeliveries: 24, runs: 20, wickets: 1 }) },
            { playerId: 'p1', playerName: 'Vijay', matchId: 'm2', battingLine: null, bowlingLine: bowlingLine({ legalDeliveries: 18, runs: 16, wickets: 2 }) },
        ];
        const result = computeLeaderboards({ contributions });
        const row = result.bowlingLeaderboard[0];
        expect(row.inningsBowled).toBe(2);
        expect(row.legalDeliveries).toBe(42);
        expect(row.runsConceded).toBe(36);
        expect(row.wickets).toBe(3);
        expect(row.economy).toBeCloseTo(36 / (42 / 6), 2); // 2dp, same rounding contract as career stats
    });
});

describe('computeLeaderboards — average is null when the player has never been out', () => {
    it('reuses battingAverage\'s own null-when-never-dismissed rule', () => {
        const contributions = [
            { playerId: 'p1', playerName: 'Rahul', matchId: 'm1', battingLine: battingLine({ runs: 50, balls: 30, isNotOut: true }), bowlingLine: null },
        ];
        const result = computeLeaderboards({ contributions });
        expect(result.battingLeaderboard[0].average).toBeNull();
    });
});

describe('computeLeaderboards — highScore and bestBowling fold across matches', () => {
    it('highScore picks the biggest single-innings score and tags its matchId', () => {
        const contributions = [
            { playerId: 'p1', playerName: 'Rahul', matchId: 'm1', battingLine: battingLine({ runs: 30, balls: 20 }), bowlingLine: null },
            { playerId: 'p1', playerName: 'Rahul', matchId: 'm2', battingLine: battingLine({ runs: 75, balls: 50, isNotOut: true }), bowlingLine: null },
            { playerId: 'p1', playerName: 'Rahul', matchId: 'm3', battingLine: battingLine({ runs: 40, balls: 30 }), bowlingLine: null },
        ];
        const result = computeLeaderboards({ contributions });
        expect(result.battingLeaderboard[0].highScore).toEqual({ runs: 75, isNotOut: true, matchId: 'm2' });
    });

    it('bestBowling uses the wickets-then-fewer-runs tiebreak, same as career stats', () => {
        const contributions = [
            { playerId: 'p1', playerName: 'Vijay', matchId: 'm1', battingLine: null, bowlingLine: bowlingLine({ legalDeliveries: 24, runs: 30, wickets: 3 }) },
            { playerId: 'p1', playerName: 'Vijay', matchId: 'm2', battingLine: null, bowlingLine: bowlingLine({ legalDeliveries: 24, runs: 18, wickets: 3 }) },
        ];
        const result = computeLeaderboards({ contributions });
        // Same wickets (3) in both matches — m2's fewer runs conceded (18 < 30) wins.
        expect(result.bowlingLeaderboard[0].bestBowling).toEqual({ wickets: 3, runs: 18, matchId: 'm2' });
    });
});

describe('computeLeaderboards — sort order', () => {
    it('sorts battingLeaderboard by runs desc, then average desc (nulls last), then name asc', () => {
        const contributions = [
            { playerId: 'p1', playerName: 'Zara', matchId: 'm1', battingLine: battingLine({ runs: 50, balls: 40, isNotOut: true }), bowlingLine: null }, // average null
            { playerId: 'p2', playerName: 'Amit', matchId: 'm1', battingLine: battingLine({ runs: 50, balls: 40, isNotOut: false }), bowlingLine: null }, // average 50
            { playerId: 'p3', playerName: 'Rahul', matchId: 'm1', battingLine: battingLine({ runs: 80, balls: 40, isNotOut: false }), bowlingLine: null },
        ];
        const result = computeLeaderboards({ contributions });
        expect(result.battingLeaderboard.map((r) => r.playerId)).toEqual(['p3', 'p2', 'p1']);
    });

    it('sorts bowlingLeaderboard by wickets desc, then runsConceded asc, then name asc', () => {
        const contributions = [
            { playerId: 'p1', playerName: 'Zara', matchId: 'm1', battingLine: null, bowlingLine: bowlingLine({ legalDeliveries: 24, runs: 20, wickets: 2 }) },
            { playerId: 'p2', playerName: 'Amit', matchId: 'm1', battingLine: null, bowlingLine: bowlingLine({ legalDeliveries: 24, runs: 15, wickets: 2 }) },
            { playerId: 'p3', playerName: 'Rahul', matchId: 'm1', battingLine: null, bowlingLine: bowlingLine({ legalDeliveries: 24, runs: 40, wickets: 4 }) },
        ];
        const result = computeLeaderboards({ contributions });
        expect(result.bowlingLeaderboard.map((r) => r.playerId)).toEqual(['p3', 'p2', 'p1']);
    });

    it('falls back to alphabetical name when every sort key is exactly tied', () => {
        const contributions = [
            { playerId: 'p1', playerName: 'Zara', matchId: 'm1', battingLine: battingLine({ runs: 30, balls: 20, isNotOut: true }), bowlingLine: null },
            { playerId: 'p2', playerName: 'Amit', matchId: 'm1', battingLine: battingLine({ runs: 30, balls: 20, isNotOut: true }), bowlingLine: null },
        ];
        const result = computeLeaderboards({ contributions });
        expect(result.battingLeaderboard.map((r) => r.playerName)).toEqual(['Amit', 'Zara']);
    });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npm test -- tests/computeLeaderboards.test.js`
Expected: FAIL with `Cannot find module '../src/utils/computeLeaderboards.js'`.

- [ ] **Step 3: Write `src/utils/computeLeaderboards.js`**

```js
import {
    battingAverage, strikeRate, economy,
    BATTING_SUM_FIELDS, BOWLING_SUM_FIELDS, num,
    isBetterHighScore, isBetterBowling,
} from './careerStats.js';

const newBattingRow = (playerId, playerName) => ({
    playerId, playerName,
    inningsBatted: 0, timesOut: 0, notOuts: 0,
    runs: 0, ballsFaced: 0, fours: 0, sixes: 0, fifties: 0, hundreds: 0,
    highScore: null,
});

const newBowlingRow = (playerId, playerName) => ({
    playerId, playerName,
    inningsBowled: 0, legalDeliveries: 0, runsConceded: 0, wickets: 0, maidens: 0,
    bestBowling: null,
});

/**
 * One tournament's batting + bowling leaderboards, computed fresh from
 * every `PlayerMatchStats` row its completed matches produced — one entry
 * per (player, match), same granularity `applyCareerStatsIncrement` writes.
 * Pure — no model, no I/O. See docs/superpowers/specs/2026-09-06-tournament-
 * leaderboards-design.md for the full contract.
 */
export const computeLeaderboards = ({ contributions }) => {
    const batting = new Map();
    const bowling = new Map();

    for (const c of contributions) {
        if (c.battingLine) {
            const row = batting.get(c.playerId) ?? newBattingRow(c.playerId, c.playerName);
            row.inningsBatted += 1;
            if (c.battingLine.isNotOut) row.notOuts += 1; else row.timesOut += 1;
            for (const [careerField, lineField] of BATTING_SUM_FIELDS) {
                row[careerField] += num(c.battingLine[lineField]);
            }
            if (isBetterHighScore(c.battingLine, row.highScore)) {
                row.highScore = { runs: c.battingLine.runs, isNotOut: c.battingLine.isNotOut, matchId: c.matchId };
            }
            batting.set(c.playerId, row);
        }
        if (c.bowlingLine) {
            const row = bowling.get(c.playerId) ?? newBowlingRow(c.playerId, c.playerName);
            row.inningsBowled += 1;
            for (const [careerField, lineField] of BOWLING_SUM_FIELDS) {
                row[careerField] += num(c.bowlingLine[lineField]);
            }
            if (isBetterBowling(c.bowlingLine, row.bestBowling)) {
                row.bestBowling = { wickets: c.bowlingLine.wickets, runs: c.bowlingLine.runs, matchId: c.matchId };
            }
            bowling.set(c.playerId, row);
        }
    }

    const battingLeaderboard = [...batting.values()].map((r) => ({
        playerId: r.playerId, playerName: r.playerName,
        inningsBatted: r.inningsBatted, runs: r.runs, ballsFaced: r.ballsFaced,
        timesOut: r.timesOut, notOuts: r.notOuts,
        average: battingAverage(r.runs, r.timesOut),
        strikeRate: strikeRate(r.runs, r.ballsFaced),
        fours: r.fours, sixes: r.sixes, fifties: r.fifties, hundreds: r.hundreds,
        highScore: r.highScore,
    }));
    battingLeaderboard.sort((a, b) =>
        b.runs - a.runs
        || (b.average ?? -Infinity) - (a.average ?? -Infinity)
        || a.playerName.localeCompare(b.playerName));

    const bowlingLeaderboard = [...bowling.values()].map((r) => ({
        playerId: r.playerId, playerName: r.playerName,
        inningsBowled: r.inningsBowled, legalDeliveries: r.legalDeliveries,
        runsConceded: r.runsConceded, wickets: r.wickets, maidens: r.maidens,
        economy: economy(r.runsConceded, r.legalDeliveries),
        bestBowling: r.bestBowling,
    }));
    bowlingLeaderboard.sort((a, b) =>
        b.wickets - a.wickets
        || a.runsConceded - b.runsConceded
        || a.playerName.localeCompare(b.playerName));

    return { battingLeaderboard, bowlingLeaderboard };
};
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npm test -- tests/computeLeaderboards.test.js`
Expected: PASS, all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/computeLeaderboards.js tests/computeLeaderboards.test.js
git commit -m "feat: add computeLeaderboards pure function for tournament leaderboards"
```

---

### Task 3: `GET /v1/tournament/:tournamentId/leaderboards` endpoint

**Files:**
- Create: `cricket-scorer-backend/src/controllers/leaderboard.controller.js`
- Modify: `cricket-scorer-backend/src/routes/tournament.routes.js`
- Modify: `cricket-scorer-backend/src/locales/en/common.json`, `hi/common.json`, `mr/common.json`
- Modify: `cricket-scorer-workspace/docs/api.md` (workspace root, not part of this repo's git — no commit needed for this file)
- Test: `cricket-scorer-backend/tests/leaderboard.test.js`

**Interfaces:**
- Consumes (from Task 2): `computeLeaderboards({ contributions })`.
- Consumes (existing): `findAccessibleTournament(tournamentId, userId)` from `./tournament.controller.js`; `Match`, `PlayerMatchStats`, `Player` models.
- Produces: `getLeaderboards` controller, exported and routed.

- [ ] **Step 1: Write the failing integration test file**

Create `tests/leaderboard.test.js`:

```js
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

const getLeaderboards = (token, tournamentId) =>
    request(app).get(`/api/v1/tournament/${tournamentId}/leaderboards`).set('Authorization', `Bearer ${token}`).send();

// Plays one full innings (6 balls, no wickets) with named players, then
// leaves the match wherever that puts it — caller decides whether to start
// a second innings or abandon. Distinct from standings.test.js's own helper,
// which uses per-match-unique names: this one takes explicit names so the
// same Player resolves across multiple matches, which is exactly what the
// multi-match summation tests below need to prove.
const playInnings = async (app, token, matchId, { striker, nonStriker, bowler, runsPerBall }) => {
    await startLiveInnings(app, token, matchId, {
        strikerName: striker, nonStrikerName: nonStriker, bowlerName: bowler,
    });
    for (let i = 0; i < 6; i += 1) {
        const res = await scoreDotBall(app, token, matchId, { runs: runsPerBall });
        expect(res.status).toBe(200);
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

const fixtureBetween = (fixtures, a, b) =>
    fixtures.find((f) => f.teamB && [f.teamA.name, f.teamB.name].includes(a) && [f.teamA.name, f.teamB.name].includes(b));

describe('GET /v1/tournament/:tournamentId/leaderboards', () => {
    it('401s with no token', async () => {
        const { tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo']);
        const res = await request(app).get(`/api/v1/tournament/${tournamentId}/leaderboards`).send();
        expect(res.status).toBe(401);
    });

    it('404s for a tournament that does not exist', async () => {
        const { token } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo']);
        const res = await getLeaderboards(token, '665f1a2b3c4d5e6f7a8b9c99');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
    });

    it('returns empty leaderboards before any match is played', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo']);
        const res = await getLeaderboards(token, tournamentId);
        expect(res.status).toBe(200);
        expect(res.body.data.battingLeaderboard).toEqual([]);
        expect(res.body.data.bowlingLeaderboard).toEqual([]);
    });

    it('is allowed for a knockout tournament, unlike standings', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', ['Alpha', 'Bravo']);
        const res = await getLeaderboards(token, tournamentId);
        expect(res.status).toBe(200);
        expect(res.body.data.battingLeaderboard).toEqual([]);
    });

    it('aggregates a player\'s batting and a bowler\'s figures across two completed matches, excluding an abandoned third', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo', 'Charlie']);
        await generateFixtures(token, tournamentId);
        const fixtures = (await listFixtures(token, tournamentId)).body.data.fixtures;

        // Match 1 (completed): Alpha vs Charlie. Rahul opens for Alpha,
        // Vijay bowls for Charlie.
        const started1 = await startFixtureMatch(token, tournamentId, fixtureBetween(fixtures, 'Alpha', 'Charlie').id, { totalOvers: 1 });
        const match1 = started1.body.data.matchId;
        await playInnings(app, token, match1, { striker: 'Rahul', nonStriker: 'Kiran', bowler: 'Vijay', runsPerBall: 2 }); // Rahul: 12 off 6
        await playInnings(app, token, match1, { striker: 'Suresh', nonStriker: 'Naveen', bowler: 'Rahul', runsPerBall: 0 });

        // Match 2 (completed): Bravo vs Charlie. Vijay bowls for Charlie again.
        const started2 = await startFixtureMatch(token, tournamentId, fixtureBetween(fixtures, 'Bravo', 'Charlie').id, { totalOvers: 1 });
        const match2 = started2.body.data.matchId;
        await playInnings(app, token, match2, { striker: 'Manoj', nonStriker: 'Deepak', bowler: 'Vijay', runsPerBall: 1 }); // Vijay concedes 6 more
        await playInnings(app, token, match2, { striker: 'Suresh', nonStriker: 'Naveen', bowler: 'Manoj', runsPerBall: 0 });

        // Match 3 (abandoned mid-innings): Alpha vs Bravo. Rahul opens again
        // and faces 2 balls (8 runs) before the match is abandoned — this
        // must NOT add to Rahul's leaderboard total, proving
        // PlayerMatchStats is never written for an abandoned match even
        // when real deliveries were bowled.
        const started3 = await startFixtureMatch(token, tournamentId, fixtureBetween(fixtures, 'Alpha', 'Bravo').id, { totalOvers: 20 });
        const match3 = started3.body.data.matchId;
        await startLiveInnings(app, token, match3, { strikerName: 'Rahul', nonStrikerName: 'Kiran', bowlerName: 'Manoj' });
        for (let i = 0; i < 2; i += 1) {
            const res = await scoreDotBall(app, token, match3, { runs: 4 });
            expect(res.status).toBe(200);
        }
        const abandonRes = await abandonMatch(token, match3);
        expect(abandonRes.status).toBe(200);

        const res = await getLeaderboards(token, tournamentId);
        expect(res.status).toBe(200);

        const rahul = res.body.data.battingLeaderboard.find((r) => r.playerName === 'Rahul');
        expect(rahul.inningsBatted).toBe(1); // only match1's innings, not match3's abandoned one
        expect(rahul.runs).toBe(12);
        expect(rahul.ballsFaced).toBe(6);

        const vijay = res.body.data.bowlingLeaderboard.find((r) => r.playerName === 'Vijay');
        expect(vijay.inningsBowled).toBe(2); // match1 + match2
        expect(vijay.legalDeliveries).toBe(12);
        expect(vijay.runsConceded).toBe(18); // 12 (match1) + 6 (match2)
    });
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `npm test -- tests/leaderboard.test.js`
Expected: FAIL — the route doesn't exist yet, every request 404s at the Express level (no matching route) rather than returning the JSON shapes asserted.

- [ ] **Step 3: Write `src/controllers/leaderboard.controller.js`**

```js
import catchAsync from '../utils/catchAsync.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Match } from '../models/match.model.js';
import { PlayerMatchStats } from '../models/playerMatchStats.model.js';
import { Player } from '../models/player.model.js';
import { findAccessibleTournament } from './tournament.controller.js';
import { computeLeaderboards } from '../utils/computeLeaderboards.js';

// No format gate, unlike getStandings — a leaderboard is player-level, not
// team-points-level, so it's meaningful for a knockout tournament too.
export const getLeaderboards = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);

    const matches = await Match.find(
        { tournament: tournament._id, isDeleted: false, status: 'completed' },
        '_id',
    );
    const matchIds = matches.map((m) => m._id);

    const rows = await PlayerMatchStats.find(
        { matchId: { $in: matchIds } },
        'playerId matchId battingLine bowlingLine',
    );

    const playerIds = [...new Set(rows.map((r) => String(r.playerId)))];
    const players = await Player.find(
        { _id: { $in: playerIds }, isDeleted: false },
        'name',
    );
    const nameById = new Map(players.map((p) => [String(p._id), p.name]));

    const contributions = rows.map((r) => ({
        playerId: String(r.playerId),
        playerName: nameById.get(String(r.playerId)) ?? 'Unknown player',
        matchId: String(r.matchId),
        battingLine: r.battingLine,
        bowlingLine: r.bowlingLine,
    }));

    const { battingLeaderboard, bowlingLeaderboard } = computeLeaderboards({ contributions });

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        battingLeaderboard,
        bowlingLeaderboard,
    }, req.t("LEADERBOARDS_FETCHED")));
});
```

- [ ] **Step 4: Wire the route**

In `src/routes/tournament.routes.js`, add the import alongside the existing `standings.controller.js` one:

```js
import { getStandings } from "../controllers/standings.controller.js";
import { getLeaderboards } from "../controllers/leaderboard.controller.js";
```

And add the route after the standings route:

```js
router.route('/:tournamentId/standings').get(verifyJwt, getStandings);
router.route('/:tournamentId/leaderboards').get(verifyJwt, getLeaderboards);
```

- [ ] **Step 5: Add the locale key to all three files**

In `src/locales/en/common.json`, immediately after the `"STANDINGS_FETCHED": "Standings fetched",` line, add:

```json
  "LEADERBOARDS_FETCHED": "Leaderboards fetched",
```

In `src/locales/hi/common.json`, in the same position:

```json
  "LEADERBOARDS_FETCHED": "लीडरबोर्ड प्राप्त किए गए",
```

In `src/locales/mr/common.json`, in the same position:

```json
  "LEADERBOARDS_FETCHED": "लीडरबोर्ड मिळाले",
```

- [ ] **Step 6: Run the test file to verify it passes**

Run: `npm test -- tests/leaderboard.test.js`
Expected: PASS, all 5 tests green.

- [ ] **Step 7: Run the full backend suite**

Run: `npm test`
Expected: every suite passes, including `tests/locales.test.js` (en/hi/mr parity) and `tests/routes.auth.test.js` (the new route already carries `verifyJwt`, so its allowlist doesn't need touching).

- [ ] **Step 8: Update `docs/api.md`**

In `cricket-scorer-workspace/docs/api.md` (the workspace-root file, not part of this repo's git history), insert a new section immediately after the existing `### GET /v1/tournament/:tournamentId/standings` section (before `### What this pass does NOT cover`):

```markdown
### GET /v1/tournament/:tournamentId/leaderboards

Any org member. Every tournament format, including `knockout` — unlike
standings, a leaderboard is player-level, not team-points-level, so a
bracket format is just as meaningful here. Recomputed fresh from
`PlayerMatchStats` rows belonging to the tournament's `completed` matches
on every call; nothing is persisted. `PlayerMatchStats` is only ever
written on genuine match completion (never on abandon — see
`applyCareerStatsIncrement`'s own contract), so an abandoned match's
players contribute nothing here without any separate exclusion logic.

Both lists are full ranked tables, not single "leader" values, and there's
no fixed roster to pad to zero — a player who never batted (or never
bowled) simply doesn't appear in that list. Batting sort: runs desc, then
average desc (a player never dismissed sorts last on this key, not first),
then player name asc. Bowling sort: wickets desc, then runs conceded asc,
then player name asc. The final name-asc step in both exists only to make
output order deterministic on an exact tie, not as a real tiebreaker —
same convention standings uses for team name.

Every batting/bowling field mirrors `GET /v1/player/:playerId/career-stats`
exactly (same field names, same average/strikeRate/economy formulas),
scoped to just this tournament's matches instead of a player's whole
career.

### Response `200`
```json
{
  "statusCode": 200,
  "data": {
    "tournamentId": "665f1a2b3c4d5e6f7a8b9c01",
    "battingLeaderboard": [
      {
        "playerId": "665f…10", "playerName": "Rahul",
        "inningsBatted": 3, "runs": 145, "ballsFaced": 98,
        "timesOut": 2, "notOuts": 1,
        "average": 72.5, "strikeRate": 147.96,
        "fours": 12, "sixes": 8, "fifties": 1, "hundreds": 0,
        "highScore": { "runs": 82, "isNotOut": true, "matchId": "665f…20" }
      }
    ],
    "bowlingLeaderboard": [
      {
        "playerId": "665f…11", "playerName": "Vijay",
        "inningsBowled": 3, "legalDeliveries": 72, "runsConceded": 88,
        "wickets": 7, "maidens": 1, "economy": 7.33,
        "bestBowling": { "wickets": 3, "runs": 21, "matchId": "665f…21" }
      }
    ]
  },
  "message": "Leaderboards fetched",
  "success": true
}
```

#### Errors
| statusCode | code | when |
|---|---|---|
| 404 | `TOURNAMENT_NOT_FOUND` | `tournamentId` doesn't exist or is soft-deleted |
| 403 | `NOT_ORG_MEMBER` | caller isn't a member of the owning organization |
| 401 | `UNAUTHORIZED_REQUEST` / `ACCESS_TOKEN_EXPIRED` / `INVALID_ACCESS_TOKEN` | via `verifyJwt` |
```

Then add a bullet to the "## Locale keys" section, immediately after the existing "Added by the standings contract" paragraph:

```markdown
Added by the leaderboards contract: `LEADERBOARDS_FETCHED`.
`TOURNAMENT_NOT_FOUND` and `NOT_ORG_MEMBER` are reused, unchanged.
```

And append a bullet to the "### What this pass does NOT cover" list under the leaderboards section (mirroring standings' own "not covered" bullet style) — actually leave that list where it is (it describes the standings pass specifically); instead add one line to the leaderboards section's own prose noting scope, which is already covered above ("no team field", "no configurable thresholds") via the design spec reference:

```markdown
See `docs/superpowers/specs/2026-09-06-tournament-leaderboards-design.md`
in `cricket-scorer-backend` for what was deliberately left out (per-row
team attribution, minimum-innings qualification thresholds, pagination).
```

- [ ] **Step 9: Commit**

```bash
git add src/controllers/leaderboard.controller.js src/routes/tournament.routes.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json tests/leaderboard.test.js
git commit -m "feat: add GET /v1/tournament/:tournamentId/leaderboards endpoint"
```

(The `docs/api.md` edit lives in the workspace root, which isn't a git repo — nothing to commit there.)

---

### Task 4: Manual verification script

**Files:**
- Create: `cricket-scorer-backend/scripts/verify-leaderboards.sh` (executable)

**Interfaces:** none — this is a standalone curl+jq script, no code imports.

- [ ] **Step 1: Write the script**

Create `scripts/verify-leaderboards.sh`:

```bash
#!/usr/bin/env bash
#
# End-to-end check for tournament leaderboards (docs/api.md ->
# "GET /v1/tournament/:tournamentId/leaderboards").
#
# Creates an organization, a round_robin tournament, and 3 teams; generates
# fixtures; plays two matches so one player's batting and another's bowling
# accumulate across both; abandons a third match mid-innings to prove that
# contribution is excluded. Prints both leaderboards for a human to eyeball,
# plus the specific assertions that make the multi-match summation and the
# abandoned-match exclusion visible rather than just "it returned 200".
#
#   npm run dev                     # in another terminal, Mongo must be a replica set
#   TOKEN=<accessToken> ./scripts/verify-leaderboards.sh
#
# or let it log in for you:
#   EMAIL=you@example.com PASSWORD=secret ./scripts/verify-leaderboards.sh
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

call POST /v1/organization "$(jq -nc --arg n "Leaderboards Verify $STAMP" '{name:$n}')"
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
    '.data.fixtures[] | select(.teamB != null) | select((.teamA.id==$a and .teamB.id==$b) or (.teamA.id==$b and .teamB.id==$a)) | .id'
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

# playInnings <striker> <nonStriker> <bowler> <runsPerBall>
playInnings() {
  startInnings "$1" "$2" "$3"
  for i in 1 2 3 4 5 6; do ball "$4"; expect "score ball" 200; done
}

echo
echo "== Match 1: Alpha vs Charlie (completed) — Rahul bats, Vijay bowls =="
startMatch "$(fixtureBetween "$ALPHA" "$CHARLIE")" 1
playInnings "Rahul" "Kiran" "Vijay" 2
playInnings "Suresh" "Naveen" "Rahul" 0

echo
echo "== Match 2: Bravo vs Charlie (completed) — Vijay bowls again =="
startMatch "$(fixtureBetween "$BRAVO" "$CHARLIE")" 1
playInnings "Manoj" "Deepak" "Vijay" 1
playInnings "Suresh" "Naveen" "Manoj" 0

echo
echo "== Match 3: Alpha vs Bravo — Rahul bats 2 balls, then abandoned =="
startMatch "$(fixtureBetween "$ALPHA" "$BRAVO")" 20
startInnings "Rahul" "Kiran" "Manoj"
ball 4; expect "score ball" 200
ball 4; expect "score ball" 200
call POST "/v1/match/$MATCH/abandon" ""
expect "abandon match" 200

echo
echo "== Fetching leaderboards =="
call GET "/v1/tournament/$TOURNAMENT_ID/leaderboards"
expect "get leaderboards" 200

echo "Batting:"; echo "$BODY" | jq '.data.battingLeaderboard'
echo "Bowling:"; echo "$BODY" | jq '.data.bowlingLeaderboard'

RAHUL_RUNS="$(echo "$BODY" | jq -r '.data.battingLeaderboard[] | select(.playerName=="Rahul") | .runs')"
RAHUL_INNINGS="$(echo "$BODY" | jq -r '.data.battingLeaderboard[] | select(.playerName=="Rahul") | .inningsBatted')"
[ "$RAHUL_RUNS" = "12" ] || fail "Rahul should have 12 runs (only match 1 — the abandoned match's 8 runs must not count), got $RAHUL_RUNS"
pass "Rahul has 12 runs — the abandoned match's runs were correctly excluded"
[ "$RAHUL_INNINGS" = "1" ] || fail "Rahul should show 1 innings batted, got $RAHUL_INNINGS"
pass "Rahul shows 1 innings batted"

VIJAY_DELIVERIES="$(echo "$BODY" | jq -r '.data.bowlingLeaderboard[] | select(.playerName=="Vijay") | .legalDeliveries')"
VIJAY_RUNS="$(echo "$BODY" | jq -r '.data.bowlingLeaderboard[] | select(.playerName=="Vijay") | .runsConceded')"
[ "$VIJAY_DELIVERIES" = "12" ] || fail "Vijay should show 12 legal deliveries (6 per match, 2 matches), got $VIJAY_DELIVERIES"
pass "Vijay shows 12 legal deliveries across both matches"
[ "$VIJAY_RUNS" = "18" ] || fail "Vijay should have conceded 18 runs (12 + 6), got $VIJAY_RUNS"
pass "Vijay's runs conceded sum correctly across both matches (18)"

echo
echo "$PASSES checks passed."
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x scripts/verify-leaderboards.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-leaderboards.sh
git commit -m "test: add manual verification script for tournament leaderboards"
```

---

### Task 5: Frontend response models

**Files:**
- Create: `cricket-scrorer/lib/features/tournament/data/models/response/leaderboard_row_res.dart` (+ generated `leaderboard_row_res.g.dart`)

**Interfaces:**
- Consumes: `HighScore`, `BestBowling` from `package:cricket_scorer/features/scoring/data/models/response/career_stats_res.dart` (reused, not redefined).
- Produces: `BattingLeaderboardRowRes`, `BowlingLeaderboardRowRes`, `TournamentLeaderboardsRes` — consumed by Task 6's repository/use case and Task 8's screen.

- [ ] **Step 1: Write the model file**

Create `lib/features/tournament/data/models/response/leaderboard_row_res.dart`:

```dart
import 'package:cricket_scorer/features/scoring/data/models/response/career_stats_res.dart';
import 'package:json_annotation/json_annotation.dart';

part 'leaderboard_row_res.g.dart';

/// One row of `GET /v1/tournament/:tournamentId/leaderboards`'
/// `battingLeaderboard` array — see `docs/api.md`. Field names and formulas
/// mirror `BattingCareerStats` exactly (same server-side pure functions),
/// scoped to one tournament's matches instead of a whole career. Already
/// sorted by the backend (runs desc, then average desc, then player name
/// asc), so this model carries no sort logic of its own.
@JsonSerializable(explicitToJson: true)
class BattingLeaderboardRowRes {
  final String playerId;
  final String playerName;
  final int inningsBatted;
  final int runs;
  final int ballsFaced;
  final int timesOut;
  final int notOuts;

  /// Null, not 0 — the divisor is [timesOut], and a player never dismissed
  /// has no average yet, same distinction `BattingCareerStats.average` draws.
  final double? average;
  final double strikeRate;
  final int fours;
  final int sixes;
  final int fifties;
  final int hundreds;
  final HighScore? highScore;

  BattingLeaderboardRowRes({
    required this.playerId,
    required this.playerName,
    required this.inningsBatted,
    required this.runs,
    required this.ballsFaced,
    required this.timesOut,
    required this.notOuts,
    required this.average,
    required this.strikeRate,
    required this.fours,
    required this.sixes,
    required this.fifties,
    required this.hundreds,
    required this.highScore,
  });

  factory BattingLeaderboardRowRes.fromJson(Map<String, dynamic> json) =>
      _$BattingLeaderboardRowResFromJson(json);

  Map<String, dynamic> toJson() => _$BattingLeaderboardRowResToJson(this);
}

/// One row of the same response's `bowlingLeaderboard` array. Mirrors
/// `BowlingCareerStats` exactly, scoped to one tournament.
@JsonSerializable(explicitToJson: true)
class BowlingLeaderboardRowRes {
  final String playerId;
  final String playerName;
  final int inningsBowled;
  final int legalDeliveries;
  final int runsConceded;
  final int wickets;
  final int maidens;
  final double economy;
  final BestBowling? bestBowling;

  BowlingLeaderboardRowRes({
    required this.playerId,
    required this.playerName,
    required this.inningsBowled,
    required this.legalDeliveries,
    required this.runsConceded,
    required this.wickets,
    required this.maidens,
    required this.economy,
    required this.bestBowling,
  });

  factory BowlingLeaderboardRowRes.fromJson(Map<String, dynamic> json) =>
      _$BowlingLeaderboardRowResFromJson(json);

  Map<String, dynamic> toJson() => _$BowlingLeaderboardRowResToJson(this);
}

/// `GET /v1/tournament/:tournamentId/leaderboards`'s full response `data`.
/// Both lists are already sorted server-side and may be empty (a tournament
/// with no completed matches, or a player who never bowled) — that's not an
/// error state, just an empty list.
@JsonSerializable(explicitToJson: true)
class TournamentLeaderboardsRes {
  final String tournamentId;
  final List<BattingLeaderboardRowRes> battingLeaderboard;
  final List<BowlingLeaderboardRowRes> bowlingLeaderboard;

  TournamentLeaderboardsRes({
    required this.tournamentId,
    required this.battingLeaderboard,
    required this.bowlingLeaderboard,
  });

  factory TournamentLeaderboardsRes.fromJson(Map<String, dynamic> json) =>
      _$TournamentLeaderboardsResFromJson(json);

  Map<String, dynamic> toJson() => _$TournamentLeaderboardsResToJson(this);
}
```

- [ ] **Step 2: Generate the `.g.dart` file**

Run: `dart run build_runner build --delete-conflicting-outputs`
Expected: `lib/features/tournament/data/models/response/leaderboard_row_res.g.dart` is created with no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/features/tournament/data/models/response/leaderboard_row_res.dart lib/features/tournament/data/models/response/leaderboard_row_res.g.dart
git commit -m "feat: add tournament leaderboard response models"
```

---

### Task 6: Endpoint, API service, repository, use case, DI

**Files:**
- Modify: `cricket-scrorer/lib/features/tournament/data/tournament_endpoint.dart`
- Modify: `cricket-scrorer/lib/features/tournament/data/data_sources/remote/tournament_api_service.dart`
- Modify: `cricket-scrorer/lib/features/tournament/domain/repositories/tournament_repository.dart`
- Modify: `cricket-scrorer/lib/features/tournament/data/repositories/tournament_repository_impl.dart`
- Create: `cricket-scrorer/lib/features/tournament/domain/usecases/get_leaderboards.dart`
- Modify: `cricket-scrorer/lib/core/di/injection/tournament_injection.dart`

**Interfaces:**
- Consumes (from Task 5): `TournamentLeaderboardsRes`.
- Produces: `GetLeaderboardsUseCase`, `GetLeaderboardsParams` — consumed by Task 7's controller.

No test file for this task — it's pure wiring with no branching logic of its own (identical shape to the already-tested `getStandings` wiring); it's exercised end-to-end by Task 7's controller tests and Task 8's widget tests.

- [ ] **Step 1: Add the endpoint**

In `lib/features/tournament/data/tournament_endpoint.dart`, add after `standings`:

```dart
  String leaderboards(String tournamentId) =>
      '/v1/tournament/$tournamentId/leaderboards';
```

- [ ] **Step 2: Add the API service method**

In `lib/features/tournament/data/data_sources/remote/tournament_api_service.dart`, add after `getStandings`:

```dart
  Future<Either<ApiResponseModel, CricketFailure>> getLeaderboards({
    required String tournamentId,
  }) async {
    return await apiClient.get(
      endpoint: tournamentEndpoint.leaderboards(tournamentId),
    );
  }
```

- [ ] **Step 3: Add the repository interface method**

In `lib/features/tournament/domain/repositories/tournament_repository.dart`, add the import:

```dart
import 'package:cricket_scorer/features/tournament/data/models/response/leaderboard_row_res.dart';
```

And add after `getStandings`'s declaration:

```dart
  /// `GET /v1/tournament/:tournamentId/leaderboards` — any org member, every
  /// tournament format.
  Future<Either<CricketResponse<TournamentLeaderboardsRes>, CricketFailure>>
  getLeaderboards({required String tournamentId});
```

- [ ] **Step 4: Implement it in the repository**

In `lib/features/tournament/data/repositories/tournament_repository_impl.dart`, add the import:

```dart
import 'package:cricket_scorer/features/tournament/data/models/response/leaderboard_row_res.dart';
```

And add after `getStandings`'s implementation:

```dart
  @override
  Future<Either<CricketResponse<TournamentLeaderboardsRes>, CricketFailure>>
  getLeaderboards({required String tournamentId}) async {
    final response = await tournamentApiService.getLeaderboards(
      tournamentId: tournamentId,
    );
    if (response.isResult) {
      return Either.result(
        CricketResponse(
          data: TournamentLeaderboardsRes.fromJson(
            response.result.data as Map<String, dynamic>,
          ),
          message: response.result.message,
        ),
      );
    }
    return Either.fallback(response.fallback);
  }
```

- [ ] **Step 5: Write the use case**

Create `lib/features/tournament/domain/usecases/get_leaderboards.dart`:

```dart
import 'package:cricket_scorer/core/error/cricket_failure.dart';
import 'package:cricket_scorer/core/network/models/cricket_response.dart';
import 'package:cricket_scorer/core/usecase/usecase.dart';
import 'package:cricket_scorer/core/utils/either_util.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/leaderboard_row_res.dart';
import 'package:cricket_scorer/features/tournament/domain/repositories/tournament_repository.dart';

class GetLeaderboardsParams {
  final String tournamentId;

  GetLeaderboardsParams({required this.tournamentId});
}

class GetLeaderboardsUseCase
    implements
        UseCase<Either<CricketResponse<TournamentLeaderboardsRes>, CricketFailure>,
            GetLeaderboardsParams> {
  final TournamentRepository tournamentRepository;

  GetLeaderboardsUseCase({required this.tournamentRepository});

  @override
  Future<Either<CricketResponse<TournamentLeaderboardsRes>, CricketFailure>> call({
    GetLeaderboardsParams? params,
  }) {
    return tournamentRepository.getLeaderboards(tournamentId: params!.tournamentId);
  }
}
```

- [ ] **Step 6: Register it in DI**

In `lib/core/di/injection/tournament_injection.dart`, add the import:

```dart
import 'package:cricket_scorer/features/tournament/domain/usecases/get_leaderboards.dart';
```

And add after the `GetStandingsUseCase` registration:

```dart
    Get.lazyPut<GetLeaderboardsUseCase>(
      () => GetLeaderboardsUseCase(
        tournamentRepository: Get.find<TournamentRepository>(),
      ),
      fenix: true,
    );
```

- [ ] **Step 7: Verify it compiles**

Run: `flutter analyze`
Expected: no new errors (existing errors, if any, are pre-existing and unrelated — confirm by checking they also appear on `development` before this change if anything is unexpected).

- [ ] **Step 8: Commit**

```bash
git add lib/features/tournament/data/tournament_endpoint.dart lib/features/tournament/data/data_sources/remote/tournament_api_service.dart lib/features/tournament/domain/repositories/tournament_repository.dart lib/features/tournament/data/repositories/tournament_repository_impl.dart lib/features/tournament/domain/usecases/get_leaderboards.dart lib/core/di/injection/tournament_injection.dart
git commit -m "feat: wire GetLeaderboardsUseCase through the tournament repository"
```

---

### Task 7: Controller wiring + tests

**Files:**
- Modify: `cricket-scrorer/lib/features/tournament/presentation/controllers/tournament_detail_controller.dart`
- Modify: `cricket-scrorer/lib/features/tournament/presentation/bindings/tournament_detail_binding.dart`
- Modify: `cricket-scrorer/test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart`
- Modify: `cricket-scrorer/test/features/tournament/presentation/widget/edit_tournament_sheet_test.dart`
- Modify: `cricket-scrorer/test/features/tournament/presentation/widget/enroll_team_sheet_test.dart`
- Modify: `cricket-scrorer/test/features/tournament/presentation/widget/resolve_fixture_sheet_test.dart`
- Modify: `cricket-scrorer/test/features/tournament/presentation/widget/start_fixture_match_sheet_test.dart`

**Interfaces:**
- Consumes (from Task 6): `GetLeaderboardsUseCase`, `GetLeaderboardsParams`.
- Produces: `TournamentDetailController.loadLeaderboards()`, `.battingLeaderboard`, `.bowlingLeaderboard`, `.leaderboardsLoading`, `.leaderboardsError` — consumed by Task 8's screen. `TournamentDetailController`'s constructor now requires `getLeaderboardsUseCase` — every direct constructor call anywhere in the test suite must supply one, which is why the four widget test files above are touched in this task (their compile breaks the moment the constructor param is added, exactly like the standings work's own history with these same four files).

- [ ] **Step 1: Write the failing controller tests**

In `test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart`:

Add the import:

```dart
import 'package:cricket_scorer/features/tournament/data/models/response/leaderboard_row_res.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/get_leaderboards.dart';
```

Add the fake class after `_FakeGetStandingsUseCase`:

```dart
class _FakeGetLeaderboardsUseCase implements GetLeaderboardsUseCase {
  Either<CricketResponse<TournamentLeaderboardsRes>, CricketFailure>? response;

  @override
  Future<Either<CricketResponse<TournamentLeaderboardsRes>, CricketFailure>> call({
    GetLeaderboardsParams? params,
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

Add to the `main()` block's declarations, `build()`, and `setUp()`:

```dart
  late _FakeGetLeaderboardsUseCase getLeaderboardsUseCase;
```

```dart
  TournamentDetailController build(String userId) => TournamentDetailController(
    // ...existing params...
    getStandingsUseCase: getStandingsUseCase,
    getLeaderboardsUseCase: getLeaderboardsUseCase,
  );
```

```dart
  setUp(() {
    // ...existing setup...
    getStandingsUseCase = _FakeGetStandingsUseCase();
    getLeaderboardsUseCase = _FakeGetLeaderboardsUseCase();
    controller = build('owner-1');
  });
```

Add two tests after the existing `loadStandings` tests, at the end of `main()` before the closing brace:

```dart
  test('loadLeaderboards populates both leaderboards as the backend returned them', () async {
    getLeaderboardsUseCase.response = Either.result(
      CricketResponse(
        message: 'ok',
        data: TournamentLeaderboardsRes(
          tournamentId: 'tournament-1',
          battingLeaderboard: [
            BattingLeaderboardRowRes(
              playerId: 'p1', playerName: 'Rahul',
              inningsBatted: 2, runs: 100, ballsFaced: 70, timesOut: 1, notOuts: 1,
              average: 100, strikeRate: 142.86,
              fours: 10, sixes: 3, fifties: 1, hundreds: 0,
              highScore: null,
            ),
          ],
          bowlingLeaderboard: [
            BowlingLeaderboardRowRes(
              playerId: 'p2', playerName: 'Vijay',
              inningsBowled: 2, legalDeliveries: 42, runsConceded: 36, wickets: 3, maidens: 0,
              economy: 5.14,
              bestBowling: null,
            ),
          ],
        ),
      ),
    );

    await controller.loadLeaderboards();

    expect(controller.leaderboardsLoading.value, isFalse);
    expect(controller.leaderboardsError.value, isNull);
    expect(controller.battingLeaderboard.map((r) => r.playerName), ['Rahul']);
    expect(controller.bowlingLeaderboard.map((r) => r.playerName), ['Vijay']);
  });

  test('loadLeaderboards sets the backend error message on failure, leaves both lists empty', () async {
    getLeaderboardsUseCase.response = Either.fallback(
      CricketBadRequestFailure(statusCode: 404, message: 'Tournament not found'),
    );

    await controller.loadLeaderboards();

    expect(controller.leaderboardsLoading.value, isFalse);
    expect(controller.leaderboardsError.value, 'Tournament not found');
    expect(controller.battingLeaderboard, isEmpty);
    expect(controller.bowlingLeaderboard, isEmpty);
  });
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `flutter test test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart`
Expected: FAIL to compile — `TournamentDetailController` has no `getLeaderboardsUseCase` parameter and no `loadLeaderboards` method yet.

- [ ] **Step 3: Add the controller fields and method**

In `lib/features/tournament/presentation/controllers/tournament_detail_controller.dart`, add the import:

```dart
import 'package:cricket_scorer/features/tournament/data/models/response/leaderboard_row_res.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/get_leaderboards.dart';
```

Add the field and constructor param, mirroring `getStandingsUseCase`:

```dart
  final GetStandingsUseCase getStandingsUseCase;
  final GetLeaderboardsUseCase getLeaderboardsUseCase;
```

```dart
    required this.getStandingsUseCase,
    required this.getLeaderboardsUseCase,
  });
```

Add the observable state after `standingsError`:

```dart
  // Same lazy-load reasoning as standings above.
  final battingLeaderboard = <BattingLeaderboardRowRes>[].obs;
  final bowlingLeaderboard = <BowlingLeaderboardRowRes>[].obs;
  final leaderboardsLoading = false.obs;
  final leaderboardsError = Rxn<String>();
```

Add the method after `loadStandings`:

```dart
  Future<void> loadLeaderboards() async {
    leaderboardsLoading.value = true;
    leaderboardsError.value = null;

    final response = await getLeaderboardsUseCase(
      params: GetLeaderboardsParams(tournamentId: tournamentId),
    );

    if (!response.isResult) {
      leaderboardsError.value = response.fallback.message;
      leaderboardsLoading.value = false;
      return;
    }

    battingLeaderboard.assignAll(response.result.data!.battingLeaderboard);
    bowlingLeaderboard.assignAll(response.result.data!.bowlingLeaderboard);
    leaderboardsLoading.value = false;
  }
```

- [ ] **Step 4: Wire the binding**

In `lib/features/tournament/presentation/bindings/tournament_detail_binding.dart`, add the import:

```dart
import 'package:cricket_scorer/features/tournament/domain/usecases/get_leaderboards.dart';
```

And add to the constructor call:

```dart
        getStandingsUseCase: Get.find<GetStandingsUseCase>(),
        getLeaderboardsUseCase: Get.find<GetLeaderboardsUseCase>(),
```

- [ ] **Step 5: Fix the four widget test files' constructor calls**

In each of `edit_tournament_sheet_test.dart`, `enroll_team_sheet_test.dart`, `resolve_fixture_sheet_test.dart`, `start_fixture_match_sheet_test.dart`, add the import:

```dart
import 'package:cricket_scorer/features/tournament/domain/usecases/get_leaderboards.dart';
```

Add the constructor argument right after `getStandingsUseCase: _UnusedGetStandingsUseCase(),`:

```dart
        getLeaderboardsUseCase: _UnusedGetLeaderboardsUseCase(),
```

And add the class right after `class _UnusedGetStandingsUseCase implements GetStandingsUseCase { ... }`:

```dart
class _UnusedGetLeaderboardsUseCase implements GetLeaderboardsUseCase {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}
```

- [ ] **Step 6: Run the full test suite to verify everything compiles and passes**

Run: `flutter test`
Expected: all tests pass, including the 2 new controller tests and the 4 previously-broken widget test files now compiling again.

- [ ] **Step 7: Commit**

```bash
git add lib/features/tournament/presentation/controllers/tournament_detail_controller.dart lib/features/tournament/presentation/bindings/tournament_detail_binding.dart test/features/tournament/presentation/controllers/tournament_detail_controller_test.dart test/features/tournament/presentation/widget/edit_tournament_sheet_test.dart test/features/tournament/presentation/widget/enroll_team_sheet_test.dart test/features/tournament/presentation/widget/resolve_fixture_sheet_test.dart test/features/tournament/presentation/widget/start_fixture_match_sheet_test.dart
git commit -m "feat: add loadLeaderboards to TournamentDetailController"
```

---

### Task 8: Leaderboards screen, routing, translations

**Files:**
- Create: `cricket-scrorer/lib/features/tournament/presentation/pages/tournament_leaderboards_screen.dart`
- Modify: `cricket-scrorer/lib/config/routes/app_routes.dart`
- Modify: `cricket-scrorer/lib/config/routes/app_pages.dart`
- Modify: `cricket-scrorer/lib/features/tournament/presentation/pages/tournament_detail_screen.dart`
- Modify: `cricket-scrorer/lib/core/translations/translation_keys.dart`, `en.dart`, `hi.dart`, `mr.dart`
- Create: `cricket-scrorer/test/features/tournament/presentation/pages/tournament_leaderboards_screen_test.dart`

**Interfaces:**
- Consumes (from Task 7): `TournamentDetailController.battingLeaderboard`, `.bowlingLeaderboard`, `.leaderboardsLoading`, `.leaderboardsError`, `.loadLeaderboards()`.
- Consumes (existing, reused): `formatAverage`, `formatHighScore`, `formatBestBowling`, `formatOversFromLegalDeliveries` from `package:cricket_scorer/features/scoring/presentation/utils/career_stats_format.dart`.

- [ ] **Step 1: Add the three new translation keys**

In `lib/core/translations/translation_keys.dart`, add after `nrrShort`:

```dart
  static const String leaderboards = 'leaderboards';
  static const String noLeaderboardsYet = 'no_leaderboards_yet';
  static const String player = 'player';
```

In `lib/core/translations/en.dart`, add after the `nrrShort` entry:

```dart
  TranslationKeys.leaderboards: 'Leaderboards',
  TranslationKeys.noLeaderboardsYet: 'No leaderboard data yet',
  TranslationKeys.player: 'Player',
```

In `lib/core/translations/hi.dart`, add after the `nrrShort` entry:

```dart
  TranslationKeys.leaderboards: 'लीडरबोर्ड',
  TranslationKeys.noLeaderboardsYet: 'अभी तक कोई लीडरबोर्ड डेटा नहीं',
  TranslationKeys.player: 'खिलाड़ी',
```

In `lib/core/translations/mr.dart`, add after the `nrrShort` entry:

```dart
  TranslationKeys.leaderboards: 'लीडरबोर्ड',
  TranslationKeys.noLeaderboardsYet: 'अजून लीडरबोर्ड डेटा नाही',
  TranslationKeys.player: 'खेळाडू',
```

Every other label the screen needs (`battingFigures`/`bowlingFigures` for the tabs, `innings`, `runsShort`, `average`, `strikeRateShort`, `highScore`, `foursShort`, `sixesShort`, `fifties`, `hundreds`, `oversShort`, `wicketsShort`, `economyShort`, `maidensShort`, `bestBowling`, `rankShort`, `retry`) already exists from the career-stats and standings work — reused as-is, no new keys.

- [ ] **Step 2: Add the routes**

In `lib/config/routes/app_routes.dart`, add after `tournamentStandingsPath`:

```dart
  /// Registered with a GetX path parameter, same shape as
  /// [tournamentStandings]. Never navigate with this constant directly —
  /// use [tournamentLeaderboardsPath]. No binding of its own, same reasoning
  /// as standings: reuses the tag-registered `TournamentDetailController`.
  static const String tournamentLeaderboards =
      '/tournament/:tournamentId/leaderboards';

  static String tournamentLeaderboardsPath(String tournamentId) =>
      '/tournament/$tournamentId/leaderboards';
```

In `lib/config/routes/app_pages.dart`, add the import:

```dart
import 'package:cricket_scorer/features/tournament/presentation/pages/tournament_leaderboards_screen.dart';
```

And add the page after the standings `GetPage`:

```dart
    GetPage(
      name: AppRoutes.tournamentLeaderboards,
      page: () => const TournamentLeaderboardsScreen(),
    ),
```

- [ ] **Step 3: Write the screen**

Create `lib/features/tournament/presentation/pages/tournament_leaderboards_screen.dart`:

```dart
import 'package:cricket_scorer/core/extensions/space_extension.dart';
import 'package:cricket_scorer/core/extensions/theme_x.dart';
import 'package:cricket_scorer/core/global/widgets/cricket_button.dart';
import 'package:cricket_scorer/core/global/widgets/cricket_text.dart';
import 'package:cricket_scorer/core/global/widgets/custom_app_bar.dart';
import 'package:cricket_scorer/core/translations/translation_keys.dart';
import 'package:cricket_scorer/features/scoring/presentation/utils/career_stats_format.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/leaderboard_row_res.dart';
import 'package:cricket_scorer/features/tournament/presentation/controllers/tournament_detail_controller.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

/// Batting + bowling leaderboards for one tournament — reached from
/// `TournamentDetailScreen`'s "Leaderboards" action, shown for every
/// tournament format (unlike Standings, which hides for knockout). Reuses
/// that screen's own tag-registered `TournamentDetailController`, fetched
/// lazily via `loadLeaderboards()` only when this screen actually opens.
class TournamentLeaderboardsScreen extends StatefulWidget {
  const TournamentLeaderboardsScreen({super.key});

  @override
  State<TournamentLeaderboardsScreen> createState() =>
      _TournamentLeaderboardsScreenState();
}

class _TournamentLeaderboardsScreenState
    extends State<TournamentLeaderboardsScreen> {
  late final String _tournamentId = Get.parameters['tournamentId']?.trim() ?? '';
  late final TournamentDetailController controller =
      Get.find<TournamentDetailController>(tag: _tournamentId);

  @override
  void initState() {
    super.initState();
    controller.loadLeaderboards();
  }

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: CustomAppBar(
          title: TranslationKeys.leaderboards.tr,
          bottom: TabBar(
            tabs: [
              Tab(text: TranslationKeys.battingFigures.tr),
              Tab(text: TranslationKeys.bowlingFigures.tr),
            ],
          ),
        ),
        body: SafeArea(
          child: Obx(() {
            final loading = controller.leaderboardsLoading.value;
            final error = controller.leaderboardsError.value;
            final batting = controller.battingLeaderboard;
            final bowling = controller.bowlingLeaderboard;

            if (loading && batting.isEmpty && bowling.isEmpty) {
              return const Center(child: CircularProgressIndicator());
            }
            if (error != null && batting.isEmpty && bowling.isEmpty) {
              return Center(
                child: Padding(
                  padding: 24.p,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        Icons.error_outline,
                        size: 56,
                        color: context.colorScheme.onSurfaceVariant,
                      ),
                      16.h,
                      CricketText(text: error, textAlign: TextAlign.center),
                      24.h,
                      CricketButton(
                        buttonText: TranslationKeys.retry.tr,
                        onPressed: controller.loadLeaderboards,
                        width: 160,
                      ),
                    ],
                  ),
                ),
              );
            }

            return TabBarView(
              children: [
                _BattingTable(rows: batting, onRefresh: controller.loadLeaderboards),
                _BowlingTable(rows: bowling, onRefresh: controller.loadLeaderboards),
              ],
            );
          }),
        ),
      ),
    );
  }
}

class _BattingTable extends StatelessWidget {
  const _BattingTable({required this.rows, required this.onRefresh});

  final List<BattingLeaderboardRowRes> rows;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) {
      return Center(
        child: CricketText(
          text: TranslationKeys.noLeaderboardsYet.tr,
          style: context.textTheme.bodyMedium?.copyWith(
            color: context.colorScheme.onSurfaceVariant,
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: SingleChildScrollView(
        padding: 16.p,
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: DataTable(
            columnSpacing: 16,
            columns: [
              DataColumn(label: CricketText(text: TranslationKeys.rankShort.tr)),
              DataColumn(label: CricketText(text: TranslationKeys.player.tr)),
              DataColumn(label: CricketText(text: TranslationKeys.innings.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.runsShort.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.average.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.strikeRateShort.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.highScore.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.foursShort.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.sixesShort.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.fifties.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.hundreds.tr), numeric: true),
            ],
            rows: [
              for (var i = 0; i < rows.length; i += 1)
                DataRow(
                  cells: [
                    DataCell(CricketText(text: '${i + 1}')),
                    DataCell(CricketText(text: rows[i].playerName)),
                    DataCell(CricketText(text: '${rows[i].inningsBatted}')),
                    DataCell(
                      CricketText(
                        text: '${rows[i].runs}',
                        style: context.textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    DataCell(CricketText(text: formatAverage(rows[i].average))),
                    DataCell(CricketText(text: rows[i].strikeRate.toStringAsFixed(2))),
                    DataCell(CricketText(text: formatHighScore(rows[i].highScore))),
                    DataCell(CricketText(text: '${rows[i].fours}')),
                    DataCell(CricketText(text: '${rows[i].sixes}')),
                    DataCell(CricketText(text: '${rows[i].fifties}')),
                    DataCell(CricketText(text: '${rows[i].hundreds}')),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BowlingTable extends StatelessWidget {
  const _BowlingTable({required this.rows, required this.onRefresh});

  final List<BowlingLeaderboardRowRes> rows;
  final Future<void> Function() onRefresh;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) {
      return Center(
        child: CricketText(
          text: TranslationKeys.noLeaderboardsYet.tr,
          style: context.textTheme.bodyMedium?.copyWith(
            color: context.colorScheme.onSurfaceVariant,
          ),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: SingleChildScrollView(
        padding: 16.p,
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: DataTable(
            columnSpacing: 16,
            columns: [
              DataColumn(label: CricketText(text: TranslationKeys.rankShort.tr)),
              DataColumn(label: CricketText(text: TranslationKeys.player.tr)),
              DataColumn(label: CricketText(text: TranslationKeys.innings.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.oversShort.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.runsShort.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.wicketsShort.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.economyShort.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.maidensShort.tr), numeric: true),
              DataColumn(label: CricketText(text: TranslationKeys.bestBowling.tr), numeric: true),
            ],
            rows: [
              for (var i = 0; i < rows.length; i += 1)
                DataRow(
                  cells: [
                    DataCell(CricketText(text: '${i + 1}')),
                    DataCell(CricketText(text: rows[i].playerName)),
                    DataCell(CricketText(text: '${rows[i].inningsBowled}')),
                    DataCell(CricketText(text: formatOversFromLegalDeliveries(rows[i].legalDeliveries))),
                    DataCell(CricketText(text: '${rows[i].runsConceded}')),
                    DataCell(
                      CricketText(
                        text: '${rows[i].wickets}',
                        style: context.textTheme.bodyMedium?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    DataCell(CricketText(text: rows[i].economy.toStringAsFixed(2))),
                    DataCell(CricketText(text: '${rows[i].maidens}')),
                    DataCell(CricketText(text: formatBestBowling(rows[i].bestBowling))),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}
```

- [ ] **Step 4: Add the button on `TournamentDetailScreen`**

In `lib/features/tournament/presentation/pages/tournament_detail_screen.dart`, replace:

```dart
                    // Knockout is a bracket, not a table — there's no
                    // standings screen to link to for it.
                    if (data.format != 'knockout')
                      TextButton(
                        onPressed: () => Get.toNamed<dynamic>(
                          AppRoutes.tournamentStandingsPath(_tournamentId),
                        ),
                        child: CricketText(text: TranslationKeys.standings.tr),
                      ),
```

with:

```dart
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // Knockout is a bracket, not a table — there's no
                        // standings screen to link to for it. Leaderboards
                        // are player-level, so they're shown for every
                        // format, including knockout.
                        if (data.format != 'knockout')
                          TextButton(
                            onPressed: () => Get.toNamed<dynamic>(
                              AppRoutes.tournamentStandingsPath(_tournamentId),
                            ),
                            child: CricketText(text: TranslationKeys.standings.tr),
                          ),
                        TextButton(
                          onPressed: () => Get.toNamed<dynamic>(
                            AppRoutes.tournamentLeaderboardsPath(_tournamentId),
                          ),
                          child: CricketText(text: TranslationKeys.leaderboards.tr),
                        ),
                      ],
                    ),
```

- [ ] **Step 5: Regenerate nothing, but confirm compile**

Run: `flutter analyze`
Expected: no new errors.

- [ ] **Step 6: Write the widget test**

Create `test/features/tournament/presentation/pages/tournament_leaderboards_screen_test.dart`. This follows `tournament_standings_screen_test.dart`'s exact structure — a `_GetLeaderboardsUseCase` controllable fake, working (not throwing) stubs for the three use cases `TournamentDetailController.onInit()`'s automatic `loadDetail()` needs, and `_Unused...` throwing stubs for everything else:

```dart
import 'package:cricket_scorer/config/routes/app_routes.dart';
import 'package:cricket_scorer/config/theme/app_theme.dart';
import 'package:cricket_scorer/core/error/cricket_failure.dart';
import 'package:cricket_scorer/core/network/models/cricket_response.dart';
import 'package:cricket_scorer/core/utils/either_util.dart';
import 'package:cricket_scorer/features/organization/data/models/response/organization_detail_res.dart';
import 'package:cricket_scorer/features/organization/domain/usecases/get_organization.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/fixture_res.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/leaderboard_row_res.dart';
import 'package:cricket_scorer/features/tournament/data/models/response/tournament_detail_res.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/delete_tournament.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/enroll_tournament_team.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/generate_fixtures.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/get_fixtures.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/get_leaderboards.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/get_standings.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/get_tournament.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/remove_tournament_team.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/resolve_fixture.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/start_fixture_match.dart';
import 'package:cricket_scorer/features/tournament/domain/usecases/update_tournament.dart';
import 'package:cricket_scorer/features/tournament/presentation/controllers/tournament_detail_controller.dart';
import 'package:cricket_scorer/features/tournament/presentation/pages/tournament_leaderboards_screen.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get/get.dart' hide Response;

class _GetLeaderboardsUseCase implements GetLeaderboardsUseCase {
  Either<CricketResponse<TournamentLeaderboardsRes>, CricketFailure>? response;

  @override
  Future<Either<CricketResponse<TournamentLeaderboardsRes>, CricketFailure>> call({
    GetLeaderboardsParams? params,
  }) async {
    final result = response;
    if (result == null) throw UnimplementedError('Not exercised in this test.');
    return result;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

// TournamentDetailController.onInit() always calls loadDetail(), even
// though this screen only cares about leaderboards — these three need a
// working (not throwing) response so that automatic call succeeds
// harmlessly. Same reasoning as tournament_standings_screen_test.dart.
class _StubGetTournamentUseCase implements GetTournamentUseCase {
  @override
  Future<Either<CricketResponse<TournamentDetailRes>, CricketFailure>> call({
    GetTournamentParams? params,
  }) async {
    return Either.result(
      CricketResponse(
        message: 'ok',
        data: TournamentDetailRes(
          id: 'tournament-1',
          name: 'Summer Cup',
          format: 'round_robin',
          status: 'ongoing',
          organization: TournamentOrganizationRef(id: 'org-1', name: 'Riverside CC'),
          teams: const [],
          createdAt: DateTime.parse('2026-09-06T10:00:00.000Z'),
        ),
      ),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _StubGetOrganizationUseCase implements GetOrganizationUseCase {
  @override
  Future<Either<CricketResponse<OrganizationDetailRes>, CricketFailure>> call({
    GetOrganizationParams? params,
  }) async {
    return Either.result(
      CricketResponse(
        message: 'ok',
        data: OrganizationDetailRes(
          id: 'org-1',
          name: 'Riverside CC',
          owner: OrganizationUserRef(id: 'owner-1', name: 'Owner'),
          members: const [],
          teams: const [],
          tournaments: const [],
        ),
      ),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _StubGetFixturesUseCase implements GetFixturesUseCase {
  @override
  Future<Either<CricketResponse<List<FixtureRes>>, CricketFailure>> call({
    GetFixturesParams? params,
  }) async {
    return Either.result(
      const CricketResponse(message: 'ok', data: <FixtureRes>[]),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _UnusedUpdateTournamentUseCase implements UpdateTournamentUseCase {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _UnusedDeleteTournamentUseCase implements DeleteTournamentUseCase {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _UnusedEnrollTournamentTeamUseCase implements EnrollTournamentTeamUseCase {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _UnusedRemoveTournamentTeamUseCase implements RemoveTournamentTeamUseCase {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _UnusedGenerateFixturesUseCase implements GenerateFixturesUseCase {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _UnusedStartFixtureMatchUseCase implements StartFixtureMatchUseCase {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _UnusedResolveFixtureUseCase implements ResolveFixtureUseCase {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _UnusedGetStandingsUseCase implements GetStandingsUseCase {
  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

void main() {
  late _GetLeaderboardsUseCase getLeaderboardsUseCase;

  setUp(() {
    Get.testMode = true;
    getLeaderboardsUseCase = _GetLeaderboardsUseCase();
    Get.put<TournamentDetailController>(
      TournamentDetailController(
        tournamentId: 'tournament-1',
        currentUserId: 'owner-1',
        getTournamentUseCase: _StubGetTournamentUseCase(),
        getOrganizationUseCase: _StubGetOrganizationUseCase(),
        updateTournamentUseCase: _UnusedUpdateTournamentUseCase(),
        deleteTournamentUseCase: _UnusedDeleteTournamentUseCase(),
        enrollTournamentTeamUseCase: _UnusedEnrollTournamentTeamUseCase(),
        removeTournamentTeamUseCase: _UnusedRemoveTournamentTeamUseCase(),
        getFixturesUseCase: _StubGetFixturesUseCase(),
        generateFixturesUseCase: _UnusedGenerateFixturesUseCase(),
        startFixtureMatchUseCase: _UnusedStartFixtureMatchUseCase(),
        resolveFixtureUseCase: _UnusedResolveFixtureUseCase(),
        getStandingsUseCase: _UnusedGetStandingsUseCase(),
        getLeaderboardsUseCase: getLeaderboardsUseCase,
      ),
      tag: 'tournament-1',
    );
  });

  tearDown(Get.reset);

  Future<void> pumpScreen(WidgetTester tester) async {
    await tester.pumpWidget(
      GetMaterialApp(
        theme: AppTheme.lightTheme,
        initialRoute: AppRoutes.tournamentLeaderboardsPath('tournament-1'),
        getPages: [
          GetPage(
            name: AppRoutes.tournamentLeaderboards,
            page: () => const TournamentLeaderboardsScreen(),
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
  }

  BattingLeaderboardRowRes battingRow({
    required String playerId,
    required String playerName,
    required int runs,
  }) => BattingLeaderboardRowRes(
    playerId: playerId, playerName: playerName,
    inningsBatted: 2, runs: runs, ballsFaced: 70, timesOut: 1, notOuts: 1,
    average: null, strikeRate: 142.86,
    fours: 10, sixes: 3, fifties: 1, hundreds: 0, highScore: null,
  );

  BowlingLeaderboardRowRes bowlingRow({
    required String playerId,
    required String playerName,
    required int wickets,
  }) => BowlingLeaderboardRowRes(
    playerId: playerId, playerName: playerName,
    inningsBowled: 2, legalDeliveries: 42, runsConceded: 36, wickets: wickets, maidens: 0,
    economy: 5.14, bestBowling: null,
  );

  testWidgets(
    'shows the batting tab by default, and switches to bowling on tab tap',
    (tester) async {
      getLeaderboardsUseCase.response = Either.result(
        CricketResponse(
          message: 'ok',
          data: TournamentLeaderboardsRes(
            tournamentId: 'tournament-1',
            battingLeaderboard: [
              battingRow(playerId: 'p1', playerName: 'Rahul', runs: 100),
            ],
            bowlingLeaderboard: [
              bowlingRow(playerId: 'p2', playerName: 'Vijay', wickets: 3),
            ],
          ),
        ),
      );

      await pumpScreen(tester);

      expect(find.text('Rahul'), findsOneWidget);
      expect(find.text('Vijay'), findsNothing);

      await tester.tap(find.text('bowling_figures'));
      await tester.pumpAndSettle();

      expect(find.text('Vijay'), findsOneWidget);
    },
  );

  testWidgets('shows the empty state on both tabs when no one has played yet', (tester) async {
    getLeaderboardsUseCase.response = Either.result(
      CricketResponse(
        message: 'ok',
        data: TournamentLeaderboardsRes(
          tournamentId: 'tournament-1',
          battingLeaderboard: const [],
          bowlingLeaderboard: const [],
        ),
      ),
    );

    await pumpScreen(tester);

    expect(find.text('no_leaderboards_yet'), findsOneWidget);

    await tester.tap(find.text('bowling_figures'));
    await tester.pumpAndSettle();

    expect(find.text('no_leaderboards_yet'), findsOneWidget);
  });

  testWidgets('shows the backend error message and a retry button on failure', (tester) async {
    getLeaderboardsUseCase.response = Either.fallback(
      CricketNotFoundErrorFailure(statusCode: 404, message: 'Tournament not found'),
    );

    await pumpScreen(tester);

    expect(find.text('Tournament not found'), findsOneWidget);
    expect(find.text('retry'), findsOneWidget);
  });
}
```

- [ ] **Step 7: Run the test file to verify it fails, then passes**

Run: `flutter test test/features/tournament/presentation/pages/tournament_leaderboards_screen_test.dart`
Expected first: FAIL (the screen file doesn't exist until Step 3 above — if executing steps strictly in order, Step 3 already created it, so this file should compile and pass on the first run).
Expected: PASS, all 3 tests green.

- [ ] **Step 8: Run the full frontend suite**

Run: `flutter analyze && flutter test`
Expected: `flutter analyze` reports no new issues; `flutter test` passes in full.

- [ ] **Step 9: Upload the new translation keys to the CMS**

Per the Global Constraints note above, this is not optional. Using an authenticated token (e.g. from `scripts/verify-leaderboards.sh`'s login flow, or any existing session), call:

```bash
curl -s -X POST "$BASE/v1/translations/bulk-update" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '[
    {"key":"leaderboards","translations":{"en":"Leaderboards","hi":"लीडरबोर्ड","mr":"लीडरबोर्ड"}},
    {"key":"no_leaderboards_yet","translations":{"en":"No leaderboard data yet","hi":"अभी तक कोई लीडरबोर्ड डेटा नहीं","mr":"अजून लीडरबोर्ड डेटा नाही"}},
    {"key":"player","translations":{"en":"Player","hi":"खिलाड़ी","mr":"खेळाडू"}}
  ]'
```

Confirm the response is `200` with `success: true`. Then relaunch the app (or wait for `LanguageService`'s next version-poll) and visually confirm the Leaderboards screen renders real text, not raw keys like `leaderboards`/`player`.

- [ ] **Step 10: Commit**

```bash
git add lib/features/tournament/presentation/pages/tournament_leaderboards_screen.dart lib/config/routes/app_routes.dart lib/config/routes/app_pages.dart lib/features/tournament/presentation/pages/tournament_detail_screen.dart lib/core/translations/translation_keys.dart lib/core/translations/en.dart lib/core/translations/hi.dart lib/core/translations/mr.dart test/features/tournament/presentation/pages/tournament_leaderboards_screen_test.dart
git commit -m "feat: add tournament leaderboards screen"
```

---

### Task 9: Final verification

**Files:** none — this task runs the full test suites on both repos and reports results, per `superpowers:verification-before-completion`.

- [ ] **Step 1: Backend full suite**

Run (in `cricket-scorer-backend`): `npm test`
Expected: every suite passes, including `tests/computeLeaderboards.test.js`, `tests/leaderboard.test.js`, `tests/locales.test.js`, `tests/routes.auth.test.js`, and every pre-existing suite (especially `tests/careerStats*.test.js`, confirming Task 1's export changes broke nothing).

- [ ] **Step 2: Frontend full suite**

Run (in `cricket-scrorer`): `flutter analyze && flutter test`
Expected: `flutter analyze` clean (no new issues); `flutter test` passes in full, including the new controller tests and the new screen widget tests.

- [ ] **Step 3: Manual verification script**

With the dev backend running (`npm run dev`), run: `EMAIL=<you> PASSWORD=<pw> ./scripts/verify-leaderboards.sh`
Expected: every `PASS` line prints, ending in a final count, with no `FAIL`.

- [ ] **Step 4: On-device spot check (optional but recommended)**

Open the app, navigate to a tournament with at least one completed match, tap "Leaderboards", confirm both tabs render real player names and stats (not raw translation keys — this depends on Task 8 Step 9's CMS upload having actually landed).

- [ ] **Step 5: Report**

Summarize actual command output (pass/fail counts) for both suites and the manual script — per `superpowers:verification-before-completion`, no completion claim without this evidence having actually been run in this session.
