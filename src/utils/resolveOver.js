import { MAX_WICKETS } from './resolveStrike.js';

// Six LEGAL deliveries, per the extras contract: `isLegal = extraType == null`,
// so wides and no-balls never advance the over while byes and leg-byes do.
export const LEGAL_DELIVERIES_PER_OVER = 6;

/**
 * An over completes on the TRANSITION, not on the state: this delivery is legal
 * AND takes the over from 5 legal deliveries to 6. Reading `=== 6` off the
 * post-increment count instead would advance `oversCompleted` a second time if
 * an already-complete over were ever seen again.
 *
 * `overLegalDeliveries` is the count BEFORE this delivery is applied.
 */
export const completesOver = ({ isLegal, overLegalDeliveries }) =>
    Boolean(isLegal) && overLegalDeliveries === LEGAL_DELIVERIES_PER_OVER - 1;

/**
 * Law 17.6 — a bowler may not bowl two overs in succession. Compared by player
 * id, so two Player documents that happen to share a name are different
 * bowlers. Null on either side means "no previous over", which never restricts.
 */
export const isSameBowler = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * Everything this delivery did to the over and the innings, derived from the
 * ball's own record and the match's over limit — nothing read from live state.
 *
 * That is deliberate. The same function serves a freshly scored ball and an
 * idempotent replay, so the two can never drift, and a replay of an older key
 * reports what THAT ball did rather than what the innings looks like now.
 * `preEventState` is the snapshot the ball already carries for undo.
 *
 * `newBowlerRequired` is the whole point: the over ended and somebody has to
 * bowl the next one — unless there is no next one, because the innings ended on
 * this very ball.
 *
 * `teamRuns`/`inningsNumber`/`target` exist for exactly one thing: detecting a
 * chase. Only innings 2 ever carries a target, and reaching it can end the
 * innings mid-over — the instant the total passes it, unlike `allOut`/
 * `oversDone`, which fall out of a wicket or an over boundary. Checked every
 * ball, the same as `allOut`, for the same reason.
 *
 * Covered by tests/resolveOver.test.js.
 */
export const resolveBallOutcome = ({
    isLegal,
    isWicket,
    teamRuns = 0,
    preEventState,
    totalOvers,
    inningsNumber = 1,
    target = null,
}) => {
    const overComplete = completesOver({
        isLegal,
        overLegalDeliveries: preEventState.overLegalDeliveries,
    });

    const wicketsAfter = preEventState.wickets + (isWicket ? 1 : 0);
    const oversCompletedAfter = preEventState.oversCompleted + (overComplete ? 1 : 0);
    const totalRunsAfter = preEventState.totalRuns + teamRuns;

    const allOut = wicketsAfter >= MAX_WICKETS;
    // Only an over boundary can exhaust the overs, so this is gated on it —
    // a mid-over ball can never take oversCompleted past the limit.
    const oversDone = overComplete
        && Number.isInteger(totalOvers)
        && oversCompletedAfter >= totalOvers;

    const targetAchieved = inningsNumber === 2
        && Number.isInteger(target)
        && totalRunsAfter >= target;

    const inningsComplete = targetAchieved || allOut || oversDone;

    return {
        overComplete,
        wicketsAfter,
        oversCompletedAfter,
        totalRunsAfter,
        allOut,
        oversDone,
        targetAchieved,
        inningsComplete,
        newBowlerRequired: overComplete && !inningsComplete,
        // target_achieved wins even over a simultaneous all_out/oversDone: the
        // chase ends the instant the total passes the target, whatever else
        // this same ball also did. Below that, all_out still wins over
        // oversDone when the tenth wicket falls on the last ball of the last
        // over — being bowled out is the more specific cause.
        completionReason: targetAchieved
            ? 'target_achieved'
            : (allOut ? 'all_out' : (oversDone ? 'overs_complete' : null)),
    };
};
