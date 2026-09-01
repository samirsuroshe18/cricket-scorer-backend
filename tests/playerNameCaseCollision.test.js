import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';
import { Player } from '../src/models/player.model.js';

// findOrCreatePlayer used to key on {teamId, name} verbatim while every
// collision rule around it (openers must differ, bowler can't bowl
// consecutive overs, incoming-batsman reuse — see bowlerNameCollision.test.js
// and incomingBatsmanNameCollision.test.js) compares names case-insensitively.
// None of those same-innings checks apply to the one place a name genuinely
// gets reused across roles: a batsman from innings 1 who bowls in innings 2,
// once the sides swap. "Rahul" then "rahul" for that same real player used to
// pass every check and silently create a second Player document instead of
// resolving to the first — fragmenting his batting and bowling stats onto two
// different lines.
describe('player identity is case-insensitive', () => {
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

  const bowlOutOver = async (token, matchId) => {
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
    }
  };

  it('resolves a case-different name to the same real player across the innings 1/2 role swap, instead of fragmenting into a second Player document', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 1 });

    const innings1 = await startLiveInnings(app, token, matchId, {
      strikerName: 'Rahul',
      nonStrikerName: 'Non-Striker',
      bowlerName: 'Opener',
    });
    const rahulBattingId = innings1.strike.strikerId;

    await bowlOutOver(token, matchId); // completes innings 1 (totalOvers: 1)

    const midMatch = await Match.findById(matchId);
    expect(midMatch.currentInnings).toBe(2);

    // Innings 2's opening bowler is drawn from team A's roster — the same
    // team "Rahul" just opened the batting for — typed back in a different
    // case, exactly as a scorer working from memory would.
    const innings2 = await startLiveInnings(app, token, matchId, {
      strikerName: 'Someone',
      nonStrikerName: 'Someone Else',
      bowlerName: 'rahul',
    });

    expect(innings2.bowler.bowlerId).toBe(rahulBattingId);

    const rahulDocs = await Player.find({ nameLower: 'rahul' });
    expect(rahulDocs).toHaveLength(1);
  });

  it('rejects a case-different name-only bowler selection that collides with an existing bowler, same as an exact-case collision', async () => {
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

    // A second, different "RAHUL" for over 4 — no bowlerId, and a different
    // case than the existing Player, so this must still be treated as a new
    // player colliding with the existing one, not silently merged.
    const secondRahul = await selectBowler(token, matchId, { bowlerName: 'RAHUL' });

    expect(secondRahul.status).toBe(400);
    expect(secondRahul.body.code).toBe('BOWLER_NAME_ALREADY_EXISTS');

    const rahulDocs = await Player.find({ nameLower: 'rahul' });
    expect(rahulDocs).toHaveLength(1);
  });
});
