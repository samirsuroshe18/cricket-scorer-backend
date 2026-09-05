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
