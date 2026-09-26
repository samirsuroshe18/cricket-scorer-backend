import request from 'supertest';
import mongoose from 'mongoose';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';
import { Team } from '../src/models/team.model.js';
import { Player } from '../src/models/player.model.js';

describe('PUT /:matchId/squad/:side', () => {
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

  const putSquad = (token, matchId, side, body) =>
    request(app).put(`/api/v1/match/${matchId}/squad/${side}`).set('Authorization', `Bearer ${token}`).send(body);

  const squadBody = (overrides = {}) => ({
    players: [
      { name: 'Rohit Sharma', role: 'batsman' },
      { name: 'Jasprit Bumrah', role: 'bowler' },
      { name: 'Rishabh Pant', role: 'allrounder' },
    ],
    captain: 'Rohit Sharma',
    viceCaptain: 'Jasprit Bumrah',
    keeper: 'Rishabh Pant',
    ...overrides,
  });

  const setup = async () => {
    const { token, user } = await createTestUser();
    const matchId = await createMatch(app, token);
    return { token, user, matchId };
  };

  it('stores the squad, sets player roles and rosters the team', async () => {
    const { token, matchId } = await setup();

    const res = await putSquad(token, matchId, 'teamA', squadBody());

    expect(res.status).toBe(200);
    expect(res.body.data.side).toBe('teamA');
    expect(res.body.data.players.map((p) => p.name)).toEqual(['Rohit Sharma', 'Jasprit Bumrah', 'Rishabh Pant']);
    const idOf = (name) => res.body.data.players.find((p) => p.name === name).playerId;
    expect(res.body.data.captainId).toBe(idOf('Rohit Sharma'));
    expect(res.body.data.viceCaptainId).toBe(idOf('Jasprit Bumrah'));
    expect(res.body.data.keeperId).toBe(idOf('Rishabh Pant'));

    const match = await Match.findById(matchId);
    expect(match.squads.teamA.players).toHaveLength(3);
    expect(String(match.squads.teamA.captainId)).toBe(idOf('Rohit Sharma'));
    expect(match.squads.teamB.players).toHaveLength(0);
    expect((await Player.findById(idOf('Jasprit Bumrah'))).role).toBe('bowler');
    const team = await Team.findById(match.teamA);
    expect(team.players.map(String)).toEqual(expect.arrayContaining(res.body.data.players.map((p) => p.playerId)));
  });

  it('is idempotent: replaying the same body returns the same squad and creates no duplicate players', async () => {
    const { token, matchId } = await setup();

    const first = await putSquad(token, matchId, 'teamA', squadBody());
    const playersAfterFirst = await Player.countDocuments();
    const second = await putSquad(token, matchId, 'teamA', squadBody());

    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(await Player.countDocuments()).toBe(playersAfterFirst);
  });

  it('replaces the whole squad: a dropped player leaves Match.squads but stays on Team.players', async () => {
    const { token, matchId } = await setup();
    const first = await putSquad(token, matchId, 'teamA', squadBody());
    const droppedId = first.body.data.players.find((p) => p.name === 'Rishabh Pant').playerId;

    const res = await putSquad(token, matchId, 'teamA', {
      players: [{ name: 'Rohit Sharma', role: 'batsman' }],
      captain: 'Rohit Sharma',
    });

    expect(res.status).toBe(200);
    const match = await Match.findById(matchId);
    expect(match.squads.teamA.players).toHaveLength(1);
    expect(match.squads.teamA.keeperId).toBeNull();
    const team = await Team.findById(match.teamA);
    expect(team.players.map(String)).toContain(droppedId);
  });

  it('accepts an empty squad, clearing the side', async () => {
    const { token, matchId } = await setup();
    await putSquad(token, matchId, 'teamA', squadBody());

    const res = await putSquad(token, matchId, 'teamA', { players: [] });

    expect(res.status).toBe(200);
    expect(res.body.data.players).toEqual([]);
    expect(res.body.data.captainId).toBeNull();
  });

  it('rejects the same person on both sides', async () => {
    const { token, matchId } = await setup();
    await putSquad(token, matchId, 'teamA', squadBody());

    const res = await putSquad(token, matchId, 'teamB', {
      players: [{ name: 'rohit sharma', role: 'batsman' }],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SQUAD_PLAYER_ON_BOTH_SIDES');
  });

  it('rejects an unknown side', async () => {
    const { token, matchId } = await setup();

    const res = await putSquad(token, matchId, 'teamC', squadBody());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SIDE');
  });

  it('rejects validation failures with the util error codes', async () => {
    const { token, matchId } = await setup();

    const dup = await putSquad(token, matchId, 'teamA', {
      players: [{ name: 'A', role: 'batsman' }, { name: ' a', role: 'bowler' }],
    });
    const vc = await putSquad(token, matchId, 'teamA', {
      players: [{ name: 'A', role: 'batsman' }],
      captain: 'A',
      viceCaptain: 'a',
    });

    expect(dup.body.code).toBe('SQUAD_PLAYER_NAMES_MUST_DIFFER');
    expect(vc.body.code).toBe('SQUAD_CAPTAIN_VC_MUST_DIFFER');
  });

  it('refuses once an innings has started', async () => {
    const { token, matchId } = await setup();
    await startLiveInnings(app, token, matchId);

    const res = await putSquad(token, matchId, 'teamA', squadBody());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INNINGS_ALREADY_STARTED');
  });

  it('refuses a non-owner, an unknown match and a completed match', async () => {
    const { token, matchId } = await setup();
    const { token: stranger } = await createTestUser();

    const notOwned = await putSquad(stranger, matchId, 'teamA', squadBody());
    const unknown = await putSquad(token, new mongoose.Types.ObjectId().toString(), 'teamA', squadBody());
    await Match.updateOne({ _id: matchId }, { status: 'completed' });
    const completed = await putSquad(token, matchId, 'teamA', squadBody());

    expect(notOwned.status).toBe(403);
    expect(notOwned.body.code).toBe('MATCH_NOT_OWNED');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('MATCH_NOT_FOUND');
    expect(completed.status).toBe(400);
    expect(completed.body.code).toBe('MATCH_ALREADY_COMPLETED');
  });

  it('exposes an empty squads object on the create response', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Team A', teamBName: 'Team B', totalOvers: 5 });

    const empty = { players: [], captainId: null, viceCaptainId: null, keeperId: null };
    expect(res.body.data.squads).toEqual({ teamA: empty, teamB: empty });
  });

  it('lets a player move from one side to the other after being dropped', async () => {
    const { token, matchId } = await setup();
    await putSquad(token, matchId, 'teamA', { players: [{ name: 'Rahul', role: 'batsman' }] });
    await putSquad(token, matchId, 'teamA', { players: [] });

    const res = await putSquad(token, matchId, 'teamB', { players: [{ name: 'Rahul', role: 'batsman' }] });

    expect(res.status).toBe(200);
    expect(res.body.data.players.map((p) => p.name)).toEqual(['Rahul']);
  });

  it('is not blocked by a player already on the opposing team roster from another match', async () => {
    const { token, matchId } = await setup();
    const first = await putSquad(token, matchId, 'teamA', { players: [{ name: 'Rahul', role: 'batsman' }] });
    const match = await Match.findById(matchId);
    await Team.updateOne({ _id: match.teamB }, { $addToSet: { players: first.body.data.players[0].playerId } });

    const res = await putSquad(token, matchId, 'teamA', { players: [{ name: 'Rahul', role: 'batsman' }] });

    expect(res.status).toBe(200);
  });

  it('leaves a stored role alone when the request omits it', async () => {
    const { token, user, matchId } = await setup();
    const pant = await Player.create({ name: 'Pant', nameLower: 'pant', createdBy: user._id, role: 'wicketkeeper' });

    const res = await putSquad(token, matchId, 'teamA', { players: [{ name: 'Pant' }], keeper: 'Pant' });

    expect(res.status).toBe(200);
    expect(res.body.data.players[0].playerId).toBe(String(pant._id));
    expect(res.body.data.players[0].role).toBe('wicketkeeper');
    expect((await Player.findById(pant._id)).role).toBe('wicketkeeper');
  });

  it("reuses a teammate's Player by playerId instead of creating a duplicate under the caller", async () => {
    const { token, matchId } = await setup();
    const { user: colleague } = await createTestUser();
    const shared = await Player.create({ name: 'Rahul', nameLower: 'rahul', createdBy: colleague._id, role: 'bowler' });
    const match = await Match.findById(matchId);
    await Team.updateOne({ _id: match.teamA }, { $addToSet: { players: shared._id } });
    const before = await Player.countDocuments();

    const res = await putSquad(token, matchId, 'teamA', {
      players: [{ playerId: String(shared._id), name: 'Rahul', role: 'bowler' }],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.players[0].playerId).toBe(String(shared._id));
    expect(await Player.countDocuments()).toBe(before);
  });
});
