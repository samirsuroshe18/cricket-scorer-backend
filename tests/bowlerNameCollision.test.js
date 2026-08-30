import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';

// findOrCreatePlayer keys on {teamId, name} — fine for a bowler genuinely
// returning to bowl again, but a second real bowler who happens to share a
// name with an earlier one used to silently resolve to the SAME Player
// document, merging two people's overs/runs/wickets into one line. Unlike
// the batsman case, "reject on name reuse" can't be the fix here: a bowler
// legitimately reuses their own name across overs. The fix instead makes
// "reuse an existing bowler" and "type a name" two different signals:
// selectBowler now accepts an optional bowlerId — present means "resolve to
// exactly this player" (a scorer re-picking a known bowler), absent means
// "this name is a new player", so a genuinely-new colliding name is rejected
// instead of silently merged.
describe('selectBowler bowlerId disambiguation', () => {
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

  const selectBowler = (token, matchId, body) =>
    request(app)
      .post(`/api/v1/match/${matchId}/select-bowler`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  // Advances the innings by one full (six dot-ball) over, so the next
  // selectBowler call is for a fresh, not-yet-started over.
  const bowlOutOver = async (token, matchId) => {
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
    }
  };

  it('rejects a name-only selection that collides with an existing bowler on the team', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId, { bowlerName: 'Opener' });

    await bowlOutOver(token, matchId); // over 1 (Opener) done

    const rahul = await selectBowler(token, matchId, { bowlerName: 'Rahul' });
    expect(rahul.status).toBe(200);

    await bowlOutOver(token, matchId); // over 2 (Rahul) done

    const suresh = await selectBowler(token, matchId, { bowlerName: 'Suresh' });
    expect(suresh.status).toBe(200);

    await bowlOutOver(token, matchId); // over 3 (Suresh) done

    // A second, different "Rahul" for over 4 — no bowlerId, so this must be
    // treated as a new player, which collides with the existing one.
    const secondRahul = await selectBowler(token, matchId, { bowlerName: 'Rahul' });

    expect(secondRahul.status).toBe(400);
    expect(secondRahul.body.code).toBe('BOWLER_NAME_ALREADY_EXISTS');

    const rahulDocs = await Player.find({ name: 'Rahul' });
    expect(rahulDocs).toHaveLength(1);
  });

  it('lets the same bowler return via bowlerId without colliding with their own name', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId, { bowlerName: 'Opener' });

    await bowlOutOver(token, matchId); // over 1 (Opener) done

    const rahul = await selectBowler(token, matchId, { bowlerName: 'Rahul' });
    expect(rahul.status).toBe(200);
    const rahulId = rahul.body.data.bowler.bowlerId;

    await bowlOutOver(token, matchId); // over 2 (Rahul) done

    const suresh = await selectBowler(token, matchId, { bowlerName: 'Suresh' });
    expect(suresh.status).toBe(200);

    await bowlOutOver(token, matchId); // over 3 (Suresh) done

    // The real Rahul, returning for over 4 — identified by id, not name.
    const rahulReturns = await selectBowler(token, matchId, {
      bowlerName: 'Rahul',
      bowlerId: rahulId,
    });

    expect(rahulReturns.status).toBe(200);
    expect(rahulReturns.body.data.bowler.bowlerId).toBe(rahulId);

    const rahulDocs = await Player.find({ name: 'Rahul' });
    expect(rahulDocs).toHaveLength(1);
  });
});
