import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// Locks in the existing convention (invalidObjectIdCastError.test.js) for
// every new place a team id is accepted: a malformed value is a raw Mongoose
// CastError from the query layer, which errorHandler turns into 400
// INVALID_ID, not a team-specific validation error.
describe('a malformed team id is a clean 400 INVALID_ID everywhere one is accepted', () => {
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

  it('GET /v1/team/:teamId with a malformed teamId', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .get('/api/v1/team/not-a-valid-object-id')
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it('GET /v1/team/:teamId/matches with a malformed teamId', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .get('/api/v1/team/not-a-valid-object-id/matches')
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it('POST /v1/match/create with a malformed teamAId', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAId: 'not-a-valid-object-id', teamBName: 'Chennai Super Kings', totalOvers: 5 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it('POST /v1/match/create with a malformed teamBId', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Mumbai Indians', teamBId: 'not-a-valid-object-id', totalOvers: 5 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});
