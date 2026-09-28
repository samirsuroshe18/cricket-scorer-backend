import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Team } from '../src/models/team.model.js';
import { PlayerInvite } from '../src/models/playerInvite.model.js';

describe('GET / DELETE /v1/team/:teamId/invites', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true, withPlayerInvite: true, withOrganization: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const invite = (token, teamId, userId) =>
    request(app).post(`/api/v1/team/${teamId}/invites`).set(auth(token)).send({ userId: String(userId) });
  const list = (token, teamId) => request(app).get(`/api/v1/team/${teamId}/invites`).set(auth(token));
  const cancel = (token, teamId, inviteId) =>
    request(app).delete(`/api/v1/team/${teamId}/invites/${inviteId}`).set(auth(token));
  const respond = (token, inviteId, action) =>
    request(app).post(`/api/v1/player-invite/${inviteId}/${action}`).set(auth(token)).send();

  const setup = async () => {
    const { user: scorer, token } = await createTestUser({ fullName: 'Scorer Sam' });
    const team = await Team.create({ name: 'Riverside U19', createdBy: scorer._id });
    return { scorer, token, team };
  };
  const makeInvitee = (name) => createTestUser({ fullName: name, email: `${name.replace(/\s/g, '').toLowerCase()}@example.com` });

  describe('GET', () => {
    it('returns an empty list for a team with no invites', async () => {
      const { token, team } = await setup();

      const res = await list(token, team._id);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ invites: [] });
    });

    it('returns pending, accepted and declined rows with invitee details, newest first', async () => {
      const { token, team } = await setup();
      const a = await makeInvitee('Amit Accepts');
      const d = await makeInvitee('Dev Declines');
      const p = await makeInvitee('Pia Pending');
      const inviteA = await invite(token, team._id, a.user._id);
      const inviteD = await invite(token, team._id, d.user._id);
      const inviteP = await invite(token, team._id, p.user._id);
      await respond(a.token, inviteA.body.data.inviteId, 'accept');
      await respond(d.token, inviteD.body.data.inviteId, 'decline');

      const res = await list(token, team._id);

      expect(res.status).toBe(200);
      const rows = res.body.data.invites;
      expect(rows.map((r) => r.status)).toEqual(['declined', 'accepted', 'pending']);
      expect(rows[0]).toEqual({
        inviteId: inviteD.body.data.inviteId,
        status: 'declined',
        respondedAt: expect.any(String),
        player: { playerId: inviteD.body.data.player.playerId, playerName: 'Dev Declines' },
        invitee: { userId: String(d.user._id), fullName: 'Dev Declines', photoUrl: null },
      });
      expect(rows[2]).toMatchObject({ inviteId: inviteP.body.data.inviteId, respondedAt: null });
    });

    it('shows a declined-then-re-invited person once, as pending', async () => {
      const { token, team } = await setup();
      const { user, token: inviteeToken } = await makeInvitee('Rahul Sharma');
      const first = await invite(token, team._id, user._id);
      await respond(inviteeToken, first.body.data.inviteId, 'decline');
      const again = await invite(token, team._id, user._id);

      const res = await list(token, team._id);

      expect(res.body.data.invites).toHaveLength(1);
      expect(res.body.data.invites[0]).toMatchObject({ inviteId: again.body.data.inviteId, status: 'pending' });
    });

    it('omits a person whose newest invite was cancelled, even if an older one was declined', async () => {
      const { token, team } = await setup();
      const { user, token: inviteeToken } = await makeInvitee('Rahul Sharma');
      const first = await invite(token, team._id, user._id);
      await respond(inviteeToken, first.body.data.inviteId, 'decline');
      const second = await invite(token, team._id, user._id);
      await cancel(token, team._id, second.body.data.inviteId);

      const res = await list(token, team._id);

      expect(res.body.data.invites).toEqual([]);
    });

    it('does not show another team\'s invites', async () => {
      const { scorer, token, team } = await setup();
      const other = await Team.create({ name: 'Other XI', createdBy: scorer._id });
      const { user } = await makeInvitee('Rahul Sharma');
      await invite(token, other._id, user._id);

      expect((await list(token, team._id)).body.data.invites).toEqual([]);
    });

    it('refuses an organization member who is not the owner, a stranger, and an anonymous caller', async () => {
      const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
      const orgRes = await request(app).post('/api/v1/organization').set(auth(ownerToken)).send({ name: 'Riverside CC' });
      const orgId = orgRes.body.data.id;
      const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
      await request(app).post(`/api/v1/organization/${orgId}/members`).set(auth(ownerToken)).send({ email: 'member@example.com' });
      const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set(auth(ownerToken)).send({ name: 'Org Team' });
      const { token: strangerToken } = await createTestUser();
      const { team } = await setup();

      const member = await list(memberToken, teamRes.body.data.id);
      expect(member.status).toBe(403);
      expect(member.body.code).toBe('TEAM_NOT_MANAGEABLE');
      const stranger = await list(strangerToken, team._id);
      expect(stranger.status).toBe(403);
      expect(stranger.body.code).toBe('TEAM_NOT_OWNED');
      expect((await request(app).get(`/api/v1/team/${team._id}/invites`)).status).toBe(401);
    });
  });

  describe('DELETE /:inviteId', () => {
    it('cancels a pending invite, drops it from the list and blocks the invitee from answering', async () => {
      const { token, team } = await setup();
      const { user, token: inviteeToken } = await makeInvitee('Rahul Sharma');
      const sent = await invite(token, team._id, user._id);
      const inviteId = sent.body.data.inviteId;

      const res = await cancel(token, team._id, inviteId);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ inviteId, status: 'cancelled' });
      const stored = await PlayerInvite.findById(inviteId);
      expect(stored.status).toBe('cancelled');
      expect(stored.respondedAt).toBeInstanceOf(Date);
      expect((await list(token, team._id)).body.data.invites).toEqual([]);
      const late = await respond(inviteeToken, inviteId, 'accept');
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('INVITE_CANCELLED');
    });

    it('returns 409 INVITE_NOT_PENDING for an accepted, declined or already-cancelled invite', async () => {
      const { token, team } = await setup();
      const a = await makeInvitee('Amit Accepts');
      const d = await makeInvitee('Dev Declines');
      const c = await makeInvitee('Cara Cancelled');
      const inviteA = await invite(token, team._id, a.user._id);
      const inviteD = await invite(token, team._id, d.user._id);
      const inviteC = await invite(token, team._id, c.user._id);
      await respond(a.token, inviteA.body.data.inviteId, 'accept');
      await respond(d.token, inviteD.body.data.inviteId, 'decline');
      await cancel(token, team._id, inviteC.body.data.inviteId);

      for (const sent of [inviteA, inviteD, inviteC]) {
        const res = await cancel(token, team._id, sent.body.data.inviteId);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('INVITE_NOT_PENDING');
      }
      expect((await PlayerInvite.findById(inviteA.body.data.inviteId)).status).toBe('accepted');
    });

    it('returns 404 INVITE_NOT_FOUND for an invite on another team, and 400 INVALID_ID for a malformed id', async () => {
      const { scorer, token, team } = await setup();
      const other = await Team.create({ name: 'Other XI', createdBy: scorer._id });
      const { user } = await makeInvitee('Rahul Sharma');
      const sent = await invite(token, other._id, user._id);

      const wrongTeam = await cancel(token, team._id, sent.body.data.inviteId);
      expect(wrongTeam.status).toBe(404);
      expect(wrongTeam.body.code).toBe('INVITE_NOT_FOUND');
      expect((await PlayerInvite.findById(sent.body.data.inviteId)).status).toBe('pending');
      expect((await cancel(token, team._id, 'nope')).body.code).toBe('INVALID_ID');
    });

    it('refuses a stranger and an anonymous caller', async () => {
      const { token, team } = await setup();
      const { user } = await makeInvitee('Rahul Sharma');
      const sent = await invite(token, team._id, user._id);
      const { token: strangerToken } = await createTestUser();

      const stranger = await cancel(strangerToken, team._id, sent.body.data.inviteId);
      expect(stranger.status).toBe(403);
      expect(stranger.body.code).toBe('TEAM_NOT_OWNED');
      const anon = await request(app).delete(`/api/v1/team/${team._id}/invites/${sent.body.data.inviteId}`);
      expect(anon.status).toBe(401);
    });
  });
});
