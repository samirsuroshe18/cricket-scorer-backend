import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';
import { PlayerInvite } from '../src/models/playerInvite.model.js';

describe('DELETE /v1/team/:teamId/players/:playerId', () => {
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

  const remove = (token, teamId, playerId) =>
    request(app).delete(`/api/v1/team/${teamId}/players/${playerId}`).set('Authorization', `Bearer ${token}`);

  const makePlayer = (createdBy, name, extra = {}) =>
    Player.create({ name, nameLower: name.toLowerCase(), createdBy, ...extra });

  it('removes the player from the roster (200)', async () => {
    const { user, token } = await createTestUser();
    const player = await makePlayer(user._id, 'Pranay');
    const team = await Team.create({ name: 'Riverside', createdBy: user._id, players: [player._id] });

    const res = await remove(token, team._id, player._id);

    expect(res.status).toBe(200);
    expect((await Team.findById(team._id)).players).toHaveLength(0);
    // The Player itself survives — it is scorer-owned data, not team-owned.
    expect(await Player.findById(player._id)).not.toBeNull();
  });

  it('clears captainId/viceCaptainId when the removed player held either', async () => {
    const { user, token } = await createTestUser();
    const player = await makePlayer(user._id, 'Pranay');
    const team = await Team.create({
      name: 'Riverside', createdBy: user._id, players: [player._id], captainId: player._id, viceCaptainId: player._id,
    });

    await remove(token, team._id, player._id);

    const stored = await Team.findById(team._id);
    expect(stored.captainId).toBeNull();
    expect(stored.viceCaptainId).toBeNull();
  });

  it('cancels a pending invite for that player on this team', async () => {
    const { user, token } = await createTestUser();
    const { user: invitee } = await createTestUser();
    const player = await makePlayer(user._id, 'Pranay');
    const team = await Team.create({ name: 'Riverside', createdBy: user._id, players: [player._id] });
    const inv = await PlayerInvite.create({ player: player._id, team: team._id, invitedUser: invitee._id, invitedBy: user._id });

    await remove(token, team._id, player._id);

    expect((await PlayerInvite.findById(inv._id)).status).toBe('cancelled');
  });

  it('leaves an already-answered invite untouched', async () => {
    const { user, token } = await createTestUser();
    const { user: invitee } = await createTestUser();
    const player = await makePlayer(user._id, 'Pranay');
    const team = await Team.create({ name: 'Riverside', createdBy: user._id, players: [player._id] });
    const inv = await PlayerInvite.create({
      player: player._id, team: team._id, invitedUser: invitee._id, invitedBy: user._id, status: 'declined', respondedAt: new Date(),
    });

    await remove(token, team._id, player._id);

    expect((await PlayerInvite.findById(inv._id)).status).toBe('declined');
  });

  it('returns 404 PLAYER_NOT_ON_TEAM for a player not on the roster', async () => {
    const { user, token } = await createTestUser();
    const player = await makePlayer(user._id, 'Pranay');
    const team = await Team.create({ name: 'Riverside', createdBy: user._id });

    const res = await remove(token, team._id, player._id);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAYER_NOT_ON_TEAM');
  });

  it('returns 403 TEAM_NOT_MANAGEABLE for an org member who is not the org owner', async () => {
    const { token: ownerToken, user: owner } = await createTestUser();
    const { token: memberToken, user: member } = await createTestUser();
    const player = await makePlayer(owner._id, 'Pranay');
    const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Club' });
    const orgId = orgRes.body.data.id;
    await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: member.email });
    const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Riverside' });
    const teamId = teamRes.body.data.id;
    await request(app).post(`/api/v1/team/${teamId}/players`).set('Authorization', `Bearer ${ownerToken}`).send({ playerId: String(player._id) });

    const res = await remove(memberToken, teamId, player._id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_MANAGEABLE');
  });

  it('returns 400 INVALID_ID for a malformed playerId', async () => {
    const { user, token } = await createTestUser();
    const team = await Team.create({ name: 'Riverside', createdBy: user._id });

    const res = await remove(token, team._id, 'not-an-id');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });
});
