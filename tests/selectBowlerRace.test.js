import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Inning } from '../src/models/inning.model.js';
import { Player } from '../src/models/player.model.js';

// applyBowlerSelection used to persist with a plain, unconditional
// `inning.save({session: null})` — two near-simultaneous selectBowler calls
// for the same not-yet-started over could both pass validation off the same
// stale read, and whichever save landed last silently won: BOTH callers got
// a 200 with their own choice echoed back, even though only one was actually
// true in the database.
describe('selectBowler under a concurrent race', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('lets exactly one of two concurrent bowler selections for the same over win', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    const { inningsId } = await startLiveInnings(app, token, matchId, {
      bowlerName: 'Opener',
    });

    // Complete over 1 so a bowler must be chosen again for over 2.
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
    }

    const selectBowler = (bowlerName) =>
      request(app)
        .post(`/api/v1/match/${matchId}/select-bowler`)
        .set('Authorization', `Bearer ${token}`)
        .send({ bowlerName });

    const [resA, resB] = await Promise.all([
      selectBowler('Bowler Two'),
      selectBowler('Bowler Three'),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = resA.status === 200 ? resA : resB;
    expect(winner.body.data.bowler.bowlerName).toMatch(/^Bowler (Two|Three)$/);

    const loser = resA.status === 200 ? resB : resA;
    expect(loser.body.code).toBe('BOWLER_SELECTION_CONFLICT');

    const inning = await Inning.findById(inningsId);
    const winningBowler = await Player.findOne({ name: winner.body.data.bowler.bowlerName });
    expect(String(inning.currentBowlerId)).toBe(String(winningBowler._id));
  });
});
