import { resolveToss } from '../src/utils/resolveToss.js';

describe('resolveToss', () => {
    it('no toss at all defaults battingFirst to teamA', () => {
        expect(resolveToss({ tossWinner: undefined, tossDecision: undefined }))
            .toEqual({ valid: true, tossWinner: null, tossDecision: null, battingFirst: 'teamA' });
    });

    it('the toss winner bats first when they chose to bat', () => {
        expect(resolveToss({ tossWinner: 'teamB', tossDecision: 'bat' }))
            .toEqual({ valid: true, tossWinner: 'teamB', tossDecision: 'bat', battingFirst: 'teamB' });
    });

    it('the OTHER side bats first when the toss winner chose to bowl', () => {
        expect(resolveToss({ tossWinner: 'teamB', tossDecision: 'bowl' }))
            .toEqual({ valid: true, tossWinner: 'teamB', tossDecision: 'bowl', battingFirst: 'teamA' });
    });

    it('a winner with no decision is rejected, not defaulted', () => {
        expect(resolveToss({ tossWinner: 'teamA', tossDecision: undefined })).toEqual({ valid: false });
    });

    it('a decision with no winner is rejected, not defaulted', () => {
        expect(resolveToss({ tossWinner: undefined, tossDecision: 'bat' })).toEqual({ valid: false });
    });

    it('an out-of-enum winner is rejected', () => {
        expect(resolveToss({ tossWinner: 'teamC', tossDecision: 'bat' })).toEqual({ valid: false });
    });

    it('an out-of-enum decision is rejected', () => {
        expect(resolveToss({ tossWinner: 'teamA', tossDecision: 'field' })).toEqual({ valid: false });
    });
});
