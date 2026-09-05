import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Organization } from '../models/organization.model.js';
import { Team } from '../models/team.model.js';
import { isOrgMember } from '../utils/organizationAccess.js';

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

    return res.status(200).json(new ApiResponse(200, {
        id: org._id,
        name: org.name,
        owner: { id: org.owner._id, name: org.owner.fullName },
        members: org.members.map((m) => ({ id: m.user._id, name: m.user.fullName, role: m.role })),
        teams: teams.map((team) => ({ id: team._id, name: team.name, shortName: team.shortName ?? null })),
    }, req.t("ORGANIZATION_FETCHED")));
});

export { createOrganization, listMyOrganizations, getOrganization };
