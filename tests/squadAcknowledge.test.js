import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';

// Once a scorer has dealt with the Squad screen for an upcoming match — Skip or
// Save & continue — the client records it here so the screen stops appearing.
describe('POST /:matchId/squad/acknowledge', () => {
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

  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const acknowledge = (token, matchId) =>
    request(app).post(`/api/v1/match/${matchId}/squad/acknowledge`).set(auth(token)).send();
  const history = (token) => request(app).get('/api/v1/match/history').set(auth(token));

  const setup = async () => {
    const { token, user } = await createTestUser();
    const matchId = await createMatch(app, token);
    return { token, user, matchId };
  };

  it('stamps squadAcknowledgedAt and returns it', async () => {
    const { token, matchId } = await setup();
    expect((await Match.findById(matchId)).squadAcknowledgedAt).toBeNull();

    const res = await acknowledge(token, matchId);

    expect(res.status).toBe(200);
    expect(res.body.data.matchId).toBe(matchId);
    expect(res.body.data.squadAcknowledgedAt).toEqual(expect.any(String));
    const stored = await Match.findById(matchId);
    expect(stored.squadAcknowledgedAt).toBeInstanceOf(Date);
    expect(stored.squadAcknowledgedAt.toISOString()).toBe(res.body.data.squadAcknowledgedAt);
  });

  it('is idempotent: a repeat keeps the first timestamp', async () => {
    const { token, matchId } = await setup();
    const first = await acknowledge(token, matchId);

    const second = await acknowledge(token, matchId);

    expect(second.status).toBe(200);
    expect(second.body.data.squadAcknowledgedAt).toBe(first.body.data.squadAcknowledgedAt);
  });

  it('lets the assigned scorer acknowledge, and refuses anyone else', async () => {
    const { matchId } = await setup();
    const { user: delegate, token: delegateToken } = await createTestUser();
    const { token: strangerToken } = await createTestUser();
    await Match.updateOne({ _id: matchId }, { assignedScorer: delegate._id });

    const denied = await acknowledge(strangerToken, matchId);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('MATCH_NOT_OWNED');
    expect((await Match.findById(matchId)).squadAcknowledgedAt).toBeNull();

    expect((await acknowledge(delegateToken, matchId)).status).toBe(200);
  });

  it('returns 404 MATCH_NOT_FOUND for an unknown, deleted or malformed id', async () => {
    const { token, matchId } = await setup();
    await Match.updateOne({ _id: matchId }, { isDeleted: true });

    for (const id of ['665f1a2b3c4d5e6f7a8b9c99', 'not-an-id', matchId]) {
      const res = await acknowledge(token, id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MATCH_NOT_FOUND');
    }
  });

  it('requires authentication', async () => {
    const { matchId } = await setup();

    expect((await request(app).post(`/api/v1/match/${matchId}/squad/acknowledge`)).status).toBe(401);
  });

  it('does not disturb the saved squad', async () => {
    const { token, matchId } = await setup();
    await request(app)
      .put(`/api/v1/match/${matchId}/squad/teamA`)
      .set(auth(token))
      .send({ players: [{ name: 'Rohit' }, { name: 'Bumrah' }], playingXI: ['Rohit', 'Bumrah'] });

    expect((await acknowledge(token, matchId)).status).toBe(200);

    const match = await Match.findById(matchId);
    expect(match.squads.teamA.players).toHaveLength(2);
    expect(match.squads.teamA.playingXI).toHaveLength(2);
  });

  describe('in GET /v1/match/history', () => {
    it('reads false for a new match and true once acknowledged, per match', async () => {
      const { token, matchId } = await setup();
      const other = await createMatch(app, token, { teamAName: 'Other A', teamBName: 'Other B' });

      const before = await history(token);
      expect(before.body.data.matches.map((m) => m.squadAcknowledged)).toEqual([false, false]);

      await acknowledge(token, matchId);

      const after = await history(token);
      const byId = Object.fromEntries(after.body.data.matches.map((m) => [m.matchId, m.squadAcknowledged]));
      expect(byId[matchId]).toBe(true);
      expect(byId[other]).toBe(false);
    });

    it('reads false for a match created before this field existed', async () => {
      const { token, matchId } = await setup();
      await Match.collection.updateOne(
        { _id: new (await import('mongoose')).default.Types.ObjectId(matchId) },
        { $unset: { squadAcknowledgedAt: '' } },
      );

      const res = await history(token);

      expect(res.body.data.matches[0].squadAcknowledged).toBe(false);
    });
  });
});
