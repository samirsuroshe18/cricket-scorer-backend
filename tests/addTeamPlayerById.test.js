import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';

describe('POST /v1/team/:teamId/players with playerId', () => {
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

  const add = (token, teamId, body) =>
    request(app).post(`/api/v1/team/${teamId}/players`).set('Authorization', `Bearer ${token}`).send(body);

  const makePlayer = (createdBy, name, extra = {}) =>
    Player.create({ name, nameLower: name.toLowerCase(), createdBy, ...extra });

  const makeTeam = (createdBy) => Team.create({ name: 'Riverside', createdBy });

  it('adds an existing scorer-owned player by id (201) and ignores name', async () => {
    const { user, token } = await createTestUser();
    const player = await makePlayer(user._id, 'Rahul');
    const team = await makeTeam(user._id);

    const res = await add(token, team._id, { playerId: String(player._id), name: 'Ignored Name' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ playerId: String(player._id), playerName: 'Rahul' });
    const stored = await Team.findById(team._id);
    expect(stored.players.map(String)).toEqual([String(player._id)]);
    expect(await Player.countDocuments({ createdBy: user._id })).toBe(1);
  });

  it('is 200 when the player is already on the roster', async () => {
    const { user, token } = await createTestUser();
    const player = await makePlayer(user._id, 'Rahul');
    const team = await makeTeam(user._id);
    await add(token, team._id, { playerId: String(player._id) });

    const res = await add(token, team._id, { playerId: String(player._id) });

    expect(res.status).toBe(200);
    const stored = await Team.findById(team._id);
    expect(stored.players).toHaveLength(1);
  });

  it('returns 404 PLAYER_NOT_FOUND for another account\'s player', async () => {
    const { user, token } = await createTestUser();
    const { user: other } = await createTestUser();
    const foreign = await makePlayer(other._id, 'Foreign');
    const team = await makeTeam(user._id);

    const res = await add(token, team._id, { playerId: String(foreign._id) });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAYER_NOT_FOUND');
    expect((await Team.findById(team._id)).players).toHaveLength(0);
  });

  it('returns 404 PLAYER_NOT_FOUND for a soft-deleted player', async () => {
    const { user, token } = await createTestUser();
    const gone = await makePlayer(user._id, 'Gone', { isDeleted: true });
    const team = await makeTeam(user._id);

    const res = await add(token, team._id, { playerId: String(gone._id) });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAYER_NOT_FOUND');
  });

  it('still applies role and jerseyNumber from the body', async () => {
    const { user, token } = await createTestUser();
    const player = await makePlayer(user._id, 'Rahul');
    const team = await makeTeam(user._id);

    const res = await add(token, team._id, { playerId: String(player._id), role: 'bowler', jerseyNumber: 18 });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ role: 'bowler', jerseyNumber: 18 });
  });

  it('returns 400 INVALID_ID for a malformed playerId', async () => {
    const { user, token } = await createTestUser();
    const team = await makeTeam(user._id);

    const res = await add(token, team._id, { playerId: 'not-an-id' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it('returns 400 TEAM_PLAYER_NAME_INVALID when neither playerId nor a name is given', async () => {
    const { user, token } = await createTestUser();
    const team = await makeTeam(user._id);

    const res = await add(token, team._id, {});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_PLAYER_NAME_INVALID');
  });
});
