import { jest } from '@jest/globals';
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { registerAuctionSocket } from '../src/sockets/auction.socket.js';
import { AuctionLot } from '../src/models/auctionLot.model.js';

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

const setupActiveLot = async ({ budget = 100000, basePrice = 5000 } = {}) => {
  const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
  const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
  const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
  const orgId = orgRes.body.data.id;
  await addMember(ownerToken, orgId, { email: 'member@example.com' });
  const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'league' });
  const tournamentId = tournamentRes.body.data.id;
  const teamARes = await createOrgTeam(ownerToken, orgId, { name: 'Team A' });
  await addTeamToTournament(ownerToken, tournamentId, teamARes.body.data.id);
  await patchSetup(ownerToken, tournamentId, { owners: [{ teamId: teamARes.body.data.id, userId: member._id.toString(), budget }] });
  await registerPool(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice });
  await startAuction(ownerToken, tournamentId);
  const nextRes = await nextLot(ownerToken, tournamentId);
  return { ownerToken, memberToken, member, tournamentId, lotId: nextRes.body.data.lot.lotId };
};

describe('auction:bid', () => {
  it('accepts a bid from a valid owner and moves to the next increment tier', async () => {
    const { memberToken, tournamentId, lotId } = await setupActiveLot();

    const io = { on: jest.fn() };
    registerAuctionSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');
    const socket = buildFakeSocket();
    onConnection(socket);

    await socket.trigger('auction:bid', { tournamentId, lotId, accessToken: memberToken });

    const lot = await AuctionLot.findById(lotId);
    expect(lot.currentBid).toBe(5500);
    expect(lot.currentBidder).not.toBeNull();
    expect(socket.emit.mock.calls.some(([e]) => e === 'auction:bidRejected')).toBe(false);
  });

  it('rejects a bid from a user with no AuctionTeamOwner record', async () => {
    const { tournamentId, lotId } = await setupActiveLot();
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const io = { on: jest.fn() };
    registerAuctionSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');
    const socket = buildFakeSocket();
    onConnection(socket);

    await socket.trigger('auction:bid', { tournamentId, lotId, accessToken: strangerToken });

    const rejection = socket.emit.mock.calls.find(([e]) => e === 'auction:bidRejected');
    expect(rejection[1].code).toBe('NOT_AUCTION_OWNER');
  });

  it("localizes the rejection message using the locale captured on auction:join, not a hardcoded English string", async () => {
    const { ownerToken, tournamentId, lotId } = await setupActiveLot();

    const io = { on: jest.fn() };
    registerAuctionSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');
    const socket = buildFakeSocket();
    onConnection(socket);

    // The tournament owner is a real org member (so auction:join succeeds
    // and captures socket.data.auctionLocale) but never configured as an
    // AuctionTeamOwner — the same NOT_AUCTION_OWNER rejection a stranger
    // would get, without needing a second org-membership call.
    await socket.trigger('auction:join', { tournamentId, accessToken: ownerToken, locale: 'hi' });
    await socket.trigger('auction:bid', { tournamentId, lotId, accessToken: ownerToken });

    const rejection = socket.emit.mock.calls.find(([e]) => e === 'auction:bidRejected');
    expect(rejection[1].code).toBe('NOT_AUCTION_OWNER');
    expect(rejection[1].message).toBe('आप इस नीलामी में टीम मालिक नहीं हैं');
  });

  it("rejects a bid that would exceed the bidder's remaining budget", async () => {
    const { memberToken, tournamentId, lotId } = await setupActiveLot({ budget: 5200, basePrice: 5000 });

    const io = { on: jest.fn() };
    registerAuctionSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');
    const socket = buildFakeSocket();
    onConnection(socket);

    await socket.trigger('auction:bid', { tournamentId, lotId, accessToken: memberToken });

    const rejection = socket.emit.mock.calls.find(([e]) => e === 'auction:bidRejected');
    expect(rejection[1].code).toBe('INSUFFICIENT_BUDGET');
    const lot = await AuctionLot.findById(lotId);
    expect(lot.currentBid).toBe(5000);
  });

  it('rejects a bid on a lot that is not active', async () => {
    const { memberToken, tournamentId, lotId } = await setupActiveLot();
    await AuctionLot.updateOne({ _id: lotId }, { $set: { status: 'sold' } });

    const io = { on: jest.fn() };
    registerAuctionSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');
    const socket = buildFakeSocket();
    onConnection(socket);

    await socket.trigger('auction:bid', { tournamentId, lotId, accessToken: memberToken });

    const rejection = socket.emit.mock.calls.find(([e]) => e === 'auction:bidRejected');
    expect(rejection[1].code).toBe('LOT_NOT_ACTIVE');
  });

  it('rejects a bid after the timer has already expired', async () => {
    const { memberToken, tournamentId, lotId } = await setupActiveLot();
    await AuctionLot.updateOne({ _id: lotId }, { $set: { endsAt: new Date(Date.now() - 1000) } });

    const io = { on: jest.fn() };
    registerAuctionSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');
    const socket = buildFakeSocket();
    onConnection(socket);

    await socket.trigger('auction:bid', { tournamentId, lotId, accessToken: memberToken });

    const rejection = socket.emit.mock.calls.find(([e]) => e === 'auction:bidRejected');
    expect(rejection[1].code).toBe('LOT_NOT_ACTIVE');
  });
});
