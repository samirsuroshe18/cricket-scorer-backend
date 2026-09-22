import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Team } from '../src/models/team.model.js';
import { Match } from '../src/models/match.model.js';

describe('PATCH /v1/team/:teamId', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true, withOrganization: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const patch = (token, teamId, body) =>
    request(app).patch(`/api/v1/team/${teamId}`).set('Authorization', `Bearer ${token}`).send(body);

  const createStandaloneTeam = async (token, name = 'Mumbai Indians') => {
    const res = await request(app).post('/api/v1/team').set('Authorization', `Bearer ${token}`).send({ name });
    return res.body.data.id;
  };

  it("renames the team's creator's standalone team", async () => {
    const { token } = await createTestUser();
    const teamId = await createStandaloneTeam(token);

    const res = await patch(token, teamId, { name: 'Mumbai Indians XI', shortName: 'mi' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: teamId, name: 'Mumbai Indians XI', shortName: 'MI' });
    const stored = await Team.findById(teamId);
    expect(stored.name).toBe('Mumbai Indians XI');
    expect(stored.shortName).toBe('MI');
  });

  it('clears the short name when it is sent blank', async () => {
    const { token } = await createTestUser();
    const teamId = await createStandaloneTeam(token);
    await patch(token, teamId, { name: 'Mumbai Indians', shortName: 'MI' });

    const res = await patch(token, teamId, { name: 'Mumbai Indians', shortName: '' });

    expect(res.status).toBe(200);
    expect(res.body.data.shortName).toBeNull();
    const stored = await Team.findById(teamId);
    expect(stored.shortName).toBeUndefined();
  });

  it('400s with TEAM_NAME_REQUIRED for a blank name', async () => {
    const { token } = await createTestUser();
    const teamId = await createStandaloneTeam(token);

    const res = await patch(token, teamId, { name: '  ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NAME_REQUIRED');
  });

  it('400s with TEAM_NAME_TOO_LONG for a 51-character name', async () => {
    const { token } = await createTestUser();
    const teamId = await createStandaloneTeam(token);

    const res = await patch(token, teamId, { name: 'A'.repeat(51) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NAME_TOO_LONG');
  });

  it('404s for a teamId that does not exist', async () => {
    const { token } = await createTestUser();

    const res = await patch(token, '665f3b1c2d3e4f5a6b7c8d90', { name: 'X' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_FOUND');
  });

  it("403s with TEAM_NOT_OWNED for a stranger who can't access the team at all", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const teamId = await createStandaloneTeam(ownerToken);
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await patch(strangerToken, teamId, { name: 'X' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_OWNED');
  });

  it("403s with TEAM_NOT_MANAGEABLE for an organization member who is not the org owner", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: 'member@example.com' });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;

    const res = await patch(memberToken, teamId, { name: 'Renamed' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_MANAGEABLE');
  });

  it("the org owner can rename a team a different member created", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;

    const res = await patch(ownerToken, teamId, { name: 'Riverside U19 Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Riverside U19 Renamed');
  });

  it("a completed match still shows the team's new name after a rename", async () => {
    const { token } = await createTestUser();
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Old Name', teamBName: 'Opponent', totalOvers: 5 });
    const teamId = createRes.body.data.teamA.id;
    const matchId = createRes.body.data.matchId;
    await Match.updateOne({ _id: matchId }, { $set: { status: 'completed' } });

    await patch(token, teamId, { name: 'New Name' });

    const historyRes = await request(app)
      .get(`/api/v1/team/${teamId}/matches`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(historyRes.body.data.matches[0].teamA.name).toBe('New Name');
  });
});
