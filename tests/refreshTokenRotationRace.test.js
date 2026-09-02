import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { sanitizeMiddleware } from '../src/middlewares/sanitize.middleware.js';
import { localeMiddleware } from '../src/middlewares/locale.middleware.js';
import { errorHandler } from '../src/utils/errorHandler.js';
import userRouter from '../src/routes/user.routes.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { User } from '../src/models/user.model.js';

process.env.REFRESH_TOKEN_SECRET ||= 'test-refresh-token-secret';
process.env.REFRESH_TOKEN_EXPIRY ||= '7d';

// refreshAccessToken read-checked user.refreshToken against the incoming
// token, then unconditionally overwrote it with a freshly minted pair --
// a plain read-then-save, the same TOCTOU shape already fixed elsewhere
// (applyBowlerSelection, abandonMatch/deleteMatch) via compare-and-swap.
// Two concurrent refresh calls carrying the same still-valid token both
// pass that check off the same stale read, both mint distinct pairs, and
// only the LAST save wins -- silently invalidating the OTHER caller's
// brand-new token, which then fails its own next use with
// REFRESH_TOKEN_EXPIRED_OR_USED, indistinguishable from a stolen token.
describe('refresh token rotation under a concurrent race', () => {
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
    jest.restoreAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('rejects the loser of two concurrent refreshes instead of silently orphaning its new token', async () => {
    const { user } = await createTestUser();

    const loginRes = await request(app)
      .post('/api/v1/user/login')
      .send({ email: user.email, password: 'password123' });
    expect(loginRes.status).toBe(200);
    const initialRefreshToken = loginRes.body.data.refreshToken;

    // Call B: fired from inside the hook below, simulating it completing
    // its own full read-rotate-save cycle while call A's own
    // generateAccessAndRefreshToken is paused between its read and its
    // write.
    let callBToken = null;
    let findByIdCallCount = 0;
    const originalFindById = User.findById.bind(User);
    jest.spyOn(User, 'findById').mockImplementation(async (...args) => {
      findByIdCallCount += 1;
      // The 2nd findById in this request is generateAccessAndRefreshToken's
      // own (the 1st is refreshAccessToken's own initial lookup).
      if (findByIdCallCount === 2) {
        const concurrentRes = await request(app)
          .get('/api/v1/user/refresh-token')
          .set('x-refresh-token', initialRefreshToken);
        expect(concurrentRes.status).toBe(200);
        callBToken = concurrentRes.body.data.refreshToken;
      }
      return originalFindById(...args);
    });

    const resA = await request(app)
      .get('/api/v1/user/refresh-token')
      .set('x-refresh-token', initialRefreshToken);

    jest.restoreAllMocks();

    expect(callBToken).not.toBeNull();

    // A must lose cleanly (a real, actionable error) rather than appear to
    // succeed while silently clobbering B's already-issued token.
    expect(resA.status).toBe(401);
    expect(resA.body.code).toBe('REFRESH_TOKEN_EXPIRED_OR_USED');

    // B's token, obtained from a clean 200 response, must still actually
    // work — proving it wasn't the one silently orphaned.
    const verifyB = await request(app)
      .get('/api/v1/user/refresh-token')
      .set('x-refresh-token', callBToken);
    expect(verifyB.status).toBe(200);
  });
});
