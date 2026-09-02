import { jest } from '@jest/globals';
import request from 'supertest';
import { createTestUser } from './helpers/authTestUser.js';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';
import { BallEvent } from '../src/models/ballEvent.model.js';

// scoreBall/undoBall/syncMatch each check match.status/isDeleted exactly
// once, via a plain read *before* opening their transaction — the same
// TOCTOU shape matchAbandonDelete.test.js already covers for abandonMatch
// and deleteMatch, just in the other direction. Those two were given a
// compare-and-swap so a completing scoreBall can't be silently reverted by a
// concurrent abandon. Nothing equivalent guards scoreBall/undoBall against a
// concurrent abandon/delete landing in the window between their own
// pre-check and their transaction's session-scoped re-fetch of `match` —
// so a ball can still be scored into (or undone out of) a match that is, by
// the time the transaction actually runs, abandoned or soft-deleted.
describe('scoring vs. a concurrent abandon/delete', () => {
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

  it('does not score a ball into a match a concurrent abandon completed in the window before the transaction', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    const originalFindOne = Match.findOne.bind(Match);
    jest.spyOn(Match, 'findOne').mockImplementationOnce(async (...args) => {
      const doc = await originalFindOne(...args);
      // Simulates a concurrent abandonMatch committing between scoreBall's
      // pre-check read and its transaction's own re-fetch of `match`.
      await Match.updateOne({ _id: matchId }, { $set: { status: 'abandoned', completedAt: new Date() } });
      return doc;
    });

    const res = await scoreDotBall(app, token, matchId, { runs: 4 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MATCH_ALREADY_COMPLETED');

    const balls = await BallEvent.find({ matchId });
    expect(balls).toHaveLength(0);

    const stored = await Match.findById(matchId);
    expect(stored.status).toBe('abandoned');
  });

  it('does not score a ball into a match a concurrent delete removed in the window before the transaction', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    const originalFindOne = Match.findOne.bind(Match);
    jest.spyOn(Match, 'findOne').mockImplementationOnce(async (...args) => {
      const doc = await originalFindOne(...args);
      // Simulates a concurrent deleteMatch committing between scoreBall's
      // pre-check read and its transaction's own re-fetch of `match`.
      await Match.updateOne({ _id: matchId }, { $set: { isDeleted: true } });
      return doc;
    });

    const res = await scoreDotBall(app, token, matchId, { runs: 4 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MATCH_NOT_FOUND');

    const balls = await BallEvent.find({ matchId });
    expect(balls).toHaveLength(0);
  });

  it('does not undo a ball out of a match a concurrent delete removed in the window before the transaction', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);
    const scoreRes = await scoreDotBall(app, token, matchId, { runs: 4 });
    const ballEventId = scoreRes.body.data.ballEventId;

    const originalFindOne = Match.findOne.bind(Match);
    jest.spyOn(Match, 'findOne').mockImplementationOnce(async (...args) => {
      const doc = await originalFindOne(...args);
      // Simulates a concurrent deleteMatch committing between undoBall's
      // pre-check read and its transaction's own re-fetch of `match`.
      await Match.updateOne({ _id: matchId }, { $set: { isDeleted: true } });
      return doc;
    });

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/undo-ball`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ballEventId });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MATCH_NOT_FOUND');

    const stored = await BallEvent.findById(ballEventId);
    expect(stored).not.toBeNull();
  });
});
