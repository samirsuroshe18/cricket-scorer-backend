import { jest } from '@jest/globals';
import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';
import { PlayerInvite } from '../src/models/playerInvite.model.js';

describe('roster inviteStatus', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true, withPlayerInvite: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  const profile = (token, teamId) => request(app).get(`/api/v1/team/${teamId}`).set(auth(token));
  const rowFor = (res, name) => res.body.data.roster.find((r) => r.playerName === name);

  const setup = async () => {
    const { user: scorer, token } = await createTestUser({ fullName: 'Scorer Sam' });
    const { user: invitee, token: inviteeToken } = await createTestUser({ email: 'rahul@example.com', fullName: 'Rahul Sharma' });
    const team = await Team.create({ name: 'Riverside U19', createdBy: scorer._id });
    const plain = await Player.create({ name: 'Plain Player', nameLower: 'plain player', createdBy: scorer._id });
    await Team.updateOne({ _id: team._id }, { $addToSet: { players: plain._id } });
    const invited = await request(app).post(`/api/v1/team/${team._id}/invites`).set(auth(token)).send({ userId: String(invitee._id) });
    return { scorer, token, invitee, inviteeToken, team, plain, invited };
  };

  it('marks only the invited player pending on the profile roster', async () => {
    const { token, team } = await setup();

    const res = await profile(token, team._id);

    expect(rowFor(res, 'Rahul Sharma').inviteStatus).toBe('pending');
    expect(rowFor(res, 'Plain Player').inviteStatus).toBeNull();
  });

  it('is null again after the invite is accepted or declined', async () => {
    const { token, inviteeToken, team, invited } = await setup();

    await request(app).post(`/api/v1/player-invite/${invited.body.data.inviteId}/accept`).set(auth(inviteeToken)).send();
    expect(rowFor(await profile(token, team._id), 'Rahul Sharma').inviteStatus).toBeNull();

    await PlayerInvite.updateOne({ _id: invited.body.data.inviteId }, { status: 'declined' });
    expect(rowFor(await profile(token, team._id), 'Rahul Sharma').inviteStatus).toBeNull();
  });

  it('queries pending invites once per profile request regardless of roster size', async () => {
    const { scorer, token, team } = await setup();
    for (const name of ['A', 'B', 'C', 'D']) {
      const p = await Player.create({ name, nameLower: name.toLowerCase(), createdBy: scorer._id });
      await Team.updateOne({ _id: team._id }, { $addToSet: { players: p._id } });
    }
    const spy = jest.spyOn(PlayerInvite, 'find');

    await profile(token, team._id);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('carries inviteStatus on the invite, add-player and edit-player responses', async () => {
    const { token, team, invited } = await setup();
    const playerId = invited.body.data.player.playerId;

    const edited = await request(app).patch(`/api/v1/team/${team._id}/players/${playerId}`).set(auth(token)).send({ role: 'batsman' });
    const added = await request(app).post(`/api/v1/team/${team._id}/players`).set(auth(token)).send({ playerId });
    const plainAdded = await request(app).post(`/api/v1/team/${team._id}/players`).set(auth(token)).send({ name: 'Brand New' });

    expect(invited.body.data.player.inviteStatus).toBe('pending');
    expect(edited.body.data.inviteStatus).toBe('pending');
    expect(added.body.data.inviteStatus).toBe('pending');
    expect(plainAdded.body.data.inviteStatus).toBeNull();
  });

  it('answers null on the invite response when the player is already linked to the invitee', async () => {
    const { scorer, token, invitee, team } = await setup();
    await Player.updateOne({ createdBy: scorer._id, nameLower: 'rahul sharma' }, { linkedUserId: invitee._id });
    await PlayerInvite.deleteMany({});

    const res = await request(app).post(`/api/v1/team/${team._id}/invites`).set(auth(token)).send({ userId: String(invitee._id) });

    expect(res.body.data.status).toBe('accepted');
    expect(res.body.data.player.inviteStatus).toBeNull();
  });
});
