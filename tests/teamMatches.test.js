import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// Past results for a team: identical shape/validation to GET /v1/match/history
// (see matchHistory.test.js) — page-based pagination, all statuses shown, same
// INVALID_PAGINATION error. Ownership is checked on the Team, not the Match:
// a Team can only ever be attached to a match by the scorer who owns it (see
// createMatch), so team ownership implies match ownership transitively.
describe('GET /v1/team/:teamId/matches', () => {
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

  const teamMatches = (token, teamId, query = '') =>
    request(app)
      .get(`/api/v1/team/${teamId}/matches${query}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

  it('404s for a teamId that does not exist', async () => {
    const { token } = await createTestUser();

    const res = await teamMatches(token, '665f3b1c2d3e4f5a6b7c8d90');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_FOUND');
  });

  it("403s for a team that belongs to a different scorer's account", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const createRes = await createMatch(ownerToken, { teamAName: 'Owner A', teamBName: 'Owner B' });
    const teamId = createRes.body.data.teamA.id;

    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const res = await teamMatches(strangerToken, teamId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_OWNED');
  });

  it('returns matches where the team played as either teamA or teamB, newest first', async () => {
    const { token } = await createTestUser();
    const first = await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    const teamId = first.body.data.teamA.id;

    // Second match: same team, now playing as teamB against a new opponent.
    const second = await createMatch(token, { teamAId: teamId, teamBName: 'Delhi Capitals' });

    const res = await teamMatches(token, teamId);

    expect(res.status).toBe(200);
    expect(res.body.data.matches).toHaveLength(2);
    expect(res.body.data.matches[0].matchId).toBe(second.body.data.matchId);
    expect(res.body.data.matches[1].matchId).toBe(first.body.data.matchId);
    expect(res.body.data.total).toBe(2);
  });

  it('excludes matches the team was never part of', async () => {
    const { token } = await createTestUser();
    const first = await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    const teamId = first.body.data.teamA.id;
    await createMatch(token, { teamAName: 'Delhi Capitals', teamBName: 'Punjab Kings' });

    const res = await teamMatches(token, teamId);

    expect(res.body.data.matches).toHaveLength(1);
    expect(res.body.data.total).toBe(1);
  });

  it('shows all statuses, not just completed matches', async () => {
    const { token } = await createTestUser();
    const created = await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    const teamId = created.body.data.teamA.id;

    const res = await teamMatches(token, teamId);

    expect(res.body.data.matches[0].status).toBe('upcoming');
  });

  it('paginates with ?page and ?limit', async () => {
    const { token } = await createTestUser();
    const first = await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Opponent 1' });
    const teamId = first.body.data.teamA.id;
    const ids = [first.body.data.matchId];
    for (let i = 2; i <= 3; i += 1) {
      const res = await createMatch(token, { teamAId: teamId, teamBName: `Opponent ${i}` });
      ids.push(res.body.data.matchId);
    }

    const page1 = await teamMatches(token, teamId, '?page=1&limit=2');
    expect(page1.body.data.matches).toHaveLength(2);
    expect(page1.body.data.total).toBe(3);
    expect(page1.body.data.matches.map((m) => m.matchId)).toEqual([ids[2], ids[1]]);

    const page2 = await teamMatches(token, teamId, '?page=2&limit=2');
    expect(page2.body.data.matches).toHaveLength(1);
    expect(page2.body.data.matches[0].matchId).toBe(ids[0]);
  });

  it('rejects an over-large limit rather than returning an unbounded list', async () => {
    const { token } = await createTestUser();
    const created = await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    const teamId = created.body.data.teamA.id;

    const res = await teamMatches(token, teamId, '?limit=10000');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAGINATION');
  });
});
