import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// Powers the "reuse an existing team" picker: lets the client offer the
// scorer their own past teams to attach via teamAId/teamBId on createMatch,
// rather than guessing identity from a typed name (see resolveTeamSide in
// match.controller.js for why guessing was rejected).
describe('GET /v1/team', () => {
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

  const myTeams = (token) =>
    request(app)
      .get('/api/v1/team')
      .set('Authorization', `Bearer ${token}`)
      .send();

  it("returns only the caller's own teams", async () => {
    const { token: mine } = await createTestUser();
    const { token: theirs } = await createTestUser();
    await createMatch(mine, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    await createMatch(theirs, { teamAName: 'Delhi Capitals', teamBName: 'Punjab Kings' });

    const res = await myTeams(mine);

    expect(res.status).toBe(200);
    const names = res.body.data.teams.map((t) => t.name);
    expect(names.sort()).toEqual(['Chennai Super Kings', 'Mumbai Indians']);
  });

  it('does not duplicate a team reused across two matches', async () => {
    const { token } = await createTestUser();
    const first = await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    const teamId = first.body.data.teamA.id;
    await createMatch(token, { teamAId: teamId, teamBName: 'Delhi Capitals' });

    const res = await myTeams(token);

    const mumbaiEntries = res.body.data.teams.filter((t) => t.id === teamId);
    expect(mumbaiEntries).toHaveLength(1);
  });

  it('returns an empty list for a scorer with no teams yet', async () => {
    const { token } = await createTestUser();

    const res = await myTeams(token);

    expect(res.status).toBe(200);
    expect(res.body.data.teams).toEqual([]);
  });
});
