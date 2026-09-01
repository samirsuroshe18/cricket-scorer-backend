import { jest } from '@jest/globals';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { BallEvent } from '../src/models/ballEvent.model.js';

// liveStrikeFigures used to re-fetch and re-reduce every delivery ever bowled
// in the innings on every single ball — most of it for players who aren't
// even the two now at the crease — making one ball O(n) and a full innings
// O(n²). It's now a targeted $group over just the current pair's own
// deliveries. These prove both halves: the numbers a scorer sees are still
// exactly right (credited to whoever was actually striking each ball,
// through rotations), and the mechanism genuinely changed — no more
// full-history fetch per ball.
describe('liveStrikeFigures reports correct per-batsman figures without a full-history scan', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('credits every run/ball to whoever was actually striking, correctly through strike rotations', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 5 });
    const innings = await startLiveInnings(app, token, matchId);

    let prevStrike = innings.strike;
    const expected = new Map([
      [String(prevStrike.strikerId), { runs: 0, balls: 0 }],
      [String(prevStrike.nonStrikerId), { runs: 0, balls: 0 }],
    ]);

    // A mix of odd (rotates) and even (doesn't) plain-bat deliveries — no
    // extras/wickets, so credit is unambiguous: BallEvent.runs === the runs
    // sent, isLegal is always true.
    const deliveries = [1, 4, 0, 3, 6, 2];

    for (const runs of deliveries) {
      const strikerLine = expected.get(String(prevStrike.strikerId));
      strikerLine.runs += runs;
      strikerLine.balls += 1;

      const res = await scoreDotBall(app, token, matchId, { runs });
      expect(res.status).toBe(200);

      const strike = res.body.data.strike;
      expect(strike.strikerRuns).toBe(expected.get(String(strike.strikerId)).runs);
      expect(strike.strikerBalls).toBe(expected.get(String(strike.strikerId)).balls);
      expect(strike.nonStrikerRuns).toBe(expected.get(String(strike.nonStrikerId)).runs);
      expect(strike.nonStrikerBalls).toBe(expected.get(String(strike.nonStrikerId)).balls);

      prevStrike = strike;
    }
  });

  it('does not fetch the innings full ball history to compute the strike pair', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 5 });
    await startLiveInnings(app, token, matchId);

    // A handful of balls to have real history to (not) re-fetch.
    for (let i = 0; i < 4; i += 1) {
      expect((await scoreDotBall(app, token, matchId, { runs: 1 })).status).toBe(200);
    }

    const findSpy = jest.spyOn(BallEvent, 'find');
    const aggregateSpy = jest.spyOn(BallEvent, 'aggregate');

    const res = await scoreDotBall(app, token, matchId, { runs: 2 });
    expect(res.status).toBe(200);

    // find({inningsId}) with no filter is what the old full-history fetch
    // looked like; every call this ball makes should be scoped, never a bare
    // innings-wide pull.
    for (const call of findSpy.mock.calls) {
      const filter = call[0] ?? {};
      expect(Object.keys(filter)).not.toEqual(['inningsId']);
    }
    expect(aggregateSpy).toHaveBeenCalled();
  });
});
