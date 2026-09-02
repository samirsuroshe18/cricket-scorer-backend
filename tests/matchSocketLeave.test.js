import { jest } from '@jest/globals';
import { registerMatchSocket } from '../src/sockets/match.socket.js';

// The socket had exactly one inbound handler, match:join, by design — see
// this file's own comment on why a second one is not something to add
// lightly (docs/api.md's "What a spectator connection cannot do"). This one
// is safe by the same test that section applies to everything else here:
// it never touches the database, never checks ownership, and its only
// effect is on the calling socket's own room membership — the same
// category as match:join's `socket.join`, just the read-only inverse of it.
//
// Without it, a client with no way to leave a room it joined (spectating
// match A, then match B, in one continuous app session) leaves the shared
// socket connection joined to every room it has ever visited for the life
// of the process — a server-side room-membership leak and wasted broadcast
// bandwidth to a client that has long since stopped listening.
describe('match:leave', () => {
  const buildFakeSocket = () => {
    const handlers = {};
    return {
      handshake: { address: '10.0.0.1' },
      join: jest.fn(),
      leave: jest.fn(),
      emit: jest.fn(),
      on: (event, handler) => {
        handlers[event] = handler;
      },
      trigger: (event, payload) => handlers[event](payload),
    };
  };

  it("removes the socket from the match's room, by the same name match:join uses", () => {
    const io = { on: jest.fn() };
    registerMatchSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');

    const socket = buildFakeSocket();
    onConnection(socket);

    socket.trigger('match:leave', { matchId: '665f1a2b3c4d5e6f7a8b9c0d' });

    expect(socket.leave).toHaveBeenCalledWith('match:665f1a2b3c4d5e6f7a8b9c0d');
  });

  it('does nothing for a missing or malformed matchId, rather than throwing', () => {
    const io = { on: jest.fn() };
    registerMatchSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');

    const socket = buildFakeSocket();
    onConnection(socket);

    expect(() => socket.trigger('match:leave', {})).not.toThrow();
    expect(() => socket.trigger('match:leave', undefined)).not.toThrow();
    expect(socket.leave).not.toHaveBeenCalled();
  });
});
