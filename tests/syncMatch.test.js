import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Inning } from '../src/models/inning.model.js';
import { Match } from '../src/models/match.model.js';

// Closes the same coverage gap as scoringFlow.test.js, for the one endpoint
// with no analogue in the online scoring flow at all: the offline-catch-up
// batch contract documented in docs/api.md's "The conflict check" section.
describe('POST /:matchId/sync', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withOrganization: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const ballEvent = (overrides = {}) => ({
    type: 'ball',
    runs: 0,
    idempotencyKey: randomUUID(),
    ...overrides,
  });

  const sync = (token, matchId, body) =>
    request(app)
      .post(`/api/v1/match/${matchId}/sync`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('applies a clean batch of ball events in order', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    const res = await sync(token, matchId, {
      inningsNumber: 1,
      baseAbsoluteBallSeq: 0,
      events: [
        ballEvent({ runs: 1 }),
        ballEvent({ runs: 4 }),
        ballEvent({ runs: 0 }),
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.appliedCount).toBe(3);
    expect(res.body.data.absoluteBallSeq).toBe(3);

    const inning = await Inning.findOne({ matchId });
    expect(inning.totalBalls).toBe(3);
    expect(inning.totalRuns).toBe(5);
  });

  it('recognises a resume after a lost response and does not double-apply the balls the server already has', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    // The server already has two balls the client scored online, keyed by
    // the idempotencyKeys it used at the time.
    const key1 = randomUUID();
    const key2 = randomUUID();
    await scoreDotBall(app, token, matchId, { runs: 1, idempotencyKey: key1 });
    await scoreDotBall(app, token, matchId, { runs: 2, idempotencyKey: key2 });

    // The client's own response to those two calls never arrived (dropped
    // connection), so it still believes baseAbsoluteBallSeq is 0 and resends
    // everything, including a genuinely new third ball.
    const key3 = randomUUID();
    const res = await sync(token, matchId, {
      inningsNumber: 1,
      baseAbsoluteBallSeq: 0,
      events: [
        ballEvent({ runs: 1, idempotencyKey: key1 }),
        ballEvent({ runs: 2, idempotencyKey: key2 }),
        ballEvent({ runs: 6, idempotencyKey: key3 }),
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.skippedCount).toBe(2);
    expect(res.body.data.appliedCount).toBe(1);

    const inning = await Inning.findOne({ matchId });
    expect(inning.totalBalls).toBe(3);
    expect(inning.totalRuns).toBe(9);

    const match = await Match.findById(matchId);
    expect(match.syncStatus).not.toBe('conflict');
  });

  it('rejects a genuine conflict with 409 SYNC_CONFLICT and marks the match syncStatus accordingly', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    await scoreDotBall(app, token, matchId, { runs: 1 });
    await scoreDotBall(app, token, matchId, { runs: 1 });

    // The client claims to be five balls ahead of a server that has only
    // two — this can never be a lost-response resume, only a genuine
    // conflict (per resolveSyncDecision's `ahead < 0` branch).
    const res = await sync(token, matchId, {
      inningsNumber: 1,
      baseAbsoluteBallSeq: 5,
      events: [ballEvent()],
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYNC_CONFLICT');

    const match = await Match.findById(matchId);
    expect(match.syncStatus).toBe('conflict');

    // Nothing from the rejected batch was written.
    const inning = await Inning.findOne({ matchId });
    expect(inning.totalBalls).toBe(2);
  });

  it('applies the valid prefix of a batch and reports failedAt/failedCode for the event that stopped it, rather than rejecting the whole batch', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    const res = await sync(token, matchId, {
      inningsNumber: 1,
      baseAbsoluteBallSeq: 0,
      events: [
        ballEvent({ runs: 4 }),
        // Out of range (0-6) — an individually-invalid event, not a
        // structurally-invalid request, so it stops the batch here rather
        // than rejecting the first (valid) ball too.
        ballEvent({ runs: 9 }),
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.appliedCount).toBe(1);
    expect(res.body.data.failedAt).toBe(1);
    expect(res.body.data.failedCode).toBe('RUNS_OUT_OF_RANGE');

    const inning = await Inning.findOne({ matchId });
    expect(inning.totalBalls).toBe(1);
    expect(inning.totalRuns).toBe(4);
  });

  it('rejects with MATCH_NOT_OWNED for a different user', async () => {
    const { token: ownerToken } = await createTestUser();
    const { token: otherToken } = await createTestUser();
    const matchId = await createMatch(app, ownerToken);
    await startLiveInnings(app, ownerToken, matchId);

    const res = await sync(otherToken, matchId, {
      inningsNumber: 1,
      baseAbsoluteBallSeq: 0,
      events: [ballEvent()],
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });

  it('lets the assigned scorer sync a batch', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: 'scorer@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });
    await startLiveInnings(app, ownerToken, matchId);

    const res = await sync(scorerToken, matchId, {
      inningsNumber: 1,
      baseAbsoluteBallSeq: 0,
      events: [ballEvent({ runs: 1 })],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.appliedCount).toBe(1);
  });

  it('still rejects a plain org member who is not the assigned scorer', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner2@example.com' });
    const { token: memberToken, user: member } = await createTestUser({ email: 'member2@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org 2' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: member.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team 2' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await startLiveInnings(app, ownerToken, matchId);

    const res = await sync(memberToken, matchId, {
      inningsNumber: 1,
      baseAbsoluteBallSeq: 0,
      events: [ballEvent({ runs: 1 })],
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });

  it('rejects with MATCH_NOT_FOUND for an unknown matchId', async () => {
    const { token } = await createTestUser();

    const res = await sync(token, '000000000000000000000000', {
      inningsNumber: 1,
      baseAbsoluteBallSeq: 0,
      events: [ballEvent()],
    });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MATCH_NOT_FOUND');
  });
});
