import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { sanitizeMiddleware } from '../src/middlewares/sanitize.middleware.js';
import { localeMiddleware } from '../src/middlewares/locale.middleware.js';
import { errorHandler } from '../src/utils/errorHandler.js';
import userRouter from '../src/routes/user.routes.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

process.env.REFRESH_TOKEN_SECRET ||= 'test-refresh-token-secret';
process.env.REFRESH_TOKEN_EXPIRY ||= '7d';

// Neither verifyJwt nor refreshAccessToken passed an `algorithms` allowlist to
// jwt.verify — every token this app issues is signed HS256, but without a
// pinned allowlist, jsonwebtoken accepts any HMAC variant it infers from the
// secret's type (HS256/HS384/HS512 for a plain string secret). Not exploitable
// today (there's no RSA keypair here for the classic alg-confusion attack),
// but implicit rather than pinned — a token forged/re-signed with a different
// HMAC variant using the same secret used to verify regardless of which
// algorithm this app actually issues.
describe('jwt.verify pins the algorithm allowlist', () => {
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

  it('rejects an access token signed with a different HMAC algorithm using the same secret', async () => {
    const { user } = await createTestUser();

    const wrongAlgToken = jwt.sign(
      { _id: user._id, email: user.email, userName: user.userName },
      process.env.ACCESS_TOKEN_SECRET,
      { algorithm: 'HS384', expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/api/v1/user/get-current-user')
      .set('Authorization', `Bearer ${wrongAlgToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INVALID_ACCESS_TOKEN');
  });

  it('still accepts a real HS256 access token, same as before', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .get('/api/v1/user/get-current-user')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it('rejects a refresh token signed with a different HMAC algorithm using the same secret', async () => {
    const { user } = await createTestUser();

    const wrongAlgToken = jwt.sign(
      { _id: user._id },
      process.env.REFRESH_TOKEN_SECRET,
      { algorithm: 'HS512', expiresIn: '7d' }
    );

    // Stored as this user's current refresh token so the only thing standing
    // between this request and a successful refresh is jwt.verify's own
    // algorithm check — isolates that check from the separate
    // incomingRefreshToken !== user.refreshToken guard right below it.
    user.refreshToken = wrongAlgToken;
    await user.save({ validateBeforeSave: false });

    const res = await request(app)
      .get('/api/v1/user/refresh-token')
      .set('x-refresh-token', wrongAlgToken);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
  });
});
