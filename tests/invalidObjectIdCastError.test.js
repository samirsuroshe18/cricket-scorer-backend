import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// Any route with an ObjectId-shaped param — :matchId here — throws a raw
// Mongoose CastError the moment a malformed value reaches a query, straight
// out of the query-casting layer rather than anything that ever calls
// ApiError. errorHandler had no special case for it, so it fell through to
// the generic 500 INTERNAL_SERVER_ERROR — indistinguishable from a genuinely
// unexpected server bug, when this is exactly a bad-input problem instead.
describe('a malformed ObjectId-shaped route param is a clean 400, not a raw 500', () => {
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

  it('GET /:matchId/scorecard with a malformed matchId returns 400 INVALID_ID', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .get('/api/v1/match/not-a-valid-object-id/scorecard')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it('POST /:matchId/score-ball with a malformed matchId returns 400 INVALID_ID', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/match/also-not-valid/score-ball')
      .set('Authorization', `Bearer ${token}`)
      .send({ runs: 0, idempotencyKey: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it('a well-formed but nonexistent matchId still reaches the normal 404, not this new path', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .get('/api/v1/match/000000000000000000000000/scorecard')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MATCH_NOT_FOUND');
  });
});
