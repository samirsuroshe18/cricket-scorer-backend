import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';
import { PlayerInvite } from '../src/models/playerInvite.model.js';
import { Notification } from '../src/models/notification.model.js';

describe('POST /v1/team/:teamId/invites', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true, withOrganization: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  const invite = (token, teamId, body) =>
    request(app).post(`/api/v1/team/${teamId}/invites`).set(auth(token)).send(body);

  const makeTeam = (createdBy) => Team.create({ name: 'Riverside U19', createdBy });

  const setup = async () => {
    const { user: scorer, token } = await createTestUser({ fullName: 'Scorer Sam' });
    const { user: invitee } = await createTestUser({ email: 'rahul@example.com', fullName: 'Rahul Sharma' });
    const team = await makeTeam(scorer._id);
    return { scorer, token, invitee, team };
  };

  it('creates the player, roster entry, pending invite and one notification', async () => {
    const { scorer, token, invitee, team } = await setup();

    const res = await invite(token, team._id, { userId: String(invitee._id) });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      inviteId: expect.any(String),
      status: 'pending',
      player: { playerId: expect.any(String), playerName: 'Rahul Sharma' },
    });

    const player = await Player.findById(res.body.data.player.playerId);
    expect(String(player.createdBy)).toBe(String(scorer._id));
    expect(player.linkedUserId).toBeNull();
    expect((await Team.findById(team._id)).players.map(String)).toEqual([String(player._id)]);

    const stored = await PlayerInvite.findById(res.body.data.inviteId);
    expect(stored).toMatchObject({ status: 'pending' });
    expect(String(stored.invitedUser)).toBe(String(invitee._id));
    expect(String(stored.invitedBy)).toBe(String(scorer._id));
    expect(String(stored.team)).toBe(String(team._id));

    const notifications = await Notification.find({ recipient: invitee._id });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('player_invite');
    expect(notifications[0].title).toContain('Scorer Sam');
    expect(notifications[0].title).toContain('Riverside U19');
    expect(notifications[0].data).toMatchObject({
      type: 'player_invite',
      inviteId: res.body.data.inviteId,
      teamId: String(team._id),
      teamName: 'Riverside U19',
    });
  });

  it('reuses the scorer\'s existing player with the invitee\'s name', async () => {
    const { scorer, token, invitee, team } = await setup();
    const existing = await Player.create({ name: 'Rahul Sharma', nameLower: 'rahul sharma', createdBy: scorer._id });

    const res = await invite(token, team._id, { userId: String(invitee._id) });

    expect(res.body.data.player.playerId).toBe(String(existing._id));
    expect(await Player.countDocuments({ createdBy: scorer._id })).toBe(1);
  });

  it('answers 200 with the same inviteId and no second notification for a repeat invite', async () => {
    const { token, invitee, team } = await setup();
    const first = await invite(token, team._id, { userId: String(invitee._id) });

    const second = await invite(token, team._id, { userId: String(invitee._id) });

    expect(second.status).toBe(200);
    expect(second.body.data.inviteId).toBe(first.body.data.inviteId);
    expect(await PlayerInvite.countDocuments({})).toBe(1);
    expect(await Notification.countDocuments({ recipient: invitee._id })).toBe(1);
  });

  it('leaves exactly one pending invite and one notification for two simultaneous invites', async () => {
    const { token, invitee, team } = await setup();

    const [a, b] = await Promise.all([
      invite(token, team._id, { userId: String(invitee._id) }),
      invite(token, team._id, { userId: String(invitee._id) }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.data.inviteId).toBe(b.body.data.inviteId);
    expect(await PlayerInvite.countDocuments({ status: 'pending' })).toBe(1);
    expect(await Notification.countDocuments({ recipient: invitee._id })).toBe(1);
  });

  it('creates a new pending invite after the previous one was declined', async () => {
    const { token, invitee, team } = await setup();
    const first = await invite(token, team._id, { userId: String(invitee._id) });
    await PlayerInvite.updateOne({ _id: first.body.data.inviteId }, { status: 'declined', respondedAt: new Date() });

    const again = await invite(token, team._id, { userId: String(invitee._id) });

    expect(again.status).toBe(201);
    expect(again.body.data.inviteId).not.toBe(first.body.data.inviteId);
    expect(await PlayerInvite.countDocuments({ status: 'pending' })).toBe(1);
  });

  it('returns 409 PLAYER_ALREADY_CLAIMED when that name\'s player is linked to another account', async () => {
    const { scorer, token, invitee, team } = await setup();
    const { user: holder } = await createTestUser();
    await Player.create({ name: 'Rahul Sharma', nameLower: 'rahul sharma', createdBy: scorer._id, linkedUserId: holder._id });

    const res = await invite(token, team._id, { userId: String(invitee._id) });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAYER_ALREADY_CLAIMED');
    expect(await PlayerInvite.countDocuments({})).toBe(0);
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it('adds the roster entry without an invite or notification when the player is already linked to the invitee', async () => {
    const { scorer, token, invitee, team } = await setup();
    const linked = await Player.create({ name: 'Rahul Sharma', nameLower: 'rahul sharma', createdBy: scorer._id, linkedUserId: invitee._id });

    const res = await invite(token, team._id, { userId: String(invitee._id) });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ inviteId: null, status: 'accepted', player: { playerId: String(linked._id) } });
    expect((await Team.findById(team._id)).players.map(String)).toEqual([String(linked._id)]);
    expect(await PlayerInvite.countDocuments({})).toBe(0);
    expect(await Notification.countDocuments({})).toBe(0);
  });

  it('returns 400 CANNOT_INVITE_SELF', async () => {
    const { scorer, token, team } = await setup();

    const res = await invite(token, team._id, { userId: String(scorer._id) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANNOT_INVITE_SELF');
  });

  it('returns 404 USER_NOT_FOUND for a missing, deleted, blocked or unverified invitee', async () => {
    const { token, team } = await setup();
    const { user: deleted } = await createTestUser({ isDeleted: true });
    const { user: blocked } = await createTestUser({ accountStatus: 'blocked' });
    const { user: unverified } = await createTestUser({ isEmailVerified: false });

    for (const id of ['665f1a2b3c4d5e6f7a8b9c40', String(deleted._id), String(blocked._id), String(unverified._id)]) {
      const res = await invite(token, team._id, { userId: id });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('USER_NOT_FOUND');
    }
    expect(await Player.countDocuments({})).toBe(0);
  });

  it('returns 400 INVALID_ID for a malformed userId', async () => {
    const { token, team } = await setup();

    const res = await invite(token, team._id, { userId: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  it('returns 403 TEAM_NOT_MANAGEABLE for an organization member who is not the owner', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await request(app).post('/api/v1/organization').set(auth(ownerToken)).send({ name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
    await request(app).post(`/api/v1/organization/${orgId}/members`).set(auth(ownerToken)).send({ email: 'member@example.com' });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set(auth(ownerToken)).send({ name: 'Org Team' });
    const { user: invitee } = await createTestUser({ email: 'target@example.com' });

    const res = await invite(memberToken, teamRes.body.data.id, { userId: String(invitee._id) });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_MANAGEABLE');
  });

  it('returns 403 TEAM_NOT_OWNED for a stranger and 404 TEAM_NOT_FOUND for a deleted team', async () => {
    const { token, invitee, team } = await setup();
    const { token: strangerToken } = await createTestUser();
    const gone = await Team.create({ name: 'Gone', createdBy: (await Team.findById(team._id)).createdBy, isDeleted: true });

    const stranger = await invite(strangerToken, team._id, { userId: String(invitee._id) });
    const deleted = await invite(token, gone._id, { userId: String(invitee._id) });

    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe('TEAM_NOT_OWNED');
    expect(deleted.status).toBe(404);
    expect(deleted.body.code).toBe('TEAM_NOT_FOUND');
  });
});
