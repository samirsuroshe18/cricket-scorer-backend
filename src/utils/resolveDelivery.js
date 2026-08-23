// The delivery *fault* — wide/no-ball carry a 1-run penalty and must be re-bowled.
export const EXTRA_TYPES = ['wide', 'no_ball'];
// Who the runs are credited to. Orthogonal to the fault: a no-ball can go for byes.
export const RUNS_FROM = ['bat', 'bye', 'leg_bye'];

/**
 * Turns a scored delivery into its stored split and counter effects.
 *
 * `runs` is what was run/hit BEYOND the automatic penalty — the penalty is added
 * here, never sent by the client.
 *
 * Invariants (covered by tests/resolveDelivery.test.js):
 *   teamRuns === ballRuns + ballExtras
 *   sum(buckets) === ballExtras
 *
 * @param {{runs: number, extraType?: string|null, runsFrom?: string}} input
 */
export const resolveDelivery = ({ runs, extraType = null, runsFrom = 'bat' }) => {
    const penalty = extraType ? 1 : 0;
    const isLegal = extraType == null;
    // A wide is never credited to the batsman even though runs may have been run.
    const creditToBat = extraType !== 'wide' && runsFrom === 'bat';

    const ballRuns = creditToBat ? runs : 0;
    const ballExtras = penalty + (creditToBat ? 0 : runs);

    const buckets = { wides: 0, noBalls: 0, byes: 0, legByes: 0 };

    if (extraType === 'wide') {
        // Law 22: every run from a wide is debited as a wide, however it was run.
        buckets.wides = penalty + runs;
    } else {
        if (extraType === 'no_ball') buckets.noBalls = penalty;
        if (runsFrom === 'bye') buckets.byes = runs;
        if (runsFrom === 'leg_bye') buckets.legByes = runs;
    }

    return { ballRuns, ballExtras, isLegal, buckets, teamRuns: ballRuns + ballExtras };
};
