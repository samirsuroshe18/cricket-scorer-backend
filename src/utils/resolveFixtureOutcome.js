// Pure decision logic for turning a finished Match into a Fixture outcome,
// and for deciding whether an entire tournament's schedule is now fully
// resolved. No Mongoose here — the fixture controller is what loads real
// documents and applies what these functions decide.

// `fixture` needs only {teamA, teamB}; `match` needs only
// {status, result: {winner}}. Returns null when the match hasn't actually
// finished yet — callers only invoke this once they know it has.
export const decideFixtureOutcome = (fixture, match) => {
    if (match.status === 'abandoned') {
        return { status: 'unresolved', winner: null };
    }

    const outcome = match.result?.winner;
    if (outcome === 'tie' || outcome === 'no_result') {
        return { status: 'unresolved', winner: null };
    }
    if (outcome === 'teamA') {
        return { status: 'completed', winner: fixture.teamA };
    }
    if (outcome === 'teamB') {
        return { status: 'completed', winner: fixture.teamB };
    }
    return null;
};

// `fixtures` needs only {round, status} per entry — every fixture generated
// so far for one tournament. `unresolved` means something different per
// format: round_robin/league treat a tie/no-result as a normal terminal
// state (nothing to advance), so it counts as done; knockout cannot advance
// without a real winner, so an unresolved fixture — anywhere, including the
// final — blocks completion until the owner manually resolves it via
// PATCH .../fixtures/:fixtureId.
export const isTournamentComplete = (format, fixtures) => {
    if (format === 'knockout') {
        const stillPending = fixtures.some(
            (f) => f.status === 'scheduled' || f.status === 'unresolved'
        );
        if (stillPending) return false;

        const maxRound = Math.max(...fixtures.map((f) => f.round));
        const finalRoundFixtures = fixtures.filter((f) => f.round === maxRound);
        return finalRoundFixtures.length === 1 && finalRoundFixtures[0].status === 'completed';
    }

    // round_robin / league: complete once nothing is left scheduled.
    return fixtures.every((f) => f.status !== 'scheduled');
};
