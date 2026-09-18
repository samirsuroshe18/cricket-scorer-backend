import express from 'express';
import request from 'supertest';
import { sanitizeMiddleware } from '../src/middlewares/sanitize.middleware.js';
import { localeMiddleware } from '../src/middlewares/locale.middleware.js';
import { errorHandler } from '../src/utils/errorHandler.js';
import userRouter from '../src/routes/user.routes.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { CareerStats } from '../src/models/careerStats.model.js';

// Player is scorer-scoped; the only bridge to an account is
// Player.linkedUserId (the claim flow). This endpoint is what lets Home show
// "my" numbers without knowing any Player id up front.
describe('GET /v1/user/me/career-stats', () => {
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

  const getMine = (token) =>
    request(app).get('/api/v1/user/me/career-stats').set('Authorization', `Bearer ${token}`);

  const makePlayer = (createdBy, name, extra = {}) =>
    Player.create({ name, nameLower: name.toLowerCase(), createdBy, ...extra });

  const makeStats = (playerId, totals) => CareerStats.create({ playerId, ...totals });

  it('401s without a token', async () => {
    const res = await request(app).get('/api/v1/user/me/career-stats');

    expect(res.status).toBe(401);
  });

  it('returns all zeros and linkedPlayerCount 0 when nothing is linked', async () => {
    const { token } = await createTestUser();

    const res = await getMine(token);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ linkedPlayerCount: 0, matchesPlayed: 0, runs: 0, wickets: 0 });
  });

  it("returns a single linked player's totals", async () => {
    const { user, token } = await createTestUser();
    const { user: scorer } = await createTestUser();
    const rahul = await makePlayer(scorer._id, 'Rahul', { linkedUserId: user._id });
    await makeStats(rahul._id, { matchesPlayed: 5, runs: 210, wickets: 3 });

    const res = await getMine(token);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ linkedPlayerCount: 1, matchesPlayed: 5, runs: 210, wickets: 3 });
  });

  it('sums across every linked player', async () => {
    const { user, token } = await createTestUser();
    const { user: scorerA } = await createTestUser();
    const { user: scorerB } = await createTestUser();
    const a = await makePlayer(scorerA._id, 'Rahul', { linkedUserId: user._id });
    const b = await makePlayer(scorerB._id, 'Rahul', { linkedUserId: user._id });
    await makeStats(a._id, { matchesPlayed: 5, runs: 210, wickets: 3 });
    await makeStats(b._id, { matchesPlayed: 2, runs: 40, wickets: 4 });

    const res = await getMine(token);

    expect(res.body.data).toEqual({ linkedPlayerCount: 2, matchesPlayed: 7, runs: 250, wickets: 7 });
  });

  it("excludes other users' linked players, unlinked players, and soft-deleted players", async () => {
    const { user, token } = await createTestUser();
    const { user: other } = await createTestUser();
    const { user: scorer } = await createTestUser();
    const mine = await makePlayer(scorer._id, 'Mine', { linkedUserId: user._id });
    const theirs = await makePlayer(scorer._id, 'Theirs', { linkedUserId: other._id });
    const unlinked = await makePlayer(scorer._id, 'Unlinked');
    const deleted = await makePlayer(scorer._id, 'Deleted', { linkedUserId: user._id, isDeleted: true });
    await makeStats(mine._id, { matchesPlayed: 1, runs: 10, wickets: 1 });
    await makeStats(theirs._id, { matchesPlayed: 9, runs: 900, wickets: 9 });
    await makeStats(unlinked._id, { matchesPlayed: 9, runs: 900, wickets: 9 });
    await makeStats(deleted._id, { matchesPlayed: 9, runs: 900, wickets: 9 });

    const res = await getMine(token);

    expect(res.body.data).toEqual({ linkedPlayerCount: 1, matchesPlayed: 1, runs: 10, wickets: 1 });
  });

  it('counts a linked player with no CareerStats row but adds nothing to the totals', async () => {
    const { user, token } = await createTestUser();
    const { user: scorer } = await createTestUser();
    await makePlayer(scorer._id, 'Fresh', { linkedUserId: user._id });

    const res = await getMine(token);

    expect(res.body.data).toEqual({ linkedPlayerCount: 1, matchesPlayed: 0, runs: 0, wickets: 0 });
  });
});
