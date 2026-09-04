import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';

// The computation itself (CareerStats increment, the delta/correction logic)
// is covered end-to-end in careerStatsIntegration.test.js. This file is
// scoped to what's specific to the READ endpoint: ownership, the
// no-matches-yet shape, and that average/strikeRate/economy — deliberately
// unstored on CareerStats — come back correctly computed rather than
// missing or wrong.
describe('GET /:playerId/career-stats', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withPlayer: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const getCareerStats = (token, playerId) =>
    request(app)
      .get(`/api/v1/player/${playerId}/career-stats`)
      .set('Authorization', `Bearer ${token}`);

  it('404s for a playerId that does not exist', async () => {
    const { token } = await createTestUser();
    const res = await getCareerStats(token, '665f3b1c2d3e4f5a6b7c8d90');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAYER_NOT_FOUND');
  });

  it("403s for a player that belongs to a different scorer's account", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const matchId = await createMatch(app, ownerToken, { totalOvers: 1 });
    await startLiveInnings(app, ownerToken, matchId, { strikerName: 'Rahul' });
    const rahul = await Player.findOne({ nameLower: 'rahul' });

    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const res = await getCareerStats(strangerToken, rahul._id.toString());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAYER_NOT_OWNED');
  });

  it('returns the all-zero shape, not an error, for a player who has never finished a match', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 1 });
    // Rahul opens the batting but the match never completes — no
    // CareerStats row exists for him yet.
    await startLiveInnings(app, token, matchId, { strikerName: 'Rahul' });
    const rahul = await Player.findOne({ nameLower: 'rahul' });

    const res = await getCareerStats(token, rahul._id.toString());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      playerId: rahul._id.toString(),
      playerName: 'Rahul',
      matchesPlayed: 0,
      batting: { inningsBatted: 0, runs: 0, average: null, strikeRate: 0, highScore: null },
      bowling: { inningsBowled: 0, runsConceded: 0, economy: 0, bestBowling: null },
    });
  });

  // Exact worked-example verification (the "50 runs, average 50" case) lives
  // in careerStatsIntegration.test.js, which already proves the STORED sums
  // land correctly. This test is scoped to a narrower claim: that the READ
  // endpoint's average/strikeRate/economy — deliberately not stored fields —
  // are actually wired to the same formulas, by checking the returned rate
  // against the returned sums directly, whatever the exact numbers are.
  it('computes average/strikeRate/economy at read time from the stored sums', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 1 });

    await startLiveInnings(app, token, matchId, {
      strikerName: 'Rahul',
      nonStrikerName: 'Ravi',
      bowlerName: 'BowlerB1',
    });
    // All even runs: Rahul stays on strike for every ball, so his own
    // contribution is exactly this sequence — 4 runs x 5 balls, then
    // dismissed for 0 on ball 6, completing the (one-over) innings.
    for (let i = 0; i < 5; i += 1) {
      const res = await scoreDotBall(app, token, matchId, { runs: 4 });
      expect(res.status).toBe(200);
    }
    const wicketRes = await scoreDotBall(app, token, matchId, {
      runs: 0,
      wicketType: 'bowled',
      dismissedBatsman: 'striker',
      incomingBatsmanName: 'NewBatsman',
    });
    expect(wicketRes.status).toBe(200);

    await startLiveInnings(app, token, matchId, {
      strikerName: 'Someone',
      nonStrikerName: 'SomeoneElse',
      bowlerName: 'Rahul',
    });
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId, { runs: 1 });
      expect(res.status).toBe(200);
    }

    const rahul = await Player.findOne({ nameLower: 'rahul' });
    const res = await getCareerStats(token, rahul._id.toString());

    expect(res.status).toBe(200);
    const { batting, bowling } = res.body.data;

    expect(batting.runs).toBe(20);
    expect(batting.ballsFaced).toBe(6);
    expect(batting.timesOut).toBe(1);
    expect(batting.average).toBeCloseTo(20 / 1, 2);
    expect(batting.strikeRate).toBeCloseTo((20 / 6) * 100, 2);

    expect(bowling.runsConceded).toBe(6);
    expect(bowling.legalDeliveries).toBe(6);
    expect(bowling.economy).toBeCloseTo(6 / (6 / 6), 2);
  });
});
