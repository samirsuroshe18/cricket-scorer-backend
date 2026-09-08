import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { AuctionSession } from '../src/models/auctionSession.model.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Organization } from '../src/models/organization.model.js';
import { User } from '../src/models/user.model.js';

describe('AuctionSession', () => {
  beforeAll(async () => {
    await connectTestDb();
    await AuctionSession.init();
  });

  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  const seedTournament = async () => {
    const owner = await User.create({ email: 'owner@example.com', password: 'password123', fullName: 'Owner' });
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }],
    });
    const tournament = await Tournament.create({
      name: 'Summer T20', nameLower: 'summer t20', organization: org._id, format: 'league', createdBy: owner._id,
    });
    return { owner, tournament };
  };

  it('creates with the given fields, defaulting status to active', async () => {
    const { owner, tournament } = await seedTournament();

    const session = await AuctionSession.create({
      tournament: tournament._id, createdBy: owner._id, startedAt: new Date(),
    });

    expect(session.status).toBe('active');
    expect(session.completedAt).toBeNull();
  });

  it('rejects a second session for the same tournament', async () => {
    const { owner, tournament } = await seedTournament();
    await AuctionSession.create({ tournament: tournament._id, createdBy: owner._id, startedAt: new Date() });

    await expect(
      AuctionSession.create({ tournament: tournament._id, createdBy: owner._id, startedAt: new Date() })
    ).rejects.toThrow();
  });

  it('rejects an invalid status', async () => {
    const { owner, tournament } = await seedTournament();

    await expect(
      AuctionSession.create({ tournament: tournament._id, createdBy: owner._id, startedAt: new Date(), status: 'bogus' })
    ).rejects.toThrow();
  });
});
