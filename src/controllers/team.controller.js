import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Team } from '../models/team.model.js';
import { Match } from '../models/match.model.js';
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from './match.controller.js';

// Shared by getTeamProfile/getTeamMatches: both need the team to exist and
// belong to the caller before doing anything else. A Team is only ever
// attached to a Match by the scorer who owns it (see createMatch's
// resolveTeamSide), so this ownership check on the Team implies ownership of
// every Match that references it — no separate createdBy filter needed on
// the Match query below.
const findOwnedTeam = async (teamId, requesterId) => {
    const team = await Team.findOne({ _id: teamId, isDeleted: false });
    if (!team) {
        throw new ApiError(404, "TEAM_NOT_FOUND");
    }
    if (!team.createdBy?.equals(requesterId)) {
        throw new ApiError(403, "TEAM_NOT_OWNED");
    }
    return team;
};

// Same ownership pattern as getCareerStats: a malformed teamId throws a raw
// Mongoose CastError from the query layer itself, which errorHandler already
// turns into 400 INVALID_ID (see invalidObjectIdCastError.test.js) — no
// manual ObjectId validation needed here.
const getTeamProfile = catchAsync(async (req, res) => {
    const { teamId } = req.params;

    const team = await findOwnedTeam(teamId, req.user._id);
    await team.populate('players');

    return res.status(200).json(new ApiResponse(200, {
        teamId: team._id,
        name: team.name,
        shortName: team.shortName ?? null,
        // No feature currently soft-deletes a Player, but the roster
        // shouldn't surface one if that ever changes — same defensive
        // filter as every other isDeleted:false query in this codebase.
        roster: team.players.filter((player) => !player.isDeleted).map((player) => ({
            playerId: player._id,
            playerName: player.name,
            jerseyNumber: player.jerseyNumber ?? null,
            role: player.role,
        })),
    }, req.t("TEAM_PROFILE_FETCHED")));
});

// Identical shape/validation to GET /v1/match/history (see getMatchHistory)
// — an $or across the two per-side indexes (match.model.js) instead of a
// single createdBy filter, since a team can be either teamA or teamB. All
// statuses are shown, same as match history: no completed-only filter.
const getTeamMatches = catchAsync(async (req, res) => {
    const { teamId } = req.params;
    await findOwnedTeam(teamId, req.user._id);

    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || DEFAULT_HISTORY_LIMIT;

    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
        throw new ApiError(400, "INVALID_PAGINATION", { params: { max: MAX_HISTORY_LIMIT } });
    }

    const filter = { $or: [{ teamA: teamId }, { teamB: teamId }], isDeleted: false };

    const [matches, total] = await Promise.all([
        Match.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit),
        Match.countDocuments(filter),
    ]);

    // Batched rather than one Team.findById per match, same reasoning as
    // getMatchHistory. Includes teamId itself so its own name is available
    // without a special case.
    const involvedTeamIds = [...new Set(matches.flatMap((match) => [String(match.teamA), String(match.teamB)]))];
    const involvedTeams = await Team.find({ _id: { $in: involvedTeamIds } });
    const teamNameById = new Map(involvedTeams.map((team) => [String(team._id), team.name]));

    return res.status(200).json(new ApiResponse(200, {
        matches: matches.map((match) => ({
            matchId: match._id,
            teamA: { id: match.teamA, name: teamNameById.get(String(match.teamA)) ?? null },
            teamB: { id: match.teamB, name: teamNameById.get(String(match.teamB)) ?? null },
            joinCode: match.joinCode ?? null,
            totalOvers: match.totalOvers,
            status: match.status,
            result: match.result ?? null,
            tossWinner: match.tossWinner ?? null,
            tossDecision: match.tossDecision ?? null,
            createdAt: match.createdAt,
        })),
        page,
        limit,
        total,
    }, req.t("TEAM_MATCHES_FETCHED")));
});

// Powers the "reuse an existing team" picker on match creation — the
// scorer's own teams, so they can pass one back as teamAId/teamBId instead
// of typing a name that createMatch would otherwise treat as brand new.
const listMyTeams = catchAsync(async (req, res) => {
    const teams = await Team.find({ createdBy: req.user._id, isDeleted: false }).sort({ createdAt: -1 });

    return res.status(200).json(new ApiResponse(200, {
        teams: teams.map((team) => ({
            id: team._id,
            name: team.name,
            shortName: team.shortName ?? null,
        })),
    }, req.t("MY_TEAMS_FETCHED")));
});

export { getTeamProfile, getTeamMatches, listMyTeams };
