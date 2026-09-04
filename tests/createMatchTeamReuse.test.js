import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { startLiveInnings } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// Explicit opt-in team reuse via teamAId/teamBId — the replacement for the
// name-based find-or-create that was tried and reverted (matchTeamScoping.test.js).
// The scorer states identity explicitly by id; nothing here guesses from a name.
describe('createMatch with teamAId/teamBId', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const createMatch = (token, body) =>
    request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ totalOvers: 5, ...body });

  it('reuses the existing team instead of creating a new one', async () => {
    const { token } = await createTestUser();
    const first = await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    const teamId = first.body.data.teamA.id;

    const second = await createMatch(token, { teamAId: teamId, teamBName: 'Delhi Capitals' });

    expect(second.status).toBe(200);
    expect(second.body.data.teamA.id).toBe(teamId);
    expect(second.body.data.teamA.name).toBe('Mumbai Indians');
  });

  it("404s when teamAId doesn't exist", async () => {
    const { token } = await createTestUser();

    const res = await createMatch(token, { teamAId: '665f3b1c2d3e4f5a6b7c8d90', teamBName: 'Chennai Super Kings' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_FOUND');
  });

  it("403s when teamAId belongs to a different scorer", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const owned = await createMatch(ownerToken, { teamAName: 'Owner A', teamBName: 'Owner B' });
    const teamId = owned.body.data.teamA.id;

    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const res = await createMatch(strangerToken, { teamAId: teamId, teamBName: 'Stranger B' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_OWNED');
  });

  it('rejects reusing the same team for both sides', async () => {
    const { token } = await createTestUser();
    const first = await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    const teamId = first.body.data.teamA.id;

    const res = await createMatch(token, { teamAId: teamId, teamBId: teamId });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NAMES_MUST_DIFFER');
  });

  it('accumulates roster across matches for a reused team', async () => {
    const { token } = await createTestUser();
    const first = await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    const teamId = first.body.data.teamA.id;
    await startLiveInnings(app, token, first.body.data.matchId, {
      strikerName: 'Rahul',
      nonStrikerName: 'Ravi',
      bowlerName: 'BowlerOne',
    });

    const second = await createMatch(token, { teamAId: teamId, teamBName: 'Delhi Capitals' });
    await startLiveInnings(app, token, second.body.data.matchId, {
      strikerName: 'Rahul',
      nonStrikerName: 'Suresh',
      bowlerName: 'BowlerTwo',
    });

    const profileRes = await request(app)
      .get(`/api/v1/team/${teamId}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    const names = profileRes.body.data.roster.map((p) => p.playerName);
    expect(names.sort()).toEqual(['Rahul', 'Ravi', 'Suresh']);
  });
});
