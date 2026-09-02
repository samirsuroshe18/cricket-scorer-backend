import request from 'supertest';
import { createTestUser } from './helpers/authTestUser.js';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// A JSON body preserves types — a number, boolean, object, or array can sit
// where a free-text field is expected, unlike a form post. The `!field?.trim()`
// pattern (this codebase's own documented convention for a required string)
// only guards null/undefined: `(123)?.trim` is `undefined`, but calling it —
// `(123)?.trim()` — still throws a TypeError, since optional chaining only
// short-circuits a null/undefined *receiver*, not a missing *method* on a
// non-null one. That reaches the generic 500 handler instead of the field's
// own *_REQUIRED 400, for every endpoint that takes a free-text field
// straight from req.body.
describe('a malformed (non-string) required field produces a clean 400, not a 500', () => {
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

  it('POST /match/create — a numeric teamAName', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 12345, teamBName: 'Team B', totalOvers: 5 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NAMES_REQUIRED');
  });

  it('POST /match/:matchId/start-innings — an object bowlerName', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/start-innings`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        strikerName: 'Striker',
        nonStrikerName: 'Non-Striker',
        bowlerName: { name: 'Bumrah' },
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOWLER_NAME_REQUIRED');
  });

  it('POST /match/:matchId/select-bowler — an array bowlerName', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/select-bowler`)
      .set('Authorization', `Bearer ${token}`)
      .send({ bowlerName: ['Bumrah'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BOWLER_NAME_REQUIRED');
  });

  it('POST /match/:matchId/score-ball — a boolean idempotencyKey', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/score-ball`)
      .set('Authorization', `Bearer ${token}`)
      .send({ runs: 0, idempotencyKey: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('POST /match/:matchId/score-ball — a numeric incomingBatsmanName on a wicket', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    const res = await scoreDotBall(app, token, matchId, {
      wicketType: 'bowled',
      dismissedBatsman: 'striker',
      incomingBatsmanName: 42,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INCOMING_BATSMAN_REQUIRED');
  });
});
