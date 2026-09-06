import catchAsync from '../utils/catchAsync.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Match } from '../models/match.model.js';
import { findAccessibleTournament } from './tournament.controller.js';
import { buildLeaderboardsForMatchIds } from '../utils/leaderboardQuery.js';

// No format gate, unlike getStandings — a leaderboard is player-level, not
// team-points-level, so it's meaningful for a knockout tournament too.
export const getLeaderboards = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);

    const matches = await Match.find(
        { tournament: tournament._id, isDeleted: false, status: 'completed' },
        '_id',
    );

    const { battingLeaderboard, bowlingLeaderboard } =
        await buildLeaderboardsForMatchIds(matches.map((m) => m._id));

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        battingLeaderboard,
        bowlingLeaderboard,
    }, req.t("LEADERBOARDS_FETCHED")));
});
