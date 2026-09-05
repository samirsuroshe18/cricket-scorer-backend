import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

describe('GET /:matchId/scorecard — delegated scoring', () => {
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

  const setupDelegatedMatch = async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: 'scorer@example.com' });
    const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: member.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });
    await startLiveInnings(app, ownerToken, matchId);
    // getMatchScorecard only serves a completed or abandoned match —
    // abandoning here (as the creator, before the delegated-scoring checks
    // below are exercised) is the simplest way to make one available.
    await request(app).post(`/api/v1/match/${matchId}/abandon`).set('Authorization', `Bearer ${ownerToken}`);
    return { ownerToken, scorerToken, memberToken, matchId };
  };

  it('lets the assigned scorer view the scorecard', async () => {
    const { scorerToken, matchId } = await setupDelegatedMatch();

    const res = await request(app).get(`/api/v1/match/${matchId}/scorecard`).set('Authorization', `Bearer ${scorerToken}`);

    expect(res.status).toBe(200);
  });

  it('still rejects a plain org member who is not the assigned scorer', async () => {
    const { memberToken, matchId } = await setupDelegatedMatch();

    const res = await request(app).get(`/api/v1/match/${matchId}/scorecard`).set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });
});
