import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';
import { linkPlayerToUser } from '../src/utils/linkPlayerToUser.js';

// An invited or claiming account's own profile (playingRole, jerseyNumber)
// fills a roster player's unset role/jersey — never overwrites what the scorer
// already set.
describe('seeding a roster player from the account profile', () => {
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

  const invite = (token, teamId, userId) =>
    request(app)
      .post(`/api/v1/team/${teamId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: String(userId) });

  const setup = async (profile = {}) => {
    const { user: scorer, token } = await createTestUser({ fullName: 'Scorer Sam' });
    const { user: invitee } = await createTestUser({ fullName: 'Mohit Zatu', ...profile });
    const team = await Team.create({ name: 'Mumbai Indians', createdBy: scorer._id });
    return { scorer, token, invitee, team };
  };

  describe('when inviting', () => {
    it('seeds a new player\'s role and jersey number from the invitee\'s profile', async () => {
      const { token, invitee, team } = await setup({ playingRole: 'batsman', jerseyNumber: 18 });

      const res = await invite(token, team._id, invitee._id);

      expect(res.status).toBe(201);
      expect(res.body.data.player).toMatchObject({ playerName: 'Mohit Zatu', role: 'batsman', jerseyNumber: 18 });
      const stored = await Player.findById(res.body.data.player.playerId);
      expect(stored).toMatchObject({ role: 'batsman', jerseyNumber: 18 });
    });

    it('keeps a role and jersey the scorer already set on an existing player', async () => {
      const { scorer, token, invitee, team } = await setup({ playingRole: 'batsman', jerseyNumber: 18 });
      const existing = await Player.create({
        name: 'Mohit Zatu', nameLower: 'mohit zatu', createdBy: scorer._id, role: 'bowler', jerseyNumber: 3,
      });

      const res = await invite(token, team._id, invitee._id);

      expect(res.body.data.player.playerId).toBe(String(existing._id));
      expect(await Player.findById(existing._id)).toMatchObject({ role: 'bowler', jerseyNumber: 3 });
    });

    it('fills only the unset field of an existing player', async () => {
      const { scorer, token, invitee, team } = await setup({ playingRole: 'batsman', jerseyNumber: 18 });
      const existing = await Player.create({
        name: 'Mohit Zatu', nameLower: 'mohit zatu', createdBy: scorer._id, role: 'bowler',
      });

      await invite(token, team._id, invitee._id);

      expect(await Player.findById(existing._id)).toMatchObject({ role: 'bowler', jerseyNumber: 18 });
    });

    it('leaves the role unknown when the profile declares none', async () => {
      const { token, invitee, team } = await setup();

      const res = await invite(token, team._id, invitee._id);

      expect(res.body.data.player.role).toBe('unknown');
      expect(res.body.data.player.jerseyNumber ?? null).toBeNull();
    });
  });

  describe('when linking (accept or claim)', () => {
    it('fills an unknown role and missing jersey from the account holder\'s profile', async () => {
      const { user: scorer } = await createTestUser();
      const { user } = await createTestUser({ playingRole: 'allrounder', jerseyNumber: 7 });
      const player = await Player.create({ name: 'Mohit', nameLower: 'mohit', createdBy: scorer._id });

      const linked = await linkPlayerToUser(player._id, user._id);

      expect(linked).toMatchObject({ role: 'allrounder', jerseyNumber: 7 });
      expect(await Player.findById(player._id)).toMatchObject({ role: 'allrounder', jerseyNumber: 7 });
    });

    it('never overwrites what the scorer set', async () => {
      const { user: scorer } = await createTestUser();
      const { user } = await createTestUser({ playingRole: 'allrounder', jerseyNumber: 7 });
      const player = await Player.create({
        name: 'Mohit', nameLower: 'mohit', createdBy: scorer._id, role: 'bowler', jerseyNumber: 3,
      });

      await linkPlayerToUser(player._id, user._id);

      expect(await Player.findById(player._id)).toMatchObject({ role: 'bowler', jerseyNumber: 3 });
    });

    it('re-linking the same account is still a no-op for an unset profile', async () => {
      const { user: scorer } = await createTestUser();
      const { user } = await createTestUser();
      const player = await Player.create({ name: 'Mohit', nameLower: 'mohit', createdBy: scorer._id });

      await linkPlayerToUser(player._id, user._id);

      expect((await Player.findById(player._id)).role).toBe('unknown');
    });
  });
});
