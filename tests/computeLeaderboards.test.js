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
        // strikeRate is rounded to 2dp by the reused strikeRate() helper,
        // same as career stats' own contract.
        expect(row.strikeRate).toBeCloseTo((100 / 70) * 100, 2);
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
        // economy is rounded to 2dp by the reused economy() helper, same as
        // career stats' own contract.
        expect(row.economy).toBeCloseTo(36 / (42 / 6), 2);
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
