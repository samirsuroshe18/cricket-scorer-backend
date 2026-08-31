import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { MongoServerError } from 'mongodb';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';
import { Inning } from '../src/models/inning.model.js';
import { Player } from '../src/models/player.model.js';
import { Over } from '../src/models/over.model.js';

// `session.withTransaction` auto-retries its callback whole when a write
// inside it throws a `TransientTransactionError` (a WriteConflict, plausible
// under real concurrent scoring on the shared Inning document). The DB side
// of a failed attempt is rolled back, but a plain JS mutation on a `match`
// document captured OUTSIDE the transaction is not — so a retry that reuses
// that same, already-mutated object runs with state no attempt ever actually
// committed. These tests force exactly one such retry, deterministically, by
// making a single `.save()` call fail once with a labelled transient error.
const transientConflict = () => {
  const err = new MongoServerError({ message: 'WriteConflict', code: 112, codeName: 'WriteConflict' });
  err.addErrorLabel('TransientTransactionError');
  return err;
};

describe('transaction retries do not reuse a mutated in-memory Match document', () => {
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

  it('the ball that completes innings 1 still succeeds, and correctly opens innings 2 in the DB, after a WriteConflict retry', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 1 });
    await startLiveInnings(app, token, matchId);

    // Balls 1-5: ordinary, no injected failure.
    for (let i = 0; i < 5; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
    }

    // Ball 6 completes the over and, with totalOvers: 1, innings 1 itself —
    // applyDelivery mutates `match.currentInnings` to 2 and `match.status` to
    // 'innings_break' in memory, then hits this forced conflict on the
    // inning's own save, which is still inside the same (about-to-be-aborted)
    // transaction attempt.
    jest.spyOn(Inning.prototype, 'save').mockImplementationOnce(async () => {
      throw transientConflict();
    });

    const res = await scoreDotBall(app, token, matchId);

    // Before the fix: the retry re-queries `Inning.findOne({ inningsNumber:
    // match.currentInnings })` against the now-stale-in-memory `2`, finds
    // nothing (innings 2 isn't opened until a later start-innings call), and
    // this perfectly legal delivery fails with 400 INNINGS_NOT_STARTED.
    expect(res.status).toBe(200);
    expect(res.body.data.inningsComplete).toBe(true);

    const match = await Match.findById(matchId);
    expect(match.currentInnings).toBe(2);
    expect(match.status).toBe('innings_break');

    const inning1 = await Inning.findOne({ matchId, inningsNumber: 1 });
    expect(inning1.status).toBe('completed');
    expect(inning1.totalBalls).toBe(6);
  });

  it('start-innings still persists Match.status after a retry, even though the in-memory flip already happened on the failed attempt', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);

    // `match.status` flips to 'live' in memory the first time through, then
    // the transaction's own commit — the only remaining write — is forced to
    // fail once as transient. A retry that trusted the in-memory flip would
    // see `status` already 'live' and skip writing it out at all.
    jest.spyOn(Match.prototype, 'save').mockImplementationOnce(async () => {
      throw transientConflict();
    });

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/start-innings`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        strikerName: 'Striker',
        nonStrikerName: 'Non-Striker',
        bowlerName: 'Bowler One',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.inningsId).toBeTruthy();

    const match = await Match.findById(matchId);
    expect(match.status).toBe('live');
  });

  it('a sync batch\'s new-bowler event survives a retry instead of hitting BOWLER_NAME_ALREADY_EXISTS for its own earlier attempt', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    // Complete over 1 online so a bowler is owed for over 2.
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
    }

    // The batch's own bowler event runs resolveBowler's non-session
    // `Player.create()` first; forcing the conflict on the BALL event's
    // `inning.save()` — which always runs after it in this batch's order —
    // is what reproduces a retry that re-submits the same bowler event.
    jest.spyOn(Inning.prototype, 'save').mockImplementationOnce(async () => {
      throw transientConflict();
    });

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/sync`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        inningsNumber: 1,
        baseAbsoluteBallSeq: 6,
        events: [
          { type: 'bowler', bowlerName: 'New Bowler' },
          { type: 'ball', runs: 0, idempotencyKey: randomUUID() },
        ],
      });

    // Before the fix: the retry re-runs resolveBowler for the same event,
    // Player.create() hits the unique index against the first (uncommitted-
    // transaction-but-already-persisted) attempt's own document, and this
    // perfectly legitimate new bowler is rejected as a duplicate.
    expect(res.status).toBe(200);
    expect(res.body.data.failedAt).toBeNull();
    expect(res.body.data.appliedCount).toBe(2);

    const players = await Player.find({ name: 'New Bowler' });
    expect(players).toHaveLength(1);

    const inning = await Inning.findOne({ matchId, inningsNumber: 1 });
    expect(String(inning.currentBowlerId)).toBe(String(players[0]._id));
  });

  it('the first ball of a new over survives a concurrent-create race on Over instead of a raw 500', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 2 });
    await startLiveInnings(app, token, matchId);

    // Complete over 1 so over 2 has no Over document yet — exactly the
    // state two concurrent deliveries would both see nothing for.
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
    }

    // A new bowler is owed before over 2 can start at all.
    const bowlerRes = await request(app)
      .post(`/api/v1/match/${matchId}/select-bowler`)
      .set('Authorization', `Bearer ${token}`)
      .send({ bowlerName: 'Bowler Two' });
    expect(bowlerRes.status).toBe(200);

    // Simulates the loser of a real race: another concurrent delivery's
    // Over.create() already won the unique {inningsId, overNumber} index by
    // the time this one's insert runs. This is a genuine duplicate-key
    // error, not a WriteConflict, so withTransaction would not retry it on
    // its own — the fix has to relabel it itself.
    const overIndexCollision = new MongoServerError({
      message: 'E11000 duplicate key error collection: cricketdb.overs index: inningsId_1_overNumber_1',
      code: 11000,
    });
    overIndexCollision.keyPattern = { inningsId: 1, overNumber: 1 };
    jest.spyOn(Over, 'create').mockImplementationOnce(async () => {
      throw overIndexCollision;
    });

    const res = await scoreDotBall(app, token, matchId);

    // Before the fix: this raw duplicate-key error propagated straight out
    // of applyDelivery — respondWithExistingBall's idempotency fallback in
    // scoreBall's catch block can't help, since this ball's own BallEvent
    // was never created (the failure happened one step earlier, at Over).
    expect(res.status).toBe(200);
    expect(res.body.data.overNumber).toBe(2);

    const over2 = await Over.findOne({ matchId, overNumber: 2 });
    expect(over2.legalDeliveries).toBe(1);
  });

  it('the loser of a concurrent start-innings race gets a clean INNINGS_ALREADY_STARTED, not a raw 500', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);

    // Simulates the loser of two concurrent start-innings calls for the same
    // match: another request's Inning.create() already won the unique
    // {matchId, inningsNumber} index by the time this one's insert runs.
    const inningIndexCollision = new MongoServerError({
      message: 'E11000 duplicate key error collection: cricketdb.innings index: matchId_1_inningsNumber_1',
      code: 11000,
    });
    inningIndexCollision.keyPattern = { matchId: 1, inningsNumber: 1 };
    jest.spyOn(Inning, 'create').mockImplementationOnce(async () => {
      throw inningIndexCollision;
    });

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/start-innings`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        strikerName: 'Striker',
        nonStrikerName: 'Non-Striker',
        bowlerName: 'Bowler One',
      });

    // Before the fix: no catch around the transaction at all, so this raw
    // duplicate-key error surfaced as a generic 500 instead of the specific,
    // already-existing INNINGS_ALREADY_STARTED the ordinary
    // "existing.totalBalls > 0" check above already uses for the same
    // situation, just caught a moment earlier.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INNINGS_ALREADY_STARTED');
  });
});
