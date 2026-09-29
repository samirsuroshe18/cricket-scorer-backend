import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';
import { Player } from '../src/models/player.model.js';

describe('GET /:matchId/squad', () => {
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
  const getSquad = (token, matchId) =>
    request(app).get(`/api/v1/match/${matchId}/squad`).set(auth(token));
  const putSquad = (token, matchId, side, body) =>
    request(app).put(`/api/v1/match/${matchId}/squad/${side}`).set(auth(token)).send(body);

  const setup = async () => {
    const { token, user } = await createTestUser();
    const matchId = await createMatch(app, token);
    return { token, user, matchId };
  };

  it('reads a never-saved match as empty sides with no XI', async () => {
    const { token, matchId } = await setup();

    const res = await getSquad(token, matchId);

    expect(res.status).toBe(200);
    expect(res.body.data.matchId).toBe(matchId);
    expect(res.body.data.inningsStarted).toBe(false);
    for (const side of ['teamA', 'teamB']) {
      expect(res.body.data[side]).toMatchObject({
        players: [], captainId: null, viceCaptainId: null, keeperId: null, playingXI: null, savedAt: null,
      });
      expect(typeof res.body.data[side].teamId).toBe('string');
    }
  });

  it('returns a saved side with roles, jersey numbers, designations, XI and savedAt', async () => {
    const { token, matchId } = await setup();
    await putSquad(token, matchId, 'teamA', {
      players: [{ name: 'Rohit', role: 'batsman' }, { name: 'Bumrah', role: 'bowler' }, { name: 'Kohli' }],
      captain: 'Rohit',
      // Two members, not one — every match now carries a Playing XI minimum
      // of at least 2 (see tests/playingXiRange.test.js).
      playingXI: ['Bumrah', 'Kohli'],
    });
    await Player.updateOne({ nameLower: 'rohit' }, { jerseyNumber: 45 });

    const res = await getSquad(token, matchId);

    const side = res.body.data.teamA;
    expect(side.players.map((p) => p.name)).toEqual(['Rohit', 'Bumrah', 'Kohli']);
    expect(side.players[0]).toMatchObject({ role: 'batsman', jerseyNumber: 45 });
    expect(side.players[1].jerseyNumber).toBeNull();
    expect(side.captainId).toBe(side.players[0].playerId);
    expect(side.playingXI).toEqual([side.players[1].playerId, side.players[2].playerId]);
    expect(side.savedAt).toEqual(expect.any(String));
    expect(res.body.data.teamB.players).toEqual([]);
  });

  // A set-but-empty XI is no longer reachable through the API at all — every
  // match now carries a Playing XI minimum of at least 2, so a save of `[]`
  // is rejected outright (PLAYING_XI_TOO_SMALL; see
  // tests/playingXiRange.test.js) rather than persisting. Only "never set"
  // (playingXI: null, above) remains.

  it('omits soft-deleted players', async () => {
    const { token, matchId } = await setup();
    await putSquad(token, matchId, 'teamA', { players: [{ name: 'Rohit' }, { name: 'Gone' }] });
    await Player.updateOne({ nameLower: 'gone' }, { isDeleted: true });

    const res = await getSquad(token, matchId);

    expect(res.body.data.teamA.players.map((p) => p.name)).toEqual(['Rohit']);
  });

  it('reports inningsStarted once an innings exists', async () => {
    const { token, matchId } = await setup();
    await startLiveInnings(app, token, matchId);

    const res = await getSquad(token, matchId);

    expect(res.body.data.inningsStarted).toBe(true);
  });

  it('lets the assigned scorer read and refuses anyone else', async () => {
    const { token, matchId } = await setup();
    const { user: delegate, token: delegateToken } = await createTestUser();
    const { token: strangerToken } = await createTestUser();
    await Match.updateOne({ _id: matchId }, { assignedScorer: delegate._id });

    expect((await getSquad(delegateToken, matchId)).status).toBe(200);
    const denied = await getSquad(strangerToken, matchId);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('MATCH_NOT_OWNED');
    expect((await getSquad(token, matchId)).status).toBe(200);
  });

  it('returns 404 MATCH_NOT_FOUND for an unknown or malformed id', async () => {
    const { token } = await setup();

    for (const id of ['665f1a2b3c4d5e6f7a8b9c99', 'not-an-id']) {
      const res = await getSquad(token, id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('MATCH_NOT_FOUND');
    }
  });

  it('still reads a completed match', async () => {
    const { token, matchId } = await setup();
    await Match.updateOne({ _id: matchId }, { status: 'completed' });

    expect((await getSquad(token, matchId)).status).toBe(200);
  });

  it('requires authentication', async () => {
    const { matchId } = await setup();

    expect((await request(app).get(`/api/v1/match/${matchId}/squad`)).status).toBe(401);
  });
});
