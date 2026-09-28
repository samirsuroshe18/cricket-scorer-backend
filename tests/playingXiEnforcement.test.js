import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Inning } from '../src/models/inning.model.js';

// The Playing XI restricts who the ONLINE scoring endpoints accept, only once
// a side's XI is set. POST /sync never checks it: a queued event was chosen
// from the XI as it stood when it was queued.
describe('Playing XI enforcement', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withOrganization: true });
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
  const patchXi = (token, matchId, side, playingXI) =>
    request(app).patch(`/api/v1/match/${matchId}/squad/${side}/playing-xi`).set(auth(token)).send({ playingXI });
  const startInnings = (token, matchId, body) =>
    request(app).post(`/api/v1/match/${matchId}/start-innings`).set(auth(token)).send({
      strikerName: 'Bat One', nonStrikerName: 'Bat Two', bowlerName: 'Bowl One', ...body,
    });
  const selectBowler = (token, matchId, body) =>
    request(app).post(`/api/v1/match/${matchId}/select-bowler`).set(auth(token)).send(body);
  const sync = (token, matchId, events) =>
    request(app).post(`/api/v1/match/${matchId}/sync`).set(auth(token)).send({
      inningsNumber: 1, baseAbsoluteBallSeq: 0, events,
    });

  const BATTERS = ['Bat One', 'Bat Two', 'Bat Three', 'Bat Bench'];
  const BOWLERS = ['Bowl One', 'Bowl Two', 'Bowl Bench'];

  // teamA bats first (no toss => battingFirst defaults to teamA). `batXi` /
  // `bowlXi` are per-side XI names; `null` leaves that side's XI unset. (Not
  // `undefined`: a destructuring default would silently turn that into the XI.)
  const setup = async ({ batXi = ['Bat One', 'Bat Two', 'Bat Three'], bowlXi = ['Bowl One', 'Bowl Two'] } = {}) => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    const batting = await putSquad(token, matchId, 'teamA', {
      players: BATTERS.map((name) => ({ name })),
      ...(batXi !== null && { playingXI: batXi }),
    });
    const bowling = await putSquad(token, matchId, 'teamB', {
      players: BOWLERS.map((name) => ({ name })),
      ...(bowlXi !== null && { playingXI: bowlXi }),
    });
    const idOf = (res, name) => res.body.data.players.find((p) => p.name === name).playerId;
    return {
      token,
      matchId,
      bat: (name) => idOf(batting, name),
      bowl: (name) => idOf(bowling, name),
    };
  };

  const sixDots = (token, matchId) => (async () => {
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
    }
  })();

  describe('start-innings', () => {
    it('allows any names while a side has no XI set', async () => {
      const { token, matchId } = await setup({ batXi: null, bowlXi: null });

      const res = await startInnings(token, matchId, { strikerName: 'Someone New', bowlerName: 'Bowl Bench' });

      expect(res.status).toBe(200);
    });

    it('rejects an opener who is not in the batting XI, and a brand-new typed name', async () => {
      const { token, matchId } = await setup();

      for (const strikerName of ['Bat Bench', 'Brand New']) {
        const res = await startInnings(token, matchId, { strikerName });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('PLAYER_NOT_IN_PLAYING_XI');
      }
      const nonStriker = await startInnings(token, matchId, { nonStrikerName: 'Bat Bench' });
      expect(nonStriker.body.code).toBe('PLAYER_NOT_IN_PLAYING_XI');
    });

    it('rejects an opening bowler who is not in the bowling XI', async () => {
      const { token, matchId } = await setup();

      const res = await startInnings(token, matchId, { bowlerName: 'Bowl Bench' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PLAYER_NOT_IN_PLAYING_XI');
    });

    it('accepts XI members by name and by id', async () => {
      const { token, matchId, bat, bowl } = await setup();

      const byName = await startInnings(token, matchId);
      expect(byName.status).toBe(200);

      const byId = await startInnings(token, matchId, {
        strikerName: 'Bat One', strikerId: bat('Bat One'),
        nonStrikerName: 'Bat Three', nonStrikerId: bat('Bat Three'),
        bowlerName: 'Bowl Two', bowlerId: bowl('Bowl Two'),
      });
      expect(byId.status).toBe(200);
    });

    it('rejects everyone when the XI is set but empty, yet allows everyone when it is unset', async () => {
      const empty = await setup({ batXi: [], bowlXi: null });
      const rejected = await startInnings(empty.token, empty.matchId);
      expect(rejected.status).toBe(400);
      expect(rejected.body.code).toBe('PLAYER_NOT_IN_PLAYING_XI');

      const unset = await setup({ batXi: null, bowlXi: null });
      expect((await startInnings(unset.token, unset.matchId)).status).toBe(200);
    });
  });

  describe('select-bowler', () => {
    it('rejects a bowler outside the XI and accepts one inside it', async () => {
      const { token, matchId, bowl } = await setup();
      await startInnings(token, matchId);
      await sixDots(token, matchId);

      const benched = await selectBowler(token, matchId, { bowlerName: 'Bowl Bench', bowlerId: bowl('Bowl Bench') });
      expect(benched.status).toBe(400);
      expect(benched.body.code).toBe('PLAYER_NOT_IN_PLAYING_XI');

      const inXi = await selectBowler(token, matchId, { bowlerName: 'Bowl Two', bowlerId: bowl('Bowl Two') });
      expect(inXi.status).toBe(200);
    });
  });

  describe('score-ball incoming batsman', () => {
    const wicket = (token, matchId, incomingBatsmanName) =>
      scoreDotBall(app, token, matchId, { wicketType: 'bowled', dismissedBatsman: 'striker', incomingBatsmanName });

    it('rejects an incoming batsman outside the XI and accepts one inside it', async () => {
      const { token, matchId } = await setup();
      await startInnings(token, matchId);

      const benched = await wicket(token, matchId, 'Bat Bench');
      expect(benched.status).toBe(400);
      expect(benched.body.code).toBe('PLAYER_NOT_IN_PLAYING_XI');

      expect((await wicket(token, matchId, 'Bat Three')).status).toBe(200);
    });

    it('ignores the name on the final wicket rather than rejecting it', async () => {
      const { token, matchId } = await setup();
      await startInnings(token, matchId);
      await Inning.updateOne({ matchId }, { wickets: 9 });

      const res = await wicket(token, matchId, 'Nobody In The XI');

      expect(res.status).toBe(200);
    });
  });

  describe('benching mid-innings', () => {
    it('does not stop scoring by the current bowler after they are benched', async () => {
      const { token, matchId, bowl } = await setup();
      await startInnings(token, matchId);

      const moved = await patchXi(token, matchId, 'teamB', [bowl('Bowl Two')]);
      expect(moved.status).toBe(200);

      expect((await scoreDotBall(app, token, matchId)).status).toBe(200);
    });
  });

  describe('POST /sync', () => {
    it('replays a bowler event and an incoming-batsman event for players outside the XI', async () => {
      const { token, matchId, bowl } = await setup();
      await startInnings(token, matchId);

      const dot = () => ({ type: 'ball', runs: 0, idempotencyKey: randomUUID() });
      const events = [
        { type: 'ball', runs: 0, idempotencyKey: randomUUID(), wicketType: 'bowled', dismissedBatsman: 'striker', incomingBatsmanName: 'Bat Bench' },
        dot(), dot(), dot(), dot(), dot(),
        { type: 'bowler', bowlerName: 'Bowl Bench', bowlerId: bowl('Bowl Bench') },
      ];

      const res = await sync(token, matchId, events);

      expect(res.status).toBe(200);
      expect(res.body.data.failedCode).toBeNull();
      expect(res.body.data.appliedCount).toBe(7);
    });
  });
});
