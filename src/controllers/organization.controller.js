import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Organization } from '../models/organization.model.js';
import { Team } from '../models/team.model.js';

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

export { createOrganization, listMyOrganizations };
