import { jest } from '@jest/globals';
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { AuctionSession } from '../src/models/auctionSession.model.js';
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

const setupReadyTournament = async () => {
  const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
  const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
  const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
  const orgId = orgRes.body.data.id;
  await addMember(ownerToken, orgId, { email: 'member@example.com' });
  const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'league' });
  const tournamentId = tournamentRes.body.data.id;
  const teamARes = await createOrgTeam(ownerToken, orgId, { name: 'Team A' });
  await addTeamToTournament(ownerToken, tournamentId, teamARes.body.data.id);
  await patchSetup(ownerToken, tournamentId, { owners: [{ teamId: teamARes.body.data.id, userId: member._id.toString(), budget: 100000 }] });
  await registerPool(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });
  await registerPool(ownerToken, tournamentId, { playerName: 'Virat Kohli', basePrice: 8000 });
  return { ownerToken, memberToken, tournamentId };
};

describe('POST /:tournamentId/auction/start', () => {
  it('creates an active session and snapshots the pool into queued lots, in pool order', async () => {
    const { ownerToken, tournamentId } = await setupReadyTournament();

    const res = await startAuction(ownerToken, tournamentId);

    expect(res.status).toBe(201);
    expect(res.body.data.lotCount).toBe(2);
    const auctionSession = await AuctionSession.findOne({ tournament: tournamentId });
    expect(auctionSession.status).toBe('active');
    const lots = await AuctionLot.find({ session: auctionSession._id }).sort({ sequence: 1 });
    expect(lots).toHaveLength(2);
    expect(lots[0].sequence).toBe(0);
    expect(lots[0].currentBid).toBe(lots[0].basePrice);
    expect(lots[0].status).toBe('queued');
  });

  it('rejects a non-owner', async () => {
    const { memberToken, tournamentId } = await setupReadyTournament();
    const res = await startAuction(memberToken, tournamentId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it('rejects starting a second time', async () => {
    const { ownerToken, tournamentId } = await setupReadyTournament();
    await startAuction(ownerToken, tournamentId);

    const res = await startAuction(ownerToken, tournamentId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AUCTION_ALREADY_STARTED');
  });

  it('rejects starting with no configured owners', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner2@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Lone CC' });
    const tournamentRes = await createTournament(ownerToken, orgRes.body.data.id, { name: 'Lonely Cup', format: 'league' });
    const tournamentId = tournamentRes.body.data.id;

    const res = await startAuction(ownerToken, tournamentId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUCTION_SETUP_INCOMPLETE');
  });

  it('locks auction-setup edits once the auction has started', async () => {
    const { ownerToken, tournamentId } = await setupReadyTournament();
    await startAuction(ownerToken, tournamentId);

    const res = await patchSetup(ownerToken, tournamentId, { minSquadSize: 15 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AUCTION_SETUP_LOCKED');
  });

  // A socket that joined the auction room before the organizer clicked
  // "Start Auction" has no other way to learn the session began: the room
  // stays silent until the organizer separately calls next-lot, and even
  // then only `auction:lotOnBlock` fires — never anything that tells an
  // already-joined client the session itself is no longer null/not-started.
  it('broadcasts to already-joined sockets that the session has started', async () => {
    const { ownerToken, tournamentId } = await setupReadyTournament();
    const emit = jest.fn();
    const io = { to: jest.fn(() => ({ emit })) };
    app.app.set('io', io);

    await startAuction(ownerToken, tournamentId);

    expect(io.to).toHaveBeenCalledWith(`auction:${tournamentId}`);
    expect(emit.mock.calls[0][0]).toBe('auction:sessionStarted');
    expect(emit.mock.calls[0][1].tournamentId.toString()).toBe(tournamentId);
    expect(emit.mock.calls[0][1].lotCount).toBe(2);
  });
});
