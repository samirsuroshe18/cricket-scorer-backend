import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { AuctionBidEvent } from '../src/models/auctionBidEvent.model.js';
import { AuctionSession } from '../src/models/auctionSession.model.js';
import { AuctionLot } from '../src/models/auctionLot.model.js';
import { AuctionTeamOwner } from '../src/models/auctionTeamOwner.model.js';
import { PlayerPoolEntry } from '../src/models/playerPoolEntry.model.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Organization } from '../src/models/organization.model.js';
import { Team } from '../src/models/team.model.js';
import { Player } from '../src/models/player.model.js';
import { User } from '../src/models/user.model.js';

describe('AuctionBidEvent', () => {
  beforeAll(async () => {
    await connectTestDb();
    await AuctionBidEvent.init();
  });

  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('creates with the given fields, required amount enforced', async () => {
    const owner = await User.create({ email: 'owner@example.com', password: 'password123', fullName: 'Owner' });
    const member = await User.create({ email: 'member@example.com', password: 'password123', fullName: 'Member' });
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }, { user: member._id, role: 'member' }],
    });
    const tournament = await Tournament.create({
      name: 'Summer T20', nameLower: 'summer t20', organization: org._id, format: 'league', createdBy: owner._id,
    });
    const team = await Team.create({ name: 'Team A', createdBy: owner._id, organization: org._id });
    const teamOwner = await AuctionTeamOwner.create({
      tournament: tournament._id, team: team._id, owner: member._id, budget: 100000, createdBy: owner._id,
    });
    const player = await Player.create({ name: 'Rohit Sharma', createdBy: owner._id, nameLower: 'rohit sharma' });
    const poolEntry = await PlayerPoolEntry.create({
      tournament: tournament._id, player: player._id, basePrice: 5000, createdBy: owner._id,
    });
    const session = await AuctionSession.create({ tournament: tournament._id, createdBy: owner._id, startedAt: new Date() });
    const lot = await AuctionLot.create({
      session: session._id, tournament: tournament._id, poolEntry: poolEntry._id, player: player._id,
      basePrice: 5000, currentBid: 5500, status: 'active', sequence: 0,
    });

    const event = await AuctionBidEvent.create({ lot: lot._id, session: session._id, bidder: teamOwner._id, amount: 5500 });

    expect(event.amount).toBe(5500);
    expect(event.createdAt).toBeInstanceOf(Date);

    await expect(
      AuctionBidEvent.create({ lot: lot._id, session: session._id, bidder: teamOwner._id })
    ).rejects.toThrow();
  });
});
