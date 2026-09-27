import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { PlayerInvite } from '../src/models/playerInvite.model.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';
import { User } from '../src/models/user.model.js';

describe('PlayerInvite', () => {
  beforeAll(async () => {
    await connectTestDb();
    await PlayerInvite.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const seed = async () => {
    const scorer = await User.create({ email: 'scorer@example.com', password: 'password123', fullName: 'Scorer' });
    const invitee = await User.create({ email: 'invitee@example.com', password: 'password123', fullName: 'Invitee' });
    const player = await Player.create({ name: 'Rahul', nameLower: 'rahul', createdBy: scorer._id });
    const teamA = await Team.create({ name: 'Team A', createdBy: scorer._id });
    const teamB = await Team.create({ name: 'Team B', createdBy: scorer._id });
    const base = { player: player._id, invitedUser: invitee._id, invitedBy: scorer._id };
    return { scorer, invitee, player, teamA, teamB, base };
  };

  it('rejects a second pending invite for the same team and invitee', async () => {
    const { teamA, base } = await seed();
    await PlayerInvite.create({ ...base, team: teamA._id });
    await expect(PlayerInvite.create({ ...base, team: teamA._id })).rejects.toMatchObject({ code: 11000 });
  });

  it('allows a new pending invite after the earlier one was declined', async () => {
    const { teamA, base } = await seed();
    const first = await PlayerInvite.create({ ...base, team: teamA._id });
    first.status = 'declined';
    first.respondedAt = new Date();
    await first.save();
    const second = await PlayerInvite.create({ ...base, team: teamA._id });
    expect(second.status).toBe('pending');
  });

  it('allows the same invitee pending on two different teams', async () => {
    const { teamA, teamB, base } = await seed();
    await PlayerInvite.create({ ...base, team: teamA._id });
    await expect(PlayerInvite.create({ ...base, team: teamB._id })).resolves.toBeDefined();
  });
});
