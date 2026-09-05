import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Tournament } from '../models/tournament.model.js';
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

export {
    findAccessibleTournament,
    findOwnedTournament,
    getTournament,
};
