import { jest } from '@jest/globals';
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { registerAuctionSocket } from '../src/sockets/auction.socket.js';
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

describe('auction:bid under a concurrent race', () => {
  it('lets exactly one of two simultaneous bids win, with no double bid-event and no budget mutation at bid time', async () => {
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
    const socketB = buildFakeSocket();
    onConnection(socketA);
    onConnection(socketB);

    await Promise.all([
      socketA.trigger('auction:bid', { tournamentId, lotId, accessToken: memberAToken }),
      socketB.trigger('auction:bid', { tournamentId, lotId, accessToken: memberBToken }),
    ]);

    // Exactly one bid landed — basePrice 5000 + the first-tier +500
    // increment, never applied twice.
    const lot = await AuctionLot.findById(lotId);
    expect(lot.currentBid).toBe(5500);

    const winnerOwnerId = String(lot.currentBidder);
    const ownerA = await AuctionTeamOwner.findOne({ tournament: tournamentId, owner: memberA._id });
    const ownerB = await AuctionTeamOwner.findOne({ tournament: tournamentId, owner: memberB._id });
    expect([String(ownerA._id), String(ownerB._id)]).toContain(winnerOwnerId);

    // Exactly one bid event was recorded — the loser's compare-and-swap
    // matched nothing, so it never got as far as logging a bid.
    const events = await AuctionBidEvent.find({ lot: lotId });
    expect(events).toHaveLength(1);

    // Exactly one of the two sockets received a rejection.
    const rejections = [socketA, socketB].filter((s) =>
      s.emit.mock.calls.some(([event]) => event === 'auction:bidRejected')
    );
    expect(rejections).toHaveLength(1);

    // Neither owner's budget document is touched by a bid — only lot
    // resolution (the sweep, Task 8) ever increments `spent`. This is what
    // rules out a double-charge at bid time regardless of which side won.
    expect(ownerA.spent).toBe(0);
    expect(ownerB.spent).toBe(0);
  });
});
