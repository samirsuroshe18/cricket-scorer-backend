// A toss is optional at match creation — both `tossWinner` and `tossDecision`
// must be given together, or both left out. `battingFirst` falls back to
// 'teamA' either way, matching what this field silently defaulted to before
// toss existed: a scorer who skips the toss sees no behavior change.
export const resolveToss = ({ tossWinner, tossDecision }) => {
    const hasToss = tossWinner != null || tossDecision != null;

    if (!hasToss) {
        return { valid: true, tossWinner: null, tossDecision: null, battingFirst: 'teamA' };
    }

    const isValid =
        ['teamA', 'teamB'].includes(tossWinner) && ['bat', 'bowl'].includes(tossDecision);

    if (!isValid) {
        return { valid: false };
    }

    const battingFirst =
        tossDecision === 'bat'
            ? tossWinner
            : (tossWinner === 'teamA' ? 'teamB' : 'teamA');

    return { valid: true, tossWinner, tossDecision, battingFirst };
};
