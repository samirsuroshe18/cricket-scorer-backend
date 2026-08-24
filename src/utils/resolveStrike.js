// The six dismissals in scope for v1. `obstructing` and `timed_out` are real but
// vanishingly rare in local cricket and stay out; retired hurt/out are excluded
// for a different reason — they happen between balls and consume no delivery, so
// they cannot ride on a BallEvent at all.
export const WICKET_TYPES = ['bowled', 'caught', 'lbw', 'run_out', 'stumped', 'hit_wicket'];

// Only a run out can take the non-striker; every other type dismisses the
// batsman facing.
export const DISMISSED_BATSMEN = ['striker', 'non_striker'];
export const RUN_OUT = 'run_out';

// A wicket may not be scored off a no-ball except a run out, and off a wide
// only a stumping or a run out. Both are Laws, not preferences — and "wide +
// stumped" is common enough that a scorer will tap it.
export const WICKET_TYPES_ON_NO_BALL = [RUN_OUT];
export const WICKET_TYPES_ON_WIDE = ['stumped', RUN_OUT];

export const MAX_WICKETS = 10;

const samePlayer = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * The pair at the crease after a delivery: rotate, then substitute.
 *
 * Order is load-bearing. `dismissedId` names a batsman as of *before* the ball,
 * and rotation may have moved them, so the substitution matches on the player
 * rather than on an end. Doing it the other way round puts the incoming batsman
 * at the wrong end whenever the batsmen crossed — which is exactly the run-out
 * case this exists for.
 *
 * With no dismissal this is a plain swap, and the old invariant still holds:
 * `rotated` true means the striker afterwards is the non-striker from before.
 * A wicket breaks that, because one batsman is replaced rather than moved.
 *
 * `incomingId`/`incomingName` are null on the final wicket — nobody is left to
 * come in, and the dismissed end is left empty.
 *
 * Covered by tests/resolveStrike.test.js.
 */
export const resolveStrike = ({
    strikerId,
    strikerName,
    nonStrikerId,
    nonStrikerName,
    rotated = false,
    dismissedId = null,
    incomingId = null,
    incomingName = null,
}) => {
    const pair = rotated
        ? {
            strikerId: nonStrikerId,
            strikerName: nonStrikerName,
            nonStrikerId: strikerId,
            nonStrikerName: strikerName,
        }
        : { strikerId, strikerName, nonStrikerId, nonStrikerName };

    if (dismissedId == null) return pair;

    if (samePlayer(pair.strikerId, dismissedId)) {
        return { ...pair, strikerId: incomingId, strikerName: incomingName };
    }

    if (samePlayer(pair.nonStrikerId, dismissedId)) {
        return { ...pair, nonStrikerId: incomingId, nonStrikerName: incomingName };
    }

    // Dismissed player is not at the crease. The controller validates this, so
    // reaching here means a bug — leave the pair untouched rather than evicting
    // whichever batsman happened to be second.
    return pair;
};
