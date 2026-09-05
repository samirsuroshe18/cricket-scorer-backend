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

// The org(s), if any, whose owner may assign a scorer for a match between
// these two teams — the owner of teamA's org, the owner of teamB's org, or
// both if they differ. A team with no organization simply contributes
// nothing; if neither has one, the result is empty.
export const qualifyingOrgOwnerIds = async (teamA, teamB) => {
    const orgIds = [teamA.organization, teamB.organization].filter(Boolean);
    if (orgIds.length === 0) {
        return [];
    }
    const orgs = await Organization.find({ _id: { $in: orgIds }, isDeleted: false });
    return orgs.map((org) => String(org.owner));
};

// True if `userId` may assign/reassign/clear the scorer on `match` —
// either they created it, or they own an organization either team belongs
// to. Backs PATCH /v1/match/:matchId/scorer and
// GET /v1/match/:matchId/scorer-candidates.
export const canAssignScorer = async (match, teamA, teamB, userId) => {
    if (match.createdBy?.equals(userId)) {
        return true;
    }
    const ownerIds = await qualifyingOrgOwnerIds(teamA, teamB);
    return ownerIds.includes(String(userId));
};
