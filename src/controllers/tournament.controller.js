import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Tournament, TOURNAMENT_FORMATS, TOURNAMENT_STATUS } from '../models/tournament.model.js';
import { Organization } from '../models/organization.model.js';
import { isOrgMember } from '../utils/organizationAccess.js';

const asString = (value) => (typeof value === 'string' ? value : '');

// Shared by every tournament endpoint in this file — mirrors
// organization.controller.js's findAccessibleOrganization/
// findOwnedOrganization pair, but derived from the tournament's own
// `organization` field rather than a route param.
const findAccessibleTournament = async (tournamentId, userId) => {
    const tournament = await Tournament.findOne({ _id: tournamentId, isDeleted: false });
    if (!tournament) {
        throw new ApiError(404, "TOURNAMENT_NOT_FOUND");
    }
    // Every non-deleted Tournament has a non-deleted Organization —
    // deleteOrganization cascades to soft-delete its tournaments in the
    // same transaction (see organization.controller.js), so there is no
    // "orphaned tournament" case to guard against here.
    const org = await Organization.findOne({ _id: tournament.organization, isDeleted: false });
    if (!isOrgMember(org, userId)) {
        throw new ApiError(403, "NOT_ORG_MEMBER");
    }
    return { tournament, org };
};

const findOwnedTournament = async (tournamentId, userId) => {
    const { tournament, org } = await findAccessibleTournament(tournamentId, userId);
    if (!org.owner.equals(userId)) {
        throw new ApiError(403, "TOURNAMENT_NOT_OWNED");
    }
    return { tournament, org };
};

const getTournament = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament, org } = await findAccessibleTournament(tournamentId, req.user._id);

    await tournament.populate('teams.team', 'name shortName');

    return res.status(200).json(new ApiResponse(200, {
        id: tournament._id,
        name: tournament.name,
        format: tournament.format,
        status: tournament.status,
        organization: { id: org._id, name: org.name },
        teams: tournament.teams.map((entry) => ({
            id: entry.team._id,
            name: entry.team.name,
            shortName: entry.team.shortName ?? null,
            joinedAt: entry.joinedAt,
        })),
        createdAt: tournament.createdAt,
    }, req.t("TOURNAMENT_FETCHED")));
});

const updateTournament = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    const updates = {};

    if (req.body.name !== undefined) {
        const name = asString(req.body.name).trim();
        if (!name) {
            throw new ApiError(400, "TOURNAMENT_NAME_REQUIRED");
        }
        updates.name = name;
        updates.nameLower = name.toLowerCase();
    }
    if (req.body.format !== undefined) {
        const format = asString(req.body.format);
        if (!TOURNAMENT_FORMATS.includes(format)) {
            throw new ApiError(400, "INVALID_TOURNAMENT_FORMAT");
        }
        updates.format = format;
    }
    if (req.body.status !== undefined) {
        const status = asString(req.body.status);
        if (!TOURNAMENT_STATUS.includes(status)) {
            throw new ApiError(400, "INVALID_TOURNAMENT_STATUS");
        }
        updates.status = status;
    }
    if (Object.keys(updates).length === 0) {
        throw new ApiError(400, "TOURNAMENT_UPDATE_FIELDS_REQUIRED");
    }

    Object.assign(tournament, updates);
    try {
        await tournament.save();
    } catch (err) {
        const isNameCollision = err.code === 11000 && Object.hasOwn(err.keyPattern ?? {}, 'nameLower');
        if (isNameCollision) {
            throw new ApiError(409, "TOURNAMENT_NAME_TAKEN");
        }
        throw err;
    }

    return res.status(200).json(new ApiResponse(200, {
        id: tournament._id,
        name: tournament.name,
        format: tournament.format,
        status: tournament.status,
    }, req.t("TOURNAMENT_UPDATED")));
});

const deleteTournament = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    tournament.isDeleted = true;
    await tournament.save();

    return res.status(200).json(new ApiResponse(200, { tournamentId: tournament._id }, req.t("TOURNAMENT_DELETED")));
});

export {
    findAccessibleTournament,
    findOwnedTournament,
    getTournament,
    updateTournament,
    deleteTournament,
};
