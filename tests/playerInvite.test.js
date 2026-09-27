import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';
import { PlayerInvite } from '../src/models/playerInvite.model.js';

describe('/v1/player-invite', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true, withPlayerInvite: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const get = (token, id) => request(app).get(`/api/v1/player-invite/${id}`).set(auth(token));
  const accept = (token, id) => request(app).post(`/api/v1/player-invite/${id}/accept`).set(auth(token)).send();
  const decline = (token, id) => request(app).post(`/api/v1/player-invite/${id}/decline`).set(auth(token)).send();

  // A real invite through the real endpoint, so the row, roster entry and
  // player are exactly what production creates.
  const setup = async () => {
    const { user: scorer, token: scorerToken } = await createTestUser({ fullName: 'Scorer Sam' });
    const { user: invitee, token } = await createTestUser({ email: 'rahul@example.com', fullName: 'Rahul Sharma' });
    const team = await Team.create({ name: 'Riverside U19', createdBy: scorer._id });
    const res = await request(app).post(`/api/v1/team/${team._id}/invites`).set(auth(scorerToken)).send({ userId: String(invitee._id) });
    return { scorer, scorerToken, invitee, token, team, inviteId: res.body.data.inviteId, playerId: res.body.data.player.playerId };
  };

  describe('GET /:inviteId', () => {
    it('returns the current details to the invitee', async () => {
      const { token, team, inviteId } = await setup();

      const res = await get(token, inviteId);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        inviteId,
        status: 'pending',
        teamId: String(team._id),
        teamName: 'Riverside U19',
        invitedByName: 'Scorer Sam',
        playerName: 'Rahul Sharma',
      });
    });

    it('returns 404 INVITE_NOT_FOUND to anyone else, including the scorer', async () => {
      const { scorerToken, inviteId } = await setup();
      const { token: stranger } = await createTestUser();

      for (const token of [scorerToken, stranger]) {
        const res = await get(token, inviteId);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('INVITE_NOT_FOUND');
      }
    });

    it('returns 404 INVITE_NOT_FOUND once the team is soft-deleted', async () => {
      const { token, team, inviteId } = await setup();
      await Team.updateOne({ _id: team._id }, { isDeleted: true });

      const res = await get(token, inviteId);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INVITE_NOT_FOUND');
    });

    it('returns 400 INVALID_ID for a malformed id and 401 without a token', async () => {
      const { token } = await setup();

      expect((await get(token, 'nope')).body.code).toBe('INVALID_ID');
      expect((await request(app).get('/api/v1/player-invite/665f1a2b3c4d5e6f7a8b9c40')).status).toBe(401);
    });
  });

  describe('POST /:inviteId/accept', () => {
    it('links the player, marks the invite accepted and sets respondedAt', async () => {
      const { invitee, token, inviteId, playerId } = await setup();

      const res = await accept(token, inviteId);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ inviteId, status: 'accepted', playerId });
      expect(String((await Player.findById(playerId)).linkedUserId)).toBe(String(invitee._id));
      const stored = await PlayerInvite.findById(inviteId);
      expect(stored.status).toBe('accepted');
      expect(stored.respondedAt).toBeInstanceOf(Date);
    });

    it('is idempotent', async () => {
      const { token, inviteId } = await setup();
      await accept(token, inviteId);

      const again = await accept(token, inviteId);

      expect(again.status).toBe(200);
      expect(again.body.data.status).toBe('accepted');
    });

    it('returns 409 INVITE_ALREADY_DECLINED after a decline', async () => {
      const { token, inviteId } = await setup();
      await decline(token, inviteId);

      const res = await accept(token, inviteId);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVITE_ALREADY_DECLINED');
    });

    it('returns 409 PLAYER_ALREADY_CLAIMED and leaves the invite pending when another account claimed first', async () => {
      const { token, inviteId, playerId } = await setup();
      const { user: rival } = await createTestUser();
      await Player.updateOne({ _id: playerId }, { linkedUserId: rival._id });

      const res = await accept(token, inviteId);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PLAYER_ALREADY_CLAIMED');
      expect((await PlayerInvite.findById(inviteId)).status).toBe('pending');
    });

    it('returns 404 INVITE_NOT_FOUND for another user and after the team is deleted, linking nothing', async () => {
      const { token, team, inviteId, playerId } = await setup();
      const { token: stranger } = await createTestUser();

      expect((await accept(stranger, inviteId)).status).toBe(404);
      await Team.updateOne({ _id: team._id }, { isDeleted: true });
      const res = await accept(token, inviteId);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INVITE_NOT_FOUND');
      expect((await Player.findById(playerId)).linkedUserId).toBeNull();
    });

    it('returns 401 without a token', async () => {
      const res = await request(app).post('/api/v1/player-invite/665f1a2b3c4d5e6f7a8b9c40/accept').send();

      expect(res.status).toBe(401);
    });
  });

  describe('POST /:inviteId/decline', () => {
    it('marks the invite declined and leaves the player on the roster, unlinked', async () => {
      const { token, team, inviteId, playerId } = await setup();

      const res = await decline(token, inviteId);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ inviteId, status: 'declined' });
      const stored = await PlayerInvite.findById(inviteId);
      expect(stored.status).toBe('declined');
      expect(stored.respondedAt).toBeInstanceOf(Date);
      expect((await Player.findById(playerId)).linkedUserId).toBeNull();
      expect((await Team.findById(team._id)).players.map(String)).toContain(playerId);
    });

    it('is idempotent', async () => {
      const { token, inviteId } = await setup();
      await decline(token, inviteId);

      const again = await decline(token, inviteId);

      expect(again.status).toBe(200);
      expect(again.body.data.status).toBe('declined');
    });

    it('returns 409 INVITE_ALREADY_ACCEPTED after an accept', async () => {
      const { token, inviteId } = await setup();
      await accept(token, inviteId);

      const res = await decline(token, inviteId);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVITE_ALREADY_ACCEPTED');
    });

    it('returns 404 INVITE_NOT_FOUND for another user', async () => {
      const { inviteId } = await setup();
      const { token: stranger } = await createTestUser();

      const res = await decline(stranger, inviteId);

      expect(res.status).toBe(404);
      expect((await PlayerInvite.findById(inviteId)).status).toBe('pending');
    });
  });
});
