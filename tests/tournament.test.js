import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';

let app;

beforeAll(async () => {
  await connectTestDb();
  await Tournament.init();
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

const createTournament = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/tournaments`).set('Authorization', `Bearer ${token}`).send(body);

const createOrgTeam = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

const getTournament = (token, tournamentId) =>
  request(app).get(`/api/v1/tournament/${tournamentId}`).set('Authorization', `Bearer ${token}`).send();

const updateTournament = (token, tournamentId, body) =>
  request(app).patch(`/api/v1/tournament/${tournamentId}`).set('Authorization', `Bearer ${token}`).send(body);

const deleteTournament = (token, tournamentId) =>
  request(app).delete(`/api/v1/tournament/${tournamentId}`).set('Authorization', `Bearer ${token}`).send();

const addOrgMember = (token, orgId, email) =>
  request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${token}`).send({ email });

const addTeam = (token, tournamentId, body) =>
  request(app).post(`/api/v1/tournament/${tournamentId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

const removeTeam = (token, tournamentId, teamId) =>
  request(app).delete(`/api/v1/tournament/${tournamentId}/teams/${teamId}`).set('Authorization', `Bearer ${token}`).send();

describe('POST /v1/organization/:orgId/tournaments', () => {
  it('creates a tournament under the organization', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const res = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Summer T20',
      organization: orgId,
      format: 'knockout',
      status: 'upcoming',
      teams: [],
    });
  });

  it("404s for an orgId that doesn't exist", async () => {
    const { token } = await createTestUser();

    const res = await createTournament(token, '665f3b1c2d3e4f5a6b7c8d90', { name: 'Summer T20', format: 'knockout' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ORG_NOT_FOUND');
  });

  it('403s when a non-owner tries to create a tournament', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await createTournament(strangerToken, orgId, { name: 'Summer T20', format: 'knockout' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });

  it('400s for an empty name', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const res = await createTournament(token, orgId, { name: '  ', format: 'knockout' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOURNAMENT_NAME_REQUIRED');
  });

  it('400s for a missing format', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const res = await createTournament(token, orgId, { name: 'Summer T20' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOURNAMENT_FORMAT_REQUIRED');
  });

  it('400s for a format outside the enum', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const res = await createTournament(token, orgId, { name: 'Summer T20', format: 'swiss' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TOURNAMENT_FORMAT');
  });

  it('409s when the same org reuses a tournament name, case-insensitively', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });

    const res = await createTournament(token, orgId, { name: 'summer t20', format: 'league' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TOURNAMENT_NAME_TAKEN');
  });

  it('allows two different organizations to use the same tournament name', async () => {
    const { token: token1 } = await createTestUser({ email: 'owner1@example.com' });
    const { token: token2 } = await createTestUser({ email: 'owner2@example.com' });
    const org1 = await createOrg(token1, { name: 'Riverside CC' });
    const org2 = await createOrg(token2, { name: 'Downtown CC' });

    await createTournament(token1, org1.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const res = await createTournament(token2, org2.body.data.id, { name: 'Summer T20', format: 'knockout' });

    expect(res.status).toBe(200);
  });
});

describe('GET /v1/tournament/:tournamentId', () => {
  it("404s for a tournamentId that doesn't exist", async () => {
    const { token } = await createTestUser();

    const res = await getTournament(token, '665f3b1c2d3e4f5a6b7c8d90');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });

  it('403s for a caller who is not a member of the owning organization', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(ownerToken, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await getTournament(strangerToken, tournamentRes.body.data.id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('returns the tournament with its organization for an org member', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });

    const res = await getTournament(token, tournamentRes.body.data.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Summer T20',
      format: 'knockout',
      status: 'upcoming',
      organization: { id: orgId, name: 'Riverside CC' },
      teams: [],
    });
  });
});

describe('PATCH /v1/tournament/:tournamentId', () => {
  it('updates name, format, and status together', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const tournamentId = tournamentRes.body.data.id;

    const res = await updateTournament(token, tournamentId, { name: 'Winter T20', format: 'league', status: 'ongoing' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Winter T20', format: 'league', status: 'ongoing' });
  });

  it('403s when an org member who is not the owner tries to update', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'knockout' });
    const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
    await request(app)
      .post(`/api/v1/organization/${orgId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'member@example.com' });

    const res = await updateTournament(memberToken, tournamentRes.body.data.id, { name: 'Winter T20' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it("403s when a caller who isn't even a member of the organization tries to update", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(ownerToken, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await updateTournament(strangerToken, tournamentRes.body.data.id, { name: 'Winter T20' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('400s when no field is provided', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });

    const res = await updateTournament(token, tournamentRes.body.data.id, {});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOURNAMENT_UPDATE_FIELDS_REQUIRED');
  });

  it('400s for an invalid status', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });

    const res = await updateTournament(token, tournamentRes.body.data.id, { status: 'finished' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TOURNAMENT_STATUS');
  });

  it('409s when renaming into a name collision within the same organization', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await createTournament(token, orgId, { name: 'Winter T20', format: 'knockout' });
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });

    const res = await updateTournament(token, tournamentRes.body.data.id, { name: 'winter t20' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TOURNAMENT_NAME_TAKEN');
  });
});

describe('DELETE /v1/tournament/:tournamentId', () => {
  it('soft-deletes the tournament', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const tournamentId = tournamentRes.body.data.id;

    const res = await deleteTournament(token, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tournamentId });

    const after = await getTournament(token, tournamentId);
    expect(after.status).toBe(404);
    expect(after.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });

  it('403s when an org member who is not the owner tries to delete', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'knockout' });
    const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
    await addOrgMember(ownerToken, orgId, 'member@example.com');

    const res = await deleteTournament(memberToken, tournamentRes.body.data.id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it("403s when a caller who isn't even a member of the organization tries to delete", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(ownerToken, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await deleteTournament(strangerToken, tournamentRes.body.data.id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });
});

describe('POST /v1/tournament/:tournamentId/teams', () => {
  it("enrolls a team already in the tournament's organization", async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(token, orgId, { name: 'Riverside U19' });

    const res = await addTeam(token, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tournamentId: tournamentRes.body.data.id,
      team: { id: teamRes.body.data.id, name: 'Riverside U19' },
    });
  });

  it("400s for a team that doesn't belong to this tournament's organization", async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const otherOrgRes = await createOrg(token, { name: 'Downtown CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });
    const outsideTeamRes = await createOrgTeam(token, otherOrgRes.body.data.id, { name: 'Downtown XI' });

    const res = await addTeam(token, tournamentRes.body.data.id, { teamId: outsideTeamRes.body.data.id });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NOT_IN_ORGANIZATION');
  });

  it('409s when the team is already enrolled', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(token, orgId, { name: 'Riverside U19' });
    await addTeam(token, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });

    const res = await addTeam(token, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEAM_ALREADY_IN_TOURNAMENT');
  });

  it('403s when an org member who is not the owner tries to enroll a team', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
    await addOrgMember(ownerToken, orgId, 'member@example.com');

    const res = await addTeam(memberToken, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it("403s when a caller who isn't even a member of the organization tries to enroll a team", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await addTeam(strangerToken, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('404s for a nonexistent teamId', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });

    const res = await addTeam(token, tournamentRes.body.data.id, { teamId: '665f3b1c2d3e4f5a6b7c8d90' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_FOUND');
  });
});

describe('DELETE /v1/tournament/:tournamentId/teams/:teamId', () => {
  it('removes an enrolled team', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });
    const tournamentId = tournamentRes.body.data.id;
    const teamRes = await createOrgTeam(token, orgId, { name: 'Riverside U19' });
    await addTeam(token, tournamentId, { teamId: teamRes.body.data.id });

    const res = await removeTeam(token, tournamentId, teamRes.body.data.id);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tournamentId, teamId: teamRes.body.data.id });

    const after = await getTournament(token, tournamentId);
    expect(after.body.data.teams).toEqual([]);
  });

  it("404s when the team isn't enrolled", async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(token, orgId, { name: 'Riverside U19' });

    const res = await removeTeam(token, tournamentRes.body.data.id, teamRes.body.data.id);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_IN_TOURNAMENT');
  });

  it('400s for a malformed teamId, rather than a false "not in tournament"', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const tournamentRes = await createTournament(token, orgRes.body.data.id, { name: 'Summer T20', format: 'knockout' });

    const res = await removeTeam(token, tournamentRes.body.data.id, 'not-a-valid-id');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it("403s when a caller who isn't even a member of the organization tries to remove a team", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    await addTeam(ownerToken, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await removeTeam(strangerToken, tournamentRes.body.data.id, teamRes.body.data.id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('403s when an org member who is not the owner tries to remove a team', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'knockout' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    await addTeam(ownerToken, tournamentRes.body.data.id, { teamId: teamRes.body.data.id });
    const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
    await addOrgMember(ownerToken, orgId, 'member@example.com');

    const res = await removeTeam(memberToken, tournamentRes.body.data.id, teamRes.body.data.id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });
});
