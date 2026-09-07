import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

describe('GET /:matchId/bowlers', () => {
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

  const getBowlers = (token, matchId) =>
    request(app).get(`/api/v1/match/${matchId}/bowlers`).set('Authorization', `Bearer ${token}`);

  const selectBowler = (token, matchId, body) =>
    request(app)
      .post(`/api/v1/match/${matchId}/select-bowler`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('lists the full bowling-side roster, including batters who have not bowled', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId, { bowlerName: 'Bowler One' });

    const res = await getBowlers(token, matchId);

    expect(res.status).toBe(200);
    const names = res.body.data.bowlers.map((b) => b.name).sort();
    // Bowler One (opening bowler) plus Striker/Non-Striker, batting on the
    // OTHER side, must not appear — only the bowling side's roster does.
    expect(names).toEqual(['Bowler One']);
  });

  it('reports legal deliveries bowled this innings for each bowler, zero for anyone who has not bowled', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId, { bowlerName: 'Bowler One' });

    // Bowler One bowls out over 1 (6 legal deliveries).
    for (let i = 0; i < 6; i++) {
      await scoreDotBall(app, token, matchId);
    }
    await selectBowler(token, matchId, { bowlerName: 'Bowler Two' });

    const res = await getBowlers(token, matchId);

    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.data.bowlers.map((b) => [b.name, b.legalDeliveries]));
    expect(byName['Bowler One']).toBe(6);
    expect(byName['Bowler Two']).toBe(0);
  });

  it('sorts by legal deliveries bowled (desc), then name', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId, { bowlerName: 'Zed' });

    for (let i = 0; i < 6; i++) {
      await scoreDotBall(app, token, matchId);
    }
    await selectBowler(token, matchId, { bowlerName: 'Amy' });

    const res = await getBowlers(token, matchId);

    expect(res.body.data.bowlers.map((b) => b.name)).toEqual(['Zed', 'Amy']);
  });

  it('rejects a caller who neither created nor is assigned to the match', async () => {
    const { token } = await createTestUser({ email: 'creator@example.com' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    const res = await getBowlers(strangerToken, matchId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });

  it('rejects with MATCH_NOT_FOUND for an unknown matchId', async () => {
    const { token } = await createTestUser();

    const res = await getBowlers(token, '000000000000000000000000');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MATCH_NOT_FOUND');
  });

  it('rejects with INNINGS_NOT_STARTED before start-innings has been called', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);

    const res = await getBowlers(token, matchId);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INNINGS_NOT_STARTED');
  });
});
