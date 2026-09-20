import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { randomUUID } from 'node:crypto';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { Match } from '../src/models/match.model.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// The first list endpoint in this codebase — see the backend CLAUDE.md's own
// pagination convention for why `?page`/`?limit` rather than an unbounded
// `.find()`. Feeds the Flutter match-history/home screen.
describe('GET /v1/match/history', () => {
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

  const history = (token, query = '') =>
    request(app)
      .get(`/api/v1/match/history${query}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

  it("returns only the caller's own matches, newest first", async () => {
    const { token } = await createTestUser();
    const first = await createMatch(app, token, { teamAName: 'Oldest A', teamBName: 'Oldest B' });
    const second = await createMatch(app, token, { teamAName: 'Newest A', teamBName: 'Newest B' });

    const res = await history(token);

    expect(res.status).toBe(200);
    expect(res.body.data.matches).toHaveLength(2);
    expect(res.body.data.matches[0].matchId).toBe(second);
    expect(res.body.data.matches[1].matchId).toBe(first);
    expect(res.body.data.matches[0].teamA.name).toBe('Newest A');
    expect(typeof res.body.data.matches[0].teamA.id).toBe('string');
    expect(res.body.data.total).toBe(2);
  });

  it("excludes another user's matches", async () => {
    const { token: mine } = await createTestUser();
    const { token: theirs } = await createTestUser();
    await createMatch(app, theirs);

    const res = await history(mine);

    expect(res.status).toBe(200);
    expect(res.body.data.matches).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
  });

  it('excludes a soft-deleted match', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await request(app)
      .delete(`/api/v1/match/${matchId}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    const res = await history(token);

    expect(res.status).toBe(200);
    expect(res.body.data.matches).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
  });

  it('paginates with ?page and ?limit', async () => {
    const { token } = await createTestUser();
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(await createMatch(app, token, { teamAName: `Team ${i}A`, teamBName: `Team ${i}B` }));
    }

    const page1 = await history(token, '?page=1&limit=2');
    expect(page1.body.data.matches).toHaveLength(2);
    expect(page1.body.data.total).toBe(3);
    expect(page1.body.data.page).toBe(1);
    expect(page1.body.data.matches.map((m) => m.matchId)).toEqual([ids[2], ids[1]]);

    const page2 = await history(token, '?page=2&limit=2');
    expect(page2.body.data.matches).toHaveLength(1);
    expect(page2.body.data.matches[0].matchId).toBe(ids[0]);
  });

  it('rejects an over-large limit rather than returning an unbounded list', async () => {
    const { token } = await createTestUser();

    const res = await history(token, '?limit=10000');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAGINATION');
  });

  it('includes status and result so the client can route a tapped card correctly', async () => {
    const { token } = await createTestUser();
    await createMatch(app, token);

    const res = await history(token);

    expect(res.body.data.matches[0].status).toBe('upcoming');
    expect(res.body.data.matches[0].result).toBeNull();
    expect(res.body.data.matches[0]).toHaveProperty('totalOvers');
    expect(res.body.data.matches[0]).toHaveProperty('createdAt');
  });

  it('includes tossWinner/tossDecision so a reopened console can show who won the toss', async () => {
    const { token } = await createTestUser();
    await createMatch(app, token, { tossWinner: 'teamA', tossDecision: 'bat' });

    const res = await history(token);

    expect(res.body.data.matches[0].tossWinner).toBe('teamA');
    expect(res.body.data.matches[0].tossDecision).toBe('bat');
  });

  it('reports a null toss for a match created without one', async () => {
    const { token } = await createTestUser();
    await createMatch(app, token);

    const res = await history(token);

    expect(res.body.data.matches[0].tossWinner).toBeNull();
    expect(res.body.data.matches[0].tossDecision).toBeNull();
  });

  it('includes a match the caller is the assigned scorer on, not just ones they created', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: 'scorer@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });

    const res = await history(scorerToken);

    expect(res.status).toBe(200);
    const match = res.body.data.matches.find((m) => m.matchId === matchId);
    expect(match).toBeDefined();
    expect(match.createdBy.id).toBeDefined();
    expect(match.assignedScorer.id).toBe(String(scorer._id));
  });

  it("shows the assignedScorer on the creator's own list once delegated", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner2@example.com' });
    const { token: scorerToken, user: scorer } = await createTestUser({ email: 'scorer2@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org 2' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: scorer.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Org Team 2' });
    const matchId = await createMatch(app, ownerToken, { teamAId: teamRes.body.data.id, teamBName: 'Visitors' });
    await request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${ownerToken}`).send({ scorerId: String(scorer._id) });

    const res = await history(ownerToken);

    const match = res.body.data.matches.find((m) => m.matchId === matchId);
    expect(match.assignedScorer).toMatchObject({ id: String(scorer._id) });
  });

  it('still shows assignedScorer as null for a match with no delegation', async () => {
    const { token } = await createTestUser({ email: 'solo@example.com' });
    await createMatch(app, token);

    const res = await history(token);

    expect(res.body.data.matches[0].assignedScorer).toBeNull();
  });

  it('reports null currentInnings for a match that has not started', async () => {
    const { token } = await createTestUser({ email: 'notstarted@example.com' });
    await createMatch(app, token);

    const res = await history(token);

    expect(res.body.data.matches[0].status).toBe('upcoming');
    expect(res.body.data.matches[0].currentInnings).toBeNull();
  });

  it("reports the live innings' running score for a match in progress", async () => {
    const { token } = await createTestUser({ email: 'livescore@example.com' });
    const matchId = await createMatch(app, token, { totalOvers: 5 });
    await startLiveInnings(app, token, matchId);
    await scoreDotBall(app, token, matchId, { runs: 4 });
    await scoreDotBall(app, token, matchId, { runs: 1 });

    const res = await history(token);
    const match = res.body.data.matches.find((m) => m.matchId === matchId);

    expect(match.status).toBe('live');
    expect(match.currentInnings).toEqual({
      inningsNumber: 1,
      battingTeam: expect.stringMatching(/^team[AB]$/),
      totalRuns: 5,
      wickets: 0,
      overs: '0.2',
      target: null,
      recentBalls: [
        { totalRuns: 4, extraType: null, isWicket: false },
        { totalRuns: 1, extraType: null, isWicket: false },
      ],
    });
  });

  it('reports recent balls oldest-first, folding extras into the total and flagging wickets', async () => {
    const { token } = await createTestUser({ email: 'recentballs@example.com' });
    const matchId = await createMatch(app, token, { totalOvers: 5 });
    await startLiveInnings(app, token, matchId);
    await scoreDotBall(app, token, matchId, { runs: 2 });
    await scoreDotBall(app, token, matchId, { runs: 0, extraType: 'wide' });
    await scoreDotBall(app, token, matchId, { wicketType: 'bowled', incomingBatsmanName: 'Third Batsman' });

    const res = await history(token);
    const match = res.body.data.matches.find((m) => m.matchId === matchId);

    expect(match.currentInnings.recentBalls).toEqual([
      { totalRuns: 2, extraType: null, isWicket: false },
      { totalRuns: 1, extraType: 'wide', isWicket: false },
      { totalRuns: 0, extraType: null, isWicket: true },
    ]);
  });

  it('caps recent balls at the last six deliveries', async () => {
    const { token } = await createTestUser({ email: 'recentcap@example.com' });
    const matchId = await createMatch(app, token, { totalOvers: 5 });
    await startLiveInnings(app, token, matchId);
    // Five legal balls plus three wides is eight deliveries inside a single
    // over (wides are not legal), so the over never completes and no bowler
    // change interrupts scoring — the cap has to drop the two oldest.
    for (const runs of [1, 2, 3, 4, 0]) {
      // eslint-disable-next-line no-await-in-loop
      await scoreDotBall(app, token, matchId, { runs });
    }
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await scoreDotBall(app, token, matchId, { runs: 0, extraType: 'wide' });
    }

    const res = await history(token);
    const match = res.body.data.matches.find((m) => m.matchId === matchId);

    expect(match.currentInnings.recentBalls).toEqual([
      { totalRuns: 3, extraType: null, isWicket: false },
      { totalRuns: 4, extraType: null, isWicket: false },
      { totalRuns: 0, extraType: null, isWicket: false },
      { totalRuns: 1, extraType: 'wide', isWicket: false },
      { totalRuns: 1, extraType: 'wide', isWicket: false },
      { totalRuns: 1, extraType: 'wide', isWicket: false },
    ]);
  });

  it("reports the completed first innings' score at an innings break, with no recent balls", async () => {
    const { token } = await createTestUser({ email: 'inningsbreak@example.com' });
    const matchId = await createMatch(app, token, { totalOvers: 1 });
    await startLiveInnings(app, token, matchId);
    // A one-over match: six legal balls completes innings 1 and flips the
    // match to innings_break, pointing currentInnings at an innings 2 whose
    // Inning document does not exist yet.
    await scoreDotBall(app, token, matchId, { runs: 4 });
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await scoreDotBall(app, token, matchId);
    }

    const res = await history(token);
    const match = res.body.data.matches.find((m) => m.matchId === matchId);

    expect(match.status).toBe('innings_break');
    expect(match.currentInnings).toEqual({
      inningsNumber: 1,
      battingTeam: expect.stringMatching(/^team[AB]$/),
      totalRuns: 4,
      wickets: 0,
      overs: '1.0',
      target: null,
      recentBalls: [],
    });
  });

  it('reports no recent balls before the first delivery', async () => {
    const { token } = await createTestUser({ email: 'norecent@example.com' });
    const matchId = await createMatch(app, token, { totalOvers: 5 });
    await startLiveInnings(app, token, matchId);

    const res = await history(token);
    const match = res.body.data.matches.find((m) => m.matchId === matchId);

    expect(match.currentInnings.recentBalls).toEqual([]);
  });

  it('does not report a currentInnings score for a completed match', async () => {
    const { token } = await createTestUser({ email: 'donecheck@example.com' });
    const matchId = await createMatch(app, token, { totalOvers: 5 });
    await startLiveInnings(app, token, matchId);
    await scoreDotBall(app, token, matchId, { runs: 2 });
    await request(app)
      .post(`/api/v1/match/${matchId}/abandon`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    const res = await history(token);
    const match = res.body.data.matches.find((m) => m.matchId === matchId);

    expect(match.status).toBe('abandoned');
    expect(match.currentInnings).toBeNull();
  });

  it("reports syncStatus 'local' for a match never touched by the sync endpoint", async () => {
    const { token } = await createTestUser({ email: 'syncstatus-local@example.com' });
    await createMatch(app, token);

    const res = await history(token);

    expect(res.body.data.matches[0].syncStatus).toBe('local');
  });

  it("reports syncStatus 'conflict' after a genuine sync conflict, without needing to reopen the match", async () => {
    const { token } = await createTestUser({ email: 'syncstatus-conflict@example.com' });
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);
    await scoreDotBall(app, token, matchId);
    await scoreDotBall(app, token, matchId);

    // Same genuine-conflict shape as syncMatch.test.js: the client claims to
    // be ahead of a server that only has two balls, which can only be a
    // real conflict, not a lost-response resume.
    await request(app)
      .post(`/api/v1/match/${matchId}/sync`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        inningsNumber: 1,
        baseAbsoluteBallSeq: 5,
        events: [{ type: 'ball', runs: 0, idempotencyKey: randomUUID() }],
      });

    const res = await history(token);
    const match = res.body.data.matches.find((m) => m.matchId === matchId);

    expect(match.syncStatus).toBe('conflict');
  });

  describe('?status filter and per-status counts', () => {
    // Statuses are set directly: reaching `completed` through the scoring API
    // would need a whole innings, and what's under test is the read side.
    const seed = async (token, statuses) => {
      const ids = [];
      for (const [i, status] of statuses.entries()) {
        const id = await createMatch(app, token, { teamAName: `S${i}A`, teamBName: `S${i}B` });
        await Match.updateOne({ _id: id }, { status });
        ids.push(id);
      }
      return ids;
    };

    it('filters to one status and reports the filtered total', async () => {
      const { token } = await createTestUser();
      const [, live] = await seed(token, ['upcoming', 'live', 'completed', 'live']);

      const res = await history(token, '?status=live');

      expect(res.status).toBe(200);
      expect(res.body.data.matches).toHaveLength(2);
      expect(res.body.data.matches.every((m) => m.status === 'live')).toBe(true);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.matches.map((m) => m.matchId)).toContain(live);
    });

    it('accepts a comma-separated list, so "live" can include innings_break', async () => {
      const { token } = await createTestUser();
      await seed(token, ['live', 'innings_break', 'completed', 'upcoming']);

      const res = await history(token, '?status=live,innings_break');

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.matches.map((m) => m.status).sort()).toEqual(['innings_break', 'live']);
    });

    it('paginates within the filtered set, so page 2 is still that status', async () => {
      const { token } = await createTestUser();
      await seed(token, ['upcoming', 'completed', 'upcoming', 'upcoming']);

      const page1 = await history(token, '?status=upcoming&page=1&limit=2');
      const page2 = await history(token, '?status=upcoming&page=2&limit=2');

      expect(page1.body.data.matches).toHaveLength(2);
      expect(page1.body.data.total).toBe(3);
      expect(page2.body.data.matches).toHaveLength(1);
      expect(page2.body.data.matches[0].status).toBe('upcoming');
    });

    it('rejects an unknown status rather than silently returning everything', async () => {
      const { token } = await createTestUser();

      const res = await history(token, '?status=bogus');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_STATUS_FILTER');
    });

    it('rejects a list containing one unknown status', async () => {
      const { token } = await createTestUser();

      const res = await history(token, '?status=live,bogus');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_STATUS_FILTER');
    });

    it('treats an empty ?status as no filter', async () => {
      const { token } = await createTestUser();
      await seed(token, ['live', 'completed']);

      const res = await history(token, '?status=');

      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(2);
    });

    it('never widens the filter beyond the caller\'s own matches', async () => {
      const { token: mine } = await createTestUser();
      const { token: theirs } = await createTestUser();
      await seed(theirs, ['live']);

      const res = await history(mine, '?status=live');

      expect(res.body.data.matches).toHaveLength(0);
      expect(res.body.data.total).toBe(0);
    });

    it('reports a count for every status, zero where there are none', async () => {
      const { token } = await createTestUser();
      await seed(token, ['upcoming', 'live', 'live', 'completed']);

      const res = await history(token);

      expect(res.body.data.counts).toEqual({
        upcoming: 1,
        live: 2,
        innings_break: 0,
        completed: 1,
        abandoned: 0,
      });
    });

    it('reports the same counts whatever status is being filtered', async () => {
      const { token } = await createTestUser();
      await seed(token, ['upcoming', 'live', 'completed']);

      const all = await history(token);
      const filtered = await history(token, '?status=completed');

      expect(filtered.body.data.counts).toEqual(all.body.data.counts);
    });

    it("leaves deleted and other users' matches out of the counts", async () => {
      const { token } = await createTestUser();
      const { token: other } = await createTestUser();
      const [gone] = await seed(token, ['live', 'live']);
      await seed(other, ['live', 'live', 'live']);
      await request(app)
        .delete(`/api/v1/match/${gone}`)
        .set('Authorization', `Bearer ${token}`)
        .send();

      const res = await history(token);

      expect(res.body.data.counts.live).toBe(1);
    });

    it('counts a match the caller is only the assigned scorer on', async () => {
      const { token: creator } = await createTestUser();
      const { token: scorer, user } = await createTestUser();
      const [id] = await seed(creator, ['live']);
      await Match.updateOne({ _id: id }, { assignedScorer: user._id });

      const res = await history(scorer);

      expect(res.body.data.counts.live).toBe(1);
    });
  });
});
