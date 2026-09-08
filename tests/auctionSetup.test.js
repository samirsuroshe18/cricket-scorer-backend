import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';
import { AuctionSettings } from '../src/models/auctionSettings.model.js';
import { AuctionTeamOwner } from '../src/models/auctionTeamOwner.model.js';

let app;

beforeAll(async () => {
  await connectTestDb();
  await Tournament.init();
  await AuctionSettings.init();
  await AuctionTeamOwner.init();
  app = buildTestApp({ withOrganization: true, withTournament: true });
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const createOrg = (token, body) =>
  request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

const addMember = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${token}`).send(body);

const createTournament = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/tournaments`).set('Authorization', `Bearer ${token}`).send(body);

const createOrgTeam = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

const addTeamToTournament = (token, tournamentId, teamId) =>
  request(app).post(`/api/v1/tournament/${tournamentId}/teams`).set('Authorization', `Bearer ${token}`).send({ teamId });

const patchSetup = (token, tournamentId, body) =>
  request(app).patch(`/api/v1/tournament/${tournamentId}/auction-setup`).set('Authorization', `Bearer ${token}`).send(body);

// org owner + a plain member + a tournament with two enrolled teams —
// every test in this file builds on this same shape.
const setupOwnedTournament = async () => {
  const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
  const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
  const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
  const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
  const orgId = orgRes.body.data.id;
  await addMember(ownerToken, orgId, { email: 'member@example.com' });
  const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'league' });
  const tournamentId = tournamentRes.body.data.id;
  const teamARes = await createOrgTeam(ownerToken, orgId, { name: 'Team A' });
  const teamBRes = await createOrgTeam(ownerToken, orgId, { name: 'Team B' });
  await addTeamToTournament(ownerToken, tournamentId, teamARes.body.data.id);
  await addTeamToTournament(ownerToken, tournamentId, teamBRes.body.data.id);
  return {
    ownerToken, owner, memberToken, member, strangerToken, orgId, tournamentId,
    teamAId: teamARes.body.data.id, teamBId: teamBRes.body.data.id,
  };
};

describe('PATCH /:tournamentId/auction-setup — squad rules', () => {
  it('lets the org owner set minSquadSize and maxSquadSize', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { minSquadSize: 15, maxSquadSize: 20 });

    expect(res.status).toBe(200);
    expect(res.body.data.minSquadSize).toBe(15);
    expect(res.body.data.maxSquadSize).toBe(20);
    const settings = await AuctionSettings.findOne({ tournament: tournamentId });
    expect(settings.minSquadSize).toBe(15);
  });

  it('sets categoryCaps independently of squad size', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { categoryCaps: { wicketkeeper: 3 } });

    expect(res.status).toBe(200);
    expect(res.body.data.categoryCaps).toEqual({ wicketkeeper: 3 });
    expect(res.body.data.minSquadSize).toBeNull();
  });

  it('rejects minSquadSize greater than maxSquadSize in the same request', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { minSquadSize: 20, maxSquadSize: 15 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SQUAD_SIZE');
  });

  it('rejects lowering maxSquadSize below an already-stored minSquadSize', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, { minSquadSize: 20 });

    const res = await patchSetup(ownerToken, tournamentId, { maxSquadSize: 15 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SQUAD_SIZE');
  });

  it.each([0, -5, 1.5, 101])('rejects an out-of-range minSquadSize of %p', async (minSquadSize) => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { minSquadSize });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SQUAD_SIZE');
  });

  it('rejects a categoryCaps key outside the four capped roles', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { categoryCaps: { unknown: 2 } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CATEGORY_CAP');
  });

  it('rejects a categoryCaps value that is not a positive whole number', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { categoryCaps: { bowler: 0 } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CATEGORY_CAP');
  });

  it('rejects a plain org member (not owner)', async () => {
    const { memberToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(memberToken, tournamentId, { minSquadSize: 15 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it('rejects a stranger with no relationship to the organization', async () => {
    const { strangerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(strangerToken, tournamentId, { minSquadSize: 15 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('rejects with TOURNAMENT_NOT_FOUND for an unknown tournamentId', async () => {
    const { token } = await createTestUser();

    const res = await patchSetup(token, '000000000000000000000000', { minSquadSize: 15 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });
});

describe('PATCH /:tournamentId/auction-setup — owners', () => {
  it('assigns owners and budgets to enrolled teams', async () => {
    const { ownerToken, member, tournamentId, teamAId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.owners).toHaveLength(1);
    expect(res.body.data.owners[0]).toMatchObject({
      teamId: teamAId, userId: String(member._id), budget: 100000,
    });
    const stored = await AuctionTeamOwner.findOne({ tournament: tournamentId });
    expect(stored.budget).toBe(100000);
  });

  it('setting owners does not touch previously-set squad rules', async () => {
    const { ownerToken, member, tournamentId, teamAId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, { minSquadSize: 15 });

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    expect(res.body.data.minSquadSize).toBe(15);
  });

  it('setting squad rules does not touch previously-set owners', async () => {
    const { ownerToken, member, tournamentId, teamAId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    const res = await patchSetup(ownerToken, tournamentId, { minSquadSize: 15 });

    expect(res.body.data.owners).toHaveLength(1);
  });

  it('an empty owners array clears every existing owner', async () => {
    const { ownerToken, member, tournamentId, teamAId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    const res = await patchSetup(ownerToken, tournamentId, { owners: [] });

    expect(res.status).toBe(200);
    expect(res.body.data.owners).toEqual([]);
    const count = await AuctionTeamOwner.countDocuments({ tournament: tournamentId });
    expect(count).toBe(0);
  });

  it('resubmitting the owners array replaces the previous set entirely', async () => {
    const { ownerToken, member, owner, tournamentId, teamAId, teamBId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamBId, userId: String(owner._id), budget: 50000 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.owners).toHaveLength(1);
    expect(res.body.data.owners[0].teamId).toBe(teamBId);
    const count = await AuctionTeamOwner.countDocuments({ tournament: tournamentId });
    expect(count).toBe(1);
  });

  it('rejects a teamId not enrolled in this tournament', async () => {
    const { ownerToken, member, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: '000000000000000000000000', userId: String(member._id), budget: 100000 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUCTION_SETUP_TEAM_NOT_IN_TOURNAMENT');
  });

  it('rejects the same team appearing twice in one request', async () => {
    const { ownerToken, member, owner, tournamentId, teamAId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [
        { teamId: teamAId, userId: String(member._id), budget: 100000 },
        { teamId: teamAId, userId: String(owner._id), budget: 50000 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUCTION_SETUP_DUPLICATE_TEAM');
  });

  it('rejects the same owner appearing twice in one request', async () => {
    const { ownerToken, member, tournamentId, teamAId, teamBId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [
        { teamId: teamAId, userId: String(member._id), budget: 100000 },
        { teamId: teamBId, userId: String(member._id), budget: 50000 },
      ],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUCTION_SETUP_DUPLICATE_OWNER');
  });

  it('rejects a userId who is not a member of the organization', async () => {
    const { ownerToken, tournamentId, teamAId } = await setupOwnedTournament();
    const { user: outsider } = await createTestUser({ email: 'outsider@example.com' });

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(outsider._id), budget: 100000 }],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUCTION_SETUP_INVALID_OWNER');
  });

  it('rejects a missing budget', async () => {
    const { ownerToken, member, tournamentId, teamAId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id) }],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BUDGET_REQUIRED');
  });

  it.each([0, -100, 1.5, 100000001])('rejects an invalid budget of %p', async (budget) => {
    const { ownerToken, member, tournamentId, teamAId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [{ teamId: teamAId, userId: String(member._id), budget }],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BUDGET');
  });

  it('rejects owners that is present but not an array', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await patchSetup(ownerToken, tournamentId, { owners: 'not-an-array' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_OWNERS_LIST');
  });

  it('rolls back the whole request when one owners entry is invalid — no partial application', async () => {
    const { ownerToken, member, tournamentId, teamAId, teamBId } = await setupOwnedTournament();
    const { user: outsider } = await createTestUser({ email: 'outsider2@example.com' });

    const res = await patchSetup(ownerToken, tournamentId, {
      owners: [
        { teamId: teamAId, userId: String(member._id), budget: 100000 },
        { teamId: teamBId, userId: String(outsider._id), budget: 50000 },
      ],
    });

    expect(res.status).toBe(400);
    const count = await AuctionTeamOwner.countDocuments({ tournament: tournamentId });
    expect(count).toBe(0);
  });
});

const getSetup = (token, tournamentId) =>
  request(app).get(`/api/v1/tournament/${tournamentId}/auction-setup`).set('Authorization', `Bearer ${token}`);

describe('GET /:tournamentId/auction-setup', () => {
  it('returns null squad-rule fields and an empty owners array before anything is set', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await getSetup(ownerToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.minSquadSize).toBeNull();
    expect(res.body.data.maxSquadSize).toBeNull();
    expect(res.body.data.categoryCaps).toBeNull();
    expect(res.body.data.owners).toEqual([]);
  });

  it('any org member can read the current setup, with names resolved', async () => {
    const { ownerToken, memberToken, member, tournamentId, teamAId } = await setupOwnedTournament();
    await patchSetup(ownerToken, tournamentId, {
      minSquadSize: 15,
      owners: [{ teamId: teamAId, userId: String(member._id), budget: 100000 }],
    });

    const res = await getSetup(memberToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.minSquadSize).toBe(15);
    expect(res.body.data.owners[0]).toMatchObject({ teamId: teamAId, budget: 100000 });
    expect(res.body.data.owners[0].userName).toBeTruthy();
    expect(res.body.data.owners[0].teamName).toBe('Team A');
  });

  it('rejects a non-member of the organization', async () => {
    const { strangerToken, tournamentId } = await setupOwnedTournament();

    const res = await getSetup(strangerToken, tournamentId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('rejects with TOURNAMENT_NOT_FOUND for an unknown tournamentId', async () => {
    const { token } = await createTestUser();

    const res = await getSetup(token, '000000000000000000000000');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });
});
