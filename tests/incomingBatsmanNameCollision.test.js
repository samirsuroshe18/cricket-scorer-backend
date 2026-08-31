import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';

// findOrCreatePlayer keys on {teamId, name} with no guard against a name
// already used earlier in the same innings by a batsman who has since been
// dismissed (only the current crease pair was checked). Two different real
// players sharing a name — plausible on an informal roster — silently become
// one Player document once the first is out and gone from the crease, and
// buildBattingScores then merges their runs/balls under one line.
describe('incoming batsman name reused from earlier in the innings', () => {
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

  const bowledOut = (app, token, matchId, incomingBatsmanName) =>
    scoreDotBall(app, token, matchId, {
      wicketType: 'bowled',
      dismissedBatsman: 'striker',
      incomingBatsmanName,
    });

  it('is rejected once the earlier same-named batsman has left the crease', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId, {
      strikerName: 'Striker',
      nonStrikerName: 'Non-Striker',
    });

    // Alex replaces Striker.
    const first = await bowledOut(app, token, matchId, 'Alex');
    expect(first.status).toBe(200);

    // Rahul replaces Alex — Alex is now dismissed and off the crease.
    const second = await bowledOut(app, token, matchId, 'Rahul');
    expect(second.status).toBe(200);

    // A second, different "Alex" comes in for Rahul. Alex isn't at the
    // crease to trip the existing check, so today this silently resolves to
    // the first Alex's Player document.
    const third = await bowledOut(app, token, matchId, 'Alex');

    expect(third.status).toBe(400);
    expect(third.body.code).toBe('INCOMING_BATSMAN_NAME_REUSED');

    // Only one "Alex" Player document should ever exist for this team —
    // proves the rejection, not just the status code, is what's protecting
    // the data.
    const alexDocs = await Player.find({ name: 'Alex' });
    expect(alexDocs).toHaveLength(1);
  });
});
