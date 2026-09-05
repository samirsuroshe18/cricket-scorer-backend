import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Inning } from '../src/models/inning.model.js';

// Closes the gap the 2026-08-29 Phase 1 review found: only the pure
// `resolveX` helpers (resolveDelivery, resolveStrike, resolveOver, ...) had
// any test coverage. The orchestration in match.controller.js that wires
// them together — transactions, ownership checks, idempotency, response
// shaping — had never been exercised end-to-end. These tests do that for
// startInnings/selectBowler/scoreBall/undoBall.
describe('scoring flow', () => {
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

  // Every widened-check test in this file needs the same shape: an
  // org-owned teamA, an owner (the creator), a plain member, an assigned
  // scorer (also a plain member until assigned), and a stranger.
  const setupDelegatedMatch = async (overrides = {}) => {
    const { token: ownerToken, user: owner } = await createTestUser({ email: `owner-${randomUUID()}@example.com` });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: `scorer-${randomUUID()}@example.com` });
    const { token: memberToken, user: member } = await createTestUser({ email: `member-${randomUUID()}@example.com` });
    const { token: strangerToken } = await createTestUser({ email: `stranger-${randomUUID()}@example.com` });

    const orgRes = await request(app)
      .post('/api/v1/organization')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: `Org ${randomUUID()}` });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: member.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team' });
    const teamId = teamRes.body.data.id;

    const matchId = await createMatch(app, ownerToken, { teamAId: teamId, teamBName: 'Visitors', ...overrides });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });

    return { ownerToken, memberToken, scorerToken, strangerToken, matchId };
  };

  describe('POST /:matchId/start-innings', () => {
    it('creates the Inning document with the named openers and bowler', async () => {
      const { token } = await createTestUser();
      const matchId = await createMatch(app, token);

      const data = await startLiveInnings(app, token, matchId);

      expect(data.strike.strikerName).toBe('Striker');
      expect(data.strike.nonStrikerName).toBe('Non-Striker');
      expect(data.bowler.bowlerName).toBe('Bowler One');

      const inning = await Inning.findOne({ matchId, inningsNumber: 1 });
      expect(inning).not.toBeNull();
      expect(inning.strikerName).toBe('Striker');
      expect(inning.currentBowlerId).not.toBeNull();
    });

    it('rejects when striker and non-striker names are the same', async () => {
      const { token } = await createTestUser();
      const matchId = await createMatch(app, token);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/start-innings`)
        .set('Authorization', `Bearer ${token}`)
        .send({ strikerName: 'Same Name', nonStrikerName: 'same name', bowlerName: 'Bowler' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OPENER_NAMES_MUST_DIFFER');
    });

    it('rejects starting an innings that already has a ball scored', async () => {
      const { token } = await createTestUser();
      const matchId = await createMatch(app, token);
      await startLiveInnings(app, token, matchId);
      await scoreDotBall(app, token, matchId);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/start-innings`)
        .set('Authorization', `Bearer ${token}`)
        .send({ strikerName: 'New', nonStrikerName: 'Names', bowlerName: 'Bowler' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INNINGS_ALREADY_STARTED');
    });

    it('rejects with MATCH_NOT_OWNED for a different user', async () => {
      const { token: ownerToken } = await createTestUser();
      const { token: otherToken } = await createTestUser();
      const matchId = await createMatch(app, ownerToken);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/start-innings`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ strikerName: 'A', nonStrikerName: 'B', bowlerName: 'C' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });

    it('lets the assigned scorer start the innings', async () => {
      const { scorerToken, matchId } = await setupDelegatedMatch();

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/start-innings`)
        .set('Authorization', `Bearer ${scorerToken}`)
        .send({ strikerName: 'A', nonStrikerName: 'B', bowlerName: 'C' });

      expect(res.status).toBe(200);
    });

    it('still rejects a plain org member who is not the assigned scorer', async () => {
      const { memberToken, matchId } = await setupDelegatedMatch();

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/start-innings`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ strikerName: 'A', nonStrikerName: 'B', bowlerName: 'C' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });

    it('rejects with MATCH_NOT_FOUND for an unknown matchId', async () => {
      const { token } = await createTestUser();

      const res = await request(app)
        .post('/api/v1/match/000000000000000000000000/start-innings')
        .set('Authorization', `Bearer ${token}`)
        .send({ strikerName: 'A', nonStrikerName: 'B', bowlerName: 'C' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MATCH_NOT_FOUND');
    });
  });

  describe('POST /:matchId/select-bowler', () => {
    // 2 overs, so completing over 1 leaves the innings still live and
    // owed a bowler for over 2, rather than ending the match.
    const startAndCompleteOver1 = async (token) => {
      const matchId = await createMatch(app, token, { totalOvers: 2 });
      await startLiveInnings(app, token, matchId);
      for (let i = 0; i < 6; i += 1) {
        await scoreDotBall(app, token, matchId);
      }
      return matchId;
    };

    it('assigns the named bowler for the next over', async () => {
      const { token } = await createTestUser();
      const matchId = await startAndCompleteOver1(token);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/select-bowler`)
        .set('Authorization', `Bearer ${token}`)
        .send({ bowlerName: 'Bowler Two' });

      expect(res.status).toBe(200);
      expect(res.body.data.bowler.bowlerName).toBe('Bowler Two');
      expect(res.body.data.overNumber).toBe(2);

      const inning = await Inning.findOne({ matchId });
      expect(inning.currentBowlerId.toString()).toBe(res.body.data.bowler.bowlerId);
    });

    it('refuses the same bowler for two overs running (Law 17.6)', async () => {
      const { token } = await createTestUser();
      const matchId = await startAndCompleteOver1(token);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/select-bowler`)
        .set('Authorization', `Bearer ${token}`)
        // "Bowler One" bowled over 1 (set by start-innings).
        .send({ bowlerName: 'Bowler One' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BOWLER_CANNOT_BOWL_CONSECUTIVE_OVERS');
    });

    it('rejects with MATCH_NOT_OWNED for a different user', async () => {
      const { token: ownerToken } = await createTestUser();
      const { token: otherToken } = await createTestUser();
      const matchId = await startAndCompleteOver1(ownerToken);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/select-bowler`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ bowlerName: 'Bowler Two' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });

    it('lets the assigned scorer select the bowler', async () => {
      const { ownerToken, scorerToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);
      for (let i = 0; i < 6; i += 1) {
        await scoreDotBall(app, ownerToken, matchId);
      }

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/select-bowler`)
        .set('Authorization', `Bearer ${scorerToken}`)
        .send({ bowlerName: 'Bowler Two' });

      expect(res.status).toBe(200);
    });

    it('still rejects a plain org member who is not the assigned scorer', async () => {
      const { ownerToken, memberToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);
      for (let i = 0; i < 6; i += 1) {
        await scoreDotBall(app, ownerToken, matchId);
      }

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/select-bowler`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ bowlerName: 'Bowler Two' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });

    it('rejects with MATCH_NOT_FOUND for an unknown matchId', async () => {
      const { token } = await createTestUser();

      const res = await request(app)
        .post('/api/v1/match/000000000000000000000000/select-bowler')
        .set('Authorization', `Bearer ${token}`)
        .send({ bowlerName: 'Bowler' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MATCH_NOT_FOUND');
    });
  });

  describe('POST /:matchId/score-ball', () => {
    it('updates innings totals for a dot ball', async () => {
      const { token } = await createTestUser();
      const matchId = await createMatch(app, token);
      await startLiveInnings(app, token, matchId);

      const res = await scoreDotBall(app, token, matchId);

      expect(res.status).toBe(200);
      expect(res.body.data.inningsTotals.totalRuns).toBe(0);
      expect(res.body.data.inningsTotals.legalBalls).toBe(1);

      const inning = await Inning.findOne({ matchId });
      expect(inning.totalBalls).toBe(1);
    });

    it('a wicket with a valid incoming batsman continues the innings', async () => {
      const { token } = await createTestUser();
      const matchId = await createMatch(app, token);
      await startLiveInnings(app, token, matchId);

      const res = await scoreDotBall(app, token, matchId, {
        wicketType: 'bowled',
        incomingBatsmanName: 'Third Batsman',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.wicket).not.toBeNull();
      expect(res.body.data.inningsTotals.wickets).toBe(1);

      const inning = await Inning.findOne({ matchId });
      expect(
        [inning.strikerName, inning.nonStrikerName].includes('Third Batsman')
      ).toBe(true);
    });

    it('replaying the same idempotencyKey returns the original result instead of scoring twice', async () => {
      const { token } = await createTestUser();
      const matchId = await createMatch(app, token);
      await startLiveInnings(app, token, matchId);
      const key = randomUUID();

      const first = await scoreDotBall(app, token, matchId, { runs: 4, idempotencyKey: key });
      const second = await scoreDotBall(app, token, matchId, { runs: 4, idempotencyKey: key });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.data.ballEventId).toBe(first.body.data.ballEventId);

      const inning = await Inning.findOne({ matchId });
      expect(inning.totalRuns).toBe(4);
      expect(inning.totalBalls).toBe(1);
    });

    it('completing an over reports overComplete and clears the current bowler', async () => {
      const { token } = await createTestUser();
      const matchId = await createMatch(app, token, { totalOvers: 2 });
      await startLiveInnings(app, token, matchId);

      let last;
      for (let i = 0; i < 6; i += 1) {
        last = await scoreDotBall(app, token, matchId);
      }

      expect(last.body.data.overComplete).toBe(true);

      const inning = await Inning.findOne({ matchId });
      expect(inning.oversCompleted).toBe(1);
      expect(inning.currentBowlerId).toBeNull();
    });

    it('rejects with INNINGS_NOT_STARTED when no innings has been opened', async () => {
      const { token } = await createTestUser();
      const matchId = await createMatch(app, token);

      const res = await scoreDotBall(app, token, matchId);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INNINGS_NOT_STARTED');
    });

    it('rejects with MATCH_NOT_OWNED for a different user', async () => {
      const { token: ownerToken } = await createTestUser();
      const { token: otherToken } = await createTestUser();
      const matchId = await createMatch(app, ownerToken);
      await startLiveInnings(app, ownerToken, matchId);

      const res = await scoreDotBall(app, otherToken, matchId);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });

    it('lets the assigned scorer score a ball', async () => {
      const { ownerToken, scorerToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);

      const res = await scoreDotBall(app, scorerToken, matchId, { runs: 1 });

      expect(res.status).toBe(200);
    });

    it('still rejects a plain org member who is not the assigned scorer', async () => {
      const { ownerToken, memberToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);

      const res = await scoreDotBall(app, memberToken, matchId, { runs: 1 });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });
  });

  describe('POST /:matchId/undo-ball', () => {
    it('undoing the most recent ball restores the pre-ball innings totals', async () => {
      const { token } = await createTestUser();
      const matchId = await createMatch(app, token);
      await startLiveInnings(app, token, matchId);
      const scored = await scoreDotBall(app, token, matchId, { runs: 6 });

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/undo-ball`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ballEventId: scored.body.data.ballEventId });

      expect(res.status).toBe(200);
      expect(res.body.data.alreadyUndone).toBe(false);
      expect(res.body.data.inningsTotals.totalRuns).toBe(0);

      const inning = await Inning.findOne({ matchId });
      expect(inning.totalRuns).toBe(0);
      expect(inning.totalBalls).toBe(0);
    });

    it('undoing a non-latest ball is rejected with BALL_NOT_LATEST', async () => {
      const { token } = await createTestUser();
      const matchId = await createMatch(app, token);
      await startLiveInnings(app, token, matchId);
      const first = await scoreDotBall(app, token, matchId);
      await scoreDotBall(app, token, matchId);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/undo-ball`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ballEventId: first.body.data.ballEventId });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BALL_NOT_LATEST');
    });

    it('undoing an already-undone ball is idempotent, not an error', async () => {
      const { token } = await createTestUser();
      const matchId = await createMatch(app, token);
      await startLiveInnings(app, token, matchId);
      const scored = await scoreDotBall(app, token, matchId);

      await request(app)
        .post(`/api/v1/match/${matchId}/undo-ball`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ballEventId: scored.body.data.ballEventId });

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/undo-ball`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ballEventId: scored.body.data.ballEventId });

      expect(res.status).toBe(200);
      expect(res.body.data.alreadyUndone).toBe(true);
    });

    // A ball can never move matches, so an id that demonstrably belongs to a
    // DIFFERENT match is never a legitimate "already undone" retry — unlike
    // the case above, this must not be masked as a harmless no-op.
    it('rejects a ballEventId that belongs to a different match, rather than reporting alreadyUndone', async () => {
      const { token } = await createTestUser();

      const matchA = await createMatch(app, token);
      await startLiveInnings(app, token, matchA);

      const matchB = await createMatch(app, token);
      await startLiveInnings(app, token, matchB);
      const scoredInB = await scoreDotBall(app, token, matchB);

      const res = await request(app)
        .post(`/api/v1/match/${matchA}/undo-ball`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ballEventId: scoredInB.body.data.ballEventId });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BALL_EVENT_ID_MISMATCH');

      // The ball is untouched in its real match.
      const stillThere = await request(app)
        .post(`/api/v1/match/${matchB}/undo-ball`)
        .set('Authorization', `Bearer ${token}`)
        .send({ ballEventId: scoredInB.body.data.ballEventId });
      expect(stillThere.status).toBe(200);
      expect(stillThere.body.data.alreadyUndone).toBe(false);
    });

    it('rejects with MATCH_NOT_OWNED for a different user', async () => {
      const { token: ownerToken } = await createTestUser();
      const { token: otherToken } = await createTestUser();
      const matchId = await createMatch(app, ownerToken);
      await startLiveInnings(app, ownerToken, matchId);
      const scored = await scoreDotBall(app, ownerToken, matchId);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/undo-ball`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ ballEventId: scored.body.data.ballEventId });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });

    it('lets the assigned scorer undo a ball', async () => {
      const { ownerToken, scorerToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);
      const scoreRes = await scoreDotBall(app, ownerToken, matchId);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/undo-ball`)
        .set('Authorization', `Bearer ${scorerToken}`)
        .send({ ballEventId: scoreRes.body.data.ballEventId });

      expect(res.status).toBe(200);
    });

    it('still rejects a plain org member who is not the assigned scorer', async () => {
      const { ownerToken, memberToken, matchId } = await setupDelegatedMatch();
      await startLiveInnings(app, ownerToken, matchId);
      const scoreRes = await scoreDotBall(app, ownerToken, matchId);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/undo-ball`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ ballEventId: scoreRes.body.data.ballEventId });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');
    });

    it('rejects with MATCH_NOT_FOUND for an unknown matchId', async () => {
      const { token } = await createTestUser();

      const res = await request(app)
        .post('/api/v1/match/000000000000000000000000/undo-ball')
        .set('Authorization', `Bearer ${token}`)
        .send({ ballEventId: '000000000000000000000000' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MATCH_NOT_FOUND');
    });
  });
});
