import { resolveMatchResult } from '../src/utils/resolveMatchResult.js';

const base = (overrides = {}) => resolveMatchResult({
    completionReason: 'overs_complete',
    battingTeam1: 'teamA',
    battingTeam2: 'teamB',
    runs1: 150,
    runs2: 140,
    wickets2: 6,
    ...overrides,
});

describe('resolveMatchResult', () => {
    it('a target chase win is a wickets margin, not runs', () => {
        expect(base({
            completionReason: 'target_achieved',
            runs2: 151,
            wickets2: 6,
        })).toEqual({ winner: 'teamB', marginType: 'wickets', margin: 4 });
    });

    it('losing zero wickets on the way to the target is a 10-wicket win', () => {
        expect(base({
            completionReason: 'target_achieved',
            runs2: 151,
            wickets2: 0,
        })).toEqual({ winner: 'teamB', marginType: 'wickets', margin: 10 });
    });

    it('all out short of the target is a runs win for the side batting first', () => {
        expect(base({ completionReason: 'all_out', runs1: 150, runs2: 120 }))
            .toEqual({ winner: 'teamA', marginType: 'runs', margin: 30 });
    });

    it('overs run out short of the target is a runs win for the side batting first', () => {
        expect(base({ completionReason: 'overs_complete', runs1: 150, runs2: 149 }))
            .toEqual({ winner: 'teamA', marginType: 'runs', margin: 1 });
    });

    it('equal totals is a tie, not a runs win for either side', () => {
        expect(base({ completionReason: 'all_out', runs1: 150, runs2: 150 }))
            .toEqual({ winner: 'tie', marginType: null, margin: null });
    });

    it('one run short of a tie is still a runs win, not rounded down to a tie', () => {
        expect(base({ completionReason: 'all_out', runs1: 150, runs2: 149 }))
            .toEqual({ winner: 'teamA', marginType: 'runs', margin: 1 });
    });

    it('target_achieved always names the side batting second, never the first', () => {
        const result = base({ completionReason: 'target_achieved', runs2: 200, wickets2: 3 });
        expect(result.winner).toBe('teamB');
    });
});
