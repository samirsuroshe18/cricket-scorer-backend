import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';
import { Team } from '../src/models/team.model.js';
import { canAccessTeam, getMemberOrgIds } from '../src/utils/organizationAccess.js';

describe('organizationAccess', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Organization.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('canAccessTeam is true for the team creator, even with no organization', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const team = await Team.create({ name: 'A', createdBy: ownerId });

    await expect(canAccessTeam(team, ownerId)).resolves.toBe(true);
  });

  it('canAccessTeam is false for a stranger to a standalone team', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const strangerId = new mongoose.Types.ObjectId();
    const team = await Team.create({ name: 'A', createdBy: ownerId });

    await expect(canAccessTeam(team, strangerId)).resolves.toBe(false);
  });

  it('canAccessTeam is true for an org member on an org-owned team, even if they did not create it', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const memberId = new mongoose.Types.ObjectId();
    const org = await Organization.create({
      name: 'Riverside CC',
      nameLower: 'riverside cc',
      owner: ownerId,
      members: [
        { user: ownerId, role: 'owner' },
        { user: memberId, role: 'member' },
      ],
    });
    const team = await Team.create({ name: 'Riverside U19', createdBy: ownerId, organization: org._id });

    await expect(canAccessTeam(team, memberId)).resolves.toBe(true);
  });

  it('canAccessTeam is false for a non-member even when the team belongs to an organization', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const strangerId = new mongoose.Types.ObjectId();
    const org = await Organization.create({
      name: 'Riverside CC',
      nameLower: 'riverside cc',
      owner: ownerId,
      members: [{ user: ownerId, role: 'owner' }],
    });
    const team = await Team.create({ name: 'Riverside U19', createdBy: ownerId, organization: org._id });

    await expect(canAccessTeam(team, strangerId)).resolves.toBe(false);
  });

  it('getMemberOrgIds returns every non-deleted org the user belongs to, owner or member', async () => {
    const userId = new mongoose.Types.ObjectId();
    const otherId = new mongoose.Types.ObjectId();
    const orgOwned = await Organization.create({
      name: 'Owned', nameLower: 'owned', owner: userId, members: [{ user: userId, role: 'owner' }],
    });
    const orgMemberOf = await Organization.create({
      name: 'Joined', nameLower: 'joined', owner: otherId,
      members: [{ user: otherId, role: 'owner' }, { user: userId, role: 'member' }],
    });
    await Organization.create({
      name: 'Unrelated', nameLower: 'unrelated', owner: otherId, members: [{ user: otherId, role: 'owner' }],
    });

    const ids = await getMemberOrgIds(userId);

    expect(ids.map(String).sort()).toEqual([String(orgOwned._id), String(orgMemberOf._id)].sort());
  });

  it('getMemberOrgIds excludes a soft-deleted organization', async () => {
    const userId = new mongoose.Types.ObjectId();
    const org = await Organization.create({
      name: 'Deleted', nameLower: 'deleted', owner: userId,
      members: [{ user: userId, role: 'owner' }], isDeleted: true,
    });

    const ids = await getMemberOrgIds(userId);

    expect(ids.map(String)).not.toContain(String(org._id));
  });
});
