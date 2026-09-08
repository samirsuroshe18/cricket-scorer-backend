import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { AuctionLot } from '../src/models/auctionLot.model.js';
import { AuctionSession } from '../src/models/auctionSession.model.js';
import { PlayerPoolEntry } from '../src/models/playerPoolEntry.model.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Organization } from '../src/models/organization.model.js';
import { Player } from '../src/models/player.model.js';
import { User } from '../src/models/user.model.js';

describe('AuctionLot', () => {
  beforeAll(async () => {
    await connectTestDb();
    await AuctionLot.init();
  });

  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  const seed = async () => {
    const owner = await User.create({ email: 'owner@example.com', password: 'password123', fullName: 'Owner' });
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }],
    });
    const tournament = await Tournament.create({
      name: 'Summer T20', nameLower: 'summer t20', organization: org._id, format: 'league', createdBy: owner._id,
    });
    const player = await Player.create({ name: 'Rohit Sharma', createdBy: owner._id, nameLower: 'rohit sharma' });
    const poolEntry = await PlayerPoolEntry.create({
      tournament: tournament._id, player: player._id, basePrice: 5000, createdBy: owner._id,
    });
    const session = await AuctionSession.create({
      tournament: tournament._id, createdBy: owner._id, startedAt: new Date(),
    });
    return { owner, tournament, player, poolEntry, session };
  };

  it('creates a queued lot with the given fields', async () => {
    const { tournament, player, poolEntry, session } = await seed();

    const lot = await AuctionLot.create({
      session: session._id, tournament: tournament._id, poolEntry: poolEntry._id, player: player._id,
      basePrice: 5000, currentBid: 5000, status: 'queued', sequence: 0,
    });

    expect(lot.status).toBe('queued');
    expect(lot.currentBidder).toBeNull();
    expect(lot.endsAt).toBeNull();
  });

  it('rejects a second lot for the same pool entry in the same session', async () => {
    const { tournament, player, poolEntry, session } = await seed();
    await AuctionLot.create({
      session: session._id, tournament: tournament._id, poolEntry: poolEntry._id, player: player._id,
      basePrice: 5000, currentBid: 5000, status: 'queued', sequence: 0,
    });

    await expect(
      AuctionLot.create({
        session: session._id, tournament: tournament._id, poolEntry: poolEntry._id, player: player._id,
        basePrice: 5000, currentBid: 5000, status: 'queued', sequence: 1,
      })
    ).rejects.toThrow();
  });

  it('rejects an invalid status', async () => {
    const { tournament, player, poolEntry, session } = await seed();

    await expect(
      AuctionLot.create({
        session: session._id, tournament: tournament._id, poolEntry: poolEntry._id, player: player._id,
        basePrice: 5000, currentBid: 5000, status: 'bogus', sequence: 0,
      })
    ).rejects.toThrow();
  });
});
