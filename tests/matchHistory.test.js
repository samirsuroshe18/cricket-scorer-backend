import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// The first list endpoint in this codebase — see the backend CLAUDE.md's own
// pagination convention for why `?page`/`?limit` rather than an unbounded
// `.find()`. Feeds the Flutter match-history/home screen.
describe('GET /v1/match/history', () => {
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
});
