import { jest } from '@jest/globals';
import { registerAuctionSocket } from '../src/sockets/auction.socket.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Organization } from '../src/models/organization.model.js';

const buildFakeSocket = () => {
  const handlers = {};
  return {
    data: {},
    join: jest.fn(),
    leave: jest.fn(),
    emit: jest.fn(),
    on: (event, handler) => { handlers[event] = handler; },
    trigger: (event, payload) => handlers[event](payload),
  };
};

describe('auction:join', () => {
  let tournament, ownerToken, strangerToken;

  beforeAll(async () => {
    await connectTestDb();
    const { user: owner, token } = await createTestUser({ email: 'owner@example.com' });
    ownerToken = token;
    const { token: strangerT } = await createTestUser({ email: 'stranger@example.com' });
    strangerToken = strangerT;
    const org = await Organization.create({
      name: 'Riverside CC', nameLower: 'riverside cc', owner: owner._id,
      members: [{ user: owner._id, role: 'owner' }],
    });
    tournament = await Tournament.create({
      name: 'Summer T20', nameLower: 'summer t20', organization: org._id, format: 'league', createdBy: owner._id,
    });
  });

  afterAll(async () => {
    await clearTestDb();
    await disconnectTestDb();
  });

  it('joins the room and acks with state for an org member', async () => {
    const io = { on: jest.fn() };
    registerAuctionSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');

    const socket = buildFakeSocket();
    onConnection(socket);

    await socket.trigger('auction:join', { tournamentId: String(tournament._id), accessToken: ownerToken });

    expect(socket.join).toHaveBeenCalledWith(`auction:${tournament._id}`);
    expect(socket.emit).toHaveBeenCalledWith('auction:state', expect.objectContaining({ sessionStatus: null, lot: null }));
  });

  it('does not join a non-org-member, and emits nothing', async () => {
    const io = { on: jest.fn() };
    registerAuctionSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');

    const socket = buildFakeSocket();
    onConnection(socket);

    await socket.trigger('auction:join', { tournamentId: String(tournament._id), accessToken: strangerToken });

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('does not join with a missing or garbage access token', async () => {
    const io = { on: jest.fn() };
    registerAuctionSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');

    const socket = buildFakeSocket();
    onConnection(socket);

    await socket.trigger('auction:join', { tournamentId: String(tournament._id), accessToken: 'garbage' });

    expect(socket.join).not.toHaveBeenCalled();
  });

  it('auction:leave removes the socket from the room without touching the DB', () => {
    const io = { on: jest.fn() };
    registerAuctionSocket(io);
    const [, onConnection] = io.on.mock.calls.find(([e]) => e === 'connection');

    const socket = buildFakeSocket();
    onConnection(socket);
    socket.trigger('auction:leave', { tournamentId: String(tournament._id) });

    expect(socket.leave).toHaveBeenCalledWith(`auction:${tournament._id}`);
  });
});
