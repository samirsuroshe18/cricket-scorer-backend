import { Organization } from '../models/organization.model.js';

// True when `userId` is present in `org.members`, regardless of role — an
// owner is always also a member entry (see organization.controller.js's
// createOrganization), so this single check covers both roles.
export const isOrgMember = (org, userId) =>
    org.members.some((m) => m.user.equals(userId));

// True if `userId` can view/use `team` — either they created it directly,
// or it belongs to an organization they're a member of. Backs the widened
// resolveTeamSide (match.controller.js) and findOwnedTeam (team.controller.js).
export const canAccessTeam = async (team, userId) => {
    if (team.createdBy?.equals(userId)) {
        return true;
    }
    if (!team.organization) {
        return false;
    }
    const org = await Organization.findOne({ _id: team.organization, isDeleted: false });
    return org != null && isOrgMember(org, userId);
};

// Every non-deleted organization `userId` belongs to, owner or member —
// backs the widened GET /v1/team query in listMyTeams.
export const getMemberOrgIds = async (userId) => {
    const orgs = await Organization.find(
        { 'members.user': userId, isDeleted: false },
        '_id'
    );
    return orgs.map((org) => org._id);
};
