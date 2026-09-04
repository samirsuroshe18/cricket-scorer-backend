import {
    battingAverage,
    strikeRate,
    economy,
    parseOvers,
    buildMatchContributions,
    computeDelta,
} from '../src/utils/careerStats.js';

// battingLineSchema-shaped test fixtures, matching Scorecard's own
// battingScores[]/bowlingScores[] shape — the real input this whole module
// reads.
const battingLine = (overrides = {}) => ({
    playerId: 'p1',
    playerName: 'Rahul',
    runs: 0,
    balls: 0,
    fours: 0,
    sixes: 0,
    isNotOut: true,
    ...overrides,
});

const bowlingLine = (overrides = {}) => ({
    playerId: 'p1',
    playerName: 'Rahul',
    overs: '0.0',
    maidens: 0,
    runs: 0,
    wickets: 0,
    wides: 0,
    noBalls: 0,
    ...overrides,
});

const scorecard = ({ battingScores = [], bowlingScores = [] } = {}) => ({ battingScores, bowlingScores });

describe('battingAverage', () => {
    // The exact worked example this whole feature exists to get right:
    // 50 runs across 2 innings, only one of which ended in a dismissal.
    // The divisor is timesOut (1), never inningsBatted (2) — 50/1 = 50,
    // not 50/2 = 25. By hand: 50 ÷ 1 = 50.
    it('divides by timesOut, not inningsBatted — 50 runs, 1 dismissal out of 2 innings, is an average of 50', () => {
        expect(battingAverage(50, 1)).toBe(50);
    });

    // The same 50 runs, misattributed to inningsBatted instead of timesOut,
    // would silently produce 25 — half the true average, and exactly the
    // wrong-but-plausible-looking number this test exists to catch.
    it('is not runs divided by innings batted', () => {
        expect(battingAverage(50, 1)).not.toBe(50 / 2);
    });

    it('is null, not 0 or Infinity, when never dismissed', () => {
        expect(battingAverage(120, 0)).toBeNull();
    });

    it('rounds to 2 decimal places', () => {
        // 100 / 3 = 33.333... by hand -> 33.33
        expect(battingAverage(100, 3)).toBe(33.33);
    });
});

describe('strikeRate', () => {
    // By hand: (86 / 40) * 100 = 215.
    it('computes runs/balls * 100 from cumulative totals', () => {
        expect(strikeRate(86, 40)).toBe(215);
    });

    // The averaging-rates trap: two innings of 100(50 balls) and 0(10 balls)
    // have PER-MATCH strike rates of 200 and 0. Averaging those two rates
    // gives 100. The correct cumulative figure is (100+0)/(50+10)*100 =
    // 166.67 by hand — a different number, because strike rate is not a
    // linear quantity that per-match averaging preserves.
    it('cumulative recomputation disagrees with naively averaging per-match rates', () => {
        const matchOneRate = strikeRate(100, 50); // 200
        const matchTwoRate = strikeRate(0, 10); // 0
        const naiveAverageOfRates = (matchOneRate + matchTwoRate) / 2; // 100

        const cumulative = strikeRate(100 + 0, 50 + 10); // the correct figure

        expect(cumulative).toBe(166.67);
        expect(cumulative).not.toBe(naiveAverageOfRates);
    });

    it('is 0, not NaN, when no balls faced', () => {
        expect(strikeRate(0, 0)).toBe(0);
    });
});

describe('economy', () => {
    // By hand: 45 runs off 90 legal deliveries = 15 overs. 45 / 15 = 3.
    it('computes runsConceded / (legalDeliveries/6) from cumulative totals', () => {
        expect(economy(45, 90)).toBe(3);
    });

    // Same averaging-rates trap as strike rate, for bowling: a 4-over spell
    // for 40 (economy 10) and a 10-over spell for 10 (economy 1) do NOT
    // average to an economy of 5.5. By hand: (40+10) runs / ((24+60)/6)
    // overs = 50 / 14 = 3.5714... -> 3.57.
    it('cumulative recomputation disagrees with naively averaging per-match economies', () => {
        const matchOneEconomy = economy(40, 24); // 4 overs, economy 10
        const matchTwoEconomy = economy(10, 60); // 10 overs, economy 1
        const naiveAverage = (matchOneEconomy + matchTwoEconomy) / 2; // 5.5

        const cumulative = economy(40 + 10, 24 + 60);

        expect(cumulative).toBe(3.57);
        expect(cumulative).not.toBe(naiveAverage);
    });

    it('is 0, not NaN, when no deliveries bowled', () => {
        expect(economy(0, 0)).toBe(0);
    });
});

describe('parseOvers', () => {
    it('parses "4.2" as 26 legal deliveries — 4*6 + 2', () => {
        expect(parseOvers('4.2')).toBe(26);
    });

    it('parses a whole-over count with no partial ball', () => {
        expect(parseOvers('3.0')).toBe(18);
    });

    it('parses zero overs', () => {
        expect(parseOvers('0.0')).toBe(0);
    });
});

describe('buildMatchContributions', () => {
    it('pairs a player\'s batting line (innings 1) with their bowling line (innings 2)', () => {
        const contributions = buildMatchContributions([
            scorecard({ battingScores: [battingLine({ playerId: 'p1', runs: 20, balls: 15 })] }),
            scorecard({ bowlingScores: [bowlingLine({ playerId: 'p1', overs: '4.0', runs: 22, wickets: 2 })] }),
        ]);

        const p1 = contributions.get('p1');
        expect(p1.battingLine).toMatchObject({ runs: 20, balls: 15 });
        expect(p1.bowlingLine).toMatchObject({ legalDeliveries: 24, runs: 22, wickets: 2 });
    });

    it('leaves bowlingLine null for a player who only batted this match', () => {
        const contributions = buildMatchContributions([
            scorecard({ battingScores: [battingLine({ playerId: 'p1' })] }),
        ]);
        expect(contributions.get('p1').bowlingLine).toBeNull();
    });

    // The exact 49/50/99/100 boundary — the class of bug this whole feature
    // is trying to avoid shipping.
    it.each([
        [49, false, false],
        [50, true, false],
        [99, true, false],
        [100, false, true],
    ])('runs=%i -> wasFifty=%s, wasHundred=%s', (runs, wasFifty, wasHundred) => {
        const contributions = buildMatchContributions([
            scorecard({ battingScores: [battingLine({ playerId: 'p1', runs })] }),
        ]);
        const line = contributions.get('p1').battingLine;
        expect(line.wasFifty).toBe(wasFifty);
        expect(line.wasHundred).toBe(wasHundred);
    });

    it('skips a null scorecard (an abandoned match that never reached innings 2)', () => {
        const contributions = buildMatchContributions([
            scorecard({ battingScores: [battingLine({ playerId: 'p1' })] }),
            null,
        ]);
        expect(contributions.get('p1')).toBeDefined();
    });
});

// computeDelta's input shape is PlayerMatchStats' own — the
// buildMatchContributions output, not the raw Scorecard line — so these
// fixtures are deliberately distinct from battingLine()/bowlingLine() above.
const postBuildBattingLine = (overrides = {}) => ({
    runs: 0,
    balls: 0,
    fours: 0,
    sixes: 0,
    isNotOut: true,
    wasFifty: false,
    wasHundred: false,
    ...overrides,
});

const postBuildBowlingLine = (overrides = {}) => ({
    legalDeliveries: 0,
    runs: 0,
    wickets: 0,
    maidens: 0,
    wides: 0,
    noBalls: 0,
    ...overrides,
});

describe('computeDelta', () => {
    it('is the full contribution when there is no prior row (first-time, not a correction)', () => {
        const after = {
            battingLine: postBuildBattingLine({ runs: 30, balls: 20, fours: 2, sixes: 1, isNotOut: true }),
            bowlingLine: null,
        };
        const delta = computeDelta(null, after);

        expect(delta).toMatchObject({
            inningsBatted: 1,
            runs: 30,
            ballsFaced: 20,
            fours: 2,
            sixes: 1,
            timesOut: 0,
            notOuts: 1,
            inningsBowled: 0,
        });
    });

    // The exact scenario this class of design exists for: a completed
    // match's last ball gets undone and rescored, changing the outcome.
    // Runs go from 30 (out) to 45 (not out) on a correction — the CORRECT
    // delta must move CareerStats.runs by +15, CareerStats.timesOut by -1
    // (the correction turned a dismissal into a not-out), and
    // CareerStats.notOuts by +1. Applying `after` as a fresh +45 on top of
    // the original +30 (i.e. failing to diff against `before`) would double
    // -count the match entirely — the exact bug this delta design exists to
    // prevent.
    it('is the difference between old and new on a correction, not the new value added again', () => {
        const before = {
            battingLine: postBuildBattingLine({ runs: 30, balls: 25, fours: 1, sixes: 0, isNotOut: false }),
            bowlingLine: null,
        };
        const after = {
            battingLine: postBuildBattingLine({ runs: 45, balls: 25, fours: 1, sixes: 1, isNotOut: true }),
            bowlingLine: null,
        };

        const delta = computeDelta(before, after);

        expect(delta.runs).toBe(15); // 45 - 30, not 45
        expect(delta.sixes).toBe(1); // 1 - 0
        expect(delta.inningsBatted).toBe(0); // still exactly one batting line, before and after
        expect(delta.timesOut).toBe(-1); // was dismissed, now not out
        expect(delta.notOuts).toBe(1); // was 0, now 1
    });

    it('counts a boolean threshold flag flipping true->false as -1, not 0', () => {
        const before = { battingLine: postBuildBattingLine({ runs: 55, wasFifty: true }), bowlingLine: null };
        const after = { battingLine: postBuildBattingLine({ runs: 40, wasFifty: false }), bowlingLine: null };

        const delta = computeDelta(before, after);
        expect(delta.fifties).toBe(-1);
    });

    it('a bowling-only correction does not touch batting fields', () => {
        const before = { battingLine: null, bowlingLine: postBuildBowlingLine({ legalDeliveries: 24, runs: 30, wickets: 1, maidens: 0 }) };
        const after = { battingLine: null, bowlingLine: postBuildBowlingLine({ legalDeliveries: 24, runs: 18, wickets: 3, maidens: 1 }) };

        const delta = computeDelta(before, after);

        expect(delta.runsConceded).toBe(-12); // 18 - 30
        expect(delta.wickets).toBe(2); // 3 - 1
        expect(delta.maidens).toBe(1);
        expect(delta.runs).toBe(0);
        expect(delta.ballsFaced).toBe(0);
        expect(delta.inningsBatted).toBe(0);
    });
});
