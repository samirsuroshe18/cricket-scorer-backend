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
