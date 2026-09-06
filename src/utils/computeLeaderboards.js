import {
    battingAverage, strikeRate, economy,
    BATTING_SUM_FIELDS, BOWLING_SUM_FIELDS, num,
    isBetterHighScore, isBetterBowling,
} from './careerStats.js';

const newBattingRow = (playerId, playerName) => ({
    playerId, playerName,
    inningsBatted: 0, timesOut: 0, notOuts: 0,
    runs: 0, ballsFaced: 0, fours: 0, sixes: 0, fifties: 0, hundreds: 0,
    highScore: null,
});

const newBowlingRow = (playerId, playerName) => ({
    playerId, playerName,
    inningsBowled: 0, legalDeliveries: 0, runsConceded: 0, wickets: 0, maidens: 0,
    bestBowling: null,
});

/**
 * One tournament's batting + bowling leaderboards, computed fresh from
 * every `PlayerMatchStats` row its completed matches produced — one entry
 * per (player, match), same granularity `applyCareerStatsIncrement` writes.
 * Pure — no model, no I/O. See docs/superpowers/specs/2026-09-06-tournament-
 * leaderboards-design.md for the full contract.
 */
export const computeLeaderboards = ({ contributions }) => {
    const batting = new Map();
    const bowling = new Map();

    for (const c of contributions) {
        if (c.battingLine) {
            const row = batting.get(c.playerId) ?? newBattingRow(c.playerId, c.playerName);
            row.inningsBatted += 1;
            if (c.battingLine.isNotOut) row.notOuts += 1; else row.timesOut += 1;
            for (const [careerField, lineField] of BATTING_SUM_FIELDS) {
                row[careerField] += num(c.battingLine[lineField]);
            }
            if (isBetterHighScore(c.battingLine, row.highScore)) {
                row.highScore = { runs: c.battingLine.runs, isNotOut: c.battingLine.isNotOut, matchId: c.matchId };
            }
            batting.set(c.playerId, row);
        }
        if (c.bowlingLine) {
            const row = bowling.get(c.playerId) ?? newBowlingRow(c.playerId, c.playerName);
            row.inningsBowled += 1;
            for (const [careerField, lineField] of BOWLING_SUM_FIELDS) {
                row[careerField] += num(c.bowlingLine[lineField]);
            }
            if (isBetterBowling(c.bowlingLine, row.bestBowling)) {
                row.bestBowling = { wickets: c.bowlingLine.wickets, runs: c.bowlingLine.runs, matchId: c.matchId };
            }
            bowling.set(c.playerId, row);
        }
    }

    const battingLeaderboard = [...batting.values()].map((r) => ({
        playerId: r.playerId, playerName: r.playerName,
        inningsBatted: r.inningsBatted, runs: r.runs, ballsFaced: r.ballsFaced,
        timesOut: r.timesOut, notOuts: r.notOuts,
        average: battingAverage(r.runs, r.timesOut),
        strikeRate: strikeRate(r.runs, r.ballsFaced),
        fours: r.fours, sixes: r.sixes, fifties: r.fifties, hundreds: r.hundreds,
        highScore: r.highScore,
    }));
    battingLeaderboard.sort((a, b) =>
        b.runs - a.runs
        || (b.average ?? -Infinity) - (a.average ?? -Infinity)
        || a.playerName.localeCompare(b.playerName));

    const bowlingLeaderboard = [...bowling.values()].map((r) => ({
        playerId: r.playerId, playerName: r.playerName,
        inningsBowled: r.inningsBowled, legalDeliveries: r.legalDeliveries,
        runsConceded: r.runsConceded, wickets: r.wickets, maidens: r.maidens,
        economy: economy(r.runsConceded, r.legalDeliveries),
        bestBowling: r.bestBowling,
    }));
    bowlingLeaderboard.sort((a, b) =>
        b.wickets - a.wickets
        || a.runsConceded - b.runsConceded
        || a.playerName.localeCompare(b.playerName));

    return { battingLeaderboard, bowlingLeaderboard };
};
