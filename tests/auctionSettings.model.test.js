import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { AuctionSettings, CATEGORY_CAP_ROLES } from '../src/models/auctionSettings.model.js';
import { PLAYER_ROLES } from '../src/models/player.model.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Organization } from '../src/models/organization.model.js';
import { User } from '../src/models/user.model.js';

describe('AuctionSettings', () => {
  beforeAll(async () => {
    await connectTestDb();
    await AuctionSettings.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const seedTournament = async () => {
    const owner = await User.create({ email: 'owner@example.com', password: 'password123', fullName: 'Owner' });
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }],
    });
    return Tournament.create({
      name: 'Summer T20', nameLower: 'summer t20', organization: org._id, format: 'league', createdBy: owner._id,
    });
  };

  it('CATEGORY_CAP_ROLES excludes unknown, includes every other player role', () => {
    expect(CATEGORY_CAP_ROLES).not.toContain('unknown');
    expect(CATEGORY_CAP_ROLES.sort()).toEqual(PLAYER_ROLES.filter((r) => r !== 'unknown').sort());
  });

  it('creates with the given fields', async () => {
    const tournament = await seedTournament();
    const owner = await User.findOne({ email: 'owner@example.com' });

    const settings = await AuctionSettings.create({
      tournament: tournament._id, minSquadSize: 15, maxSquadSize: 20,
      categoryCaps: { wicketkeeper: 3 }, createdBy: owner._id,
    });

    expect(settings.minSquadSize).toBe(15);
    expect(settings.categoryCaps).toEqual({ wicketkeeper: 3 });
  });

  it('rejects a second document for the same tournament', async () => {
    const tournament = await seedTournament();
    const owner = await User.findOne({ email: 'owner@example.com' });
    await AuctionSettings.create({ tournament: tournament._id, createdBy: owner._id });

    await expect(
      AuctionSettings.create({ tournament: tournament._id, createdBy: owner._id })
    ).rejects.toThrow();
  });
});
