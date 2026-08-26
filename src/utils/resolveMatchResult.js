import { MAX_WICKETS } from './resolveStrike.js';

/**
 * The match result from the two innings' final totals — derived, never
 * decided independently, so it can never disagree with the completionReason
 * resolveBallOutcome already committed the innings to.
 *
 * `battingTeam2`/`wickets2` are the side that just finished batting second;
 * `target_achieved` can only ever name them, since only innings 2 chases.
 *
 * No `description` string here on purpose. A human-readable sentence would be
 * English text sitting in `data`, outside this app's translation contract —
 * the client already owns the real team names and TranslationKeys for
 * "won by"/"tie"/wickets/runs, the same way it already renders wicketType.
 *
 * Covered by tests/resolveMatchResult.test.js.
 */
export const resolveMatchResult = ({
    completionReason,
    battingTeam1,
    battingTeam2,
    runs1,
    runs2,
    wickets2,
}) => {
    if (completionReason === 'target_achieved') {
        return { winner: battingTeam2, marginType: 'wickets', margin: MAX_WICKETS - wickets2 };
    }

    if (runs2 === runs1) {
        return { winner: 'tie', marginType: null, margin: null };
    }

    if (runs2 > runs1) {
        // Reached ahead of the target's own boundary check firing is not a
        // real path today — target_achieved above catches every case this app
        // can produce — but resolving it as a runs win rather than assuming
        // it unreachable keeps this function correct if that ever changes.
        return { winner: battingTeam2, marginType: 'runs', margin: runs2 - runs1 };
    }

    return { winner: battingTeam1, marginType: 'runs', margin: runs1 - runs2 };
};
