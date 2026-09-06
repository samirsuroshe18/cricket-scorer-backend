import catchAsync from '../utils/catchAsync.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Match } from '../models/match.model.js';
import { PlayerMatchStats } from '../models/playerMatchStats.model.js';
import { Player } from '../models/player.model.js';
import { findAccessibleTournament } from './tournament.controller.js';
import { computeLeaderboards } from '../utils/computeLeaderboards.js';

// No format gate, unlike getStandings — a leaderboard is player-level, not
// team-points-level, so it's meaningful for a knockout tournament too.
export const getLeaderboards = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);

    const matches = await Match.find(
        { tournament: tournament._id, isDeleted: false, status: 'completed' },
        '_id',
    );
    const matchIds = matches.map((m) => m._id);

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

    const { battingLeaderboard, bowlingLeaderboard } = computeLeaderboards({ contributions });

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        battingLeaderboard,
        bowlingLeaderboard,
    }, req.t("LEADERBOARDS_FETCHED")));
});
