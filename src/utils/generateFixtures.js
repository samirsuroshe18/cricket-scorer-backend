// Pure schedule-building blocks for tournament fixture generation. Nothing
// here touches Mongoose or the database — the fixture controller is
// responsible for turning what these return into actual Fixture
// documents. Kept pure specifically so every shape (odd/even team counts,
// exact-power-of-two knockout fields) is a plain unit test, not an
// integration test.

// Smallest power of two >= n. Every real caller has already passed the
// format's minimum-team check (2 for knockout) before this runs, so n >= 2
// always in practice.
const nextPowerOfTwo = (n) => {
    let p = 1;
    while (p < n) p *= 2;
    return p;
};

// [a,b,c,d] -> [[a,b],[c,d]]. Callers only ever pass even-length arrays —
// guaranteed by the power-of-two bracket invariant for knockout, and by
// construction for round-robin/league.
const pairUp = (arr) => {
    const pairs = [];
    for (let i = 0; i < arr.length; i += 2) {
        pairs.push([arr[i], arr[i + 1]]);
    }
    return pairs;
};

// Round 1 of a knockout bracket. `teamIds` ordered by enrollment
// (Tournament.teams array order, i.e. joinedAt). The earliest-enrolled
// teams get however many byes are needed to round the field up to a power
// of two — "seeded by enrollment order," not a draw. Returns
// { teamA, teamB, isBye } slots; teamB is null and isBye true for a bye.
export const buildKnockoutRound1 = (teamIds) => {
    const target = nextPowerOfTwo(teamIds.length);
    const byeCount = target - teamIds.length;
    const byeTeams = teamIds.slice(0, byeCount);
    const remaining = teamIds.slice(byeCount);

    const byeSlots = byeTeams.map((teamId) => ({ teamA: teamId, teamB: null, isBye: true }));
    const realSlots = pairUp(remaining).map(([teamA, teamB]) => ({ teamA, teamB, isBye: false }));
    return [...byeSlots, ...realSlots];
};

// Round N+1 of a knockout bracket, built from round N's winners (already
// ordered by round N's own `order` field). No byes are possible past round
// 1 — the power-of-two invariant guarantees `winnerTeamIds.length` is even
// whenever there's more than one fixture left to pair.
export const buildKnockoutNextRound = (winnerTeamIds) =>
    pairUp(winnerTeamIds).map(([teamA, teamB]) => ({ teamA, teamB, isBye: false }));

// Circle-method round-robin schedule. `teamIds` ordered by enrollment.
// Returns one array per round, each an array of { teamA, teamB, isBye }
// slots — teamB null (isBye true) for whichever team sits out that round
// when teamIds.length is odd. Standard algorithm: pad to even length with a
// null "bye" placeholder, fix position 0, rotate every other position one
// round at a time for teamIds.length - 1 (padded length - 1) rounds.
export const buildRoundRobinRounds = (teamIds) => {
    const hasByeSlot = teamIds.length % 2 !== 0;
    let arr = hasByeSlot ? [...teamIds, null] : [...teamIds];
    const size = arr.length;
    const roundCount = size - 1;
    const rounds = [];

    for (let r = 0; r < roundCount; r += 1) {
        const slots = [];
        for (let i = 0; i < size / 2; i += 1) {
            const a = arr[i];
            const b = arr[size - 1 - i];
            if (a === null) {
                slots.push({ teamA: b, teamB: null, isBye: true });
            } else if (b === null) {
                slots.push({ teamA: a, teamB: null, isBye: true });
            } else {
                slots.push({ teamA: a, teamB: b, isBye: false });
            }
        }
        rounds.push(slots);
        // Position 0 never rotates; the rest do, one step per round.
        arr = [arr[0], arr[size - 1], ...arr.slice(1, size - 1)];
    }
    return rounds;
};

// `league` format: the same round-robin schedule played twice — the second
// leg with sides reversed. Returns rounds in play order: every first-leg
// round, then every second-leg round. This doubling is `league`'s actual
// fixture-generation behavior (see docs/api.md's Fixture section), not
// only a future points-table label.
export const buildLeagueRounds = (teamIds) => {
    const firstLeg = buildRoundRobinRounds(teamIds);
    const secondLeg = firstLeg.map((round) =>
        round.map((slot) =>
            slot.isBye ? slot : { teamA: slot.teamB, teamB: slot.teamA, isBye: false }
        )
    );
    return [...firstLeg, ...secondLeg];
};
