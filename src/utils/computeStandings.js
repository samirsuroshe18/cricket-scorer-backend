// Pure decision logic for turning a tournament's completed/abandoned matches
// into a ranked points table. No Mongoose here — the standings controller is
// what loads real documents and reshapes them into the plain objects this
// function expects. Mirrors resolveFixtureOutcome.js's split between pure
// logic and the controller that touches the database.

export const STANDINGS_FORMATS = ['round_robin', 'league'];

const POINTS = { win: 2, loss: 0, tie: 1, noResult: 1 };

const oversOf = (innings, totalOvers) => (innings.allOut ? totalOvers : innings.legalBalls / 6);

// `teams` is every currently-enrolled team — the table always lists all of
// them, even one with zero matches played. `matches` is only matches that
// have reached a terminal state (`completed` or `abandoned`); the caller is
// responsible for filtering to that and for attributing `teamAId`/`teamBId`
// as real team ids (not the match-relative 'teamA'/'teamB' side labels the
// Match/Inning models use internally — those live in `resultWinner` and
// `innings[].battingSide` instead, exactly as the Mongoose documents store
// them).
export const computeStandings = ({ teams, matches }) => {
    const rows = new Map(teams.map((t) => [t.id, {
        teamId: t.id,
        teamName: t.name,
        played: 0, won: 0, lost: 0, tied: 0, noResult: 0, points: 0,
        runsFor: 0, oversFor: 0, runsAgainst: 0, oversAgainst: 0,
    }]));

    for (const match of matches) {
        const a = rows.get(match.teamAId);
        const b = rows.get(match.teamBId);

        a.played += 1;
        b.played += 1;

        if (match.status === 'abandoned') {
            a.noResult += 1;
            b.noResult += 1;
            a.points += POINTS.noResult;
            b.points += POINTS.noResult;
            continue;
        }

        if (match.resultWinner === 'tie') {
            a.tied += 1;
            b.tied += 1;
            a.points += POINTS.tie;
            b.points += POINTS.tie;
        } else if (match.resultWinner === 'teamA') {
            a.won += 1;
            a.points += POINTS.win;
            b.lost += 1;
            b.points += POINTS.loss;
        } else if (match.resultWinner === 'teamB') {
            b.won += 1;
            b.points += POINTS.win;
            a.lost += 1;
            a.points += POINTS.loss;
        }

        for (const innings of match.innings) {
            const overs = oversOf(innings, match.totalOvers);
            const battingRow = innings.battingSide === 'teamA' ? a : b;
            const bowlingRow = innings.battingSide === 'teamA' ? b : a;
            battingRow.runsFor += innings.runs;
            battingRow.oversFor += overs;
            bowlingRow.runsAgainst += innings.runs;
            bowlingRow.oversAgainst += overs;
        }
    }

    const table = [...rows.values()].map((r) => ({
        teamId: r.teamId,
        teamName: r.teamName,
        played: r.played,
        won: r.won,
        lost: r.lost,
        tied: r.tied,
        noResult: r.noResult,
        points: r.points,
        nrr: (r.oversFor === 0 || r.oversAgainst === 0) ? 0 : (r.runsFor / r.oversFor) - (r.runsAgainst / r.oversAgainst),
    }));

    table.sort((x, y) => y.points - x.points || y.nrr - x.nrr || x.teamName.localeCompare(y.teamName));
    return table;
};
