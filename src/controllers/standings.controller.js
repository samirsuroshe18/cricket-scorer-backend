import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Match } from '../models/match.model.js';
import { Inning } from '../models/inning.model.js';
import { findAccessibleTournament } from './tournament.controller.js';
import { computeStandings, STANDINGS_FORMATS } from '../utils/computeStandings.js';

const roundNrr = (value) => Math.round(value * 1000) / 1000;

export const getStandings = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);

    if (!STANDINGS_FORMATS.includes(tournament.format)) {
        throw new ApiError(400, "STANDINGS_NOT_APPLICABLE");
    }

    await tournament.populate('teams.team', 'name');
    const teams = tournament.teams.map((entry) => ({
        id: String(entry.team._id),
        name: entry.team.name,
    }));

    const matches = await Match.find(
        { tournament: tournament._id, isDeleted: false, status: { $in: ['completed', 'abandoned'] } },
        'teamA teamB status result totalOvers',
    );

    const innings = await Inning.find(
        { matchId: { $in: matches.map((m) => m._id) } },
        'matchId battingTeam totalRuns legalBalls completionReason',
    );
    const inningsByMatch = innings.reduce((acc, inn) => {
        const key = String(inn.matchId);
        (acc[key] ??= []).push(inn);
        return acc;
    }, {});

    const matchInputs = matches.map((m) => ({
        teamAId: String(m.teamA),
        teamBId: String(m.teamB),
        status: m.status,
        resultWinner: m.result?.winner ?? null,
        totalOvers: m.totalOvers,
        innings: (inningsByMatch[String(m._id)] ?? []).map((inn) => ({
            battingSide: inn.battingTeam,
            runs: inn.totalRuns,
            legalBalls: inn.legalBalls,
            allOut: inn.completionReason === 'all_out',
        })),
    }));

    const standings = computeStandings({ teams, matches: matchInputs })
        .map((row) => ({ ...row, nrr: roundNrr(row.nrr) }));

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        format: tournament.format,
        standings,
    }, req.t("STANDINGS_FETCHED")));
});
