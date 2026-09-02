import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';

// docs/api.md promises: "A `bowler` event inside the skipped prefix is
// simply not re-attempted. One sitting exactly on the boundary is ambiguous,
// and harmlessly so: re-applying it is a no-op when `Inning.currentBowlerId`
// already names that bowler for that over." A batch whose LAST event is a
// new-bowler selection (no bowlerId — a freshly-typed name) sits exactly on
// that boundary once every ball ahead of it has already been recognised as
// applied: resolveBowler's plain `Player.create()` had no way to tell "this
// exact selection already committed in the attempt whose response was lost"
// apart from a genuine same-name-different-person collision, so a lost-
// response retry of such a batch used to fail forever with
// BOWLER_NAME_ALREADY_EXISTS instead of the clean no-op the docs promise.
describe('a sync batch ending in a new-bowler event survives a lost-response retry', () => {
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

  const ballEvent = (overrides = {}) => ({
    type: 'ball',
    runs: 0,
    idempotencyKey: randomUUID(),
    ...overrides,
  });

  const sync = (token, matchId, body) =>
    request(app)
      .post(`/api/v1/match/${matchId}/sync`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('re-sending the identical batch is a clean no-op, not BOWLER_NAME_ALREADY_EXISTS', async () => {
    const { token } = await createTestUser();
    const matchId = await createMatch(app, token);
    await startLiveInnings(app, token, matchId);

    // Six dot balls complete over 1 exactly, then a freshly-typed bowler for
    // over 2 — the trailing event that sits on the resume boundary.
    const events = [
      ballEvent(), ballEvent(), ballEvent(), ballEvent(), ballEvent(), ballEvent(),
      { type: 'bowler', bowlerName: 'Second Over Bowler' },
    ];

    const first = await sync(token, matchId, { inningsNumber: 1, baseAbsoluteBallSeq: 0, events });
    expect(first.status).toBe(200);
    expect(first.body.data.failedCode).toBeNull();
    expect(first.body.data.syncStatus).toBe('synced');

    // The client never saw that response (dropped connection) and resends
    // the exact same batch.
    const retry = await sync(token, matchId, { inningsNumber: 1, baseAbsoluteBallSeq: 0, events });

    expect(retry.status).toBe(200);
    expect(retry.body.data.failedCode).toBeNull();
    expect(retry.body.data.syncStatus).toBe('synced');

    const bowlers = await Player.find({ name: 'Second Over Bowler' });
    expect(bowlers).toHaveLength(1);
  });
});
