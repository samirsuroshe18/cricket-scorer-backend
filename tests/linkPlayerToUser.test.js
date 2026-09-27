import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { linkPlayerToUser } from '../src/utils/linkPlayerToUser.js';

describe('linkPlayerToUser', () => {
  beforeAll(async () => {
    await connectTestDb();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const makePlayer = (createdBy, name = 'Rahul', extra = {}) =>
    Player.create({ name, nameLower: name.toLowerCase(), createdBy, ...extra });

  it('links an unlinked player and returns it', async () => {
    const { user: scorer } = await createTestUser();
    const { user } = await createTestUser();
    const player = await makePlayer(scorer._id);

    const linked = await linkPlayerToUser(player._id, user._id);

    expect(String(linked.linkedUserId)).toBe(String(user._id));
    expect(String((await Player.findById(player._id)).linkedUserId)).toBe(String(user._id));
  });

  it('is idempotent for the account that already holds the link', async () => {
    const { user: scorer } = await createTestUser();
    const { user } = await createTestUser();
    const player = await makePlayer(scorer._id, 'Rahul', { linkedUserId: user._id });

    const linked = await linkPlayerToUser(player._id, user._id);

    expect(String(linked.linkedUserId)).toBe(String(user._id));
  });

  it('throws 404 PLAYER_NOT_FOUND for a missing or soft-deleted player', async () => {
    const { user: scorer } = await createTestUser();
    const { user } = await createTestUser();
    const gone = await makePlayer(scorer._id, 'Gone', { isDeleted: true });

    await expect(linkPlayerToUser(gone._id, user._id)).rejects.toMatchObject({ statusCode: 404, message: 'PLAYER_NOT_FOUND' });
  });

  it('throws 409 PLAYER_ALREADY_CLAIMED when a different account holds the link', async () => {
    const { user: scorer } = await createTestUser();
    const { user: holder } = await createTestUser();
    const { user: other } = await createTestUser();
    const player = await makePlayer(scorer._id, 'Rahul', { linkedUserId: holder._id });

    await expect(linkPlayerToUser(player._id, other._id)).rejects.toMatchObject({ statusCode: 409, message: 'PLAYER_ALREADY_CLAIMED' });
    expect(String((await Player.findById(player._id)).linkedUserId)).toBe(String(holder._id));
  });

  it('leaves exactly one winner when two accounts link at the same moment', async () => {
    const { user: scorer } = await createTestUser();
    const { user: a } = await createTestUser();
    const { user: b } = await createTestUser();
    const player = await makePlayer(scorer._id);

    const results = await Promise.allSettled([
      linkPlayerToUser(player._id, a._id),
      linkPlayerToUser(player._id, b._id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected.reason).toMatchObject({ statusCode: 409, message: 'PLAYER_ALREADY_CLAIMED' });
  });
});
