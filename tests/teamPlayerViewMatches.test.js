import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';
import { Match } from '../src/models/match.model.js';

describe('GET /v1/team/:teamId/player-view/matches', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const matches = (token, teamId, query = '') =>
    request(app).get(`/api/v1/team/${teamId}/player-view/matches${query}`).set('Authorization', `Bearer ${token}`);

  const seed = async () => {
    const { user: scorer } = await createTestUser();
    const { user, token } = await createTestUser();
    const me = await Player.create({ name: 'Me', nameLower: 'me', createdBy: scorer._id, linkedUserId: user._id });
    const team = await Team.create({ name: 'Home', createdBy: scorer._id, players: [me._id] });
    const rival = await Team.create({ name: 'Away', createdBy: scorer._id });
    let seq = 0;
    const make = (status, extra = {}) =>
      Match.create({
        teamA: team._id, teamB: rival._id, totalOvers: 5, status, createdBy: scorer._id, joinCode: `JOIN${String((seq += 1)).padStart(2, '0')}`, ...extra,
      });
    await make('live');
    await make('innings_break');
    await make('upcoming');
    await make('completed');
    return { token, team };
  };

  it('filters by status group and returns all by default', async () => {
    const { token, team } = await seed();

    const all = await matches(token, team._id);
    const live = await matches(token, team._id, '?status=live');
    const upcoming = await matches(token, team._id, '?status=upcoming');
    const completed = await matches(token, team._id, '?status=completed');

    expect(all.status).toBe(200);
    expect(all.body.data.total).toBe(4);
    expect(live.body.data.matches.map((m) => m.status).sort()).toEqual(['innings_break', 'live']);
    expect(upcoming.body.data.matches.map((m) => m.status)).toEqual(['upcoming']);
    expect(completed.body.data.matches.map((m) => m.status)).toEqual(['completed']);
  });

  it('keeps joinCode and drops scorer-side fields', async () => {
    const { token, team } = await seed();

    const res = await matches(token, team._id, '?status=live');

    const item = res.body.data.matches[0];
    expect(item.joinCode).toEqual(expect.any(String));
    expect(item).toHaveProperty('teamA');
    expect(item).toHaveProperty('teamB');
    for (const key of ['createdBy', 'assignedScorer', 'syncStatus']) {
      expect(item).not.toHaveProperty(key);
    }
  });

  it('validates status and pagination', async () => {
    const { token, team } = await seed();

    const badStatus = await matches(token, team._id, '?status=bogus');
    const tooMany = await matches(token, team._id, '?limit=51');
    const paged = await matches(token, team._id, '?page=2&limit=3');

    expect(badStatus.status).toBe(400);
    expect(badStatus.body.code).toBe('INVALID_STATUS_FILTER');
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('INVALID_PAGINATION');
    expect(paged.body.data).toMatchObject({ page: 2, limit: 3, total: 4 });
    expect(paged.body.data.matches).toHaveLength(1);
  });

  it('is 403 TEAM_NOT_A_PLAYER for a non-member', async () => {
    const { team } = await seed();
    const { token: stranger } = await createTestUser();

    const res = await matches(stranger, team._id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_A_PLAYER');
  });
});
