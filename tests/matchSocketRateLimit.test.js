import { jest } from '@jest/globals';
import { registerMatchSocket } from '../src/sockets/match.socket.js';
import { _resetForTests } from '../src/utils/socketRateLimit.js';
import { Match } from '../src/models/match.model.js';
import { Team } from '../src/models/team.model.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// registerMatchSocket wires the ONLY inbound socket event in the app — no
// auth, no per-event middleware — so `match:join` was previously
// brute-forceable against the six-character join-code space with zero
// friction and no lockout. Exercised here against a fake io/socket pair
// rather than a real socket.io-client connection: no such dependency exists
// in this project, and the wiring under test — does match:join actually
// consult the rate limiter, keyed on the connecting IP, before doing any DB
// work — needs neither a real handshake nor a real transport to prove.
describe('match:join is rate limited per connecting IP', () => {
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
      status: 'live',
    });
    matchId = match._id.toString();
  });

  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  afterEach(() => {
    _resetForTests();
  });

  it('answers ordinary attempts normally', async () => {
    const io = { on: jest.fn() };
    registerMatchSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');

    const socket = buildFakeSocket('10.0.0.1');
    onConnection(socket);

    await socket.trigger('match:join', { matchId });

    expect(socket.emit).toHaveBeenCalledWith('match:state', expect.any(Object));
  });

  it('stops answering once one IP exceeds the attempt budget, without affecting another IP', async () => {
    const io = { on: jest.fn() };
    registerMatchSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');

    const attacker = buildFakeSocket('10.0.0.9');
    onConnection(attacker);

    // Default budget is 20/minute — burn through it from the same IP.
    for (let i = 0; i < 20; i += 1) {
      await attacker.trigger('match:join', { matchId });
    }
    attacker.emit.mockClear();

    await attacker.trigger('match:join', { matchId });
    expect(attacker.emit).not.toHaveBeenCalled();

    // A genuine spectator on a different IP is unaffected by the attacker
    // having burned through their own budget.
    const spectator = buildFakeSocket('10.0.0.2');
    onConnection(spectator);
    await spectator.trigger('match:join', { matchId });
    expect(spectator.emit).toHaveBeenCalledWith('match:state', expect.any(Object));
  });
});
