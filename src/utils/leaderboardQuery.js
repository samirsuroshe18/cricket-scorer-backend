import { PlayerMatchStats } from '../models/playerMatchStats.model.js';
import { Player } from '../models/player.model.js';
import { computeLeaderboards } from './computeLeaderboards.js';

/**
 * The join + compute step shared by every leaderboard endpoint — tournament-
 * scoped and organization-scoped alike. The only difference between them is
 * which `Match` ids feed in here; this is where the `PlayerMatchStats` join
 * and the `computeLeaderboards` call live exactly once. Not itself pure
 * (queries Mongo) — `computeLeaderboards` stays pure, and this is its one
 * piece of caller-side wiring.
 */
export const buildLeaderboardsForMatchIds = async (matchIds) => {
    const rows = await PlayerMatchStats.find(
        { matchId: { $in: matchIds } },
        'playerId matchId battingLine bowlingLine',
    );

    const playerIds = [...new Set(rows.map((r) => String(r.playerId)))];
    const players = await Player.find(
        { _id: { $in: playerIds }, isDeleted: false },
        'name',
    );
    const nameById = new Map(players.map((p) => [String(p._id), p.name]));

    const contributions = rows.map((r) => ({
        playerId: String(r.playerId),
        playerName: nameById.get(String(r.playerId)) ?? 'Unknown player',
        matchId: String(r.matchId),
        battingLine: r.battingLine,
        bowlingLine: r.bowlingLine,
    }));

    return computeLeaderboards({ contributions });
};
