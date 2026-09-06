import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';

describe('PATCH /v1/player/:playerId', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withPlayer: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const updatePlayer = (token, playerId, body) =>
    request(app)
      .patch(`/api/v1/player/${playerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const createOwnedPlayer = async (token) => {
    const matchId = await createMatch(app, token, { totalOvers: 1 });
    await startLiveInnings(app, token, matchId, { strikerName: 'Rahul' });
    return Player.findOne({ nameLower: 'rahul' });
  };

  it('401s with no token', async () => {
    const { token } = await createTestUser();
    const rahul = await createOwnedPlayer(token);
    const res = await request(app).patch(`/api/v1/player/${rahul._id}`).send({ bio: 'x' });
    expect(res.status).toBe(401);
  });

  it('404s for a playerId that does not exist', async () => {
    const { token } = await createTestUser();
    const res = await updatePlayer(token, '665f3b1c2d3e4f5a6b7c8d90', { bio: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAYER_NOT_FOUND');
  });

  it("403s for a player that belongs to a different scorer's account", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const rahul = await createOwnedPlayer(ownerToken);

    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const res = await updatePlayer(strangerToken, rahul._id.toString(), { bio: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PLAYER_NOT_OWNED');
  });

  it('400s for an invalid role', async () => {
    const { token } = await createTestUser();
    const rahul = await createOwnedPlayer(token);
    const res = await updatePlayer(token, rahul._id.toString(), { role: 'goalkeeper' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PLAYER_ROLE');
  });

  it('400s for a jersey number out of range', async () => {
    const { token } = await createTestUser();
    const rahul = await createOwnedPlayer(token);
    const res = await updatePlayer(token, rahul._id.toString(), { jerseyNumber: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JERSEY_NUMBER');
  });

  it('400s for an invalid batting style', async () => {
    const { token } = await createTestUser();
    const rahul = await createOwnedPlayer(token);
    const res = await updatePlayer(token, rahul._id.toString(), { battingStyle: 'ambidextrous' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BATTING_STYLE');
  });

  it('400s for an invalid bowling style', async () => {
    const { token } = await createTestUser();
    const rahul = await createOwnedPlayer(token);
    const res = await updatePlayer(token, rahul._id.toString(), { bowlingStyle: 'underarm' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BOWLING_STYLE');
  });

  it('updates role, jerseyNumber, bio, battingStyle and bowlingStyle', async () => {
    const { token } = await createTestUser();
    const rahul = await createOwnedPlayer(token);

    const res = await updatePlayer(token, rahul._id.toString(), {
      role: 'allrounder',
      jerseyNumber: 7,
      bio: 'Opens the batting, bowls a bit of spin.',
      battingStyle: 'right_handed',
      bowlingStyle: 'right_arm_spin',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      playerId: rahul._id.toString(),
      playerName: 'Rahul',
      role: 'allrounder',
      jerseyNumber: 7,
      bio: 'Opens the batting, bowls a bit of spin.',
      battingStyle: 'right_handed',
      bowlingStyle: 'right_arm_spin',
    });

    const stored = await Player.findById(rahul._id);
    expect(stored.role).toBe('allrounder');
    expect(stored.jerseyNumber).toBe(7);
    expect(stored.bio).toBe('Opens the batting, bowls a bit of spin.');
    expect(stored.battingStyle).toBe('right_handed');
    expect(stored.bowlingStyle).toBe('right_arm_spin');
  });

  it('a partial update (just bio) leaves the other fields untouched', async () => {
    const { token } = await createTestUser();
    const rahul = await createOwnedPlayer(token);
    await updatePlayer(token, rahul._id.toString(), { role: 'batsman', jerseyNumber: 10 });

    const res = await updatePlayer(token, rahul._id.toString(), { bio: 'Just a bio update.' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      role: 'batsman',
      jerseyNumber: 10,
      bio: 'Just a bio update.',
    });
  });
});

describe('GET /:playerId/career-stats includes profile fields', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withPlayer: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('includes the default profile shape for a player nobody has edited yet', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 1 });
    await startLiveInnings(app, token, matchId, { strikerName: 'Rahul' });
    const rahul = await Player.findOne({ nameLower: 'rahul' });

    const res = await request(app)
      .get(`/api/v1/player/${rahul._id}/career-stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      role: 'unknown',
      jerseyNumber: null,
      bio: null,
      battingStyle: null,
      bowlingStyle: null,
    });
  });

  it('reflects a profile that was edited via PATCH', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 1 });
    await startLiveInnings(app, token, matchId, { strikerName: 'Rahul' });
    const rahul = await Player.findOne({ nameLower: 'rahul' });

    await request(app)
      .patch(`/api/v1/player/${rahul._id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'bowler', battingStyle: 'left_handed' });

    const res = await request(app)
      .get(`/api/v1/player/${rahul._id}/career-stats`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      role: 'bowler',
      battingStyle: 'left_handed',
    });
  });
});
