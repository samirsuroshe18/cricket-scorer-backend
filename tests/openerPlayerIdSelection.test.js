import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';

// startInnings used to accept only free-text opener/bowler names, always
// resolved through findOrCreatePlayer — fine for a brand-new player, but it
// gave a scorer picking a player already on the roster no way to say "this
// exact person" the way selectBowler's bowlerId already lets them for a
// returning bowler (see bowlerNameCollision.test.js). These tests cover the
// same disambiguation now wired onto start-innings for all three opener
// roles, via optional strikerId/nonStrikerId/bowlerId.
describe('start-innings opener/bowler id disambiguation', () => {
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

  it('resolves openers and the opening bowler by id to the exact rostered players, without creating duplicate Player documents', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);

    const first = await startLiveInnings(app, token, matchId, {
      strikerName: 'Striker',
      nonStrikerName: 'Non-Striker',
      bowlerName: 'Bowler One',
    });

    // Innings hasn't faced a ball yet, so start-innings is still re-callable
    // — a scorer swapping the pair around before play begins. Pick the same
    // three Players back by id, with mismatched name text alongside each id
    // (as a client that trusts the picked player, not its own text field,
    // would send) — proving the id, not a name match, is what resolves
    // identity here.
    const second = await startLiveInnings(app, token, matchId, {
      strikerName: 'Whoever',
      strikerId: first.strike.nonStrikerId,
      nonStrikerName: 'Whoever Else',
      nonStrikerId: first.strike.strikerId,
      bowlerName: 'Someone New',
      bowlerId: first.bowler.bowlerId,
    });

    expect(second.strike.strikerId).toBe(first.strike.nonStrikerId);
    expect(second.strike.strikerName).toBe('Non-Striker');
    expect(second.strike.nonStrikerId).toBe(first.strike.strikerId);
    expect(second.strike.nonStrikerName).toBe('Striker');
    expect(second.bowler.bowlerId).toBe(first.bowler.bowlerId);
    expect(second.bowler.bowlerName).toBe('Bowler One');

    const players = await Player.find({});
    expect(players).toHaveLength(3);
  });

  it('rejects a malformed strikerId with INVALID_STRIKER_ID', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/start-innings`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        strikerName: 'Striker',
        strikerId: 'not-an-object-id',
        nonStrikerName: 'Non-Striker',
        bowlerName: 'Bowler',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_STRIKER_ID');
  });

  it('rejects a strikerId that names a real player not on the batting side\'s roster with STRIKER_NOT_FOUND', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);

    // Bowler One is only rostered on the bowling side (team B), never the
    // batting side (team A) — a valid Player id, just the wrong roster.
    const first = await startLiveInnings(app, token, matchId, { bowlerName: 'Bowler One' });

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/start-innings`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        strikerName: 'Someone',
        strikerId: first.bowler.bowlerId,
        nonStrikerName: 'Someone Else',
        bowlerName: 'Bowler',
      });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('STRIKER_NOT_FOUND');
  });

  it('rejects a nonStrikerId not on the batting side\'s roster with NON_STRIKER_NOT_FOUND', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);

    const first = await startLiveInnings(app, token, matchId, { bowlerName: 'Bowler One' });

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/start-innings`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        strikerName: 'Someone',
        nonStrikerName: 'Someone Else',
        nonStrikerId: first.bowler.bowlerId,
        bowlerName: 'Bowler',
      });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NON_STRIKER_NOT_FOUND');
  });

  it('rejects a bowlerId not on the bowling side\'s roster with BOWLER_NOT_FOUND', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);

    const first = await startLiveInnings(app, token, matchId, { strikerName: 'Striker' });

    const res = await request(app)
      .post(`/api/v1/match/${matchId}/start-innings`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        strikerName: 'Striker',
        nonStrikerName: 'Non-Striker',
        bowlerName: 'Someone',
        bowlerId: first.strike.strikerId,
      });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('BOWLER_NOT_FOUND');
  });
});
