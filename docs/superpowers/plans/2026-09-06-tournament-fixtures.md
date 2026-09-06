# Tournament Fixture Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-generate a tournament's match schedule (round-robin, league, or knockout) from its enrolled teams, let an org member turn a scheduled fixture into a real scorable `Match`, and automatically feed match results back into the schedule (including auto-advancing a knockout bracket and auto-completing a tournament).

**Architecture:** A new `Fixture` model holds pure schedule metadata (which two teams, which round, current status, resolved winner) fully decoupled from live scoring. `Match` gains two nullable back-references (`tournament`, `fixture`). Pure, dependency-free functions generate the round-robin/league/knockout pairings and decide a fixture's outcome from its match's result — these are unit-tested with zero database involvement. A single shared hook (`resolveFixtureAfterMatch`), called from the existing ball-scoring completion path and from `abandonMatch`, keeps fixtures and tournament status in sync with match outcomes.

**Tech Stack:** Node.js, Express 5, Mongoose, Jest + Supertest (existing test stack — no new dependencies).

**Spec:** `docs/api.md`'s `## Fixture` section (workspace root, not version-controlled) — the finalized contract this plan implements. Read it alongside this plan; exact field names, status values, and error codes below are drawn from it.

## Global Constraints

- Error codes passed to `ApiError` must be bare i18n keys (SCREAMING_SNAKE_CASE), never `req.t(...)`'d text — `errorHandler` copies `err.message` straight into the response's `code` field.
- Every new locale key needs an entry in all three of `src/locales/{en,hi,mr}/common.json`, non-empty, or `tests/locales.test.js` fails the build.
- Every new route must carry `verifyJwt` (none of this feature's routes are public) — `tests/routes.auth.test.js` fails the build otherwise, since it enumerates every registered route and requires each to either carry `verifyJwt` or appear on its explicit public allowlist.
- Follow TDD: write the failing test, watch it fail, write minimal code, watch it pass, commit. No production code without a failing test first.
- `Tournament.teams` array order is enrollment order (`addTournamentTeam` always `push`es) — this is what "seeded by enrollment order" means throughout.

---

### Task 1: Pure fixture-generation algorithms

**Files:**
- Create: `src/utils/generateFixtures.js`
- Test: `tests/generateFixtures.test.js`

**Interfaces:**
- Produces: `buildRoundRobinRounds(teamIds: ObjectId[]): Array<Array<{teamA, teamB, isBye}>>`, `buildLeagueRounds(teamIds: ObjectId[]): Array<Array<{teamA, teamB, isBye}>>`, `buildKnockoutRound1(teamIds: ObjectId[]): Array<{teamA, teamB, isBye}>`, `buildKnockoutNextRound(winnerTeamIds: ObjectId[]): Array<{teamA, teamB, isBye: false}>` — all pure, no I/O. Every returned slot has `teamB: null` and `isBye: true` when (and only when) it's a bye. Task 4 consumes these directly.

- [ ] **Step 1: Write the failing tests**

Create `tests/generateFixtures.test.js`:

```javascript
import {
    buildRoundRobinRounds,
    buildLeagueRounds,
    buildKnockoutRound1,
    buildKnockoutNextRound,
} from '../src/utils/generateFixtures.js';

const T = (n) => `team-${n}`; // stand-in ids; the functions never inspect their shape

describe('buildRoundRobinRounds', () => {
    it('pairs 2 teams into a single round with one match', () => {
        const rounds = buildRoundRobinRounds([T(1), T(2)]);
        expect(rounds).toEqual([[{ teamA: T(1), teamB: T(2), isBye: false }]]);
    });

    it('gives every pair of 4 teams exactly one meeting across 3 rounds, no byes', () => {
        const rounds = buildRoundRobinRounds([T(1), T(2), T(3), T(4)]);
        expect(rounds).toHaveLength(3);

        const pairsSeen = new Set();
        rounds.forEach((round) => {
            expect(round).toHaveLength(2);
            round.forEach((slot) => {
                expect(slot.isBye).toBe(false);
                const key = [slot.teamA, slot.teamB].sort().join('|');
                expect(pairsSeen.has(key)).toBe(false); // no repeat meeting
                pairsSeen.add(key);
            });
        });
        expect(pairsSeen.size).toBe(6); // C(4,2)
    });

    it('gives every team exactly one bye and every pair exactly one meeting for 3 teams', () => {
        const rounds = buildRoundRobinRounds([T(1), T(2), T(3)]);
        expect(rounds).toHaveLength(3);

        const byeCounts = new Map();
        const pairsSeen = new Set();
        rounds.forEach((round) => {
            round.forEach((slot) => {
                if (slot.isBye) {
                    expect(slot.teamB).toBeNull();
                    byeCounts.set(slot.teamA, (byeCounts.get(slot.teamA) ?? 0) + 1);
                } else {
                    const key = [slot.teamA, slot.teamB].sort().join('|');
                    expect(pairsSeen.has(key)).toBe(false);
                    pairsSeen.add(key);
                }
            });
        });
        expect(pairsSeen.size).toBe(3); // C(3,2)
        [T(1), T(2), T(3)].forEach((team) => expect(byeCounts.get(team)).toBe(1));
    });
});

describe('buildLeagueRounds', () => {
    it('doubles a 4-team round-robin schedule with reversed return-leg sides', () => {
        const singleLeg = buildRoundRobinRounds([T(1), T(2), T(3), T(4)]);
        const league = buildLeagueRounds([T(1), T(2), T(3), T(4)]);

        expect(league).toHaveLength(singleLeg.length * 2);
        expect(league.slice(0, singleLeg.length)).toEqual(singleLeg);

        const returnLeg = league.slice(singleLeg.length);
        returnLeg.forEach((round, i) => {
            round.forEach((slot, j) => {
                const firstLegSlot = singleLeg[i][j];
                expect(slot).toEqual({
                    teamA: firstLegSlot.teamB,
                    teamB: firstLegSlot.teamA,
                    isBye: false,
                });
            });
        });
    });

    it('mirrors a bye slot unchanged in the return leg', () => {
        const league = buildLeagueRounds([T(1), T(2), T(3)]);
        const singleLeg = buildRoundRobinRounds([T(1), T(2), T(3)]);
        const returnLeg = league.slice(singleLeg.length);

        singleLeg.forEach((round, i) => {
            round.forEach((slot, j) => {
                if (slot.isBye) {
                    expect(returnLeg[i][j]).toEqual(slot);
                }
            });
        });
    });
});

describe('buildKnockoutRound1', () => {
    it('pairs an exact power-of-two field with no byes', () => {
        const slots = buildKnockoutRound1([T(1), T(2), T(3), T(4)]);
        expect(slots).toEqual([
            { teamA: T(1), teamB: T(2), isBye: false },
            { teamA: T(3), teamB: T(4), isBye: false },
        ]);
    });

    it('gives the two earliest-enrolled teams a bye for a 6-team field (next power of two is 8)', () => {
        const slots = buildKnockoutRound1([T(1), T(2), T(3), T(4), T(5), T(6)]);

        expect(slots).toEqual([
            { teamA: T(1), teamB: null, isBye: true },
            { teamA: T(2), teamB: null, isBye: true },
            { teamA: T(3), teamB: T(4), isBye: false },
            { teamA: T(5), teamB: T(6), isBye: false },
        ]);
    });

    it('produces a single fixture — the final directly — for exactly 2 teams', () => {
        const slots = buildKnockoutRound1([T(1), T(2)]);
        expect(slots).toEqual([{ teamA: T(1), teamB: T(2), isBye: false }]);
    });
});

describe('buildKnockoutNextRound', () => {
    it('pairs round winners sequentially with no byes', () => {
        const slots = buildKnockoutNextRound([T(1), T(2), T(3), T(4)]);
        expect(slots).toEqual([
            { teamA: T(1), teamB: T(2), isBye: false },
            { teamA: T(3), teamB: T(4), isBye: false },
        ]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- generateFixtures.test.js`
Expected: FAIL — `Cannot find module '../src/utils/generateFixtures.js'`

- [ ] **Step 3: Write the implementation**

Create `src/utils/generateFixtures.js`:

```javascript
// Pure schedule-building blocks for tournament fixture generation. Nothing
// here touches Mongoose or the database — the fixture controller (Task 4)
// is responsible for turning what these return into actual Fixture
// documents. Kept pure specifically so every shape (odd/even team counts,
// exact-power-of-two knockout fields) is a plain unit test, not an
// integration test.

// Smallest power of two >= n. Every real caller has already passed the
// format's minimum-team check (2 for knockout) before this runs, so n >= 2
// always in practice.
const nextPowerOfTwo = (n) => {
    let p = 1;
    while (p < n) p *= 2;
    return p;
};

// [a,b,c,d] -> [[a,b],[c,d]]. Callers only ever pass even-length arrays —
// guaranteed by the power-of-two bracket invariant for knockout, and by
// construction for round-robin/league.
const pairUp = (arr) => {
    const pairs = [];
    for (let i = 0; i < arr.length; i += 2) {
        pairs.push([arr[i], arr[i + 1]]);
    }
    return pairs;
};

// Round 1 of a knockout bracket. `teamIds` ordered by enrollment
// (Tournament.teams array order, i.e. joinedAt). The earliest-enrolled
// teams get however many byes are needed to round the field up to a power
// of two — "seeded by enrollment order," not a draw. Returns
// { teamA, teamB, isBye } slots; teamB is null and isBye true for a bye.
export const buildKnockoutRound1 = (teamIds) => {
    const target = nextPowerOfTwo(teamIds.length);
    const byeCount = target - teamIds.length;
    const byeTeams = teamIds.slice(0, byeCount);
    const remaining = teamIds.slice(byeCount);

    const byeSlots = byeTeams.map((teamId) => ({ teamA: teamId, teamB: null, isBye: true }));
    const realSlots = pairUp(remaining).map(([teamA, teamB]) => ({ teamA, teamB, isBye: false }));
    return [...byeSlots, ...realSlots];
};

// Round N+1 of a knockout bracket, built from round N's winners (already
// ordered by round N's own `order` field). No byes are possible past round
// 1 — the power-of-two invariant guarantees `winnerTeamIds.length` is even
// whenever there's more than one fixture left to pair.
export const buildKnockoutNextRound = (winnerTeamIds) =>
    pairUp(winnerTeamIds).map(([teamA, teamB]) => ({ teamA, teamB, isBye: false }));

// Circle-method round-robin schedule. `teamIds` ordered by enrollment.
// Returns one array per round, each an array of { teamA, teamB, isBye }
// slots — teamB null (isBye true) for whichever team sits out that round
// when teamIds.length is odd. Standard algorithm: pad to even length with a
// null "bye" placeholder, fix position 0, rotate every other position one
// round at a time for teamIds.length - 1 (padded length - 1) rounds.
export const buildRoundRobinRounds = (teamIds) => {
    const hasByeSlot = teamIds.length % 2 !== 0;
    let arr = hasByeSlot ? [...teamIds, null] : [...teamIds];
    const size = arr.length;
    const roundCount = size - 1;
    const rounds = [];

    for (let r = 0; r < roundCount; r += 1) {
        const slots = [];
        for (let i = 0; i < size / 2; i += 1) {
            const a = arr[i];
            const b = arr[size - 1 - i];
            if (a === null) {
                slots.push({ teamA: b, teamB: null, isBye: true });
            } else if (b === null) {
                slots.push({ teamA: a, teamB: null, isBye: true });
            } else {
                slots.push({ teamA: a, teamB: b, isBye: false });
            }
        }
        rounds.push(slots);
        // Position 0 never rotates; the rest do, one step per round.
        arr = [arr[0], arr[size - 1], ...arr.slice(1, size - 1)];
    }
    return rounds;
};

// `league` format: the same round-robin schedule played twice — the second
// leg with sides reversed. Returns rounds in play order: every first-leg
// round, then every second-leg round. This doubling is `league`'s actual
// fixture-generation behavior (see docs/api.md's Fixture section), not
// only a future points-table label.
export const buildLeagueRounds = (teamIds) => {
    const firstLeg = buildRoundRobinRounds(teamIds);
    const secondLeg = firstLeg.map((round) =>
        round.map((slot) =>
            slot.isBye ? slot : { teamA: slot.teamB, teamB: slot.teamA, isBye: false }
        )
    );
    return [...firstLeg, ...secondLeg];
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- generateFixtures.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/utils/generateFixtures.js tests/generateFixtures.test.js
git commit -m "feat: add pure fixture-scheduling algorithms for round-robin, league, knockout"
```

---

### Task 2: Fixture model and Match model additions

**Files:**
- Create: `src/models/fixture.model.js`
- Modify: `src/models/match.model.js`
- Test: `tests/fixture.model.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Fixture` (Mongoose model), `FIXTURE_STATUS` (array of the 4 enum strings), exported from `src/models/fixture.model.js`. `Match.tournament` and `Match.fixture` fields (both `ObjectId`, default `null`). Task 4/5/6 create and query `Fixture` documents and set these two `Match` fields.

- [ ] **Step 1: Write the failing test**

Create `tests/fixture.model.test.js`:

```javascript
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Fixture } from '../src/models/fixture.model.js';
import { Tournament } from '../src/models/tournament.model.js';

beforeAll(async () => {
    await connectTestDb();
    await Fixture.init();
});

afterEach(async () => {
    await clearTestDb();
});

afterAll(async () => {
    await disconnectTestDb();
});

describe('Fixture model', () => {
    it('creates a scheduled fixture with two teams', async () => {
        const tournamentId = new mongoose.Types.ObjectId();
        const teamA = new mongoose.Types.ObjectId();
        const teamB = new mongoose.Types.ObjectId();

        const fixture = await Fixture.create({
            tournament: tournamentId,
            round: 1,
            order: 0,
            teamA,
            teamB,
        });

        expect(fixture.status).toBe('scheduled');
        expect(fixture.isBye).toBe(false);
        expect(fixture.match).toBeNull();
        expect(fixture.winner).toBeNull();
    });

    it('allows teamB to be null for a bye fixture', async () => {
        const fixture = await Fixture.create({
            tournament: new mongoose.Types.ObjectId(),
            round: 1,
            order: 0,
            teamA: new mongoose.Types.ObjectId(),
            teamB: null,
            isBye: true,
            status: 'bye',
        });

        expect(fixture.teamB).toBeNull();
        expect(fixture.status).toBe('bye');
    });

    it('rejects an invalid status value', async () => {
        const fixture = new Fixture({
            tournament: new mongoose.Types.ObjectId(),
            round: 1,
            order: 0,
            teamA: new mongoose.Types.ObjectId(),
            teamB: new mongoose.Types.ObjectId(),
            status: 'not-a-real-status',
        });

        await expect(fixture.validate()).rejects.toThrow();
    });

    it('requires teamA', async () => {
        const fixture = new Fixture({
            tournament: new mongoose.Types.ObjectId(),
            round: 1,
            order: 0,
            teamB: new mongoose.Types.ObjectId(),
        });

        await expect(fixture.validate()).rejects.toThrow();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fixture.model.test.js`
Expected: FAIL — `Cannot find module '../src/models/fixture.model.js'`

- [ ] **Step 3: Write the implementation**

Create `src/models/fixture.model.js`:

```javascript
import mongoose, { Schema } from "mongoose";

export const FIXTURE_STATUS = ['scheduled', 'bye', 'completed', 'unresolved'];

const fixtureSchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true },
    // 1-indexed. For round_robin/league, a round is one matchday of the
    // circle-method schedule. For knockout, round 1 is the first bracket
    // round and each later round is generated on demand — see
    // generateFixtures.js and fixture.controller.js.
    round: { type: Number, required: true, min: 1 },
    // Stable display/read order within a round.
    order: { type: Number, required: true, min: 0 },
    teamA: { type: Schema.Types.ObjectId, ref: 'Team', required: true },
    // Null only when isBye is true. There is no TBD/placeholder team
    // anywhere in this model — every fixture has two concrete teams (or one
    // team plus a bye) from the moment it's created; see docs/api.md's
    // Fixture section for why knockout rounds are generated on demand
    // instead of upfront with placeholders.
    teamB: { type: Schema.Types.ObjectId, ref: 'Team', default: null },
    isBye: { type: Boolean, default: false },
    status: { type: String, enum: FIXTURE_STATUS, default: 'scheduled' },
    // Set once POST .../fixtures/:fixtureId/start-match creates the real
    // Match for this fixture.
    match: { type: Schema.Types.ObjectId, ref: 'Match', default: null },
    // Null until the fixture resolves. Stays null for a round-robin/league
    // bye (no advancement concept there) and while status is 'unresolved'.
    winner: { type: Schema.Types.ObjectId, ref: 'Team', default: null },
  },
  { timestamps: true }
);

// The schedule's own natural read order — every fixture list in this
// feature reads round-by-round, ordered within a round.
fixtureSchema.index({ tournament: 1, round: 1, order: 1 });

export const Fixture = mongoose.model('Fixture', fixtureSchema);
```

Modify `src/models/match.model.js` — add two fields to `matchSchema`, right after `createdBy` and before `assignedScorer` (keeping the existing `assignedScorer` comment intact below):

```javascript
        createdBy:       { type: Schema.Types.ObjectId, ref: 'User', index: true },
        // Both null on every match not created via
        // POST /v1/tournament/:tournamentId/fixtures/:fixtureId/start-match,
        // including every match that predates this feature. Set together,
        // only by that endpoint — see docs/api.md's Fixture section.
        tournament:      { type: Schema.Types.ObjectId, ref: 'Tournament', default: null },
        fixture:         { type: Schema.Types.ObjectId, ref: 'Fixture', default: null },
        // The one delegated scorer for this match, distinct from `createdBy` —
```

(The existing `assignedScorer` line and its comment stay exactly as they are, just after this insertion — only the two new fields and their own comment are added.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- fixture.model.test.js`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/models/fixture.model.js src/models/match.model.js tests/fixture.model.test.js
git commit -m "feat: add Fixture model and Match.tournament/fixture back-references"
```

---

### Task 3: Fixture-outcome and tournament-completion pure logic

**Files:**
- Create: `src/utils/resolveFixtureOutcome.js`
- Test: `tests/resolveFixtureOutcome.test.js`

**Interfaces:**
- Consumes: nothing beyond plain objects shaped like a `Fixture`/`Match` document (`{teamA, teamB}` and `{status, result: {winner}}` respectively) — no Mongoose import, so this stays a pure unit test.
- Produces: `decideFixtureOutcome(fixture, match): {status, winner} | null` and `isTournamentComplete(format, fixtures): boolean`. Task 6 wires both into the live match-completion hook and the manual resolve endpoint.

- [ ] **Step 1: Write the failing tests**

Create `tests/resolveFixtureOutcome.test.js`:

```javascript
import { decideFixtureOutcome, isTournamentComplete } from '../src/utils/resolveFixtureOutcome.js';

const fixture = { teamA: 'team-A', teamB: 'team-B' };

describe('decideFixtureOutcome', () => {
    it('resolves to completed with teamA as winner', () => {
        const match = { status: 'completed', result: { winner: 'teamA' } };
        expect(decideFixtureOutcome(fixture, match)).toEqual({ status: 'completed', winner: 'team-A' });
    });

    it('resolves to completed with teamB as winner', () => {
        const match = { status: 'completed', result: { winner: 'teamB' } };
        expect(decideFixtureOutcome(fixture, match)).toEqual({ status: 'completed', winner: 'team-B' });
    });

    it('resolves to unresolved on a tie', () => {
        const match = { status: 'completed', result: { winner: 'tie' } };
        expect(decideFixtureOutcome(fixture, match)).toEqual({ status: 'unresolved', winner: null });
    });

    it('resolves to unresolved on no_result', () => {
        const match = { status: 'completed', result: { winner: 'no_result' } };
        expect(decideFixtureOutcome(fixture, match)).toEqual({ status: 'unresolved', winner: null });
    });

    it('resolves to unresolved when the match was abandoned', () => {
        const match = { status: 'abandoned', result: undefined };
        expect(decideFixtureOutcome(fixture, match)).toEqual({ status: 'unresolved', winner: null });
    });

    it('returns null when the match has not actually finished yet', () => {
        const match = { status: 'live', result: undefined };
        expect(decideFixtureOutcome(fixture, match)).toBeNull();
    });
});

describe('isTournamentComplete', () => {
    it('round_robin: true once nothing is left scheduled, including ties', () => {
        const fixtures = [
            { round: 1, status: 'completed' },
            { round: 1, status: 'unresolved' },
            { round: 2, status: 'bye' },
        ];
        expect(isTournamentComplete('round_robin', fixtures)).toBe(true);
    });

    it('round_robin: false while any fixture is still scheduled', () => {
        const fixtures = [
            { round: 1, status: 'completed' },
            { round: 1, status: 'scheduled' },
        ];
        expect(isTournamentComplete('round_robin', fixtures)).toBe(false);
    });

    it('league: same rule as round_robin', () => {
        const fixtures = [{ round: 1, status: 'unresolved' }];
        expect(isTournamentComplete('league', fixtures)).toBe(true);
    });

    it('knockout: false while an earlier round still has a fixture in progress', () => {
        const fixtures = [
            { round: 1, status: 'completed' },
            { round: 1, status: 'scheduled' },
        ];
        expect(isTournamentComplete('knockout', fixtures)).toBe(false);
    });

    it('knockout: false when the latest round has more than one fixture, even if all resolved', () => {
        const fixtures = [
            { round: 1, status: 'bye' },
            { round: 1, status: 'bye' },
            { round: 2, status: 'completed' },
            { round: 2, status: 'completed' },
        ];
        expect(isTournamentComplete('knockout', fixtures)).toBe(false);
    });

    it('knockout: true once the sole final-round fixture is completed', () => {
        const fixtures = [
            { round: 1, status: 'bye' },
            { round: 1, status: 'bye' },
            { round: 2, status: 'completed' },
        ];
        expect(isTournamentComplete('knockout', fixtures)).toBe(true);
    });

    it('knockout: false when the sole final-round fixture is only unresolved (a tied final has no champion yet)', () => {
        const fixtures = [
            { round: 1, status: 'completed' },
            { round: 2, status: 'unresolved' },
        ];
        expect(isTournamentComplete('knockout', fixtures)).toBe(false);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- resolveFixtureOutcome.test.js`
Expected: FAIL — `Cannot find module '../src/utils/resolveFixtureOutcome.js'`

- [ ] **Step 3: Write the implementation**

Create `src/utils/resolveFixtureOutcome.js`:

```javascript
// Pure decision logic for turning a finished Match into a Fixture outcome,
// and for deciding whether an entire tournament's schedule is now fully
// resolved. No Mongoose here — Task 6 is what loads real documents and
// applies what these functions decide.

// `fixture` needs only {teamA, teamB}; `match` needs only
// {status, result: {winner}}. Returns null when the match hasn't actually
// finished yet — callers only invoke this once they know it has.
export const decideFixtureOutcome = (fixture, match) => {
    if (match.status === 'abandoned') {
        return { status: 'unresolved', winner: null };
    }

    const outcome = match.result?.winner;
    if (outcome === 'tie' || outcome === 'no_result') {
        return { status: 'unresolved', winner: null };
    }
    if (outcome === 'teamA') {
        return { status: 'completed', winner: fixture.teamA };
    }
    if (outcome === 'teamB') {
        return { status: 'completed', winner: fixture.teamB };
    }
    return null;
};

// `fixtures` needs only {round, status} per entry — every fixture generated
// so far for one tournament. `unresolved` means something different per
// format: round_robin/league treat a tie/no-result as a normal terminal
// state (nothing to advance), so it counts as done; knockout cannot advance
// without a real winner, so an unresolved fixture — anywhere, including the
// final — blocks completion until the owner manually resolves it via
// PATCH .../fixtures/:fixtureId.
export const isTournamentComplete = (format, fixtures) => {
    if (format === 'knockout') {
        const stillPending = fixtures.some(
            (f) => f.status === 'scheduled' || f.status === 'unresolved'
        );
        if (stillPending) return false;

        const maxRound = Math.max(...fixtures.map((f) => f.round));
        const finalRoundFixtures = fixtures.filter((f) => f.round === maxRound);
        return finalRoundFixtures.length === 1 && finalRoundFixtures[0].status === 'completed';
    }

    // round_robin / league: complete once nothing is left scheduled.
    return fixtures.every((f) => f.status !== 'scheduled');
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- resolveFixtureOutcome.test.js`
Expected: PASS, 12 tests

- [ ] **Step 5: Commit**

```bash
git add src/utils/resolveFixtureOutcome.js tests/resolveFixtureOutcome.test.js
git commit -m "feat: add pure fixture-outcome and tournament-completion logic"
```

---

### Task 4: Generate and list fixtures, roster lock

**Files:**
- Create: `src/controllers/fixture.controller.js`
- Modify: `src/controllers/tournament.controller.js` (roster lock in `addTournamentTeam`/`removeTournamentTeam`)
- Modify: `src/routes/tournament.routes.js`
- Modify: `src/locales/{en,hi,mr}/common.json`
- Test: `tests/fixture.test.js`
- Test: Modify `tests/tournament.test.js` (roster-lock cases)

**Interfaces:**
- Consumes: `Fixture`/`FIXTURE_STATUS` (Task 2), `buildRoundRobinRounds`/`buildLeagueRounds`/`buildKnockoutRound1`/`buildKnockoutNextRound` (Task 1), `isTournamentComplete` (Task 3), `findAccessibleTournament`/`findOwnedTournament` (already exported from `tournament.controller.js`).
- Produces: `generateFixtures`, `listFixtures`, `serializeFixture` exported from `fixture.controller.js`. Task 5/6 import `serializeFixture` and mount more routes in `tournament.routes.js` alongside these.

- [ ] **Step 1: Write the failing tests**

Create `tests/fixture.test.js`:

```javascript
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Fixture } from '../src/models/fixture.model.js';

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

const removeTeamFromTournament = (token, tournamentId, teamId) =>
    request(app).delete(`/api/v1/tournament/${tournamentId}/teams/${teamId}`).set('Authorization', `Bearer ${token}`).send();

const generateFixtures = (token, tournamentId) =>
    request(app).post(`/api/v1/tournament/${tournamentId}/fixtures`).set('Authorization', `Bearer ${token}`).send();

const listFixtures = (token, tournamentId) =>
    request(app).get(`/api/v1/tournament/${tournamentId}/fixtures`).set('Authorization', `Bearer ${token}`).send();

// Creates an org, a tournament of `format`, and `count` teams already
// enrolled into it (in creation order, matching enrollment/seeding order).
// Returns { token, orgId, tournamentId, teamIds }.
const setupTournamentWithTeams = async (format, count) => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer Cup', format });
    const tournamentId = tournamentRes.body.data.id;

    const teamIds = [];
    for (let i = 0; i < count; i += 1) {
        const teamRes = await createOrgTeam(token, orgId, { name: `Team ${i}` });
        const teamId = teamRes.body.data.id;
        await addTeamToTournament(token, tournamentId, teamId);
        teamIds.push(teamId);
    }

    return { token, orgId, tournamentId, teamIds };
};

describe('POST /v1/tournament/:tournamentId/fixtures', () => {
    it('generates a full round-robin schedule for 4 teams in one call', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 4);

        const res = await generateFixtures(token, tournamentId);

        expect(res.status).toBe(200);
        expect(res.body.data.round).toBe(1);
        expect(res.body.data.fixtures).toHaveLength(2); // round 1 only, in the response

        const all = await listFixtures(token, tournamentId);
        expect(all.body.data.fixtures).toHaveLength(6); // C(4,2) total across 3 rounds
        expect(all.body.data.fixtures.every((f) => f.status === 'scheduled')).toBe(true);
    });

    it('generates a doubled schedule for a league of 4 teams', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('league', 4);

        await generateFixtures(token, tournamentId);

        const all = await listFixtures(token, tournamentId);
        expect(all.body.data.fixtures).toHaveLength(12); // 2x round-robin
    });

    it('generates only round 1 for a knockout, with byes for the earliest-enrolled teams', async () => {
        const { token, tournamentId, teamIds } = await setupTournamentWithTeams('knockout', 6);

        const res = await generateFixtures(token, tournamentId);

        expect(res.status).toBe(200);
        expect(res.body.data.round).toBe(1);
        expect(res.body.data.fixtures).toHaveLength(4); // 2 byes + 2 real matches (field of 8)

        const byes = res.body.data.fixtures.filter((f) => f.isBye);
        expect(byes).toHaveLength(2);
        expect(byes.map((f) => f.teamA.id).sort()).toEqual([teamIds[0], teamIds[1]].sort());
        byes.forEach((f) => {
            expect(f.status).toBe('bye');
            expect(f.winner.id).toBe(f.teamA.id);
        });
    });

    it('400s for a round_robin tournament with fewer than 3 teams', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 2);

        const res = await generateFixtures(token, tournamentId);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INSUFFICIENT_TEAMS_FOR_FORMAT');
    });

    it('allows a knockout with exactly 2 teams and auto-completes the tournament immediately (round 1 is the final)', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', 2);

        const res = await generateFixtures(token, tournamentId);
        expect(res.status).toBe(200);
        expect(res.body.data.fixtures).toHaveLength(1);

        const tournament = await Tournament.findById(tournamentId);
        // Not complete yet — the one fixture is 'scheduled', no match played.
        expect(tournament.status).toBe('upcoming');
    });

    it('409s calling generate again on an already-generated round_robin tournament', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);

        const res = await generateFixtures(token, tournamentId);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('FIXTURES_ALREADY_GENERATED');
    });

    it('400s advancing a knockout round before its current round is fully resolved', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', 4);
        await generateFixtures(token, tournamentId); // round 1, 2 scheduled matches, no byes

        const res = await generateFixtures(token, tournamentId);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ROUND_NOT_COMPLETE');
    });

    it('403s when a non-owner member tries to generate fixtures', async () => {
        const { token: ownerToken, orgId, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
        await request(app)
            .post(`/api/v1/organization/${orgId}/members`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ email: 'member@example.com' });

        const res = await generateFixtures(memberToken, tournamentId);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
    });
});

describe('GET /v1/tournament/:tournamentId/fixtures', () => {
    it('lists fixtures sorted by round then order with populated team names', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);

        const res = await listFixtures(token, tournamentId);

        expect(res.status).toBe(200);
        expect(res.body.data.fixtures.length).toBeGreaterThan(0);
        res.body.data.fixtures.forEach((f) => {
            expect(f.teamA.name).toEqual(expect.any(String));
        });
    });
});

describe('tournament roster lock', () => {
    it('blocks enrolling a new team once fixtures exist', async () => {
        const { token, orgId, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const extraTeamRes = await createOrgTeam(token, orgId, { name: 'Latecomer FC' });

        const res = await addTeamToTournament(token, tournamentId, extraTeamRes.body.data.id);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TOURNAMENT_FIXTURES_LOCKED');
    });

    it('blocks removing a team once fixtures exist', async () => {
        const { token, tournamentId, teamIds } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);

        const res = await removeTeamFromTournament(token, tournamentId, teamIds[0]);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TOURNAMENT_FIXTURES_LOCKED');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- fixture.test.js`
Expected: FAIL — `Cannot find module '../src/controllers/fixture.controller.js'` (and the roster-lock tests fail with 200 instead of 409, since the lock doesn't exist yet)

- [ ] **Step 3: Write the implementation**

Create `src/controllers/fixture.controller.js`:

```javascript
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Fixture } from '../models/fixture.model.js';
import { findAccessibleTournament, findOwnedTournament } from './tournament.controller.js';
import {
    buildRoundRobinRounds,
    buildLeagueRounds,
    buildKnockoutRound1,
    buildKnockoutNextRound,
} from '../utils/generateFixtures.js';
import { isTournamentComplete } from '../utils/resolveFixtureOutcome.js';

const MIN_TEAMS = { knockout: 2, round_robin: 3, league: 3 };

const populateFixtures = (fixtures) =>
    Fixture.populate(fixtures, [
        { path: 'teamA', select: 'name shortName' },
        { path: 'teamB', select: 'name shortName' },
        { path: 'winner', select: 'name' },
    ]);

// Exported so Task 5/6's endpoints render a fixture the same way this one
// does — one shape for "a fixture" across the whole feature.
export const serializeFixture = (fixture) => ({
    id: fixture._id,
    round: fixture.round,
    order: fixture.order,
    teamA: fixture.teamA ? { id: fixture.teamA._id, name: fixture.teamA.name, shortName: fixture.teamA.shortName ?? null } : null,
    teamB: fixture.teamB ? { id: fixture.teamB._id, name: fixture.teamB.name, shortName: fixture.teamB.shortName ?? null } : null,
    isBye: fixture.isBye,
    status: fixture.status,
    winner: fixture.winner ? { id: fixture.winner._id, name: fixture.winner.name } : null,
    matchId: fixture.match ?? null,
});

const slotsToDocs = (tournamentId, round, slots) =>
    slots.map((slot, order) => ({
        tournament: tournamentId,
        round,
        order,
        teamA: slot.teamA,
        teamB: slot.teamB,
        isBye: slot.isBye,
        status: slot.isBye ? 'bye' : 'scheduled',
        winner: slot.isBye ? slot.teamA : null,
    }));

// Checks the whole tournament's fixtures for completion and, if resolved,
// flips Tournament.status. Shared by three call sites: this task's own
// "generate round 1 of a 2-team knockout" (which never touches a Match at
// all, so nothing else would ever check it), Task 6's match-completion hook
// (which passes `session` since it runs inside scoreBall's transaction),
// and Task 6's manual-resolve endpoint (no session, same as this one).
export const checkTournamentCompletion = async (tournament, { session } = {}) => {
    if (tournament.status === 'completed') return;
    const allFixtures = await Fixture.find({ tournament: tournament._id }, 'round status').session(session ?? null);
    if (isTournamentComplete(tournament.format, allFixtures)) {
        tournament.status = 'completed';
        await tournament.save({ session });
    }
};

export const generateFixtures = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    if (tournament.status === 'completed') {
        throw new ApiError(409, "TOURNAMENT_ALREADY_COMPLETE");
    }

    const existingFixtures = await Fixture.find({ tournament: tournament._id }).sort({ round: 1, order: 1 });

    if (existingFixtures.length === 0) {
        const minTeams = MIN_TEAMS[tournament.format];
        if (tournament.teams.length < minTeams) {
            throw new ApiError(400, "INSUFFICIENT_TEAMS_FOR_FORMAT");
        }

        const teamIds = tournament.teams.map((entry) => entry.team);
        const roundsOfSlots =
            tournament.format === 'knockout' ? [buildKnockoutRound1(teamIds)]
            : tournament.format === 'league' ? buildLeagueRounds(teamIds)
            : buildRoundRobinRounds(teamIds);

        const docs = roundsOfSlots.flatMap((slots, i) => slotsToDocs(tournament._id, i + 1, slots));
        await Fixture.insertMany(docs);

        // A 2-team knockout's round 1 IS the final — check immediately,
        // since this path never touches a Match to trigger the usual hook.
        if (tournament.format === 'knockout') {
            await checkTournamentCompletion(tournament);
        }

        const round1 = await Fixture.find({ tournament: tournament._id, round: 1 }).sort({ order: 1 });
        await populateFixtures(round1);

        return res.status(200).json(new ApiResponse(200, {
            tournamentId: tournament._id,
            round: 1,
            fixtures: round1.map(serializeFixture),
        }, req.t("FIXTURES_GENERATED")));
    }

    if (tournament.format !== 'knockout') {
        throw new ApiError(409, "FIXTURES_ALREADY_GENERATED");
    }

    const maxRound = Math.max(...existingFixtures.map((f) => f.round));
    const latestRound = existingFixtures.filter((f) => f.round === maxRound);

    if (latestRound.length === 1) {
        throw new ApiError(409, "TOURNAMENT_ALREADY_COMPLETE");
    }
    if (latestRound.some((f) => f.status === 'scheduled' || f.status === 'unresolved')) {
        throw new ApiError(400, "ROUND_NOT_COMPLETE");
    }

    const winnerIds = latestRound.map((f) => f.winner);
    const slots = buildKnockoutNextRound(winnerIds);
    const docs = slotsToDocs(tournament._id, maxRound + 1, slots);
    await Fixture.insertMany(docs);

    const nextRound = await Fixture.find({ tournament: tournament._id, round: maxRound + 1 }).sort({ order: 1 });
    await populateFixtures(nextRound);

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        round: maxRound + 1,
        fixtures: nextRound.map(serializeFixture),
    }, req.t("FIXTURES_GENERATED")));
});

export const listFixtures = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);

    const fixtures = await Fixture.find({ tournament: tournament._id }).sort({ round: 1, order: 1 });
    await populateFixtures(fixtures);

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        fixtures: fixtures.map(serializeFixture),
    }, req.t("FIXTURES_FETCHED")));
});
```

Modify `src/controllers/tournament.controller.js`:

1. Add the import at the top, alongside the existing `Team` import:

```javascript
import { Fixture } from '../models/fixture.model.js';
```

2. In `addTournamentTeam`, right after the `const { tournament, org } = await findOwnedTournament(...)` line, add:

```javascript
    if (await Fixture.exists({ tournament: tournament._id })) {
        throw new ApiError(409, "TOURNAMENT_FIXTURES_LOCKED");
    }
```

3. In `removeTournamentTeam`, right after its own `const { tournament } = await findOwnedTournament(...)` line, add the same check:

```javascript
    if (await Fixture.exists({ tournament: tournament._id })) {
        throw new ApiError(409, "TOURNAMENT_FIXTURES_LOCKED");
    }
```

Modify `src/routes/tournament.routes.js` to add the two new routes:

```javascript
import { Router } from "express";
import { getTournament, updateTournament, deleteTournament, addTournamentTeam, removeTournamentTeam } from "../controllers/tournament.controller.js";
import { generateFixtures, listFixtures } from "../controllers/fixture.controller.js";
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

export default router;
```

Add these 7 new keys to all three of `src/locales/en/common.json`, `src/locales/hi/common.json`, `src/locales/mr/common.json` — insert them right after the existing `"TEAM_REMOVED_FROM_TOURNAMENT"` line in each file (keep valid JSON: add a trailing comma to that line):

`src/locales/en/common.json`:
```json
  "TEAM_REMOVED_FROM_TOURNAMENT": "Team removed from tournament",
  "TOURNAMENT_FIXTURES_LOCKED": "This tournament's fixtures are already generated — the team roster is locked",
  "INSUFFICIENT_TEAMS_FOR_FORMAT": "Not enough teams enrolled for this tournament's format",
  "FIXTURES_ALREADY_GENERATED": "Fixtures have already been generated for this tournament",
  "ROUND_NOT_COMPLETE": "Every fixture in the current round must be resolved before the next round can be generated",
  "TOURNAMENT_ALREADY_COMPLETE": "This tournament is already complete",
  "FIXTURES_GENERATED": "Fixtures generated",
  "FIXTURES_FETCHED": "Fixtures fetched",
```

`src/locales/hi/common.json`:
```json
  "TEAM_REMOVED_FROM_TOURNAMENT": "टीम को टूर्नामेंट से हटाया गया",
  "TOURNAMENT_FIXTURES_LOCKED": "इस टूर्नामेंट के फिक्स्चर पहले ही बन चुके हैं — टीम सूची लॉक है",
  "INSUFFICIENT_TEAMS_FOR_FORMAT": "इस टूर्नामेंट प्रारूप के लिए पर्याप्त टीमें नहीं जोड़ी गई हैं",
  "FIXTURES_ALREADY_GENERATED": "इस टूर्नामेंट के फिक्स्चर पहले ही बनाए जा चुके हैं",
  "ROUND_NOT_COMPLETE": "अगला राउंड बनाने से पहले मौजूदा राउंड के सभी फिक्स्चर तय होने चाहिए",
  "TOURNAMENT_ALREADY_COMPLETE": "यह टूर्नामेंट पहले ही पूरा हो चुका है",
  "FIXTURES_GENERATED": "फिक्स्चर बनाए गए",
  "FIXTURES_FETCHED": "फिक्स्चर प्राप्त हुए",
```

`src/locales/mr/common.json`:
```json
  "TEAM_REMOVED_FROM_TOURNAMENT": "संघ स्पर्धेतून काढला",
  "TOURNAMENT_FIXTURES_LOCKED": "या स्पर्धेचे फिक्स्चर आधीच तयार झाले आहेत — संघ यादी लॉक आहे",
  "INSUFFICIENT_TEAMS_FOR_FORMAT": "या स्पर्धा प्रकारासाठी पुरेसे संघ नोंदवलेले नाहीत",
  "FIXTURES_ALREADY_GENERATED": "या स्पर्धेचे फिक्स्चर आधीच तयार केले गेले आहेत",
  "ROUND_NOT_COMPLETE": "पुढील फेरी तयार करण्यापूर्वी सध्याच्या फेरीतील सर्व फिक्स्चर निकाली निघणे आवश्यक आहे",
  "TOURNAMENT_ALREADY_COMPLETE": "ही स्पर्धा आधीच पूर्ण झाली आहे",
  "FIXTURES_GENERATED": "फिक्स्चर तयार झाले",
  "FIXTURES_FETCHED": "फिक्स्चर मिळाले",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- fixture.test.js tournament.test.js`
Expected: PASS, all tests in both files

Run: `npm test -- locales.test.js routes.auth.test.js`
Expected: PASS — locale parity holds, and the two new fixture routes carry `verifyJwt` so the auth allowlist test needs no changes

- [ ] **Step 5: Commit**

```bash
git add src/controllers/fixture.controller.js src/controllers/tournament.controller.js src/routes/tournament.routes.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json tests/fixture.test.js
git commit -m "feat: generate and list tournament fixtures, lock roster once generated"
```

---

### Task 5: Start a fixture into a real Match

**Files:**
- Modify: `src/controllers/match.controller.js` (export `createMatchWithJoinCode`)
- Modify: `src/controllers/fixture.controller.js` (add `startFixtureMatch`)
- Modify: `src/routes/tournament.routes.js`
- Modify: `src/locales/{en,hi,mr}/common.json`
- Test: append to `tests/fixture.test.js`

**Interfaces:**
- Consumes: `createMatchWithJoinCode(fields): Promise<Match>` (exported this task from `match.controller.js`), `resolveToss` (`src/utils/resolveToss.js`, already exists), `serializeFixture` (Task 4).
- Produces: `startFixtureMatch` exported from `fixture.controller.js`, mounted at `POST /:tournamentId/fixtures/:fixtureId/start-match`. Task 6's tests create matches through this endpoint to then drive them to completion.

- [ ] **Step 1: Write the failing tests**

Append to `tests/fixture.test.js` (same file, new `describe` block; the helpers/imports from Task 4 are already in scope):

```javascript
const startFixtureMatch = (token, tournamentId, fixtureId, body) =>
    request(app)
        .post(`/api/v1/tournament/${tournamentId}/fixtures/${fixtureId}/start-match`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

describe('POST /v1/tournament/:tournamentId/fixtures/:fixtureId/start-match', () => {
    it('creates a real match for a scheduled fixture', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const fixtures = (await listFixtures(token, tournamentId)).body.data.fixtures;
        const scheduled = fixtures.find((f) => f.status === 'scheduled');

        const res = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });

        expect(res.status).toBe(200);
        expect(res.body.data.matchId).toEqual(expect.any(String));
        expect(res.body.data.fixtureId).toBe(scheduled.id);
        expect(res.body.data.joinCode).toHaveLength(6);

        const updatedFixture = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.id === scheduled.id);
        expect(updatedFixture.matchId).toBe(res.body.data.matchId);
    });

    it('409s starting a fixture that already has a match', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');
        await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });

        const res = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('FIXTURE_ALREADY_STARTED');
    });

    it('400s starting a bye fixture', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', 3);
        await generateFixtures(token, tournamentId);
        const bye = (await listFixtures(token, tournamentId)).body.data.fixtures.find((f) => f.isBye);

        const res = await startFixtureMatch(token, tournamentId, bye.id, { totalOvers: 20 });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('FIXTURE_NOT_SCHEDULED');
    });

    it('400s an invalid overs value, same rule as POST /v1/match', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');

        const res = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 0 });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_OVERS_FORMAT');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- fixture.test.js`
Expected: FAIL — the route doesn't exist (404), so the new `describe` block's assertions on `res.body.data`/`res.body.code` fail

- [ ] **Step 3: Write the implementation**

Modify `src/controllers/match.controller.js` — change only the final export line to also export `createMatchWithJoinCode`:

```javascript
export { createMatch, startInnings, selectBowler, scoreBall, undoBall, syncMatch, getMatchScorecard, getPublicMatch, abandonMatch, deleteMatch, getMatchHistory, assignScorer, getScorerCandidates, createMatchWithJoinCode, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT };
```

Add to `src/controllers/fixture.controller.js` — new imports at the top:

```javascript
import mongoose from 'mongoose';
import { createMatchWithJoinCode } from './match.controller.js';
import { resolveToss } from '../utils/resolveToss.js';
```

And the new handler, appended to the file:

```javascript
const MIN_OVERS = 1;
const MAX_OVERS = 50;

export const startFixtureMatch = catchAsync(async (req, res) => {
    const { tournamentId, fixtureId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);

    const fixture = await Fixture.findOne({ _id: fixtureId, tournament: tournament._id })
        .populate('teamA', 'name')
        .populate('teamB', 'name');
    if (!fixture) {
        throw new ApiError(404, "FIXTURE_NOT_FOUND");
    }
    if (fixture.isBye || fixture.status !== 'scheduled') {
        throw new ApiError(400, "FIXTURE_NOT_SCHEDULED");
    }
    if (fixture.match) {
        throw new ApiError(409, "FIXTURE_ALREADY_STARTED");
    }

    const { totalOvers, tossWinner, tossDecision } = req.body;
    if (!Number.isInteger(totalOvers) || totalOvers < MIN_OVERS || totalOvers > MAX_OVERS) {
        throw new ApiError(400, "INVALID_OVERS_FORMAT");
    }
    const toss = resolveToss({ tossWinner, tossDecision });
    if (!toss.valid) {
        throw new ApiError(400, "INVALID_TOSS_RESULT");
    }

    const match = await createMatchWithJoinCode({
        teamA: fixture.teamA._id,
        teamB: fixture.teamB._id,
        totalOvers,
        tossWinner: toss.tossWinner ?? undefined,
        tossDecision: toss.tossDecision ?? undefined,
        battingFirst: toss.battingFirst,
        createdBy: req.user._id,
        matchType: 'tournament',
        tournament: tournament._id,
        fixture: fixture._id,
    });

    // Atomic claim: a filter requiring `match: null` means a concurrent
    // second call loses the race here rather than both succeeding — the
    // Match this call already created is a harmless orphan in that case,
    // same tolerance this codebase already extends to an orphan Team/Player
    // from a losing findOneAndUpdate race elsewhere.
    const claimed = await Fixture.findOneAndUpdate(
        { _id: fixture._id, match: null },
        { $set: { match: match._id } }
    );
    if (!claimed) {
        throw new ApiError(409, "FIXTURE_ALREADY_STARTED");
    }

    return res.status(200).json(new ApiResponse(200, {
        matchId: match._id,
        fixtureId: fixture._id,
        tournamentId: tournament._id,
        joinCode: match.joinCode,
        teamA: { id: fixture.teamA._id, name: fixture.teamA.name },
        teamB: { id: fixture.teamB._id, name: fixture.teamB.name },
        totalOvers: match.totalOvers,
        tossWinner: match.tossWinner ?? null,
        tossDecision: match.tossDecision ?? null,
        status: match.status,
        syncStatus: match.syncStatus,
        createdAt: match.createdAt,
    }, req.t("MATCH_CREATED")));
});
```

Remove the now-unused `mongoose` import if nothing else in the file uses it yet — check with `grep -n "mongoose\." src/controllers/fixture.controller.js`; if it's unused after this step, delete the `import mongoose from 'mongoose';` line (Task 6 will need it again for `PATCH .../fixtures/:fixtureId`, but re-add it there rather than leaving an unused import in between).

Modify `src/routes/tournament.routes.js`:

```javascript
import { Router } from "express";
import { getTournament, updateTournament, deleteTournament, addTournamentTeam, removeTournamentTeam } from "../controllers/tournament.controller.js";
import { generateFixtures, listFixtures, startFixtureMatch } from "../controllers/fixture.controller.js";
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
router.route('/:tournamentId/fixtures/:fixtureId/start-match').post(verifyJwt, startFixtureMatch);

export default router;
```

Add 2 more keys to all three locale files, right after the `"FIXTURES_FETCHED"` line added in Task 4 (add a trailing comma to that line):

`src/locales/en/common.json`:
```json
  "FIXTURES_FETCHED": "Fixtures fetched",
  "FIXTURE_NOT_FOUND": "That fixture couldn't be found",
  "FIXTURE_NOT_SCHEDULED": "This fixture can't be started — it's a bye, or already decided",
  "FIXTURE_ALREADY_STARTED": "This fixture already has a match",
```

`src/locales/hi/common.json`:
```json
  "FIXTURES_FETCHED": "फिक्स्चर प्राप्त हुए",
  "FIXTURE_NOT_FOUND": "वह फिक्स्चर नहीं मिल सका",
  "FIXTURE_NOT_SCHEDULED": "यह फिक्स्चर शुरू नहीं किया जा सकता — यह बाई है, या पहले ही तय हो चुका है",
  "FIXTURE_ALREADY_STARTED": "इस फिक्स्चर का मैच पहले ही बन चुका है",
```

`src/locales/mr/common.json`:
```json
  "FIXTURES_FETCHED": "फिक्स्चर मिळाले",
  "FIXTURE_NOT_FOUND": "तो फिक्स्चर सापडला नाही",
  "FIXTURE_NOT_SCHEDULED": "हा फिक्स्चर सुरू करता येणार नाही — तो बाय आहे, किंवा आधीच निकाली निघाला आहे",
  "FIXTURE_ALREADY_STARTED": "या फिक्स्चरचा सामना आधीच तयार झाला आहे",
```

(Note: `MATCH_CREATED`, `INVALID_OVERS_FORMAT`, `INVALID_TOSS_RESULT` already exist from the match feature — reused as-is, no new key needed for those three.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- fixture.test.js`
Expected: PASS, all tests including the new `start-match` block

Run: `npm test -- locales.test.js routes.auth.test.js match.test.js`
Expected: PASS — locale parity holds, the new route carries `verifyJwt`, and exporting `createMatchWithJoinCode` doesn't change `match.controller.js`'s existing behavior

- [ ] **Step 5: Commit**

```bash
git add src/controllers/match.controller.js src/controllers/fixture.controller.js src/routes/tournament.routes.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json tests/fixture.test.js
git commit -m "feat: start a scheduled fixture into a real scorable match"
```

---

### Task 6: Wire match outcomes back into fixtures, manual resolution, bracket progression end-to-end

**Files:**
- Modify: `src/controllers/match.controller.js` (`applyDelivery`, `abandonMatch`)
- Modify: `src/controllers/fixture.controller.js` (add `resolveFixture`, `resolveFixtureAfterMatch`)
- Modify: `src/routes/tournament.routes.js`
- Modify: `src/locales/{en,hi,mr}/common.json`
- Test: append to `tests/fixture.test.js`

**Interfaces:**
- Consumes: `decideFixtureOutcome`, `isTournamentComplete` (Task 3), `checkTournamentCompletion` (Task 4, already exported from `fixture.controller.js`).
- Produces: `resolveFixtureAfterMatch(match, {session}?): Promise<void>` exported from `fixture.controller.js`, called from both `match.controller.js` hook points. `resolveFixture` mounted at `PATCH /:tournamentId/fixtures/:fixtureId`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/fixture.test.js`. This block completes a match through the
real scoring flow using the existing `tests/helpers/matchSetup.js` helpers
(`startLiveInnings`, `scoreDotBall` — the latter takes `overrides` despite
its name, so `{ runs: 1 }` works fine) rather than hand-rolled request
builders — add this import at the top of the file alongside the other
imports:

```javascript
import { startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
```

```javascript
const abandonMatch = (token, matchId) =>
    request(app).delete(`/api/v1/match/${matchId}/abandon`).set('Authorization', `Bearer ${token}`).send();

const resolveFixture = (token, tournamentId, fixtureId, body) =>
    request(app)
        .patch(`/api/v1/tournament/${tournamentId}/fixtures/${fixtureId}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

// Plays out a 1-over-per-side match: 6 balls at 1 run each for the team
// batting first (total 6), then 6 dot balls for the team batting second
// (total 0) — deterministic win for whichever team the fixture set as
// battingFirst, no wickets, no extras, so the match completes cleanly with
// a real winner rather than a tie.
const playOutMatch = async (token, matchId) => {
    await startLiveInnings(app, token, matchId, {
        strikerName: 'A1', nonStrikerName: 'A2', bowlerName: 'B1',
    });
    for (let i = 0; i < 6; i += 1) {
        const res = await scoreDotBall(app, token, matchId, { runs: 1 });
        expect(res.status).toBe(200);
    }
    await startLiveInnings(app, token, matchId, {
        strikerName: 'B1', nonStrikerName: 'B2', bowlerName: 'A1',
    });
    for (let i = 0; i < 6; i += 1) {
        const res = await scoreDotBall(app, token, matchId);
        expect(res.status).toBe(200);
    }
};

describe('match completion resolves the linked fixture', () => {
    it('marks the fixture completed with the winning team once the match finishes', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');
        const started = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 1 });

        await playOutMatch(token, started.body.data.matchId);

        const updated = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.id === scheduled.id);
        expect(updated.status).toBe('completed');
        expect(updated.winner).not.toBeNull();
    });

    it('marks the fixture unresolved when the match is abandoned', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');
        const started = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });

        await abandonMatch(token, started.body.data.matchId);

        const updated = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.id === scheduled.id);
        expect(updated.status).toBe('unresolved');
        expect(updated.winner).toBeNull();
    });
});

describe('PATCH /v1/tournament/:tournamentId/fixtures/:fixtureId', () => {
    it('lets the owner manually resolve an unresolved fixture', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');
        const started = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });
        await abandonMatch(token, started.body.data.matchId);

        const res = await resolveFixture(token, tournamentId, scheduled.id, { winner: scheduled.teamA.id });

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('completed');
        expect(res.body.data.winner.id).toBe(scheduled.teamA.id);
    });

    it("400s resolving a fixture that isn't unresolved", async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');

        const res = await resolveFixture(token, tournamentId, scheduled.id, { winner: scheduled.teamA.id });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('FIXTURE_NOT_UNRESOLVED');
    });

    it("400s a winner that isn't one of the fixture's two teams", async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');
        const started = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });
        await abandonMatch(token, started.body.data.matchId);

        const res = await resolveFixture(token, tournamentId, scheduled.id, { winner: '665f1a2b3c4d5e6f7a8b9c99' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_FIXTURE_WINNER');
    });
});

describe('knockout bracket progression end-to-end', () => {
    it('advances a 4-team knockout through both rounds and auto-completes the tournament', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', 4);
        await generateFixtures(token, tournamentId); // round 1: 2 matches, no byes

        let round1 = (await listFixtures(token, tournamentId)).body.data.fixtures
            .filter((f) => f.round === 1);
        for (const fixture of round1) {
            const started = await startFixtureMatch(token, tournamentId, fixture.id, { totalOvers: 1 });
            await playOutMatch(token, started.body.data.matchId);
        }

        const round2Res = await generateFixtures(token, tournamentId);
        expect(round2Res.status).toBe(200);
        expect(round2Res.body.data.round).toBe(2);
        expect(round2Res.body.data.fixtures).toHaveLength(1); // the final

        const final = round2Res.body.data.fixtures[0];
        const startedFinal = await startFixtureMatch(token, tournamentId, final.id, { totalOvers: 1 });
        await playOutMatch(token, startedFinal.body.data.matchId);

        const tournament = await Tournament.findById(tournamentId);
        expect(tournament.status).toBe('completed');

        // No further round to generate.
        const afterFinal = await generateFixtures(token, tournamentId);
        expect(afterFinal.status).toBe(409);
        expect(afterFinal.body.code).toBe('TOURNAMENT_ALREADY_COMPLETE');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- fixture.test.js`
Expected: FAIL — `PATCH .../fixtures/:fixtureId` 404s (route doesn't exist), and match completion doesn't touch the fixture at all yet (`updated.status` stays `'scheduled'`)

- [ ] **Step 3: Write the implementation**

Add to `src/controllers/fixture.controller.js` — re-add the `mongoose` import removed in Task 5, and add `decideFixtureOutcome` to the existing `../utils/resolveFixtureOutcome.js` import line (which already has `isTournamentComplete` from Task 4 — extend that line, don't duplicate it):

```javascript
import mongoose from 'mongoose';
```
```javascript
import { isTournamentComplete, decideFixtureOutcome } from '../utils/resolveFixtureOutcome.js';
```

Append to `src/controllers/fixture.controller.js`:

```javascript
const asString = (value) => (typeof value === 'string' ? value : '');

// Called once a Match tied to a fixture reaches a terminal state
// ('completed' with a result, or 'abandoned'). Shared by the scoreBall/
// syncMatch completion path (inside a transaction, via `session`) and
// abandonMatch (best-effort, no transaction — same tolerance this codebase
// already gives generateScorecard's own post-abandon call).
export const resolveFixtureAfterMatch = async (match, { session } = {}) => {
    if (!match.fixture) return;

    const fixture = await Fixture.findById(match.fixture).session(session ?? null);
    if (!fixture) return;

    const outcome = decideFixtureOutcome(fixture, match);
    if (!outcome) return;

    fixture.status = outcome.status;
    fixture.winner = outcome.winner;
    await fixture.save({ session });

    const tournament = await Tournament.findById(fixture.tournament).session(session ?? null);
    if (!tournament) return;
    await checkTournamentCompletion(tournament, { session });
};

export const resolveFixture = catchAsync(async (req, res) => {
    const { tournamentId, fixtureId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    const fixture = await Fixture.findOne({ _id: fixtureId, tournament: tournament._id });
    if (!fixture) {
        throw new ApiError(404, "FIXTURE_NOT_FOUND");
    }
    if (fixture.status !== 'unresolved') {
        throw new ApiError(400, "FIXTURE_NOT_UNRESOLVED");
    }

    const winnerId = asString(req.body.winner).trim();
    if (!winnerId) {
        throw new ApiError(400, "FIXTURE_WINNER_REQUIRED");
    }
    if (!mongoose.Types.ObjectId.isValid(winnerId)) {
        throw new ApiError(400, "INVALID_ID");
    }
    if (![String(fixture.teamA), String(fixture.teamB)].includes(winnerId)) {
        throw new ApiError(400, "INVALID_FIXTURE_WINNER");
    }

    fixture.status = 'completed';
    fixture.winner = winnerId;
    await fixture.save();

    await checkTournamentCompletion(tournament);

    await fixture.populate('winner', 'name');
    return res.status(200).json(new ApiResponse(200, {
        fixtureId: fixture._id,
        status: fixture.status,
        winner: { id: fixture.winner._id, name: fixture.winner.name },
    }, req.t("FIXTURE_RESOLVED")));
});
```

Add the import for `Tournament` at the top of `fixture.controller.js` if it isn't already imported (Task 4 imported `Fixture` but not `Tournament` directly — `checkTournamentCompletion` from Task 4 receives a `tournament` document from its caller rather than loading one itself, so add):

```javascript
import { Tournament } from '../models/tournament.model.js';
```

Modify `src/controllers/match.controller.js`:

1. Add the import near the other util imports:

```javascript
import { resolveFixtureAfterMatch } from './fixture.controller.js';
```

This makes `match.controller.js` and `fixture.controller.js` import from
each other (`fixture.controller.js` already imports `createMatchWithJoinCode`
from here, from Task 5). This circular ES-module import is safe in Node:
both imported functions are only ever called from inside another function's
body (never at module-evaluation time), so by the time either runs, both
modules have already finished initializing. Step 4's test run below would
surface immediately if this were a problem — it isn't.

2. In `applyDelivery`, inside the `if (outcome.inningsComplete) { ... await match.save({ session }); }` block, right after `await match.save({ session });`, add:

```javascript
        if (matchJustCompleted) {
            await resolveFixtureAfterMatch(match, { session });
        }
```

3. In `abandonMatch`, right after the existing best-effort scorecard-generation `try`/`catch` block (the one logging `'scorecard generation failed on abandon'`), add a second best-effort block:

```javascript
    if (updated.fixture) {
        try {
            await resolveFixtureAfterMatch(updated);
        } catch (err) {
            console.error('fixture resolution failed on abandon', err);
        }
    }
```

Modify `src/routes/tournament.routes.js` — final version:

```javascript
import { Router } from "express";
import { getTournament, updateTournament, deleteTournament, addTournamentTeam, removeTournamentTeam } from "../controllers/tournament.controller.js";
import { generateFixtures, listFixtures, startFixtureMatch, resolveFixture } from "../controllers/fixture.controller.js";
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

export default router;
```

Add the final 4 locale keys to all three files, right after `"FIXTURE_ALREADY_STARTED"` (added in Task 5; add a trailing comma there):

`src/locales/en/common.json`:
```json
  "FIXTURE_ALREADY_STARTED": "This fixture already has a match",
  "FIXTURE_NOT_UNRESOLVED": "This fixture isn't awaiting manual resolution",
  "FIXTURE_WINNER_REQUIRED": "The advancing team must be specified",
  "INVALID_FIXTURE_WINNER": "That team isn't one of this fixture's two teams",
  "FIXTURE_RESOLVED": "Fixture resolved",
```

`src/locales/hi/common.json`:
```json
  "FIXTURE_ALREADY_STARTED": "इस फिक्स्चर का मैच पहले ही बन चुका है",
  "FIXTURE_NOT_UNRESOLVED": "यह फिक्स्चर मैनुअल निर्णय की प्रतीक्षा में नहीं है",
  "FIXTURE_WINNER_REQUIRED": "आगे बढ़ने वाली टीम बतानी आवश्यक है",
  "INVALID_FIXTURE_WINNER": "वह टीम इस फिक्स्चर की दोनों टीमों में से एक नहीं है",
  "FIXTURE_RESOLVED": "फिक्स्चर तय किया गया",
```

`src/locales/mr/common.json`:
```json
  "FIXTURE_ALREADY_STARTED": "या फिक्स्चरचा सामना आधीच तयार झाला आहे",
  "FIXTURE_NOT_UNRESOLVED": "हा फिक्स्चर मॅन्युअल निर्णयाच्या प्रतीक्षेत नाही",
  "FIXTURE_WINNER_REQUIRED": "पुढे जाणारा संघ नमूद करणे आवश्यक आहे",
  "INVALID_FIXTURE_WINNER": "तो संघ या फिक्स्चरच्या दोन संघांपैकी एक नाही",
  "FIXTURE_RESOLVED": "फिक्स्चर निकाली काढला",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- fixture.test.js`
Expected: PASS, every test in the file including the knockout end-to-end progression

Run: `npm test -- match.test.js locales.test.js routes.auth.test.js`
Expected: PASS — the two new `match.controller.js` hook points don't change behavior for any match with `fixture: null` (every existing match), locale parity holds, and the new `PATCH` route carries `verifyJwt`

- [ ] **Step 5: Commit**

```bash
git add src/controllers/fixture.controller.js src/controllers/match.controller.js src/routes/tournament.routes.js src/locales/en/common.json src/locales/hi/common.json src/locales/mr/common.json tests/fixture.test.js
git commit -m "feat: resolve fixtures from match outcomes, manual tie-break resolution, bracket progression"
```

---

### Task 7: Full verification and manual walkthrough

**Files:** none created or modified — this task only runs and reads output, plus writes the manual-verification walkthrough into this plan file's final section for handoff.

- [ ] **Step 1: Run the full backend test suite**

Run: `npm test`
Expected: every test file passes, including all of `tests/fixture.test.js`, `tests/generateFixtures.test.js`, `tests/fixture.model.test.js`, `tests/resolveFixtureOutcome.test.js`, `tests/tournament.test.js`, `tests/match.test.js`, `tests/locales.test.js`, `tests/routes.auth.test.js`

- [ ] **Step 2: Confirm locale parity explicitly**

Run: `npm test -- locales.test.js`
Expected: PASS for all `SUPPORTED_LANGUAGES`, including "no empty values"

- [ ] **Step 3: Confirm the route-auth allowlist explicitly**

Run: `npm test -- routes.auth.test.js`
Expected: PASS — every fixture route (`POST/GET .../fixtures`, `POST .../fixtures/:fixtureId/start-match`, `PATCH .../fixtures/:fixtureId`) carries `verifyJwt` and none needed adding to `PUBLIC_ROUTES`

- [ ] **Step 4: Lint, if the project has one configured**

Run: `npm run lint --if-present`
Expected: PASS, or a message that no lint script exists (check `package.json`'s `scripts` first — do not add a lint config as part of this task if none exists)

- [ ] **Step 5: Manual verification walkthrough (curl), one per format**

Run the dev server (`npm run dev`), then substitute a real bearer `$TOKEN` (from logging in as any test/dev user) into the commands below. This walkthrough exercises all three formats end-to-end against a real running server — keep it for future manual smoke-testing of this feature.

```bash
# 1. Create an organization and enroll teams
curl -s -X POST http://localhost:9000/api/v1/organization \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Fixture Test Club"}' | tee /tmp/org.json
ORG_ID=$(node -pe 'JSON.parse(require("fs").readFileSync("/tmp/org.json")).data.id')

for i in 1 2 3 4 5; do
  curl -s -X POST "http://localhost:9000/api/v1/organization/$ORG_ID/teams" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"name\":\"Team $i\"}"
done
# Copy each response's data.id into TEAM1..TEAM5 below.

# 2. ROUND ROBIN — create, enroll teams, generate, list
curl -s -X POST "http://localhost:9000/api/v1/organization/$ORG_ID/tournaments" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"RR Cup","format":"round_robin"}' | tee /tmp/rr.json
RR_ID=$(node -pe 'JSON.parse(require("fs").readFileSync("/tmp/rr.json")).data.id')

for TEAM in $TEAM1 $TEAM2 $TEAM3; do
  curl -s -X POST "http://localhost:9000/api/v1/tournament/$RR_ID/teams" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"teamId\":\"$TEAM\"}"
done

curl -s -X POST "http://localhost:9000/api/v1/tournament/$RR_ID/fixtures" \
  -H "Authorization: Bearer $TOKEN"
# Expect: round 1, one fixture (odd team count → one team has a bye)

curl -s "http://localhost:9000/api/v1/tournament/$RR_ID/fixtures" \
  -H "Authorization: Bearer $TOKEN"
# Expect: 3 fixtures total (C(3,2)), across 3 rounds, one bye per round

# 3. LEAGUE — same as above with "format":"league" against 4 enrolled teams
# Expect: GET .../fixtures returns 12 fixtures (2x the 6-fixture round-robin schedule)

# 4. KNOCKOUT — 5 teams enrolled
curl -s -X POST "http://localhost:9000/api/v1/organization/$ORG_ID/tournaments" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"KO Cup","format":"knockout"}' | tee /tmp/ko.json
KO_ID=$(node -pe 'JSON.parse(require("fs").readFileSync("/tmp/ko.json")).data.id')
# enroll 5 teams the same way as step 2, then:

curl -s -X POST "http://localhost:9000/api/v1/tournament/$KO_ID/fixtures" \
  -H "Authorization: Bearer $TOKEN"
# Expect: round 1, 4 fixtures — 3 byes (earliest-enrolled teams) + 1 real match

# Start the one real round-1 match (substitute its fixture id as $FIXTURE_ID):
curl -s -X POST "http://localhost:9000/api/v1/tournament/$KO_ID/fixtures/$FIXTURE_ID/start-match" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"totalOvers":5}'
# Score it to completion via the existing POST /v1/match/:matchId/score-ball
# flow (see docs/api.md's Match section), then:

curl -s -X POST "http://localhost:9000/api/v1/tournament/$KO_ID/fixtures" \
  -H "Authorization: Bearer $TOKEN"
# Expect: 400 ROUND_NOT_COMPLETE if any round-1 fixture is still scheduled,
# or round 2 (2 fixtures) once all 4 are resolved (byes + the played match)
```

- [ ] **Step 6: Invoke superpowers:requesting-code-review**

Get `BASE_SHA` (the commit on `development` this branch forked from) and `HEAD_SHA` (`git rev-parse HEAD`), then dispatch a code-reviewer subagent per that skill's template, covering the whole `feat-tournament-fixtures` branch against this plan and `docs/api.md`'s Fixture section. Fix any Critical/Important findings before proceeding; note Minor findings.

- [ ] **Step 7: Report results**

Summarize for the user: full test count and pass/fail, locale/route-auth status, lint status, and the code review's findings (fixed vs. noted). This is Phase 2's completion report — Phase 3 (frontend) gets planned separately per the user's original three-phase instructions, only after this report.
