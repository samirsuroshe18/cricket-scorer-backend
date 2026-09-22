import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Team } from '../models/team.model.js';
import { Match } from '../models/match.model.js';
import { Organization } from '../models/organization.model.js';
import { canAccessTeam, canManageTeam, getMemberOrgIds } from '../utils/organizationAccess.js';
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, serializeMatchHistoryItems } from './match.controller.js';
import { uploadOnCloudinary } from '../utils/cloudinary.js';
import { discardStagedFile } from '../utils/discardStagedFile.js';
import { parseTeamFields } from '../utils/teamFields.js';

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
    if (!(await canAccessTeam(team, requesterId))) {
        throw new ApiError(403, "TEAM_NOT_OWNED");
    }
    return team;
};

// A team's organization is populated here (name only — no endpoint needs
// its members/owner) so the response can carry {id, name} per docs/api.md,
// not the bare ObjectId Team.organization actually stores.
const toOrganizationSummary = (organization) =>
    organization ? { id: organization._id, name: organization.name } : null;

// Same ownership pattern as getCareerStats: a malformed teamId throws a raw
// Mongoose CastError from the query layer itself, which errorHandler already
// turns into 400 INVALID_ID (see invalidObjectIdCastError.test.js) — no
// manual ObjectId validation needed here.
const getTeamProfile = catchAsync(async (req, res) => {
    const { teamId } = req.params;

    const team = await findOwnedTeam(teamId, req.user._id);
    await team.populate('players');
    await team.populate('organization', 'name');

    return res.status(200).json(new ApiResponse(200, {
        teamId: team._id,
        name: team.name,
        shortName: team.shortName ?? null,
        logoUrl: team.logoUrl ?? null,
        organization: toOrganizationSummary(team.organization),
        canManage: await canManageTeam(team, req.user._id),
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

// Identical shape/validation to GET /v1/match/history (see getMatchHistory;
// the per-match serializer is shared, since the client parses both with one model)
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

    const items = await serializeMatchHistoryItems(matches);

    return res.status(200).json(new ApiResponse(200, {
        matches: items,
        page,
        limit,
        total,
    }, req.t("TEAM_MATCHES_FETCHED")));
});

// Powers the "reuse an existing team" picker on match creation — the
// scorer's own teams, so they can pass one back as teamAId/teamBId instead
// of typing a name that createMatch would otherwise treat as brand new.
const listMyTeams = catchAsync(async (req, res) => {
    const orgIds = await getMemberOrgIds(req.user._id);
    const teams = await Team.find({
        isDeleted: false,
        $or: [{ createdBy: req.user._id }, { organization: { $in: orgIds } }],
    })
        .sort({ createdAt: -1 })
        .populate('organization', 'name');

    return res.status(200).json(new ApiResponse(200, {
        teams: teams.map((team) => ({
            id: team._id,
            name: team.name,
            shortName: team.shortName ?? null,
            logoUrl: team.logoUrl ?? null,
            organization: toOrganizationSummary(team.organization),
        })),
    }, req.t("MY_TEAMS_FETCHED")));
});

// Attach an existing standalone team to an organization the caller owns, or
// detach an org-owned team back to standalone. Detaching only ever needs
// team ownership; attaching additionally needs ownership of the target org.
const updateTeamOrganization = catchAsync(async (req, res) => {
    const { teamId } = req.params;
    const team = await findOwnedTeam(teamId, req.user._id);

    const organizationId = req.body.organizationId ?? null;

    if (organizationId === null) {
        team.organization = null;
        await team.save();
        return res.status(200).json(new ApiResponse(200, {
            id: team._id,
            organization: null,
        }, req.t("TEAM_ORGANIZATION_UPDATED")));
    }

    if (team.organization != null) {
        throw new ApiError(409, "TEAM_ALREADY_IN_ORGANIZATION");
    }

    const org = await Organization.findOne({ _id: organizationId, isDeleted: false });
    if (!org) {
        throw new ApiError(404, "ORG_NOT_FOUND");
    }
    if (!org.owner.equals(req.user._id)) {
        throw new ApiError(403, "ORG_NOT_OWNED");
    }

    team.organization = org._id;
    await team.save();

    return res.status(200).json(new ApiResponse(200, {
        id: team._id,
        organization: team.organization,
    }, req.t("TEAM_ORGANIZATION_UPDATED")));
});

// Same file-upload path as updateOrganizationLogo: `upload.single('file')`
// stages and validates (type/size), Cloudinary hosts it. The previous logo is
// left orphaned on Cloudinary, the same tradeoff updateProfile and
// updateOrganizationLogo already make. Ownership is findOwnedTeam's own rule
// (creator or org member), so anyone who can open the team profile can set
// its logo.
const updateTeamLogo = catchAsync(async (req, res) => {
    const { teamId } = req.params;

    let team;
    try {
        team = await findOwnedTeam(teamId, req.user._id);
    } catch (error) {
        await discardStagedFile(req.file);
        throw error;
    }

    if (!req.file) {
        throw new ApiError(400, "LOGO_REQUIRED");
    }

    const uploadResult = await uploadOnCloudinary(req.file.path);
    if (!uploadResult?.secure_url) {
        throw new ApiError(500, "LOGO_UPLOAD_FAILED");
    }

    team.logoUrl = uploadResult.secure_url;
    await team.save();

    return res.status(200).json(new ApiResponse(200, {
        id: team._id,
        logoUrl: team.logoUrl,
    }, req.t("TEAM_LOGO_UPDATED")));
});

// A standalone team the caller owns, created without playing a match first.
// Organization-owned teams go through POST /v1/organization/:orgId/teams
// instead; both validate through parseTeamFields.
const createTeam = catchAsync(async (req, res) => {
    const { name, shortName } = parseTeamFields(req.body);

    const team = await Team.create({
        name,
        shortName,
        createdBy: req.user._id,
        organization: null,
    });

    return res.status(200).json(new ApiResponse(200, {
        id: team._id,
        name: team.name,
        shortName: team.shortName ?? null,
        logoUrl: null,
        organization: null,
    }, req.t("TEAM_CREATED")));
});

// Rename (and/or re-set the short name of) a team the caller manages —
// creator for a standalone team, organization owner for an org team. Reuses
// parseTeamFields as-is: the edit sheet always sends both fields (prefilled
// from the current profile), so there is no "omitted vs blank shortName"
// distinction to make on the wire that create doesn't already handle.
const updateTeam = catchAsync(async (req, res) => {
    const { teamId } = req.params;
    const team = await findOwnedTeam(teamId, req.user._id);
    if (!(await canManageTeam(team, req.user._id))) {
        throw new ApiError(403, "TEAM_NOT_MANAGEABLE");
    }

    const { name, shortName } = parseTeamFields(req.body);
    team.name = name;
    team.shortName = shortName;
    await team.save();

    return res.status(200).json(new ApiResponse(200, {
        id: team._id,
        name: team.name,
        shortName: team.shortName ?? null,
    }, req.t("TEAM_UPDATED")));
});

export { getTeamProfile, getTeamMatches, listMyTeams, createTeam, updateTeam, updateTeamOrganization, updateTeamLogo };
