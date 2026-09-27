const FORM_LENGTH = 5;

const OUTCOME_CODE = { won: 'W', lost: 'L', tied: 'T', noResult: 'N' };

// The outcome of one completed match from `teamId`'s point of view. `winner`
// is a side ('teamA'/'teamB') or 'tie'/'no_result'; which side this team
// played decides whether a side winner is a win or a loss.
const outcomeFor = (teamId, match) => {
    const winner = match.result?.winner;
    if (!winner) return null;
    if (winner === 'tie') return 'tied';
    if (winner === 'no_result') return 'noResult';
    const side = String(match.teamA) === String(teamId) ? 'teamA' : 'teamB';
    return winner === side ? 'won' : 'lost';
};

// Computed on read rather than stored: undo-and-rescore re-completes a match,
// so a stored counter would need an idempotent delta. `matches` are the
// team's completed matches, newest first.
export const computeTeamStats = (teamId, matches) => {
    const counts = { won: 0, lost: 0, tied: 0, noResult: 0 };
    const form = [];

    for (const match of matches) {
        const outcome = outcomeFor(teamId, match);
        if (!outcome) continue;
        counts[outcome] += 1;
        if (form.length < FORM_LENGTH) form.push(OUTCOME_CODE[outcome]);
    }

    const played = counts.won + counts.lost + counts.tied + counts.noResult;
    const winPercentage = played === 0 ? 0 : Math.round((counts.won / played) * 1000) / 10;

    return { played, ...counts, winPercentage, form };
};
