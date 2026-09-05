import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

describe('GET /:matchId/scorer-candidates', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withOrganization: true });
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

  const createOrgTeam = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

  const getCandidates = (token, matchId) =>
    request(app).get(`/api/v1/match/${matchId}/scorer-candidates`).set('Authorization', `Bearer ${token}`);

  it('lists the org\'s members for a match created with an org-owned team', async () => {
    const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
    const { user: member } = await createTestUser({ email: 'member@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'member@example.com' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });

    const res = await getCandidates(ownerToken, matchId);

    expect(res.status).toBe(200);
    const ids = res.body.data.candidates.map((c) => c.id).sort();
    expect(ids).toEqual([String(owner._id), String(member._id)].sort());
  });

  it('returns an empty list for an authorized caller on a match with no org-linked team', async () => {
    const { token } = await createTestUser({ email: 'adhoc@example.com' });
    const matchId = await createMatch(app, token);

    const res = await getCandidates(token, matchId);

    expect(res.status).toBe(200);
    expect(res.body.data.candidates).toEqual([]);
  });

  it('rejects a caller with no assign-authority, even on a match with no org-linked team', async () => {
    const { token } = await createTestUser({ email: 'creator@example.com' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const matchId = await createMatch(app, token);

    const res = await getCandidates(strangerToken, matchId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });

  it('rejects with MATCH_NOT_FOUND for an unknown matchId', async () => {
    const { token } = await createTestUser();

    const res = await getCandidates(token, '000000000000000000000000');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MATCH_NOT_FOUND');
  });
});
