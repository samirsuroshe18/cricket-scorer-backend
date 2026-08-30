import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// findOrCreateTeam used to key on {createdBy, name} and reuse the existing
// Team (and therefore its whole Player pool) whenever the same scorer typed
// the same team name in a later, unrelated match — even though Phase 1 is
// meant to be ad-hoc, per-match-only teams (docs/roadmap.md). Two different
// real-world "Team A"s belonging to the same scorer would silently share a
// roster.
describe('teams are scoped to the match they were created for', () => {
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

  const createMatch = async (token) => {
    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Team A', teamBName: 'Team B', totalOvers: 5 });
    return res.body.data;
  };

  it("gives a second match its own teams, even when the same scorer reuses a team name", async () => {
    const { token } = await createTestUser();

    const first = await createMatch(token);
    const second = await createMatch(token);

    expect(second.matchId).not.toBe(first.matchId);
    expect(second.teamA.id).not.toBe(first.teamA.id);
    expect(second.teamB.id).not.toBe(first.teamB.id);
  });
});
