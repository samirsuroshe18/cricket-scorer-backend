import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Team } from '../src/models/team.model.js';
import { Match } from '../src/models/match.model.js';

describe('DELETE /v1/team/:teamId', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true, withOrganization: true, withTournament: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const del = (token, teamId) =>
    request(app).delete(`/api/v1/team/${teamId}`).set('Authorization', `Bearer ${token}`).send();

  const createStandaloneTeam = async (token, name = 'Mumbai Indians') => {
    const res = await request(app).post('/api/v1/team').set('Authorization', `Bearer ${token}`).send({ name });
    return res.body.data.id;
  };

  it('soft-deletes a standalone team with no matches or tournaments', async () => {
    const { token } = await createTestUser();
    const teamId = await createStandaloneTeam(token);

    const res = await del(token, teamId);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: teamId });
    const stored = await Team.findById(teamId);
    expect(stored.isDeleted).toBe(true);
  });

  it('a deleted team no longer appears in GET /v1/team', async () => {
    const { token } = await createTestUser();
    const teamId = await createStandaloneTeam(token);
    await del(token, teamId);

    const res = await request(app).get('/api/v1/team').set('Authorization', `Bearer ${token}`).send();

    expect(res.body.data.teams.map((t) => t.id)).not.toContain(teamId);
  });

  it('404s for a teamId that does not exist', async () => {
    const { token } = await createTestUser();

    const res = await del(token, '665f3b1c2d3e4f5a6b7c8d90');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_FOUND');
  });

  it("403s with TEAM_NOT_OWNED for a stranger", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const teamId = await createStandaloneTeam(ownerToken);
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await del(strangerToken, teamId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_OWNED');
  });

  it("403s with TEAM_NOT_MANAGEABLE for an org member who is not the org owner", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: 'member@example.com' });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;

    const res = await del(memberToken, teamId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_MANAGEABLE');
  });

  it.each(['upcoming', 'live', 'innings_break'])(
    '409s with TEAM_IN_ACTIVE_MATCH when the team is teamA in a %s match',
    async (status) => {
      const { token } = await createTestUser();
      const createRes = await request(app)
        .post('/api/v1/match/create')
        .set('Authorization', `Bearer ${token}`)
        .send({ teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings', totalOvers: 5 });
      const teamId = createRes.body.data.teamA.id;
      await Match.updateOne({ _id: createRes.body.data.matchId }, { $set: { status } });

      const res = await del(token, teamId);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('TEAM_IN_ACTIVE_MATCH');
    },
  );

  it('409s with TEAM_IN_ACTIVE_MATCH when the team is teamB (not teamA) in a live match', async () => {
    const { token } = await createTestUser();
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings', totalOvers: 5 });
    const teamBId = createRes.body.data.teamB.id;
    await Match.updateOne({ _id: createRes.body.data.matchId }, { $set: { status: 'live' } });

    const res = await del(token, teamBId);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEAM_IN_ACTIVE_MATCH');
  });

  it('deletes successfully when the team\'s only match is completed', async () => {
    const { token } = await createTestUser();
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings', totalOvers: 5 });
    const teamId = createRes.body.data.teamA.id;
    await Match.updateOne({ _id: createRes.body.data.matchId }, { $set: { status: 'completed' } });

    const res = await del(token, teamId);

    expect(res.status).toBe(200);
  });

  it('deletes successfully when the team\'s only match is abandoned', async () => {
    const { token } = await createTestUser();
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings', totalOvers: 5 });
    const teamId = createRes.body.data.teamA.id;
    await Match.updateOne({ _id: createRes.body.data.matchId }, { $set: { status: 'abandoned' } });

    const res = await del(token, teamId);

    expect(res.status).toBe(200);
  });

  it('409s with TEAM_IN_TOURNAMENT when the team is enrolled in a non-deleted tournament', async () => {
    const { token } = await createTestUser();
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send({ name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send({ name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;
    const tournamentRes = await request(app).post(`/api/v1/organization/${orgId}/tournaments`).set('Authorization', `Bearer ${token}`).send({ name: 'Summer T20', format: 'knockout' });
    const tournamentId = tournamentRes.body.data.id;
    await request(app).post(`/api/v1/tournament/${tournamentId}/teams`).set('Authorization', `Bearer ${token}`).send({ teamId });

    const res = await del(token, teamId);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEAM_IN_TOURNAMENT');
  });
});
