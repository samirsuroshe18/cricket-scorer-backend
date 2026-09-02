import { jest } from '@jest/globals';
import { registerMatchSocket } from '../src/sockets/match.socket.js';
import { Match } from '../src/models/match.model.js';
import { Team } from '../src/models/team.model.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// buildInningsState's populated path always includes partnershipRuns/
// partnershipBalls (0/0 once an innings exists with no wicket yet). The
// hand-built fallback match:join emits when no innings has started yet
// never carried those two keys at all, so a client with a fixed-shape
// model for match:state saw two different key sets depending on whether an
// innings existed — harmless today since the client's fields are nullable,
// but an inconsistency worth closing so the two paths agree by
// construction rather than by accident.
describe('match:state before any innings has started', () => {
  let matchId;

  const buildFakeSocket = (address) => {
    const handlers = {};
    return {
      handshake: { address },
      join: jest.fn(),
      emit: jest.fn(),
      on: (event, handler) => {
        handlers[event] = handler;
      },
      trigger: (event, payload) => handlers[event](payload),
    };
  };

  beforeAll(async () => {
    await connectTestDb();

    const [teamA, teamB] = await Team.create([{ name: 'Team A' }, { name: 'Team B' }]);
    const match = await Match.create({
      teamA: teamA._id,
      teamB: teamB._id,
      totalOvers: 5,
      status: 'upcoming',
    });
    matchId = match._id.toString();
  });

  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  it('still carries partnershipRuns/partnershipBalls, zeroed, same as the populated path', async () => {
    const io = { on: jest.fn() };
    registerMatchSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');

    const socket = buildFakeSocket('10.0.0.3');
    onConnection(socket);

    await socket.trigger('match:join', { matchId });

    const [, state] = socket.emit.mock.calls.find(([event]) => event === 'match:state');
    expect(state.partnershipRuns).toBe(0);
    expect(state.partnershipBalls).toBe(0);
  });
});
