import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Organization } from '../models/organization.model.js';
import { Team } from '../models/team.model.js';
import { isOrgMember } from '../utils/organizationAccess.js';
import { User } from '../models/user.model.js';
import { Tournament, TOURNAMENT_FORMATS } from '../models/tournament.model.js';

const asString = (value) => (typeof value === 'string' ? value : '');

const createOrganization = catchAsync(async (req, res) => {
    const name = asString(req.body.name).trim();
    if (!name) {
        throw new ApiError(400, "ORG_NAME_REQUIRED");
    }

    let org;
    try {
        org = await Organization.create({
            name,
            nameLower: name.toLowerCase(),
            owner: req.user._id,
            members: [{ user: req.user._id, role: 'owner' }],
        });
    } catch (err) {
        const isNameCollision = err.code === 11000 && Object.hasOwn(err.keyPattern ?? {}, 'nameLower');
        if (isNameCollision) {
            throw new ApiError(409, "ORG_NAME_TAKEN");
        }
        throw err;
    }

    return res.status(200).json(new ApiResponse(200, {
        id: org._id,
        name: org.name,
        owner: { id: req.user._id, name: req.user.fullName },
        members: [{ id: req.user._id, name: req.user.fullName, role: 'owner' }],
        teams: [],
        createdAt: org.createdAt,
    }, req.t("ORGANIZATION_CREATED")));
});

const listMyOrganizations = catchAsync(async (req, res) => {
    const orgs = await Organization.find({ 'members.user': req.user._id, isDeleted: false }).sort({ createdAt: -1 });

    const orgIds = orgs.map((org) => org._id);
    const teamCounts = await Team.aggregate([
        { $match: { organization: { $in: orgIds }, isDeleted: false } },
        { $group: { _id: '$organization', count: { $sum: 1 } } },
    ]);
    const teamCountByOrgId = new Map(teamCounts.map((row) => [String(row._id), row.count]));

    return res.status(200).json(new ApiResponse(200, {
        organizations: orgs.map((org) => ({
            id: org._id,
            name: org.name,
            myRole: org.members.find((m) => m.user.equals(req.user._id))?.role ?? 'member',
            memberCount: org.members.length,
            teamCount: teamCountByOrgId.get(String(org._id)) ?? 0,
        })),
    }, req.t("ORGANIZATIONS_FETCHED")));
});

// Shared by every remaining org endpoint in this file — mirrors
// team.controller.js's findOwnedTeam shape, but with two variants: "any
// member can view" vs "only the owner can act."
const findAccessibleOrganization = async (orgId, userId) => {
    const org = await Organization.findOne({ _id: orgId, isDeleted: false });
    if (!org) {
        throw new ApiError(404, "ORG_NOT_FOUND");
    }
    if (!isOrgMember(org, userId)) {
        throw new ApiError(403, "NOT_ORG_MEMBER");
    }
    return org;
};

const findOwnedOrganization = async (orgId, userId) => {
    const org = await Organization.findOne({ _id: orgId, isDeleted: false });
    if (!org) {
        throw new ApiError(404, "ORG_NOT_FOUND");
    }
    if (!org.owner.equals(userId)) {
        throw new ApiError(403, "ORG_NOT_OWNED");
    }
    return org;
};

const getOrganization = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findAccessibleOrganization(orgId, req.user._id);
    await org.populate('owner', 'fullName');
    await org.populate('members.user', 'fullName');

    const teams = await Team.find({ organization: org._id, isDeleted: false });
    const tournaments = await Tournament.find({ organization: org._id, isDeleted: false }).sort({ createdAt: -1 });

    return res.status(200).json(new ApiResponse(200, {
        id: org._id,
        name: org.name,
        owner: { id: org.owner._id, name: org.owner.fullName },
        // m.user is null when that user account has since been deleted —
        // nothing today cascades a User deletion into every org's members
        // array, so a stale reference is expected data, not corruption.
        members: org.members
            .filter((m) => m.user)
            .map((m) => ({ id: m.user._id, name: m.user.fullName, role: m.role })),
        teams: teams.map((team) => ({ id: team._id, name: team.name, shortName: team.shortName ?? null })),
        tournaments: tournaments.map((t) => ({
            id: t._id,
            name: t.name,
            format: t.format,
            status: t.status,
            teamCount: t.teams.length,
        })),
    }, req.t("ORGANIZATION_FETCHED")));
});

const addOrganizationMember = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findOwnedOrganization(orgId, req.user._id);

    const email = asString(req.body.email).trim().toLowerCase();
    const user = await User.findOne({ email });
    if (!user) {
        throw new ApiError(404, "USER_NOT_FOUND");
    }
    if (isOrgMember(org, user._id)) {
        throw new ApiError(409, "ALREADY_ORG_MEMBER");
    }

    org.members.push({ user: user._id, role: 'member' });
    await org.save();

    return res.status(200).json(new ApiResponse(200, {
        id: user._id,
        name: user.fullName,
        role: 'member',
    }, req.t("ORG_MEMBER_ADDED")));
});

const removeOrganizationMember = catchAsync(async (req, res) => {
    const { orgId, userId } = req.params;
    const org = await Organization.findOne({ _id: orgId, isDeleted: false });
    if (!org) {
        throw new ApiError(404, "ORG_NOT_FOUND");
    }
    if (org.owner.equals(userId)) {
        throw new ApiError(400, "CANNOT_REMOVE_OWNER");
    }
    const isSelf = req.user._id.equals(userId);
    if (!org.owner.equals(req.user._id) && !isSelf) {
        throw new ApiError(403, "ORG_NOT_OWNED");
    }
    if (!isOrgMember(org, userId)) {
        throw new ApiError(404, "NOT_ORG_MEMBER");
    }

    org.members = org.members.filter((m) => !m.user.equals(userId));
    await org.save();

    return res.status(200).json(new ApiResponse(200, { orgId: org._id, userId }, req.t("ORG_MEMBER_REMOVED")));
});

const createOrganizationTeam = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findOwnedOrganization(orgId, req.user._id);

    const name = asString(req.body.name).trim();
    if (!name) {
        throw new ApiError(400, "TEAM_NAMES_REQUIRED");
    }

    const team = await Team.create({
        name,
        shortName: req.body.shortName,
        createdBy: req.user._id,
        organization: org._id,
    });

    return res.status(200).json(new ApiResponse(200, {
        id: team._id,
        name: team.name,
        shortName: team.shortName ?? null,
        organization: team.organization,
    }, req.t("TEAM_CREATED")));
});

const createOrgTournament = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findOwnedOrganization(orgId, req.user._id);

    const name = asString(req.body.name).trim();
    if (!name) {
        throw new ApiError(400, "TOURNAMENT_NAME_REQUIRED");
    }
    const format = asString(req.body.format);
    if (!format) {
        throw new ApiError(400, "TOURNAMENT_FORMAT_REQUIRED");
    }
    if (!TOURNAMENT_FORMATS.includes(format)) {
        throw new ApiError(400, "INVALID_TOURNAMENT_FORMAT");
    }

    let tournament;
    try {
        tournament = await Tournament.create({
            name,
            nameLower: name.toLowerCase(),
            organization: org._id,
            format,
            createdBy: req.user._id,
        });
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
        organization: tournament.organization,
        format: tournament.format,
        status: tournament.status,
        teams: [],
        createdAt: tournament.createdAt,
    }, req.t("TOURNAMENT_CREATED")));
});

const deleteOrganization = catchAsync(async (req, res) => {
    const { orgId } = req.params;
    const org = await findOwnedOrganization(orgId, req.user._id);

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await Organization.updateOne({ _id: org._id }, { $set: { isDeleted: true } }, { session });
            await Team.updateMany({ organization: org._id }, { $set: { organization: null } }, { session });
            // Unlike Team, a Tournament can't be orphaned back to standalone —
            // `organization` is required (tournament.model.js) since
            // tournament hosting has no ad-hoc/standalone case. The only way
            // to keep "every non-deleted Tournament has a non-deleted
            // Organization" true is to soft-delete them along with the org.
            await Tournament.updateMany({ organization: org._id }, { $set: { isDeleted: true } }, { session });
        });
    } finally {
        await session.endSession();
    }

    return res.status(200).json(new ApiResponse(200, { orgId: org._id }, req.t("ORGANIZATION_DELETED")));
});

export {
    createOrganization,
    listMyOrganizations,
    getOrganization,
    addOrganizationMember,
    removeOrganizationMember,
    createOrganizationTeam,
    createOrgTournament,
    deleteOrganization,
};
