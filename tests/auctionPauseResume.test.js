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
const pauseAuction = (token, tournamentId) => request(app).post(`/api/v1/tournament/${tournamentId}/auction/pause`).set('Authorization', `Bearer ${token}`).send();
const resumeAuction = (token, tournamentId) => request(app).post(`/api/v1/tournament/${tournamentId}/auction/resume`).set('Authorization', `Bearer ${token}`).send();

const setupStartedAuction = async () => {
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
  await startAuction(ownerToken, tournamentId);
  return { ownerToken, memberToken, tournamentId };
};

describe('POST /:tournamentId/auction/pause and /resume', () => {
  it('pauses an active lot, freezing its remaining time', async () => {
    const { ownerToken, tournamentId } = await setupStartedAuction();
    await nextLot(ownerToken, tournamentId);

    const res = await pauseAuction(ownerToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('paused');
    const auctionSession = await AuctionSession.findOne({ tournament: tournamentId });
    const lot = await AuctionLot.findOne({ session: auctionSession._id, status: 'active' });
    expect(lot.endsAt).toBeNull();
    expect(lot.pausedRemainingMs).toBeGreaterThan(0);
  });

  it('pausing before any lot is on the block still succeeds, at the session level', async () => {
    const { ownerToken, tournamentId } = await setupStartedAuction();
    const res = await pauseAuction(ownerToken, tournamentId);
    expect(res.status).toBe(200);
    const auctionSession = await AuctionSession.findOne({ tournament: tournamentId });
    expect(auctionSession.status).toBe('paused');
  });

  it('resumes, recomputing endsAt from the paused remaining time', async () => {
    const { ownerToken, tournamentId } = await setupStartedAuction();
    await nextLot(ownerToken, tournamentId);
    await pauseAuction(ownerToken, tournamentId);

    const res = await resumeAuction(ownerToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
    const auctionSession = await AuctionSession.findOne({ tournament: tournamentId });
    const lot = await AuctionLot.findOne({ session: auctionSession._id, status: 'active' });
    expect(lot.endsAt).not.toBeNull();
    expect(lot.pausedRemainingMs).toBeNull();
  });

  it('rejects resuming when not paused', async () => {
    const { ownerToken, tournamentId } = await setupStartedAuction();
    const res = await resumeAuction(ownerToken, tournamentId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUCTION_NOT_PAUSED');
  });
});
