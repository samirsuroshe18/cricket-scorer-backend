import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Player } from '../models/player.model.js';
import { CareerStats } from '../models/careerStats.model.js';
import { battingAverage, strikeRate, economy } from '../utils/careerStats.js';

// A Player with no CareerStats row (never finished a match) is not an error
// — the zero-value shape a screen renders as "no matches yet" rather than an
// error page. Matches CareerStats' own field defaults exactly, so a fresh
// Player and a Player whose one match got abandoned (which never increments
// CareerStats — see docs/api.md) look identical here, correctly.
const emptyCareerStats = {
    matchesPlayed: 0,
    batting: {
        inningsBatted: 0, runs: 0, ballsFaced: 0, timesOut: 0, notOuts: 0,
        average: null, strikeRate: 0,
        fours: 0, sixes: 0, fifties: 0, hundreds: 0, highScore: null,
    },
    bowling: {
        inningsBowled: 0, legalDeliveries: 0, runsConceded: 0, wickets: 0, maidens: 0,
        economy: 0, bestBowling: null,
    },
};

// average/strikeRate/economy are deliberately not stored on CareerStats —
// computed here, from the same pure functions applyCareerStatsIncrement's
// own max-field logic never touches, so the read path can never drift from
// the write path's arithmetic. See "Exact fields and formulas" in
// docs/api.md.
const getCareerStats = catchAsync(async (req, res) => {
    const { playerId } = req.params;

    const player = await Player.findOne({ _id: playerId, isDeleted: false });
    if (!player) {
        throw new ApiError(404, "PLAYER_NOT_FOUND");
    }

    if (!player.createdBy?.equals(req.user._id)) {
        throw new ApiError(403, "PLAYER_NOT_OWNED");
    }

    const career = await CareerStats.findOne({ playerId: player._id });

    const data = {
        playerId: player._id,
        playerName: player.name,
        ...(career
            ? {
                matchesPlayed: career.matchesPlayed,
                batting: {
                    inningsBatted: career.inningsBatted,
                    runs: career.runs,
                    ballsFaced: career.ballsFaced,
                    timesOut: career.timesOut,
                    notOuts: career.notOuts,
                    average: battingAverage(career.runs, career.timesOut),
                    strikeRate: strikeRate(career.runs, career.ballsFaced),
                    fours: career.fours,
                    sixes: career.sixes,
                    fifties: career.fifties,
                    hundreds: career.hundreds,
                    highScore: career.highScore,
                },
                bowling: {
                    inningsBowled: career.inningsBowled,
                    legalDeliveries: career.legalDeliveries,
                    runsConceded: career.runsConceded,
                    wickets: career.wickets,
                    maidens: career.maidens,
                    economy: economy(career.runsConceded, career.legalDeliveries),
                    bestBowling: career.bestBowling,
                },
            }
            : emptyCareerStats),
    };

    return res.status(200).json(
        new ApiResponse(200, data, req.t("CAREER_STATS_FETCHED"))
    );
});

export { getCareerStats };
