import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';

// `Match.status` has had 'abandoned' in its enum, and `Match.isDeleted` has
// existed, since the schema was first written — but nothing ever set either
// (verified by grep across match.controller.js during the 2026-08-29 Phase 1
// review). A rained-off match had no way to leave 'live', and a mis-created
// match (wrong team names typed) had no way to leave a scorer's history.
describe('match abandon/delete', () => {
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

  const createLiveMatch = async (token) => {
    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Team A', teamBName: 'Team B', totalOvers: 5 });
    return res.body.data.matchId;
  };

  describe('POST /:matchId/abandon', () => {
    it("sets the match's status to 'abandoned'", async () => {
      const { token } = await createTestUser();
      const matchId = await createLiveMatch(token);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/abandon`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('abandoned');

      const stored = await Match.findById(matchId);
      expect(stored.status).toBe('abandoned');
      expect(stored.completedAt).not.toBeNull();
    });

    it('rejects with MATCH_NOT_OWNED when abandoned by a different user', async () => {
      const { token: ownerToken } = await createTestUser();
      const { token: otherToken } = await createTestUser();
      const matchId = await createLiveMatch(ownerToken);

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/abandon`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');

      const stored = await Match.findById(matchId);
      expect(stored.status).toBe('upcoming');
    });

    it('rejects with MATCH_NOT_FOUND for an unknown matchId', async () => {
      const { token } = await createTestUser();

      const res = await request(app)
        .post('/api/v1/match/000000000000000000000000/abandon')
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MATCH_NOT_FOUND');
    });

    it('rejects an already-abandoned match with MATCH_ALREADY_COMPLETED rather than abandoning it twice', async () => {
      const { token } = await createTestUser();
      const matchId = await createLiveMatch(token);

      await request(app)
        .post(`/api/v1/match/${matchId}/abandon`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      const res = await request(app)
        .post(`/api/v1/match/${matchId}/abandon`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MATCH_ALREADY_COMPLETED');
    });
  });

  describe('DELETE /:matchId', () => {
    it('soft-deletes the match regardless of its current status', async () => {
      const { token } = await createTestUser();
      const matchId = await createLiveMatch(token);

      const res = await request(app)
        .delete(`/api/v1/match/${matchId}`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(res.status).toBe(200);

      const stored = await Match.findById(matchId);
      expect(stored.isDeleted).toBe(true);
    });

    it('rejects with MATCH_NOT_OWNED when deleted by a different user', async () => {
      const { token: ownerToken } = await createTestUser();
      const { token: otherToken } = await createTestUser();
      const matchId = await createLiveMatch(ownerToken);

      const res = await request(app)
        .delete(`/api/v1/match/${matchId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('MATCH_NOT_OWNED');

      const stored = await Match.findById(matchId);
      expect(stored.isDeleted).toBe(false);
    });

    it('treats an already-deleted match as not found, same as an unknown id', async () => {
      const { token } = await createTestUser();
      const matchId = await createLiveMatch(token);

      await request(app)
        .delete(`/api/v1/match/${matchId}`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      const res = await request(app)
        .delete(`/api/v1/match/${matchId}`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MATCH_NOT_FOUND');
    });
  });

  describe('scorecard of an abandoned match', () => {
    // getMatchScorecard's guard used to require `status === 'completed'`,
    // which a normal completion always satisfies with both innings present
    // — but abandonMatch generates a scorecard for whatever innings exist
    // and sets status to 'abandoned', never 'completed'. Without also
    // widening this guard, the scorecard abandonMatch just generated would
    // be permanently unreachable through this endpoint.
    it('is fetchable once the match is abandoned, with only the started innings populated', async () => {
      const { token } = await createTestUser();
      const matchId = await createLiveMatch(token);
      await startLiveInnings(app, token, matchId);
      await scoreDotBall(app, token, matchId, { runs: 4 });

      await request(app)
        .post(`/api/v1/match/${matchId}/abandon`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      const res = await request(app)
        .get(`/api/v1/match/${matchId}/scorecard`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.data.innings[0]).not.toBeNull();
      expect(res.body.data.innings[0].inningsNumber).toBe(1);
      // Innings 2 was never started before the match was abandoned — must
      // come back as null, not crash generateScorecard(matchId, null).
      expect(res.body.data.innings[1]).toBeNull();
    });
  });
});
