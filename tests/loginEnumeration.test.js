import express from 'express';
import request from 'supertest';
import { sanitizeMiddleware } from '../src/middlewares/sanitize.middleware.js';
import { localeMiddleware } from '../src/middlewares/locale.middleware.js';
import { errorHandler } from '../src/utils/errorHandler.js';
import userRouter from '../src/routes/user.routes.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// authTestUser.js sets ACCESS_TOKEN_SECRET/EXPIRY for tests that sign an
// access token directly, bypassing HTTP — this is the first test to
// exercise the full /login flow, which also mints a refresh token.
process.env.REFRESH_TOKEN_SECRET ||= 'test-refresh-token-secret';
process.env.REFRESH_TOKEN_EXPIRY ||= '7d';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(sanitizeMiddleware);
  app.use(localeMiddleware);
  app.use('/api/v1/user', userRouter);
  app.use(errorHandler);
  return app;
};

// loginUser used to check isEmailVerified/accountStatus BEFORE the password
// at all — three distinct, revealing outcomes (INVALID_CREDENTIALS,
// EMAIL_NOT_VERIFIED, ACCOUNT_STATUS_ISSUE) for a request that never once
// proved it knew the password, plus a free OTP email on every hit of the
// unverified branch. Every wrong-credential case here must now converge on
// the exact same INVALID_CREDENTIALS — that convergence is the fix, not
// each status code in isolation.
describe('POST /user/login does not leak account existence/state before the password check', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildApp();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const login = (email, password) =>
    request(app).post('/api/v1/user/login').send({ email, password });

  it('an unregistered email and a wrong password on a real account return the identical error', async () => {
    await createTestUser({ email: 'real-account@example.com' });

    const unregistered = await login('nobody-here@example.com', 'whatever123');
    const wrongPassword = await login('real-account@example.com', 'wrong-password');

    expect(unregistered.status).toBe(401);
    expect(unregistered.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('a wrong password on an unverified account does not reveal it is unverified', async () => {
    await createTestUser({
      email: 'unverified@example.com',
      isEmailVerified: false,
    });

    const res = await login('unverified@example.com', 'wrong-password');

    // Before the fix: 403 EMAIL_NOT_VERIFIED, and a fresh OTP email sent —
    // both without ever checking this request knew the real password.
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('a wrong password on a blocked account does not reveal its account status', async () => {
    await createTestUser({
      email: 'blocked@example.com',
      accountStatus: 'blocked',
    });

    const res = await login('blocked@example.com', 'wrong-password');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('the correct password on an active, verified account still logs in normally', async () => {
    await createTestUser({ email: 'active@example.com', password: 'password123' });

    const res = await login('active@example.com', 'password123');

    expect(res.status).toBe(200);
    expect(res.body.data.loggedInUser.email).toBe('active@example.com');
  });
});
