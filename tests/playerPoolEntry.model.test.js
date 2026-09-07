import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { PlayerPoolEntry } from '../src/models/playerPoolEntry.model.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Organization } from '../src/models/organization.model.js';
import { Player } from '../src/models/player.model.js';
import { User } from '../src/models/user.model.js';

describe('PlayerPoolEntry', () => {
  beforeAll(async () => {
    await connectTestDb();
    await PlayerPoolEntry.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const seed = async () => {
    const owner = await User.create({ email: 'owner@example.com', password: 'password123', fullName: 'Owner' });
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }],
    });
    const tournament = await Tournament.create({
      name: 'Summer T20', nameLower: 'summer t20', organization: org._id, format: 'league', createdBy: owner._id,
    });
    const player = await Player.create({ name: 'Rohit Sharma', nameLower: 'rohit sharma', createdBy: owner._id });
    return { owner, tournament, player };
  };

  it('creates with the given fields', async () => {
    const { owner, tournament, player } = await seed();

    const entry = await PlayerPoolEntry.create({
      tournament: tournament._id, player: player._id, basePrice: 5000, createdBy: owner._id,
    });

    expect(entry.basePrice).toBe(5000);
  });

  it('rejects a second entry for the same {tournament, player} pair', async () => {
    const { owner, tournament, player } = await seed();
    await PlayerPoolEntry.create({
      tournament: tournament._id, player: player._id, basePrice: 5000, createdBy: owner._id,
    });

    await expect(
      PlayerPoolEntry.create({
        tournament: tournament._id, player: player._id, basePrice: 6000, createdBy: owner._id,
      })
    ).rejects.toThrow();
  });

  it('allows the same player in two different tournaments', async () => {
    const { owner, tournament, player } = await seed();
    const tournament2 = await Tournament.create({
      name: 'Winter T20', nameLower: 'winter t20', organization: tournament.organization, format: 'knockout', createdBy: owner._id,
    });
    await PlayerPoolEntry.create({
      tournament: tournament._id, player: player._id, basePrice: 5000, createdBy: owner._id,
    });

    const second = await PlayerPoolEntry.create({
      tournament: tournament2._id, player: player._id, basePrice: 7000, createdBy: owner._id,
    });

    expect(second.basePrice).toBe(7000);
  });
});
