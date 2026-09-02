import { jest } from '@jest/globals';
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { BallEvent } from '../src/models/ballEvent.model.js';
import { currentPartnership } from '../src/utils/scorecard.js';

// A client joining or resuming a match mid-innings has no ball history of its
// own to compute "runs since the last wicket" from, so it used to seed the
// partnership checkpoint from whatever the totals happened to be at that
// moment — reading as 0(0) regardless of how far the actual partnership had
// actually gotten. `buildInningsState` (shared by the socket join ack and
// this public fetch) now reports the real figure, computed from the innings'
// own ball history, so a resumed session can seed correctly instead of
// guessing "the connection moment is the start of a new partnership".
describe('the public match fetch reports the current partnership, not just raw totals', () => {
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

  it('reports runs/balls since the last wicket, not since the innings began', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 5 });
    await startLiveInnings(app, token, matchId);

    // Openers' partnership: 7 runs off 2 balls.
    expect((await scoreDotBall(app, token, matchId, { runs: 4 })).status).toBe(200);
    expect((await scoreDotBall(app, token, matchId, { runs: 3 })).status).toBe(200);

    // A wicket ends it — total is now 7/1. A new pair starts.
    const wicketRes = await scoreDotBall(app, token, matchId, {
      runs: 0,
      wicketType: 'bowled',
      dismissedBatsman: 'striker',
      incomingBatsmanName: 'New Batsman',
    });
    expect(wicketRes.status).toBe(200);

    // The new pair adds 5 more runs off 2 balls: total is now 12/1.
    expect((await scoreDotBall(app, token, matchId, { runs: 2 })).status).toBe(200);
    expect((await scoreDotBall(app, token, matchId, { runs: 3 })).status).toBe(200);

    const res = await request(app).get(`/api/v1/match/public/${matchId}`);
    expect(res.status).toBe(200);

    const innings = res.body.data.innings;
    expect(innings.totalRuns).toBe(12);
    expect(innings.wickets).toBe(1);
    // Would be 12 (the whole innings) if this just echoed totalRuns.
    expect(innings.partnershipRuns).toBe(5);
    expect(innings.partnershipBalls).toBe(2);
  });

  it('reports the whole innings so far when no wicket has fallen yet', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 5 });
    await startLiveInnings(app, token, matchId);

    expect((await scoreDotBall(app, token, matchId, { runs: 1 })).status).toBe(200);
    expect((await scoreDotBall(app, token, matchId, { runs: 6 })).status).toBe(200);
    expect((await scoreDotBall(app, token, matchId, { runs: 0 })).status).toBe(200);

    const res = await request(app).get(`/api/v1/match/public/${matchId}`);
    expect(res.status).toBe(200);

    const innings = res.body.data.innings;
    expect(innings.partnershipRuns).toBe(7);
    expect(innings.partnershipBalls).toBe(3);
  });

  // Previously two separate round trips (a findOne for the last wicket, then
  // an aggregate for everything after it) — a concurrent scoreBall
  // transaction committing a NEW wicket in the gap between them left
  // `sinceSeq` stale, so the aggregate's `$gt: sinceSeq` filter still
  // included the just-committed wicket ball itself, blending the
  // just-finished partnership's stats with the brand new (should read 0/0)
  // one. Reproduced here the same way the abandon/delete TOCTOU races are:
  // hooking the first of the two calls to commit the concurrent write
  // before the second one runs.
  it('does not blend a concurrently-committed wicket into the wrong partnership', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 5 });
    const { inningsId } = await startLiveInnings(app, token, matchId);

    // Openers' partnership: 7 runs off 2 balls, no wicket yet.
    expect((await scoreDotBall(app, token, matchId, { runs: 4 })).status).toBe(200);
    expect((await scoreDotBall(app, token, matchId, { runs: 3 })).status).toBe(200);

    const originalFindOne = BallEvent.findOne.bind(BallEvent);
    const findOneSpy = jest
      .spyOn(BallEvent, 'findOne')
      .mockImplementationOnce((...args) => {
        // Simulates a concurrent scoreBall transaction committing a
        // wicket-ending delivery in the window between currentPartnership's
        // two separate reads. Returns a chainable stand-in (rather than a
        // plain Promise) since the real call site chains .sort().select()
        // onto this — the injection runs once that chain actually resolves.
        const resultPromise = originalFindOne(...args)
          .sort({ absoluteBallSeq: -1 })
          .select('absoluteBallSeq')
          .then(async (doc) => {
            const wicketRes = await scoreDotBall(app, token, matchId, {
              runs: 0,
              wicketType: 'bowled',
              dismissedBatsman: 'striker',
              incomingBatsmanName: 'New Batsman',
            });
            expect(wicketRes.status).toBe(200);
            return doc;
          });

        return { sort: () => ({ select: () => resultPromise }) };
      });

    const result = await currentPartnership(inningsId);
    findOneSpy.mockRestore();

    expect(result).not.toEqual({ partnershipRuns: 7, partnershipBalls: 3 });
    expect([
      { partnershipRuns: 7, partnershipBalls: 2 },
      { partnershipRuns: 0, partnershipBalls: 0 },
    ]).toContainEqual(result);
  });
});
