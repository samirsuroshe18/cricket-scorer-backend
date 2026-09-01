import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// createMatch's duplicate-team-name check normalized case but not internal
// whitespace — "Mumbai Indians" and "Mumbai  Indians" (a doubled space, an
// easy typo) compared unequal and both passed as "different" teams.
describe('createMatch rejects team names that only differ by whitespace', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp();
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

  it('rejects a doubled internal space as a "different" team name', async () => {
    const { token } = await createTestUser();

    const res = await createMatch(token, {
      teamAName: 'Mumbai Indians',
      teamBName: 'Mumbai  Indians',
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NAMES_MUST_DIFFER');
  });

  it('still rejects an exact case-insensitive duplicate, unchanged', async () => {
    const { token } = await createTestUser();

    const res = await createMatch(token, {
      teamAName: 'Mumbai Indians',
      teamBName: 'mumbai indians',
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NAMES_MUST_DIFFER');
  });

  it('still allows genuinely different team names', async () => {
    const { token } = await createTestUser();

    const res = await createMatch(token, {
      teamAName: 'Mumbai Indians',
      teamBName: 'Chennai Super Kings',
    });

    expect(res.status).toBe(200);
  });
});
