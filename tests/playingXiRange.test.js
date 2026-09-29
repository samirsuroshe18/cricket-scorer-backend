import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';

// The per-match Playing XI size range a scorer sets at match creation and can
// adjust later: min defaults to 2 and can never go lower; max defaults to 11
// with no ceiling. See docs/api.md.
describe('Playing XI size range', () => {
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
  const create = (token, body = {}) =>
    request(app).post('/api/v1/match/create').set(auth(token)).send({
      teamAName: 'Team A', teamBName: 'Team B', totalOvers: 5, ...body,
    });

  describe('POST /match/create', () => {
    it('defaults to min 2, max 11 when omitted', async () => {
      const { token } = await createTestUser();

      const res = await create(token);

      expect(res.status).toBe(200);
      const match = await Match.findById(res.body.data.matchId);
      expect(match.minPlayingXi).toBe(2);
      expect(match.maxPlayingXi).toBe(11);
    });

    it('stores a scorer-provided range', async () => {
      const { token } = await createTestUser();

      const res = await create(token, { minPlayingXi: 6, maxPlayingXi: 8 });

      expect(res.status).toBe(200);
      const match = await Match.findById(res.body.data.matchId);
      expect(match.minPlayingXi).toBe(6);
      expect(match.maxPlayingXi).toBe(8);
    });

    it('rejects a min below 2', async () => {
      const { token } = await createTestUser();

      const res = await create(token, { minPlayingXi: 1, maxPlayingXi: 11 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PLAYING_XI_RANGE');
    });

    it('rejects a max below min', async () => {
      const { token } = await createTestUser();

      const res = await create(token, { minPlayingXi: 8, maxPlayingXi: 6 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PLAYING_XI_RANGE');
    });

    it('rejects a non-integer min or max', async () => {
      const { token } = await createTestUser();

      expect((await create(token, { minPlayingXi: 2.5 })).body.code).toBe('INVALID_PLAYING_XI_RANGE');
      expect((await create(token, { maxPlayingXi: 'x' })).body.code).toBe('INVALID_PLAYING_XI_RANGE');
    });
  });

  describe('PATCH /match/:matchId/playing-xi-range', () => {
    const patchRange = (token, matchId, body) =>
      request(app).patch(`/api/v1/match/${matchId}/playing-xi-range`).set(auth(token)).send(body);

    it('updates the range after creation', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;

      const res = await patchRange(token, matchId, { minPlayingXi: 4, maxPlayingXi: 9 });

      expect(res.status).toBe(200);
      expect(res.body.data.minPlayingXi).toBe(4);
      expect(res.body.data.maxPlayingXi).toBe(9);
      const match = await Match.findById(matchId);
      expect(match.minPlayingXi).toBe(4);
      expect(match.maxPlayingXi).toBe(9);
    });

    it('rejects the same invalid shapes as create', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;

      expect((await patchRange(token, matchId, { minPlayingXi: 1, maxPlayingXi: 11 })).body.code)
        .toBe('INVALID_PLAYING_XI_RANGE');
      expect((await patchRange(token, matchId, { minPlayingXi: 8, maxPlayingXi: 6 })).body.code)
        .toBe('INVALID_PLAYING_XI_RANGE');
    });

    it('refuses a non-owner, requires auth, and 404s an unknown match', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;
      const { token: strangerToken } = await createTestUser();

      const denied = await patchRange(strangerToken, matchId, { minPlayingXi: 3, maxPlayingXi: 9 });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('MATCH_NOT_OWNED');

      const anon = await request(app)
        .patch(`/api/v1/match/${matchId}/playing-xi-range`)
        .send({ minPlayingXi: 3, maxPlayingXi: 9 });
      expect(anon.status).toBe(401);

      const missing = await patchRange(token, '507f1f77bcf86cd799439011', { minPlayingXi: 3, maxPlayingXi: 9 });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('MATCH_NOT_FOUND');
    });

    it('allowed once the match is completed too, unlike squad edits', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;
      await Match.updateOne({ _id: matchId }, { status: 'completed' });

      const res = await patchRange(token, matchId, { minPlayingXi: 3, maxPlayingXi: 9 });

      expect(res.status).toBe(200);
    });
  });

  describe('enforcing the range when a Playing XI is saved', () => {
    const putSquad = (token, matchId, side, body) =>
      request(app).put(`/api/v1/match/${matchId}/squad/${side}`).set(auth(token)).send(body);
    const patchXi = (token, matchId, side, playingXI) =>
      request(app).patch(`/api/v1/match/${matchId}/squad/${side}/playing-xi`).set(auth(token)).send({ playingXI });

    const setupRoster = async (token, matchId, names) => {
      const res = await putSquad(token, matchId, 'teamA', { players: names.map((name) => ({ name })) });
      return Object.fromEntries(res.body.data.players.map((p) => [p.name, p.playerId]));
    };

    it('PATCH .../playing-xi rejects a count below the match minimum', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;
      const ids = await setupRoster(token, matchId, ['A', 'B']);

      const res = await patchXi(token, matchId, 'teamA', [ids.A]);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PLAYING_XI_TOO_SMALL');
    });

    it('PATCH .../playing-xi rejects a count above the match maximum', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token, { minPlayingXi: 2, maxPlayingXi: 3 })).body.data.matchId;
      const ids = await setupRoster(token, matchId, ['A', 'B', 'C', 'D']);

      const res = await patchXi(token, matchId, 'teamA', [ids.A, ids.B, ids.C, ids.D]);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PLAYING_XI_TOO_LARGE');
    });

    it('PATCH .../playing-xi accepts a count inside the range', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;
      const ids = await setupRoster(token, matchId, ['A', 'B']);

      const res = await patchXi(token, matchId, 'teamA', [ids.A, ids.B]);

      expect(res.status).toBe(200);
    });

    it('PUT /squad rejects a playingXI count outside the range, same as PATCH', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;

      const res = await putSquad(token, matchId, 'teamA', {
        players: [{ name: 'A' }, { name: 'B' }],
        playingXI: ['A'],
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PLAYING_XI_TOO_SMALL');
    });

    it('PUT /squad leaving playingXI unset is unaffected by the range', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;

      const res = await putSquad(token, matchId, 'teamA', { players: [{ name: 'A' }] });

      expect(res.status).toBe(200);
    });
  });

  describe('start-innings requires both sides to have a valid Playing XI', () => {
    const putSquad = (token, matchId, side, body) =>
      request(app).put(`/api/v1/match/${matchId}/squad/${side}`).set(auth(token)).send(body);
    const startInnings = (token, matchId, body = {}) =>
      request(app).post(`/api/v1/match/${matchId}/start-innings`).set(auth(token)).send({
        strikerName: 'Striker', nonStrikerName: 'Non-Striker', bowlerName: 'Bowler', ...body,
      });

    it('rejects with PLAYING_XI_NOT_SET when neither side has one', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;

      const res = await startInnings(token, matchId);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PLAYING_XI_NOT_SET');
    });

    it('rejects with PLAYING_XI_NOT_SET when only one side has one', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;
      await putSquad(token, matchId, 'teamA', {
        players: [{ name: 'Striker' }, { name: 'Non-Striker' }],
        playingXI: ['Striker', 'Non-Striker'],
      });

      const res = await startInnings(token, matchId);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PLAYING_XI_NOT_SET');
    });

    it('rejects with the size codes when a side\'s already-saved XI stops satisfying a range tightened afterwards', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;
      await putSquad(token, matchId, 'teamA', {
        players: [{ name: 'Striker' }, { name: 'Non-Striker' }],
        playingXI: ['Striker', 'Non-Striker'],
      });
      await putSquad(token, matchId, 'teamB', {
        players: [{ name: 'Bowler' }, { name: 'Fielder' }, { name: 'Extra' }],
        playingXI: ['Bowler', 'Fielder', 'Extra'],
      });
      await request(app)
        .patch(`/api/v1/match/${matchId}/playing-xi-range`)
        .set(auth(token))
        .send({ minPlayingXi: 3, maxPlayingXi: 11 });

      const res = await startInnings(token, matchId);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PLAYING_XI_TOO_SMALL');
    });

    it('starts once both sides have a valid Playing XI', async () => {
      const { token } = await createTestUser();
      const matchId = (await create(token)).body.data.matchId;
      await putSquad(token, matchId, 'teamA', {
        players: [{ name: 'Striker' }, { name: 'Non-Striker' }],
        playingXI: ['Striker', 'Non-Striker'],
      });
      await putSquad(token, matchId, 'teamB', {
        players: [{ name: 'Bowler' }, { name: 'Fielder' }],
        playingXI: ['Bowler', 'Fielder'],
      });

      const res = await startInnings(token, matchId);

      expect(res.status).toBe(200);
    });
  });
});
