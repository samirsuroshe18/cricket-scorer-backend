import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { AuctionTeamOwner } from '../src/models/auctionTeamOwner.model.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Organization } from '../src/models/organization.model.js';
import { Team } from '../src/models/team.model.js';
import { User } from '../src/models/user.model.js';

describe('AuctionTeamOwner', () => {
  beforeAll(async () => {
    await connectTestDb();
    await AuctionTeamOwner.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const seed = async () => {
    const owner = await User.create({ email: 'owner@example.com', password: 'password123', fullName: 'Owner' });
    const member = await User.create({ email: 'member@example.com', password: 'password123', fullName: 'Member' });
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }, { user: member._id, role: 'member' }],
    });
    const tournament = await Tournament.create({
      name: 'Summer T20', nameLower: 'summer t20', organization: org._id, format: 'league', createdBy: owner._id,
    });
    const teamA = await Team.create({ name: 'Team A', createdBy: owner._id, organization: org._id });
    const teamB = await Team.create({ name: 'Team B', createdBy: owner._id, organization: org._id });
    return { owner, member, org, tournament, teamA, teamB };
  };

  it('creates with the given fields', async () => {
    const { tournament, teamA, member, owner } = await seed();

    const doc = await AuctionTeamOwner.create({
      tournament: tournament._id, team: teamA._id, owner: member._id, budget: 100000, createdBy: owner._id,
    });

    expect(doc.budget).toBe(100000);
  });

  it('rejects a second owner for the same team in the same tournament', async () => {
    const { tournament, teamA, member, owner } = await seed();
    await AuctionTeamOwner.create({
      tournament: tournament._id, team: teamA._id, owner: member._id, budget: 100000, createdBy: owner._id,
    });

    await expect(
      AuctionTeamOwner.create({
        tournament: tournament._id, team: teamA._id, owner: owner._id, budget: 50000, createdBy: owner._id,
      })
    ).rejects.toThrow();
  });

  it('rejects the same owner assigned to a second team in the same tournament', async () => {
    const { tournament, teamA, teamB, member, owner } = await seed();
    await AuctionTeamOwner.create({
      tournament: tournament._id, team: teamA._id, owner: member._id, budget: 100000, createdBy: owner._id,
    });

    await expect(
      AuctionTeamOwner.create({
        tournament: tournament._id, team: teamB._id, owner: member._id, budget: 100000, createdBy: owner._id,
      })
    ).rejects.toThrow();
  });

  it('allows the same team/owner pairing across two different tournaments', async () => {
    const { tournament, teamA, member, owner, org } = await seed();
    const tournament2 = await Tournament.create({
      name: 'Winter T20', nameLower: 'winter t20', organization: org._id, format: 'knockout', createdBy: owner._id,
    });
    await AuctionTeamOwner.create({
      tournament: tournament._id, team: teamA._id, owner: member._id, budget: 100000, createdBy: owner._id,
    });

    const second = await AuctionTeamOwner.create({
      tournament: tournament2._id, team: teamA._id, owner: member._id, budget: 75000, createdBy: owner._id,
    });

    expect(second.budget).toBe(75000);
  });
});
