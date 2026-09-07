import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';
import { PlayerPoolEntry } from '../src/models/playerPoolEntry.model.js';
import { Player } from '../src/models/player.model.js';

let app;

beforeAll(async () => {
  await connectTestDb();
  await Tournament.init();
  await PlayerPoolEntry.init();
  app = buildTestApp({ withOrganization: true, withTournament: true });
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const createOrg = (token, body) =>
  request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

const addMember = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${token}`).send(body);

const createTournament = (token, orgId, body) =>
  request(app).post(`/api/v1/organization/${orgId}/tournaments`).set('Authorization', `Bearer ${token}`).send(body);

const registerPlayer = (token, tournamentId, body) =>
  request(app).post(`/api/v1/tournament/${tournamentId}/pool`).set('Authorization', `Bearer ${token}`).send(body);

// org owner + a plain member + a tournament they both belong to, none of
// this tournament's own pool populated yet — every register test builds on
// this same shape.
const setupOwnedTournament = async () => {
  const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
  const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
  const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
  const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
  const orgId = orgRes.body.data.id;
  await addMember(ownerToken, orgId, { email: 'member@example.com' });
  const tournamentRes = await createTournament(ownerToken, orgId, { name: 'Summer T20', format: 'league' });
  const tournamentId = tournamentRes.body.data.id;
  return { ownerToken, owner, memberToken, strangerToken, tournamentId };
};

describe('POST /:tournamentId/pool', () => {
  it('lets the org owner register a new player by name', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });

    expect(res.status).toBe(201);
    expect(res.body.data.playerName).toBe('Rohit Sharma');
    expect(res.body.data.basePrice).toBe(5000);
    const entry = await PlayerPoolEntry.findOne({ tournament: tournamentId });
    expect(entry.basePrice).toBe(5000);
  });

  it('rejects a plain org member (not owner) trying to register', async () => {
    const { memberToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(memberToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
  });

  it('rejects a stranger with no relationship to the organization', async () => {
    const { strangerToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(strangerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('rejects a blank player name with no playerId given', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(ownerToken, tournamentId, { playerName: '  ', basePrice: 5000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('POOL_PLAYER_NAME_REQUIRED');
  });

  it('rejects a missing basePrice', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BASE_PRICE_REQUIRED');
  });

  it.each([0, -100, 1.5, 100000001])('rejects an invalid basePrice of %p', async (basePrice) => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BASE_PRICE');
  });

  it('rejects registering the same resolved player twice for the same tournament', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();
    await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });

    const res = await registerPlayer(ownerToken, tournamentId, { playerName: 'rohit sharma', basePrice: 6000 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PLAYER_ALREADY_IN_POOL');
  });

  it('allows registering the same player name across two different tournaments', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();
    await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });
    const orgRes = await createOrg(ownerToken, { name: 'Second Org' });
    const tournament2Res = await createTournament(ownerToken, orgRes.body.data.id, { name: 'Winter T20', format: 'knockout' });

    const res = await registerPlayer(ownerToken, tournament2Res.body.data.id, { playerName: 'Rohit Sharma', basePrice: 7000 });

    expect(res.status).toBe(201);
  });

  it('accepts an explicit playerId already owned by the organizer', async () => {
    const { ownerToken, owner, tournamentId } = await setupOwnedTournament();
    const player = await Player.create({ name: 'Virat Kohli', nameLower: 'virat kohli', createdBy: owner._id });

    const res = await registerPlayer(ownerToken, tournamentId, { playerId: String(player._id), basePrice: 9000 });

    expect(res.status).toBe(201);
    expect(res.body.data.playerId).toBe(String(player._id));
  });

  it('rejects a playerId owned by a different user', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();
    const { user: someoneElse } = await createTestUser({ email: 'someoneelse@example.com' });
    const player = await Player.create({ name: 'Virat Kohli', nameLower: 'virat kohli', createdBy: someoneElse._id });

    const res = await registerPlayer(ownerToken, tournamentId, { playerId: String(player._id), basePrice: 9000 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PLAYER_ID');
  });

  it('rejects with TOURNAMENT_NOT_FOUND for an unknown tournamentId', async () => {
    const { token } = await createTestUser();

    const res = await registerPlayer(token, '000000000000000000000000', { playerName: 'A', basePrice: 100 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });
});

const listPool = (token, tournamentId) =>
  request(app).get(`/api/v1/tournament/${tournamentId}/pool`).set('Authorization', `Bearer ${token}`);

describe('GET /:tournamentId/pool', () => {
  it('lists registered players in registration order for any org member', async () => {
    const { ownerToken, memberToken, tournamentId } = await setupOwnedTournament();
    await registerPlayer(ownerToken, tournamentId, { playerName: 'Rohit Sharma', basePrice: 5000 });
    await registerPlayer(ownerToken, tournamentId, { playerName: 'Virat Kohli', basePrice: 9000 });

    const res = await listPool(memberToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.entries.map((e) => e.playerName)).toEqual(['Rohit Sharma', 'Virat Kohli']);
    expect(res.body.data.entries[1].basePrice).toBe(9000);
  });

  it('returns an empty list, not an error, for a tournament with nothing registered', async () => {
    const { ownerToken, tournamentId } = await setupOwnedTournament();

    const res = await listPool(ownerToken, tournamentId);

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toEqual([]);
  });

  it('rejects a non-member of the owning organization', async () => {
    const { strangerToken, tournamentId } = await setupOwnedTournament();

    const res = await listPool(strangerToken, tournamentId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('rejects with TOURNAMENT_NOT_FOUND for an unknown tournamentId', async () => {
    const { token } = await createTestUser();

    const res = await listPool(token, '000000000000000000000000');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
  });
});
