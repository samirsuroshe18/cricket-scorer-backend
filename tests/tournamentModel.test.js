import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';

describe('Tournament model', () => {
  beforeAll(async () => {
    await connectTestDb();
    // Indexes are created asynchronously on connect; wait for them so the
    // uniqueness test below isn't racing index creation.
    await Tournament.init();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const objectId = () => new mongoose.Types.ObjectId();

  it('requires name, organization, format, and createdBy', async () => {
    await expect(Tournament.create({})).rejects.toThrow();
  });

  it('defaults status to upcoming, isDeleted to false, and teams to empty', async () => {
    const organization = objectId();
    const createdBy = objectId();
    const tournament = await Tournament.create({
      name: 'Riverside Summer T20',
      nameLower: 'riverside summer t20',
      organization,
      format: 'knockout',
      createdBy,
    });

    expect(tournament.status).toBe('upcoming');
    expect(tournament.isDeleted).toBe(false);
    expect(tournament.teams).toEqual([]);
  });

  it('rejects a format outside the enum', async () => {
    const organization = objectId();
    const createdBy = objectId();

    await expect(
      Tournament.create({
        name: 'Riverside Summer T20',
        nameLower: 'riverside summer t20',
        organization,
        format: 'swiss',
        createdBy,
      })
    ).rejects.toThrow();
  });

  it('stamps joinedAt when a team subdocument is added', async () => {
    const organization = objectId();
    const createdBy = objectId();
    const team = objectId();

    const tournament = await Tournament.create({
      name: 'Riverside Summer T20',
      nameLower: 'riverside summer t20',
      organization,
      format: 'round_robin',
      createdBy,
      teams: [{ team }],
    });

    expect(tournament.teams[0].team).toEqual(team);
    expect(tournament.teams[0].joinedAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate {organization, nameLower} pair', async () => {
    const organization = objectId();
    const createdBy = objectId();

    await Tournament.create({
      name: 'Riverside Summer T20',
      nameLower: 'riverside summer t20',
      organization,
      format: 'league',
      createdBy,
    });

    await expect(
      Tournament.create({
        name: 'Riverside Summer T20',
        nameLower: 'riverside summer t20',
        organization,
        format: 'league',
        createdBy: objectId(),
      })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows two different organizations to use the same tournament name', async () => {
    const createdBy = objectId();

    await Tournament.create({
      name: 'Summer T20',
      nameLower: 'summer t20',
      organization: objectId(),
      format: 'knockout',
      createdBy,
    });

    await expect(
      Tournament.create({
        name: 'Summer T20',
        nameLower: 'summer t20',
        organization: objectId(),
        format: 'knockout',
        createdBy,
      })
    ).resolves.toBeDefined();
  });
});
