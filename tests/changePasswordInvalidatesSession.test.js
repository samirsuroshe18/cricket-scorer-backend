import express from 'express';
import request from 'supertest';
import { sanitizeMiddleware } from '../src/middlewares/sanitize.middleware.js';
import { localeMiddleware } from '../src/middlewares/locale.middleware.js';
import { errorHandler } from '../src/utils/errorHandler.js';
import userRouter from '../src/routes/user.routes.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

process.env.REFRESH_TOKEN_SECRET ||= 'test-refresh-token-secret';
process.env.REFRESH_TOKEN_EXPIRY ||= '7d';

// setPassword (the forgot-password reset path) already clears
// user.refreshToken on success, with its own comment: "Reset invalidates
// any existing session (single-session model)." changeCurrentPassword --
// reachable by anyone who already holds a valid access token and the
// current password, exactly the path a scorer who notices a hijacked
// session would use -- never did the same, so a session compromised via a
// leaked/stolen refresh token survived a password change made through this
// route, contradicting the single-session design intent stated elsewhere in
// this codebase.
describe('changing the current password invalidates the existing session', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = express();
    app.use(express.json());
    app.use(sanitizeMiddleware);
    app.use(localeMiddleware);
    app.use('/api/v1/user', userRouter);
    app.use(errorHandler);
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('clears the refresh token, so it can no longer be used to refresh', async () => {
    const { user } = await createTestUser();

    const loginRes = await request(app)
      .post('/api/v1/user/login')
      .send({ email: user.email, password: 'password123' });
    expect(loginRes.status).toBe(200);
    const { accessToken, refreshToken } = loginRes.body.data;

    const changeRes = await request(app)
      .post('/api/v1/user/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ oldPassword: 'password123', newPassword: 'newPassword456' });
    expect(changeRes.status).toBe(200);

    const refreshRes = await request(app)
      .get('/api/v1/user/refresh-token')
      .set('x-refresh-token', refreshToken);

    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.code).toBe('REFRESH_TOKEN_EXPIRED_OR_USED');
  });
});
