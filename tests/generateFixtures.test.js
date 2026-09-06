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
