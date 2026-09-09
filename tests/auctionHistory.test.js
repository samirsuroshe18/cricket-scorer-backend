import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { AuctionLot } from '../src/models/auctionLot.model.js';
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
const getHistory = (token, tournamentId) => request(app).get(`/api/v1/tournament/${tournamentId}/auction/history`).set('Authorization', `Bearer ${token}`);

const setupResolvedAuction = async () => {
  const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
  const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
  const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
  const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
  const orgId = orgRes.body.data.id;
  await addMember(ownerToken, orgId, { email: 'member@example.com' });
  const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'league' });
  const tournamentId = tournamentRes.body.data.id;
  const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Team A' });
  await addTeamToTournament(ownerToken, tournamentId, teamRes.body.data.id);
  await patchSetup(ownerToken, tournamentId, { owners: [{ teamId: teamRes.body.data.id, userId: member._id.toString(), budget: 100000 }] });
  await registerPool(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });
  await registerPool(ownerToken, tournamentId, { playerName: 'Virat Kohli', basePrice: 6000 });
  await startAuction(ownerToken, tournamentId);

  const ownerRecord = await AuctionTeamOwner.findOne({ tournament: tournamentId });

  const resolveNext = async ({ sold, price, at }) => {
    const res = await nextLot(ownerToken, tournamentId);
    const lotId = res.body.data.lot.lotId;
    const update = sold
      ? { status: 'sold', soldTo: ownerRecord._id, soldPrice: price, resolvedAt: at }
      : { status: 'unsold', resolvedAt: at };
    await AuctionLot.updateOne({ _id: lotId }, { $set: update });
    return lotId;
  };

  // Resolve Virat before Rohit (out of registration order) to prove history
  // orders by resolution time, not pool/lot sequence.
  const later = new Date(Date.now() + 60000);
  const earlier = new Date(Date.now() + 1000);
  await resolveNext({ sold: true, price: 6500, at: later }); // Rohit (sequence 0) resolves second
  await resolveNext({ sold: false, at: earlier }); // Virat (sequence 1) resolves first, unsold

  return { ownerToken, memberToken, strangerToken, tournamentId, teamRes };
};

describe('GET /:tournamentId/auction/history', () => {
  it('orders entries by resolution time, earliest first', async () => {
    const { ownerToken, tournamentId } = await setupResolvedAuction();

    const res = await getHistory(ownerToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.entries.map((e) => e.playerName)).toEqual(['Virat Kohli', 'Rohit Sharma']);
  });

  it('reports team and price for a sold entry, and neither for unsold', async () => {
    const { ownerToken, tournamentId, teamRes } = await setupResolvedAuction();

    const res = await getHistory(ownerToken, tournamentId);

    const sold = res.body.data.entries.find((e) => e.playerName === 'Rohit Sharma');
    const unsold = res.body.data.entries.find((e) => e.playerName === 'Virat Kohli');
    expect(sold).toMatchObject({ outcome: 'sold', soldPrice: 6500, teamId: teamRes.body.data.id, teamName: 'Team A' });
    expect(unsold).toMatchObject({ outcome: 'unsold', soldPrice: null, teamId: null, teamName: null });
  });

  it('omits lots that have not resolved yet (still queued or active)', async () => {
    const { ownerToken, tournamentId } = await setupResolvedAuction();

    const res = await getHistory(ownerToken, tournamentId);

    expect(res.body.data.entries).toHaveLength(2);
  });

  it('is readable by any org member, not just the owner', async () => {
    const { memberToken, tournamentId } = await setupResolvedAuction();

    const res = await getHistory(memberToken, tournamentId);

    expect(res.status).toBe(200);
  });

  it('rejects a non-member of the owning organization', async () => {
    const { strangerToken, tournamentId } = await setupResolvedAuction();

    const res = await getHistory(strangerToken, tournamentId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('404s when no auction has ever been started for the tournament', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'never-started@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'No Auction CC' });
    const tournamentRes = await createTournament(ownerToken, orgRes.body.data.id, { name: 'Idle Cup', format: 'league' });

    const res = await getHistory(ownerToken, tournamentRes.body.data.id);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AUCTION_NOT_FOUND');
  });
});
