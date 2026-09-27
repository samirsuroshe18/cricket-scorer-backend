import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// Its own file so the request count here cannot spend another file's budget.
describe('GET /v1/user/lookup rate limit', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withUser: true });
  });

  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  const lookup = (token) =>
    request(app).get('/api/v1/user/lookup').set('Authorization', `Bearer ${token}`).query({ email: 'nobody@example.com' });

  it('returns 429 TOO_MANY_REQUESTS on the 31st request from one user, not for another user', async () => {
    const { token } = await createTestUser();
    const { token: otherToken } = await createTestUser();

    for (let i = 0; i < 30; i += 1) {
      const res = await lookup(token);
      expect(res.status).toBe(404);
    }
    const limited = await lookup(token);
    const otherUser = await lookup(otherToken);

    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('TOO_MANY_REQUESTS');
    expect(otherUser.status).toBe(404);
  });
});
