import express from 'express';
import request from 'supertest';
import { sanitizeMiddleware } from '../src/middlewares/sanitize.middleware.js';
import { localeMiddleware } from '../src/middlewares/locale.middleware.js';
import { errorHandler } from '../src/utils/errorHandler.js';
import userRouter from '../src/routes/user.routes.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// battingStyle/bowlingStyle are self-declared, on User rather than Player —
// see docs/api.md's update-profile section. Covers the two new validation
// branches update-profile grew: neither was reachable before, and a bare
// Mongoose enum mismatch would otherwise fall through errorHandler as a 500
// rather than the documented 400s (see the pre-check's own comment in
// user.controller.js).
describe('POST /v1/user/update-profile — battingStyle / bowlingStyle', () => {
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

  it('accepts and persists a valid battingStyle and bowlingStyle', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({
        userName: 'lefty_spinner',
        battingStyle: 'left_handed',
        bowlingStyle: 'right_arm_spin',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.battingStyle).toBe('left_handed');
    expect(res.body.data.bowlingStyle).toBe('right_arm_spin');
  });

  it('rejects a battingStyle outside the enum with 400 INVALID_BATTING_STYLE', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'someone', battingStyle: 'ambidextrous' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BATTING_STYLE');
  });

  it('rejects a bowlingStyle outside the enum with 400 INVALID_BOWLING_STYLE', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'someone', bowlingStyle: 'off_break' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BOWLING_STYLE');
  });

  it('leaves both fields unset when omitted, with no error', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'batsman_only' });

    expect(res.status).toBe(200);
    expect(res.body.data.battingStyle).toBeUndefined();
    expect(res.body.data.bowlingStyle).toBeUndefined();
  });

  it('does not clear a previously-set style on a later update that omits it', async () => {
    const { token } = await createTestUser();

    await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'allrounder', battingStyle: 'right_handed', bowlingStyle: 'left_arm_pace' });

    const res = await request(app)
      .post('/api/v1/user/update-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userName: 'allrounder', bio: 'Now with a bio' });

    expect(res.status).toBe(200);
    expect(res.body.data.battingStyle).toBe('right_handed');
    expect(res.body.data.bowlingStyle).toBe('left_arm_pace');
  });
});
