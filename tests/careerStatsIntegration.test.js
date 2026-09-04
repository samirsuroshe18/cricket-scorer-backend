import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { PlayerMatchStats } from '../src/models/playerMatchStats.model.js';
import { CareerStats } from '../src/models/careerStats.model.js';

// End-to-end: real matches, scored through the real API, driving the real
// finishBallDelivery -> generateScorecard -> applyCareerStatsIncrement hook.
// Pure-function arithmetic is covered in careerStats.test.js; this file
// proves the whole pipeline reaches the same numbers, and covers what only a
// real database can: the player-identity rework's roster rules, and a
// genuine correction via undo-then-rescore.
describe('career stats — end to end', () => {
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

  // Every worked-example number below is reproduced in the PR description /
  // chat response for hand verification. Two totalOvers:1 matches (one over
  // = 6 legal balls per innings), scored so Rahul's contribution to each
  // ball is unambiguous:
  //
  // Match 1, innings 1 (Rahul bats for Team A): 6,6,6,6,6,0 — six legal
  //   balls, all even runs so strike never rotates and Rahul faces every
  //   ball. 30 runs, 6 balls, not out (innings ends via overs_complete).
  // Match 1, innings 2 (Rahul bowls for Team A, sides swapped): six dot
  //   balls conceding 1 run each is too fiddly to keep even/odd-safe for a
  //   test that doesn't care who's on strike, so the batting side scores
  //   1 run every ball — 6 legal balls, 6 runs conceded, 0 wickets.
  //
  // Match 2, innings 1 (Rahul bats for Team A again): 6,6,4,4,[wicket],0 —
  //   four even-run balls (20 runs, strike held throughout) then a
  //   0-run bowled dismissal on ball 5, then a new batsman faces ball 6.
  //   Rahul: 20 runs, 5 balls, OUT (dismissalType bowled).
  // Match 2, innings 2 (Rahul bowls for Team A again): six balls, a wicket
  //   on ball 3 with 0 runs off every ball — a maiden over: 6 legal
  //   deliveries, 0 runs, 1 wicket, 1 maiden.
  //
  // Hand-verified cumulative CareerStats after both matches:
  //   runs = 30 + 20 = 50
  //   timesOut = 0 + 1 = 1        (match 1 not out, match 2 out)
  //   average = 50 / 1 = 50       (NOT 50 / inningsBatted(2) = 25)
  //   ballsFaced = 6 + 5 = 11
  //   strikeRate = (50/11)*100 = 454.5454... -> 454.55
  //   highScore = 30 (match 1's 30 beats match 2's 20), not out
  //   fifties = 0, hundreds = 0 (30 and 20 both under 50)
  //   legalDeliveries = 6 + 6 = 12
  //   runsConceded = 6 + 0 = 6
  //   wickets = 0 + 1 = 1
  //   maidens = 0 + 1 = 1
  //   economy = 6 / (12/6) = 6/2 = 3
  //   bestBowling = {wickets: 1, runs: 0}  (match 2 beats match 1's 0-for-6)
  //   matchesPlayed = 2, inningsBatted = 2, inningsBowled = 2
  it('computes cumulative career stats across two matches, average correctly divided by dismissals not innings', async () => {
    const { token } = await createTestUser();

    // --- Match 1 ---
    const match1 = await createMatch(app, token, { totalOvers: 1 });
    await startLiveInnings(app, token, match1, {
      strikerName: 'Rahul',
      nonStrikerName: 'Ravi',
      bowlerName: 'BowlerB1',
    });

    for (const runs of [6, 6, 6, 6, 6, 0]) {
      const res = await scoreDotBall(app, token, match1, { runs });
      expect(res.status).toBe(200);
    }

    await startLiveInnings(app, token, match1, {
      strikerName: 'Suresh',
      nonStrikerName: 'Sachin',
      bowlerName: 'Rahul', // Team A now bowls — same Rahul, opposite role
    });

    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, match1, { runs: 1 });
      expect(res.status).toBe(200);
    }

    // --- Match 2: a fresh match, same scorer, same name "Rahul" ---
    const match2 = await createMatch(app, token, { totalOvers: 1 });
    await startLiveInnings(app, token, match2, {
      strikerName: 'Rahul',
      nonStrikerName: 'Ravi',
      bowlerName: 'BowlerB2',
    });

    for (const runs of [6, 6, 4, 4]) {
      const res = await scoreDotBall(app, token, match2, { runs });
      expect(res.status).toBe(200);
    }
    const wicketRes = await scoreDotBall(app, token, match2, {
      runs: 0,
      wicketType: 'bowled',
      dismissedBatsman: 'striker',
      incomingBatsmanName: 'NewBatsman',
    });
    expect(wicketRes.status).toBe(200);
    const lastBall = await scoreDotBall(app, token, match2, { runs: 0 });
    expect(lastBall.status).toBe(200);

    await startLiveInnings(app, token, match2, {
      strikerName: 'Zaheer',
      nonStrikerName: 'Zubin',
      bowlerName: 'Rahul',
    });

    for (let i = 0; i < 2; i += 1) {
      const res = await scoreDotBall(app, token, match2, { runs: 0 });
      expect(res.status).toBe(200);
    }
    const secondWicket = await scoreDotBall(app, token, match2, {
      runs: 0,
      wicketType: 'bowled',
      dismissedBatsman: 'striker',
      incomingBatsmanName: 'NewBatsman2',
    });
    expect(secondWicket.status).toBe(200);
    for (let i = 0; i < 3; i += 1) {
      const res = await scoreDotBall(app, token, match2, { runs: 0 });
      expect(res.status).toBe(200);
    }

    // Exactly one persistent "Rahul" Player across both matches — the whole
    // point of the identity rework.
    const rahulDocs = await Player.find({ nameLower: 'rahul' });
    expect(rahulDocs).toHaveLength(1);
    const rahulId = rahulDocs[0]._id;

    // Two PlayerMatchStats rows, one per match, each carrying both lines.
    const rows = await PlayerMatchStats.find({ playerId: rahulId }).sort({ matchId: 1 });
    expect(rows).toHaveLength(2);

    const career = await CareerStats.findOne({ playerId: rahulId });

    expect(career.matchesPlayed).toBe(2);
    expect(career.inningsBatted).toBe(2);
    expect(career.runs).toBe(50);
    expect(career.ballsFaced).toBe(11);
    expect(career.timesOut).toBe(1);
    expect(career.notOuts).toBe(1);
    expect(career.fifties).toBe(0);
    expect(career.hundreds).toBe(0);
    expect(career.highScore).toMatchObject({ runs: 30, isNotOut: true });

    expect(career.inningsBowled).toBe(2);
    expect(career.legalDeliveries).toBe(12);
    expect(career.runsConceded).toBe(6);
    expect(career.wickets).toBe(1);
    expect(career.maidens).toBe(1);
    expect(career.bestBowling).toMatchObject({ wickets: 1, runs: 0 });
  });

  it('rejects an incoming batsman name that collides with a player already rostered on the opposing team', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 1 });

    // Team A opens with "Rahul" at the crease; Team B's opening bowler is
    // "Vijay".
    await startLiveInnings(app, token, matchId, {
      strikerName: 'Rahul',
      nonStrikerName: 'Ravi',
      bowlerName: 'Vijay',
    });

    // A wicket falls, and the incoming batsman is named "Vijay" — the exact
    // name already rostered on the OPPOSING (bowling) side this match. Two
    // different real people can plausibly share a name across two ad-hoc
    // sides; this must be rejected, not silently merged into the bowler's
    // own Player document.
    const res = await scoreDotBall(app, token, matchId, {
      runs: 0,
      wicketType: 'bowled',
      dismissedBatsman: 'striker',
      incomingBatsmanName: 'Vijay',
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PLAYER_ON_OPPOSING_TEAM');

    // Confirms the rejection actually protected the data: still exactly one
    // "Vijay" Player document, not a merge and not a second one either.
    const vijayDocs = await Player.find({ nameLower: 'vijay' });
    expect(vijayDocs).toHaveLength(1);
  });

  it('rejects a mid-match bowler change whose name collides with a player already rostered on the opposing (batting) team', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 2 });

    // Team A opens with "Rahul" at the crease; Team B opens the bowling
    // with "Suresh".
    await startLiveInnings(app, token, matchId, {
      strikerName: 'Rahul',
      nonStrikerName: 'Ravi',
      bowlerName: 'Suresh',
    });
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId);
      expect(res.status).toBe(200);
    }

    // Over 2's bowler, for Team B, is named "Rahul" — the exact name
    // already rostered on the OPPOSING (batting) side this match. This is
    // resolveBowler's own opposing-roster check, distinct from
    // findOrCreatePlayer's — both must enforce the same rule.
    const res = await selectBowler(token, matchId, { bowlerName: 'Rahul' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PLAYER_ON_OPPOSING_TEAM');

    const rahulDocs = await Player.find({ nameLower: 'rahul' });
    expect(rahulDocs).toHaveLength(1);
  });

  it('self-corrects career stats when the completing ball of a match is undone and rescored', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token, { totalOvers: 1 });

    // Only the match's very last ball is undoable, and that ball is always
    // in the second (match-completing) innings — so Rahul has to be the one
    // batting THERE for this test to correct a batting figure at all. Team
    // A bats first with unrelated openers, scoring high enough (36, target
    // 37) that Team B's own innings below can't reach the target early and
    // cut the over short before ball 6.
    await startLiveInnings(app, token, matchId, {
      strikerName: 'OpenerA1',
      nonStrikerName: 'OpenerA2',
      bowlerName: 'BowlerB1',
    });
    for (let i = 0; i < 6; i += 1) {
      const res = await scoreDotBall(app, token, matchId, { runs: 6 });
      expect(res.status).toBe(200);
    }

    await startLiveInnings(app, token, matchId, {
      strikerName: 'Rahul',
      nonStrikerName: 'Ravi',
      bowlerName: 'BowlerA1',
    });
    for (const runs of [4, 4, 4, 4, 4]) {
      const res = await scoreDotBall(app, token, matchId, { runs });
      expect(res.status).toBe(200);
    }
    // Ball 6, scored as a dot ball first — this is the innings-completing
    // (and, since totalOvers:1, match-completing) delivery.
    const originalLastBall = await scoreDotBall(app, token, matchId, { runs: 0 });
    expect(originalLastBall.status).toBe(200);
    const lastBallId = originalLastBall.body.data.ballEventId;

    const afterFirstCompletion = await CareerStats.findOne({
      playerId: (await Player.findOne({ nameLower: 'rahul' }))._id,
    });
    expect(afterFirstCompletion.runs).toBe(20); // 4*5 + 0

    // Undo the completing ball, then rescore it as a boundary instead of a
    // dot ball — Rahul's true final total is 24, not 20.
    const undoRes = await request(app)
      .post(`/api/v1/match/${matchId}/undo-ball`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ballEventId: lastBallId });
    expect(undoRes.status).toBe(200);
    expect(undoRes.body.data.matchReopened).toBe(true);

    const correctedLastBall = await scoreDotBall(app, token, matchId, { runs: 4 });
    expect(correctedLastBall.status).toBe(200);

    const rahul = await Player.findOne({ nameLower: 'rahul' });
    const career = await CareerStats.findOne({ playerId: rahul._id });

    // The corrected total, not 20 + 24 = 44 from double-counting the match.
    expect(career.runs).toBe(24);
    expect(career.matchesPlayed).toBe(1);
    expect(career.inningsBatted).toBe(1);
    expect(career.highScore).toMatchObject({ runs: 24 });

    const rows = await PlayerMatchStats.find({ playerId: rahul._id });
    expect(rows).toHaveLength(1); // replaced, not appended
    expect(rows[0].battingLine.runs).toBe(24);
  });
});
