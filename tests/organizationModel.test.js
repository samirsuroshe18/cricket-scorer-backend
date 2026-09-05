import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';

describe('Organization model', () => {
  beforeAll(async () => {
    await connectTestDb();
    // Indexes are created asynchronously on connect; wait for them so the
    // uniqueness tests below aren't racing index creation.
    await Organization.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const ownerId = () => new mongoose.Types.ObjectId();

  it('requires name and owner', async () => {
    await expect(Organization.create({})).rejects.toThrow();
  });

  it('defaults isDeleted to false and stamps addedAt on a member', async () => {
    const owner = ownerId();
    const org = await Organization.create({
      name: 'Riverside Cricket Club',
      nameLower: 'riverside cricket club',
      owner,
      members: [{ user: owner, role: 'owner' }],
    });

    expect(org.isDeleted).toBe(false);
    expect(org.members[0].role).toBe('owner');
    expect(org.members[0].addedAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate {owner, nameLower} pair', async () => {
    const owner = ownerId();
    await Organization.create({
      name: 'Riverside CC',
      nameLower: 'riverside cc',
      owner,
      members: [{ user: owner, role: 'owner' }],
    });

    await expect(
      Organization.create({
        name: 'Riverside CC',
        nameLower: 'riverside cc',
        owner,
        members: [{ user: owner, role: 'owner' }],
      })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows two different owners to use the same name', async () => {
    const ownerA = ownerId();
    const ownerB = ownerId();
    await Organization.create({
      name: 'Riverside CC',
      nameLower: 'riverside cc',
      owner: ownerA,
      members: [{ user: ownerA, role: 'owner' }],
    });

    await expect(
      Organization.create({
        name: 'Riverside CC',
        nameLower: 'riverside cc',
        owner: ownerB,
        members: [{ user: ownerB, role: 'owner' }],
      })
    ).resolves.toBeDefined();
  });
});
