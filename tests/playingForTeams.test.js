import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';
import { Organization } from '../src/models/organization.model.js';

describe('GET /v1/team/playing-for', () => {
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

  const list = (token, query = '') => {
    const req = request(app).get(`/api/v1/team/playing-for${query}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req;
  };

  const makePlayer = (createdBy, name, extra = {}) =>
    Player.create({ name, nameLower: name.toLowerCase(), createdBy, ...extra });

  const makeTeam = (createdBy, players = [], extra = {}) =>
    Team.create({ name: 'Riverside', createdBy, players: players.map((p) => p._id), ...extra });

  it('lists a team where the caller is a linked roster player', async () => {
    const { user: scorer } = await createTestUser();
    const { user, token } = await createTestUser();
    const player = await makePlayer(scorer._id, 'Mohit Zatu', { linkedUserId: user._id });
    const team = await makeTeam(scorer._id, [player], { name: 'Mumbai Indians', shortName: 'MI' });

    const res = await list(token);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.teams).toEqual([
      {
        id: String(team._id),
        name: 'Mumbai Indians',
        shortName: 'MI',
        logoUrl: null,
        myPlayerName: 'Mohit Zatu',
      },
    ]);
  });

  it('is empty for unlinked players and players linked to someone else', async () => {
    const { user: scorer } = await createTestUser();
    const { user: other } = await createTestUser();
    const { token } = await createTestUser();
    const unlinked = await makePlayer(scorer._id, 'Unlinked');
    const theirs = await makePlayer(scorer._id, 'Theirs', { linkedUserId: other._id });
    await makeTeam(scorer._id, [unlinked, theirs]);

    const res = await list(token);

    expect(res.body.data.teams).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('excludes teams the caller created, even when also linked', async () => {
    const { user, token } = await createTestUser();
    const player = await makePlayer(user._id, 'Me', { linkedUserId: user._id });
    await makeTeam(user._id, [player]);

    const res = await list(token);

    expect(res.body.data.teams).toEqual([]);
  });

  it('excludes teams of an organization the caller belongs to', async () => {
    const { user: scorer } = await createTestUser();
    const { user, token } = await createTestUser();
    const org = await Organization.create({
      name: 'Club',
      nameLower: 'club',
      owner: scorer._id,
      members: [
        { user: scorer._id, role: 'owner' },
        { user: user._id, role: 'member' },
      ],
    });
    const player = await makePlayer(scorer._id, 'Me', { linkedUserId: user._id });
    await makeTeam(scorer._id, [player], { organization: org._id });

    const res = await list(token);

    expect(res.body.data.teams).toEqual([]);
  });

  it('excludes soft-deleted teams and soft-deleted linked players', async () => {
    const { user: scorer } = await createTestUser();
    const { user, token } = await createTestUser();
    const live = await makePlayer(scorer._id, 'A', { linkedUserId: user._id });
    const gone = await makePlayer(scorer._id, 'B', { linkedUserId: user._id, isDeleted: true });
    await makeTeam(scorer._id, [live], { name: 'Deleted Team', isDeleted: true });
    await makeTeam(scorer._id, [gone], { name: 'Gone Player Team' });

    const res = await list(token);

    expect(res.body.data.teams).toEqual([]);
  });

  it('pages results and rejects a limit above the maximum', async () => {
    const { user: scorer } = await createTestUser();
    const { user, token } = await createTestUser();
    const p1 = await makePlayer(scorer._id, 'P1', { linkedUserId: user._id });
    const p2 = await makePlayer(scorer._id, 'P2', { linkedUserId: user._id });
    await makeTeam(scorer._id, [p1], { name: 'First' });
    await makeTeam(scorer._id, [p2], { name: 'Second' });

    const second = await list(token, '?page=2&limit=1');
    const tooMany = await list(token, '?limit=51');

    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ page: 2, limit: 1, total: 2 });
    expect(second.body.data.teams).toHaveLength(1);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('INVALID_PAGINATION');
  });

  it('returns 401 without a token', async () => {
    const res = await list(null);

    expect(res.status).toBe(401);
  });
});
