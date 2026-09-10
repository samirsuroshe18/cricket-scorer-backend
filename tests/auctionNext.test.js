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
const nextLot = (token, tournamentId) => request(app).post(`/api/v1/tournament/${tournamentId}/auction/next`).set('Authorization', `Bearer ${token}`).send();

const setupStartedAuction = async ({ withPlayers = 1 } = {}) => {
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
  for (let i = 0; i < withPlayers; i += 1) {
    await registerPool(ownerToken, tournamentId, { playerName: `Player ${i}`, basePrice: 5000 });
  }
  await startAuction(ownerToken, tournamentId);
  return { ownerToken, memberToken, tournamentId };
};

describe('POST /:tournamentId/auction/next', () => {
  it('activates the lowest-sequence queued lot', async () => {
    const { ownerToken, tournamentId } = await setupStartedAuction({ withPlayers: 2 });

    const res = await nextLot(ownerToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.completed).toBe(false);
    expect(res.body.data.lot.basePrice).toBe(5000);
    expect(res.body.data.lot.playerName).toBe('Player 0');
    const auctionSession = await AuctionSession.findOne({ tournament: tournamentId });
    const active = await AuctionLot.findOne({ session: auctionSession._id, status: 'active' });
    expect(active).not.toBeNull();
    expect(active.endsAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects advancing while a lot is already active', async () => {
    const { ownerToken, tournamentId } = await setupStartedAuction({ withPlayers: 2 });
    await nextLot(ownerToken, tournamentId);

    const res = await nextLot(ownerToken, tournamentId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOT_ALREADY_ACTIVE');
  });

  it('marks the session completed once the queue is exhausted', async () => {
    const { ownerToken, tournamentId } = await setupStartedAuction({ withPlayers: 1 });
    const first = await nextLot(ownerToken, tournamentId);
    await AuctionLot.updateOne({ _id: first.body.data.lot.lotId }, { $set: { status: 'sold' } });

    const res = await nextLot(ownerToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.completed).toBe(true);
    const auctionSession = await AuctionSession.findOne({ tournament: tournamentId });
    expect(auctionSession.status).toBe('completed');
  });

  it('rejects a non-owner', async () => {
    const { memberToken, tournamentId } = await setupStartedAuction();
    const res = await nextLot(memberToken, tournamentId);
    expect(res.status).toBe(403);
  });
});
