import { resolveExpiredLots } from '../src/jobs/auctionSweep.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Organization } from '../src/models/organization.model.js';
import { Team } from '../src/models/team.model.js';
import { Player } from '../src/models/player.model.js';
import { PlayerPoolEntry } from '../src/models/playerPoolEntry.model.js';
import { AuctionSession } from '../src/models/auctionSession.model.js';
import { AuctionLot } from '../src/models/auctionLot.model.js';
import { AuctionTeamOwner } from '../src/models/auctionTeamOwner.model.js';

describe('resolveExpiredLots', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  const seed = async ({ withBidder = true } = {}) => {
    const { user: owner } = await createTestUser({ email: 'owner@example.com' });
    const { user: memberUser } = await createTestUser({ email: 'member@example.com' });
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }, { user: memberUser._id, role: 'member' }],
    });
    const tournament = await Tournament.create({
      name: 'Summer T20', nameLower: 'summer t20', organization: org._id, format: 'league', createdBy: owner._id,
    });
    const team = await Team.create({ name: 'Team A', createdBy: owner._id, organization: org._id });
    const teamOwner = await AuctionTeamOwner.create({
      tournament: tournament._id, team: team._id, owner: memberUser._id, budget: 100000, createdBy: owner._id,
    });
    const player = await Player.create({ name: 'Rohit Sharma', createdBy: owner._id, nameLower: 'rohit sharma' });
    const poolEntry = await PlayerPoolEntry.create({
      tournament: tournament._id, player: player._id, basePrice: 5000, createdBy: owner._id,
    });
    const auctionSession = await AuctionSession.create({
      tournament: tournament._id, status: 'active', createdBy: owner._id, startedAt: new Date(),
    });
    const lot = await AuctionLot.create({
      session: auctionSession._id, tournament: tournament._id, poolEntry: poolEntry._id, player: player._id,
      basePrice: 5000, currentBid: withBidder ? 5500 : 5000,
      currentBidder: withBidder ? teamOwner._id : null,
      status: 'active', endsAt: new Date(Date.now() - 1000), sequence: 0,
    });
    return { lot, teamOwner, auctionSession };
  };

  it("marks a lot with a bidder as sold and increments that owner's spent", async () => {
    const { lot, teamOwner } = await seed({ withBidder: true });

    await resolveExpiredLots(null);

    const resolved = await AuctionLot.findById(lot._id);
    expect(resolved.status).toBe('sold');
    expect(resolved.soldPrice).toBe(5500);
    expect(String(resolved.soldTo)).toBe(String(teamOwner._id));
    const updatedOwner = await AuctionTeamOwner.findById(teamOwner._id);
    expect(updatedOwner.spent).toBe(5500);
  });

  it('marks a lot with no bidder as unsold', async () => {
    const { lot } = await seed({ withBidder: false });

    await resolveExpiredLots(null);

    const resolved = await AuctionLot.findById(lot._id);
    expect(resolved.status).toBe('unsold');
    expect(resolved.soldPrice).toBeNull();
  });

  it('does not touch a lot whose timer has not expired yet', async () => {
    const { lot } = await seed({ withBidder: true });
    await AuctionLot.updateOne({ _id: lot._id }, { $set: { endsAt: new Date(Date.now() + 60000) } });

    await resolveExpiredLots(null);

    const untouched = await AuctionLot.findById(lot._id);
    expect(untouched.status).toBe('active');
  });

  it('resolves a lot exactly once even when run twice concurrently', async () => {
    const { lot, teamOwner } = await seed({ withBidder: true });

    await Promise.all([resolveExpiredLots(null), resolveExpiredLots(null)]);

    const resolved = await AuctionLot.findById(lot._id);
    expect(resolved.status).toBe('sold');
    const updatedOwner = await AuctionTeamOwner.findById(teamOwner._id);
    // Incremented exactly once — an unguarded double resolution would have
    // double-charged this owner's spend.
    expect(updatedOwner.spent).toBe(5500);
  });
});
