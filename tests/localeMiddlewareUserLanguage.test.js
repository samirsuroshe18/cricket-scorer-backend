import express from 'express';
import request from 'supertest';
import { sanitizeMiddleware } from '../src/middlewares/sanitize.middleware.js';
import { localeMiddleware } from '../src/middlewares/locale.middleware.js';
import { errorHandler } from '../src/utils/errorHandler.js';
import userRouter from '../src/routes/user.routes.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// localeMiddleware is mounted globally ahead of every router, while verifyJwt
// is applied per-route inside them — so on every request, protected or
// public, localeMiddleware has already run (and already resolved req.t)
// before verifyJwt ever populates req.user. A signed-in user's own stored
// `language` can therefore never reach a server-composed message; only the
// accept-language header does. This pins that as the actual, current
// behavior — not a regression to fix here, but worth a test given a "fix"
// was previously claimed adjacent to this exact area.
describe('a signed-in user\'s stored language preference does not affect server messages', () => {
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

  it('a Marathi accept-language header wins over a Hindi stored preference', async () => {
    const { token } = await createTestUser({ language: 'hi' });

    const res = await request(app)
      .get('/api/v1/user/get-current-user')
      .set('Authorization', `Bearer ${token}`)
      .set('accept-language', 'mr');

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('सध्याचा वापरकर्ता यशस्वीरित्या मिळाला');
  });
});
