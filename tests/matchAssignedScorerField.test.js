import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';
import { Team } from '../src/models/team.model.js';
import { User } from '../src/models/user.model.js';

describe('Match.assignedScorer', () => {
  beforeAll(async () => {
    await connectTestDb();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('defaults to null', async () => {
    const user = await User.create({ email: 'a@example.com', password: 'password123', fullName: 'A' });
    const teamA = await Team.create({ name: 'A', createdBy: user._id });
    const teamB = await Team.create({ name: 'B', createdBy: user._id });
    const match = await Match.create({ teamA: teamA._id, teamB: teamB._id, totalOvers: 5, createdBy: user._id });

    expect(match.assignedScorer).toBeNull();
  });

  it('accepts a valid User ObjectId', async () => {
    const user = await User.create({ email: 'a@example.com', password: 'password123', fullName: 'A' });
    const scorer = await User.create({ email: 'b@example.com', password: 'password123', fullName: 'B' });
    const teamA = await Team.create({ name: 'A', createdBy: user._id });
    const teamB = await Team.create({ name: 'B', createdBy: user._id });
    const match = await Match.create({
      teamA: teamA._id, teamB: teamB._id, totalOvers: 5, createdBy: user._id, assignedScorer: scorer._id,
    });

    expect(match.assignedScorer.equals(scorer._id)).toBe(true);
  });
});
