import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';
import { PlayerInvite } from '../src/models/playerInvite.model.js';

describe('GET /v1/team/:teamId/player-view', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const view = (token, teamId) =>
    request(app).get(`/api/v1/team/${teamId}/player-view`).set('Authorization', `Bearer ${token}`);

  const makePlayer = (createdBy, name, extra = {}) =>
    Player.create({ name, nameLower: name.toLowerCase(), createdBy, ...extra });

  const setup = async () => {
    const { user: scorer } = await createTestUser();
    const { user, token } = await createTestUser();
    const me = await makePlayer(scorer._id, 'Mohit Zatu', { linkedUserId: user._id, role: 'batsman', jerseyNumber: 7 });
    const mate = await makePlayer(scorer._id, 'Mate');
    const team = await Team.create({
      name: 'Mumbai Indians',
      shortName: 'MI',
      createdBy: scorer._id,
      players: [me._id, mate._id],
      captainId: mate._id,
    });
    return { scorer, user, token, me, mate, team };
  };

  it('returns the roster and stats to a linked player, without private fields', async () => {
    const { token, me, mate, team } = await setup();

    const res = await view(token, team._id);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      teamId: String(team._id),
      name: 'Mumbai Indians',
      shortName: 'MI',
      logoUrl: null,
      captainId: String(mate._id),
      viceCaptainId: null,
    });
    expect(res.body.data.stats).toBeDefined();
    expect(res.body.data.roster).toHaveLength(2);
    expect(Object.keys(res.body.data.roster[0]).sort()).toEqual(
      ['isCaptain', 'isViceCaptain', 'jerseyNumber', 'playerId', 'playerName', 'role'].sort(),
    );
    const mine = res.body.data.roster.find((r) => r.playerId === String(me._id));
    expect(mine).toMatchObject({ playerName: 'Mohit Zatu', jerseyNumber: 7, isCaptain: false });
    for (const key of ['organization', 'canManage', 'inviteStatus', 'isClaimed', 'linkedUserId']) {
      expect(res.body.data).not.toHaveProperty(key);
    }
  });

  it('is 403 TEAM_NOT_A_PLAYER for a pending invite only', async () => {
    const { scorer, team } = await setup();
    const { user: invitee, token } = await createTestUser();
    const named = await makePlayer(scorer._id, 'Invitee');
    await Team.updateOne({ _id: team._id }, { $push: { players: named._id } });
    await PlayerInvite.create({ player: named._id, team: team._id, invitedUser: invitee._id, invitedBy: scorer._id });

    const res = await view(token, team._id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_A_PLAYER');
  });

  it('is 403 for a declined invite, a stranger, and the creator', async () => {
    const { scorer, team } = await setup();
    const { user: invitee, token: inviteeToken } = await createTestUser();
    const { token: strangerToken } = await createTestUser();
    const { token: scorerToken } = await createTestUser();
    const named = await makePlayer(scorer._id, 'Invitee');
    await Team.updateOne({ _id: team._id }, { $push: { players: named._id } });
    await PlayerInvite.create({
      player: named._id, team: team._id, invitedUser: invitee._id, invitedBy: scorer._id, status: 'declined',
    });

    for (const token of [inviteeToken, strangerToken, scorerToken]) {
      const res = await view(token, team._id);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('TEAM_NOT_A_PLAYER');
    }
  });

  it('is 403 when the linked player is soft-deleted', async () => {
    const { token, me, team } = await setup();
    await Player.updateOne({ _id: me._id }, { isDeleted: true });

    const res = await view(token, team._id);

    expect(res.status).toBe(403);
  });

  it('is 404 for a soft-deleted team and 400 for a malformed id', async () => {
    const { token, team } = await setup();
    await Team.updateOne({ _id: team._id }, { isDeleted: true });

    const gone = await view(token, team._id);
    const bad = await view(token, 'not-an-id');

    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('TEAM_NOT_FOUND');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_ID');
  });
});
