// Only the innings' four extras buckets, copied rather than aliased: the
// snapshot is a Mongoose subdocument and assigning it straight onto the live
// document would share state between the ball being deleted and the innings
// being restored.
const copyExtras = (extras) => ({
    wides:   extras?.wides   ?? 0,
    noBalls: extras?.noBalls ?? 0,
    byes:    extras?.byes    ?? 0,
    legByes: extras?.legByes ?? 0,
});

/**
 * The exact state to write back when a delivery is removed, derived from the
 * `preEventState` that ball has carried since it was scored.
 *
 * Pure on purpose, for the same reason resolveDelivery and resolveOver are: the
 * restore is the half of undo that has to be *exactly* right, and it is the
 * half that needs no database to verify.
 *
 * Three values are computed rather than read, because the snapshot does not
 * carry them and adding them would strand every ball written before the change:
 *
 *  - `over.wickets` — only this ball could have changed it, so one decrement
 *    inverts it. Floored at zero so a corrupt count cannot go negative.
 *  - `over.isComplete` — always false. A delivery cannot be bowled at an over
 *    that already has six legal balls, so the over was open before this one.
 *  - `inning.status` — always in_progress. `score-ball` refuses a completed
 *    innings, so the innings was open before this ball too, whatever this ball
 *    then did to it.
 *
 * Covered by tests/resolveUndo.test.js.
 */
export const resolveUndo = ({ preEventState, isWicket = false, overWickets = 0 }) => {
    const pre = preEventState;

    return {
        inning: {
            totalRuns:      pre.totalRuns,
            wickets:        pre.wickets,
            legalBalls:     pre.legalBalls,
            totalBalls:     pre.totalBalls,
            oversCompleted: pre.oversCompleted,
            extras:         copyExtras(pre.extrasSnapshot),
            strikerId:      pre.strikerId ?? null,
            strikerName:    pre.strikerName ?? null,
            nonStrikerId:   pre.nonStrikerId ?? null,
            nonStrikerName: pre.nonStrikerName ?? null,
            // Restoring this is what discards a bowler chosen for the next over
            // after the over-ending ball — that over is unfinished again, so its
            // own bowler is the correct answer. Never null: score-ball refuses a
            // delivery without a bowler, so the snapshot always has one.
            currentBowlerId: pre.currentBowlerId ?? null,
            status:          'in_progress',
            completionReason: undefined,
        },
        over: {
            totalRuns:       pre.overTotalRuns,
            legalDeliveries: pre.overLegalDeliveries,
            extras:          copyExtras(pre.overExtrasSnapshot),
            wickets:         Math.max(0, overWickets - (isWicket ? 1 : 0)),
            isComplete:      false,
        },
    };
};
