import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';

describe('GET /v1/player', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withPlayer: true, withTeam: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const list = (token, query = '') => {
    const req = request(app).get(`/api/v1/player${query}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  };

  const makePlayer = (createdBy, name, extra = {}) =>
    Player.create({ name, nameLower: name.toLowerCase(), createdBy, ...extra });

  const makeTeam = (createdBy, players = [], extra = {}) =>
    Team.create({ name: 'Riverside', createdBy, players: players.map((p) => p._id), ...extra });

  it('returns only players created by the caller, sorted by name', async () => {
    const { user, token } = await createTestUser();
    const { user: other } = await createTestUser();
    await makePlayer(user._id, 'Zaheer');
    await makePlayer(user._id, 'Amit', { role: 'bowler', jerseyNumber: 7 });
    await makePlayer(other._id, 'Someone Else');

    const res = await list(token);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.limit).toBe(20);
    expect(res.body.data.players.map((p) => p.playerName)).toEqual(['Amit', 'Zaheer']);
    expect(res.body.data.players[0]).toEqual({
      playerId: expect.any(String),
      playerName: 'Amit',
      role: 'bowler',
      jerseyNumber: 7,
      isClaimed: false,
    });
  });

  it('reports isClaimed without revealing who claimed', async () => {
    const { user, token } = await createTestUser();
    const { user: claimer } = await createTestUser();
    await makePlayer(user._id, 'Claimed One', { linkedUserId: claimer._id });

    const res = await list(token);

    expect(res.body.data.players[0].isClaimed).toBe(true);
    expect(res.body.data.players[0]).not.toHaveProperty('linkedUserId');
  });

  it('excludes soft-deleted players', async () => {
    const { user, token } = await createTestUser();
    await makePlayer(user._id, 'Gone', { isDeleted: true });
    await makePlayer(user._id, 'Here');

    const res = await list(token);

    expect(res.body.data.players.map((p) => p.playerName)).toEqual(['Here']);
  });

  it('filters by case-insensitive name substring', async () => {
    const { user, token } = await createTestUser();
    await makePlayer(user._id, 'Rahul Sharma');
    await makePlayer(user._id, 'Priya Rahulan');
    await makePlayer(user._id, 'Virat');

    const res = await list(token, '?q=RAHUL');

    expect(res.body.data.players.map((p) => p.playerName)).toEqual(['Priya Rahulan', 'Rahul Sharma']);
  });

  it('treats regex metacharacters in q as literal text', async () => {
    const { user, token } = await createTestUser();
    await makePlayer(user._id, 'Rahul');

    const paren = await list(token, `?q=${encodeURIComponent('(')}`);
    const wildcard = await list(token, `?q=${encodeURIComponent('.*')}`);

    expect(paren.status).toBe(200);
    expect(paren.body.data.players).toEqual([]);
    expect(wildcard.status).toBe(200);
    expect(wildcard.body.data.players).toEqual([]);
  });

  it('flags onTeam for the given team', async () => {
    const { user, token } = await createTestUser();
    const onRoster = await makePlayer(user._id, 'On Roster');
    await makePlayer(user._id, 'Off Roster');
    const team = await makeTeam(user._id, [onRoster]);

    const res = await list(token, `?teamId=${team._id}`);

    const byName = Object.fromEntries(res.body.data.players.map((p) => [p.playerName, p.onTeam]));
    expect(byName).toEqual({ 'On Roster': true, 'Off Roster': false });
  });

  it('omits onTeam when no teamId is given', async () => {
    const { user, token } = await createTestUser();
    await makePlayer(user._id, 'Solo');

    const res = await list(token);

    expect(res.body.data.players[0]).not.toHaveProperty('onTeam');
  });

  it('returns 403 TEAM_NOT_OWNED for another account\'s team', async () => {
    const { token } = await createTestUser();
    const { user: other } = await createTestUser();
    const team = await makeTeam(other._id);

    const res = await list(token, `?teamId=${team._id}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_OWNED');
  });

  it('returns 404 TEAM_NOT_FOUND for a deleted team', async () => {
    const { user, token } = await createTestUser();
    const team = await makeTeam(user._id, [], { isDeleted: true });

    const res = await list(token, `?teamId=${team._id}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_FOUND');
  });

  it('pages results and rejects a limit above 50', async () => {
    const { user, token } = await createTestUser();
    await makePlayer(user._id, 'A');
    await makePlayer(user._id, 'B');
    await makePlayer(user._id, 'C');

    const second = await list(token, '?page=2&limit=2');
    const tooMany = await list(token, '?limit=51');

    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ page: 2, limit: 2, total: 3 });
    expect(second.body.data.players.map((p) => p.playerName)).toEqual(['C']);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('INVALID_PAGINATION');
  });

  it('returns 401 without a token', async () => {
    const res = await list(null);

    expect(res.status).toBe(401);
  });
});
