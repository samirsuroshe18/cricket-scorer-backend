import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';
import { Inning } from '../src/models/inning.model.js';

// Undo restores Inning/Over from a ball's own preEventState, but never used
// to touch Match at all — so the two deliveries that most need undoing
// (the one that ends an innings, the one that ends the match) were either
// unreachable (INNINGS_NOT_STARTED, since currentInnings had already moved
// on with no Inning document behind it yet) or flatly refused
// (MATCH_ALREADY_COMPLETED). These tests exercise both, plus the sync
// endpoint's own copy of the same innings-scoping problem.
describe('undo across an innings/match boundary', () => {
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

  const undoBall = (token, matchId, ballEventId) =>
    request(app)
      .post(`/api/v1/match/${matchId}/undo-ball`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ballEventId });

  it('undoes the ball that completed innings 1, reopening it and reversing the transition to innings 2', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 1 });
    await startLiveInnings(app, token, matchId);

    let lastBallId;
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
      lastBallId = res.body.data.ballEventId;
    }

    const beforeUndo = await Match.findById(matchId);
    expect(beforeUndo.currentInnings).toBe(2);
    expect(beforeUndo.status).toBe('innings_break');

    const res = await undoBall(token, matchId, lastBallId);

    expect(res.status).toBe(200);
    expect(res.body.data.inningsNumber).toBe(1);
    expect(res.body.data.inningsReopened).toBe(true);

    const match = await Match.findById(matchId);
    expect(match.currentInnings).toBe(1);
    expect(match.status).toBe('live');

    const inning1 = await Inning.findOne({ matchId, inningsNumber: 1 });
    expect(inning1.status).toBe('in_progress');
    expect(inning1.totalBalls).toBe(5);
  });

  it('undoes the ball that completed the match, reversing status/result/completedAt', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 1 });
    await startLiveInnings(app, token, matchId);

    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
    }

    await startLiveInnings(app, token, matchId, {
      strikerName: 'New Striker',
      nonStrikerName: 'New Non-Striker',
      bowlerName: 'New Bowler',
    });

    let lastBallId;
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
      lastBallId = res.body.data.ballEventId;
    }

    const completed = await Match.findById(matchId);
    expect(completed.status).toBe('completed');
    expect(completed.result).toBeTruthy();
    expect(completed.completedAt).toBeTruthy();

    const res = await undoBall(token, matchId, lastBallId);

    // Before the fix: blocked outright by the top-of-function
    // MATCH_ALREADY_COMPLETED guard, before ever reaching applyUndo.
    expect(res.status).toBe(200);
    expect(res.body.data.matchReopened).toBe(true);

    const match = await Match.findById(matchId);
    expect(match.status).toBe('live');
    expect(match.result).toBeFalsy();
    expect(match.completedAt).toBeFalsy();
  });

  it('sync accepts an undo batch naming the innings that just completed, one behind match.currentInnings', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 1 });
    await startLiveInnings(app, token, matchId);

    let lastBallId;
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
      lastBallId = res.body.data.ballEventId;
    }

    expect((await Match.findById(matchId)).currentInnings).toBe(2);

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/sync`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        inningsNumber: 1,
        baseAbsoluteBallSeq: 6,
        events: [{ type: 'undo', ballEventId: lastBallId }],
      });

    // Before the fix: rejected as SYNC_INNINGS_MISMATCH, since
    // inningsNumber (1) !== match.currentInnings (2).
    expect(res.status).toBe(200);
    expect(res.body.data.inningsNumber).toBe(1);

    const match = await Match.findById(matchId);
    expect(match.currentInnings).toBe(1);
    expect(match.status).toBe('live');
  });
});
