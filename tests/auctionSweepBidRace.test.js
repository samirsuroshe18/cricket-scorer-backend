import { jest } from '@jest/globals';
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { registerAuctionSocket } from '../src/sockets/auction.socket.js';
import { resolveExpiredLots } from '../src/jobs/auctionSweep.js';
import { AuctionLot } from '../src/models/auctionLot.model.js';
import { AuctionBidEvent } from '../src/models/auctionBidEvent.model.js';
import { AuctionTeamOwner } from '../src/models/auctionTeamOwner.model.js';

let app;

beforeAll(async () => {
  await connectTestDb();
  app = buildTestApp({ withOrganization: true, withTournament: true });
});

afterEach(async () => { await clearTestDb(); });
afterAll(async () => { await disconnectTestDb(); });

const createOrg = (token, body) => request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);
const addMember = (token, orgId, body) => request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${token}`).send(body);
const createTournament = (token, orgId, body) => request(app).post(`/api/v1/organization/${orgId}/tournaments`).set('Authorization', `Bearer ${token}`).send(body);
const createOrgTeam = (token, orgId, body) => request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);
const addTeamToTournament = (token, tournamentId, teamId) => request(app).post(`/api/v1/tournament/${tournamentId}/teams`).set('Authorization', `Bearer ${token}`).send({ teamId });
const patchSetup = (token, tournamentId, body) => request(app).patch(`/api/v1/tournament/${tournamentId}/auction-setup`).set('Authorization', `Bearer ${token}`).send(body);
const registerPool = (token, tournamentId, body) => request(app).post(`/api/v1/tournament/${tournamentId}/pool`).set('Authorization', `Bearer ${token}`).send(body);
const startAuction = (token, tournamentId) => request(app).post(`/api/v1/tournament/${tournamentId}/auction/start`).set('Authorization', `Bearer ${token}`).send();
const nextLot = (token, tournamentId) => request(app).post(`/api/v1/tournament/${tournamentId}/auction/next`).set('Authorization', `Bearer ${token}`).send();

const buildFakeSocket = () => {
  const handlers = {};
  return {
    data: {}, join: jest.fn(), emit: jest.fn(),
    on: (event, handler) => { handlers[event] = handler; },
    trigger: (event, payload) => handlers[event](payload),
  };
};

// This is the exact race that let a bid landing between the sweep's initial
// read and its transactional write get silently overwritten by stale data —
// found in code review. Rather than asserting a specific interleaving
// (which real concurrent I/O can't guarantee), this asserts the one
// invariant that must hold regardless of which side wins the race: the
// lot's final recorded outcome must never disagree with the AuctionBidEvent
// history — soldTo/soldPrice must match whichever bid actually landed, and
// a team's `spent` must be incremented exactly once, by exactly the amount
// the lot claims it sold for.
describe('resolveExpiredLots racing a concurrent auction:bid', () => {
  it('never resolves to a stale bidder/price that disagrees with the recorded bid history', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: memberAToken, user: memberA } = await createTestUser({ email: 'member-a@example.com' });
    const { token: memberBToken, user: memberB } = await createTestUser({ email: 'member-b@example.com' });

    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'member-a@example.com' });
    await addMember(ownerToken, orgId, { email: 'member-b@example.com' });

    const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'league' });
    const tournamentId = tournamentRes.body.data.id;

    const teamARes = await createOrgTeam(ownerToken, orgId, { name: 'Team A' });
    const teamBRes = await createOrgTeam(ownerToken, orgId, { name: 'Team B' });
    await addTeamToTournament(ownerToken, tournamentId, teamARes.body.data.id);
    await addTeamToTournament(ownerToken, tournamentId, teamBRes.body.data.id);

    await patchSetup(ownerToken, tournamentId, {
      owners: [
        { teamId: teamARes.body.data.id, userId: memberA._id.toString(), budget: 100000 },
        { teamId: teamBRes.body.data.id, userId: memberB._id.toString(), budget: 100000 },
      ],
    });
    await registerPool(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });
    await startAuction(ownerToken, tournamentId);
    const nextRes = await nextLot(ownerToken, tournamentId);
    const lotId = nextRes.body.data.lot.lotId;

    const io = { on: jest.fn() };
    registerAuctionSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');
    const socketA = buildFakeSocket();
    onConnection(socketA);

    // Owner A bids first, for real — currentBid becomes 5500.
    await socketA.trigger('auction:bid', { tournamentId, lotId, accessToken: memberAToken });

    // The lot is now "expired" from the sweep's point of view. Race Owner
    // B's bid against the sweep — under the pre-fix code, the sweep reads
    // the lot BEFORE this bid lands, then writes its stale snapshot back
    // regardless of what actually happened in between.
    await AuctionLot.updateOne({ _id: lotId }, { $set: { endsAt: new Date(Date.now() - 1000) } });

    const socketB = buildFakeSocket();
    onConnection(socketB);

    await Promise.all([
      socketB.trigger('auction:bid', { tournamentId, lotId, accessToken: memberBToken }),
      resolveExpiredLots(null),
    ]);

    const lot = await AuctionLot.findById(lotId);
    const events = await AuctionBidEvent.find({ lot: lotId }).sort({ createdAt: 1 });
    const ownerBWon = events.some((e) => e.amount === 6000);

    if (ownerBWon) {
      // Owner B's bid landed before the lot was locked away from 'active'.
      // Whatever the sweep did with it, it must agree that Owner B is the
      // one holding it — either still active (B's bid extended endsAt past
      // the sweep's read) or already sold to B, never to the stale A.
      if (lot.status === 'sold') {
        expect(lot.soldPrice).toBe(6000);
        const ownerB = await AuctionTeamOwner.findOne({ tournament: tournamentId, owner: memberB._id });
        expect(String(lot.soldTo)).toBe(String(ownerB._id));
      } else {
        expect(lot.status).toBe('active');
        expect(lot.currentBid).toBe(6000);
      }
    } else {
      // Owner B's bid was rejected (the sweep locked the lot first) — the
      // original Owner A bid must be exactly what was sold.
      expect(lot.status).toBe('sold');
      expect(lot.soldPrice).toBe(5500);
      const ownerA = await AuctionTeamOwner.findOne({ tournament: tournamentId, owner: memberA._id });
      expect(String(lot.soldTo)).toBe(String(ownerA._id));
    }

    // Whichever owner actually won, they must be charged exactly once, by
    // exactly the amount the lot claims it sold for — never a stale amount,
    // never a double charge.
    if (lot.status === 'sold') {
      const winner = await AuctionTeamOwner.findById(lot.soldTo);
      expect(winner.spent).toBe(lot.soldPrice);
    }
  });
});
