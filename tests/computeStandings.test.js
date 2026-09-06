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
