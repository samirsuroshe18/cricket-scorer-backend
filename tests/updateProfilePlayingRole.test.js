import express from 'express';
import request from 'supertest';
import { sanitizeMiddleware } from '../src/middlewares/sanitize.middleware.js';
import { localeMiddleware } from '../src/middlewares/locale.middleware.js';
import { errorHandler } from '../src/utils/errorHandler.js';
import userRouter from '../src/routes/user.routes.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// playingRole/jerseyNumber are self-declared, on User rather than Player —
// see docs/api.md's update-profile section. Same reasoning and the same
// validation shape as updateProfileCricketStyle.test.js's battingStyle/
// bowlingStyle coverage: neither branch is reachable without an explicit
// pre-check, and a bare Mongoose enum/range mismatch would otherwise fall
// through errorHandler as a 500 rather than the documented 400s.
describe('POST /v1/user/update-profile — playingRole / jerseyNumber', () => {
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

  it('accepts and persists a valid playingRole and jerseyNumber', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'allrounder_7', playingRole: 'allrounder', jerseyNumber: 7 });

    expect(res.status).toBe(200);
    expect(res.body.data.playingRole).toBe('allrounder');
    expect(res.body.data.jerseyNumber).toBe(7);
  });

  it('rejects a playingRole outside the enum with 400 INVALID_PLAYER_ROLE', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'someone', playingRole: 'captain' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PLAYER_ROLE');
  });

  it('rejects a jerseyNumber outside 0-999 with 400 INVALID_JERSEY_NUMBER', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'someone', jerseyNumber: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JERSEY_NUMBER');
  });

  it('rejects a non-integer jerseyNumber with 400 INVALID_JERSEY_NUMBER', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'someone', jerseyNumber: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JERSEY_NUMBER');
  });

  it('leaves both fields unset when omitted, with no error', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'no_role_yet' });

    expect(res.status).toBe(200);
    expect(res.body.data.jerseyNumber).toBeUndefined();
  });

  it('does not clear a previously-set playingRole/jerseyNumber on a later update that omits them', async () => {
    const { token } = await createTestUser();

    await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'keeper_1', playingRole: 'wicketkeeper', jerseyNumber: 1 });

    const res = await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'keeper_1', bio: 'Now with a bio' });

    expect(res.status).toBe(200);
    expect(res.body.data.playingRole).toBe('wicketkeeper');
    expect(res.body.data.jerseyNumber).toBe(1);
  });
});
