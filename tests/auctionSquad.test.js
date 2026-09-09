import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { AuctionSession } from '../src/models/auctionSession.model.js';
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
const getSquad = (token, tournamentId) => request(app).get(`/api/v1/tournament/${tournamentId}/auction/squad`).set('Authorization', `Bearer ${token}`);

// Two team-owners (memberA/memberB), three pool players, and a helper that
// resolves the queue's lots directly (mirroring auctionNext.test.js's own
// pattern) rather than driving the real bid/sweep path — squad view only
// reads already-resolved AuctionLot/AuctionTeamOwner fields, so it doesn't
// need a real bid to exercise those reads.
const setupResolvedAuction = async () => {
  const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
  const { token: memberATokenRaw, user: memberA } = await createTestUser({ email: 'membera@example.com' });
  const { token: memberBTokenRaw, user: memberB } = await createTestUser({ email: 'memberb@example.com' });
  const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
  const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
  const orgId = orgRes.body.data.id;
  await addMember(ownerToken, orgId, { email: 'membera@example.com' });
  await addMember(ownerToken, orgId, { email: 'memberb@example.com' });
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
  await registerPool(ownerToken, tournamentId, { playerName: 'Virat Kohli', basePrice: 6000 });
  await registerPool(ownerToken, tournamentId, { playerName: 'Jasprit Bumrah', basePrice: 7000 });
  await startAuction(ownerToken, tournamentId);

  const ownerARecord = await AuctionTeamOwner.findOne({ tournament: tournamentId, owner: memberA._id });
  const ownerBRecord = await AuctionTeamOwner.findOne({ tournament: tournamentId, owner: memberB._id });

  const resolveNext = async (outcome) => {
    const res = await nextLot(ownerToken, tournamentId);
    const lot = await AuctionLot.findById(res.body.data.lot.lotId).populate('player', 'name');
    if (outcome) {
      await AuctionLot.updateOne(
        { _id: lot._id },
        { $set: { status: 'sold', soldTo: outcome.ownerRecord._id, soldPrice: outcome.price, resolvedAt: new Date() } }
      );
      await AuctionTeamOwner.updateOne({ _id: outcome.ownerRecord._id }, { $inc: { spent: outcome.price } });
    } else {
      await AuctionLot.updateOne({ _id: lot._id }, { $set: { status: 'unsold', resolvedAt: new Date() } });
    }
    return lot;
  };

  // Rohit -> Team A for 5500, Virat -> Team B for 6200, Bumrah -> unsold.
  const rohitLot = await resolveNext({ ownerRecord: ownerARecord, price: 5500 });
  const viratLot = await resolveNext({ ownerRecord: ownerBRecord, price: 6200 });
  const bumrahLot = await resolveNext(null);

  return {
    ownerToken, memberAToken: memberATokenRaw, memberBToken: memberBTokenRaw, strangerToken,
    tournamentId, teamARes, teamBRes, memberA, memberB, rohitLot, viratLot, bumrahLot,
  };
};

describe('GET /:tournamentId/auction/squad', () => {
  it('groups sold players under their winning team, with remaining budget', async () => {
    const { ownerToken, tournamentId, teamARes, teamBRes } = await setupResolvedAuction();

    const res = await getSquad(ownerToken, tournamentId);

    expect(res.status).toBe(200);
    const teamA = res.body.data.teams.find((t) => t.teamId === teamARes.body.data.id);
    const teamB = res.body.data.teams.find((t) => t.teamId === teamBRes.body.data.id);
    expect(teamA.players).toEqual([{ playerId: expect.any(String), playerName: 'Rohit Sharma', role: 'unknown', soldPrice: 5500 }]);
    expect(teamA.budget).toBe(100000);
    expect(teamA.spent).toBe(5500);
    expect(teamA.remaining).toBe(94500);
    expect(teamB.players.map((p) => p.playerName)).toEqual(['Virat Kohli']);
    expect(teamB.remaining).toBe(93800);
  });

  it('lists unsold players separately from any team', async () => {
    const { ownerToken, tournamentId } = await setupResolvedAuction();

    const res = await getSquad(ownerToken, tournamentId);

    expect(res.body.data.unsold.map((p) => p.playerName)).toEqual(['Jasprit Bumrah']);
  });

  it('shows a team with an empty roster before any of its lots resolve', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'solo-owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Empty CC' });
    const orgId = orgRes.body.data.id;
    const { user: member } = await createTestUser({ email: 'solo-member@example.com' });
    await addMember(ownerToken, orgId, { email: 'solo-member@example.com' });
    const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Preseason Cup', format: 'league' });
    const tournamentId = tournamentRes.body.data.id;
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Solo XI' });
    await addTeamToTournament(ownerToken, tournamentId, teamRes.body.data.id);
    await patchSetup(ownerToken, tournamentId, { owners: [{ teamId: teamRes.body.data.id, userId: member._id.toString(), budget: 50000 }] });
    await registerPool(ownerToken, tournamentId, { playerName: 'Someone', basePrice: 1000 });
    await startAuction(ownerToken, tournamentId);

    const res = await getSquad(ownerToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.teams).toEqual([{
      teamId: teamRes.body.data.id, teamName: 'Solo XI',
      ownerId: member._id.toString(), ownerName: member.fullName,
      budget: 50000, spent: 0, remaining: 50000, players: [],
    }]);
    expect(res.body.data.unsold).toEqual([]);
  });

  it('is readable by any org member, not just the owner', async () => {
    const { memberAToken, tournamentId } = await setupResolvedAuction();

    const res = await getSquad(memberAToken, tournamentId);

    expect(res.status).toBe(200);
  });

  it('rejects a non-member of the owning organization', async () => {
    const { strangerToken, tournamentId } = await setupResolvedAuction();

    const res = await getSquad(strangerToken, tournamentId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('404s when no auction has ever been started for the tournament', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'never-started@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'No Auction CC' });
    const tournamentRes = await createTournament(ownerToken, orgRes.body.data.id, { name: 'Idle Cup', format: 'league' });

    const res = await getSquad(ownerToken, tournamentRes.body.data.id);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AUCTION_NOT_FOUND');
  });
});
