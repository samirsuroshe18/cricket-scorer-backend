import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';
import { Team } from '../src/models/team.model.js';
import { Player } from '../src/models/player.model.js';

describe('PATCH /:matchId/squad/:side/playing-xi', () => {
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
  const putSquad = (token, matchId, side, body) =>
    request(app).put(`/api/v1/match/${matchId}/squad/${side}`).set(auth(token)).send(body);
  const patchXi = (token, matchId, side, body) =>
    request(app).patch(`/api/v1/match/${matchId}/squad/${side}/playing-xi`).set(auth(token)).send(body);
  const getSquad = (token, matchId) => request(app).get(`/api/v1/match/${matchId}/squad`).set(auth(token));

  const setup = async () => {
    const { token, user } = await createTestUser();
    const matchId = await createMatch(app, token);
    const saved = await putSquad(token, matchId, 'teamA', {
      players: [{ name: 'Rohit' }, { name: 'Bumrah' }, { name: 'Pant' }],
    });
    const ids = Object.fromEntries(saved.body.data.players.map((p) => [p.name, p.playerId]));
    return { token, user, matchId, ids };
  };

  it('sets the XI and reads back through GET /squad', async () => {
    const { token, matchId, ids } = await setup();

    const res = await patchXi(token, matchId, 'teamA', { playingXI: [ids.Rohit, ids.Pant] });

    expect(res.status).toBe(200);
    expect(res.body.data.side).toBe('teamA');
    expect(res.body.data.playingXI).toEqual([ids.Rohit, ids.Pant]);
    const read = await getSquad(token, matchId);
    expect(read.body.data.teamA.playingXI).toEqual([ids.Rohit, ids.Pant]);
  });

  it('is not blocked by a started innings, unlike PUT', async () => {
    const { token, matchId, ids } = await setup();
    await startLiveInnings(app, token, matchId);

    expect((await putSquad(token, matchId, 'teamA', { players: [] })).status).toBe(409);
    const res = await patchXi(token, matchId, 'teamA', { playingXI: [ids.Bumrah] });

    expect(res.status).toBe(200);
    expect(res.body.data.playingXI).toEqual([ids.Bumrah]);
  });

  it('appends a rostered player who is not yet in the squad, so an accepted invitee can be promoted', async () => {
    const { token, user, matchId, ids } = await setup();
    const newcomer = await Player.create({ name: 'Newcomer', nameLower: 'newcomer', createdBy: user._id });
    const match = await Match.findById(matchId);
    await Team.updateOne({ _id: match.teamA }, { $addToSet: { players: newcomer._id } });

    const res = await patchXi(token, matchId, 'teamA', { playingXI: [String(newcomer._id), ids.Rohit] });

    expect(res.status).toBe(200);
    expect(res.body.data.players.map((p) => p.name)).toEqual(['Rohit', 'Bumrah', 'Pant', 'Newcomer']);
    expect((await Match.findById(matchId)).squads.teamA.players).toHaveLength(4);
  });

  it('accepts [] as a deliberately empty XI, reading back [] not null', async () => {
    const { token, matchId, ids } = await setup();
    await patchXi(token, matchId, 'teamA', { playingXI: [ids.Rohit] });

    const res = await patchXi(token, matchId, 'teamA', { playingXI: [] });

    expect(res.status).toBe(200);
    expect(res.body.data.playingXI).toEqual([]);
    expect((await getSquad(token, matchId)).body.data.teamA.playingXI).toEqual([]);
  });

  it('collapses duplicate ids', async () => {
    const { token, matchId, ids } = await setup();

    const res = await patchXi(token, matchId, 'teamA', { playingXI: [ids.Rohit, ids.Rohit] });

    expect(res.body.data.playingXI).toEqual([ids.Rohit]);
  });

  it('does not change savedAt', async () => {
    const { token, matchId, ids } = await setup();
    const before = (await Match.findById(matchId)).squads.teamA.savedAt;

    const res = await patchXi(token, matchId, 'teamA', { playingXI: [ids.Rohit] });

    expect(res.status).toBe(200);
    expect((await Match.findById(matchId)).squads.teamA.savedAt).toEqual(before);
  });

  it('returns 404 PLAYER_NOT_ON_TEAM for a player outside this side\'s roster', async () => {
    const { token, user, matchId } = await setup();
    const stranger = await Player.create({ name: 'Stranger', nameLower: 'stranger', createdBy: user._id });

    const res = await patchXi(token, matchId, 'teamA', { playingXI: [String(stranger._id)] });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAYER_NOT_ON_TEAM');
  });

  it('returns 400 SQUAD_PLAYER_ON_BOTH_SIDES for a player already in the other side\'s squad', async () => {
    const { token, matchId } = await setup();
    const other = await putSquad(token, matchId, 'teamB', { players: [{ name: 'Kohli' }] });
    const kohliId = other.body.data.players[0].playerId;
    const match = await Match.findById(matchId);
    await Team.updateOne({ _id: match.teamA }, { $addToSet: { players: kohliId } });

    const res = await patchXi(token, matchId, 'teamA', { playingXI: [kohliId] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SQUAD_PLAYER_ON_BOTH_SIDES');
  });

  it('rejects a bad side, a non-array body and malformed ids', async () => {
    const { token, matchId } = await setup();

    expect((await patchXi(token, matchId, 'teamC', { playingXI: [] })).body.code).toBe('INVALID_SIDE');
    expect((await patchXi(token, matchId, 'teamA', { playingXI: 'x' })).body.code).toBe('INVALID_ID');
    expect((await patchXi(token, matchId, 'teamA', {})).body.code).toBe('INVALID_ID');
    expect((await patchXi(token, matchId, 'teamA', { playingXI: ['nope'] })).body.code).toBe('INVALID_ID');
  });

  it('refuses a non-owner and a completed match, and requires auth', async () => {
    const { token, matchId, ids } = await setup();
    const { token: strangerToken } = await createTestUser();

    const denied = await patchXi(strangerToken, matchId, 'teamA', { playingXI: [ids.Rohit] });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('MATCH_NOT_OWNED');

    await Match.updateOne({ _id: matchId }, { status: 'completed' });
    const done = await patchXi(token, matchId, 'teamA', { playingXI: [ids.Rohit] });
    expect(done.status).toBe(400);
    expect(done.body.code).toBe('MATCH_ALREADY_COMPLETED');

    const anon = await request(app).patch(`/api/v1/match/${matchId}/squad/teamA/playing-xi`).send({ playingXI: [] });
    expect(anon.status).toBe(401);
  });
});
