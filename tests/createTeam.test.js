import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Team } from '../src/models/team.model.js';

describe('POST /v1/team', () => {
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

  const post = (token, body) => {
    const req = request(app).post('/api/v1/team');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return body === undefined ? req : req.send(body);
  };

  it('creates a standalone team owned by the caller', async () => {
    const { user, token } = await createTestUser();

    const res = await post(token, { name: 'Riverside U19', shortName: 'ru19' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      id: expect.any(String),
      name: 'Riverside U19',
      shortName: 'RU19',
      logoUrl: null,
      organization: null,
    });

    const stored = await Team.findById(res.body.data.id);
    expect(String(stored.createdBy)).toBe(String(user._id));
    expect(stored.organization).toBeNull();
    expect(stored.isDeleted).toBe(false);
  });

  it('trims the name and short name', async () => {
    const { token } = await createTestUser();

    const res = await post(token, { name: '  Mumbai Indians  ', shortName: '  mi ' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Mumbai Indians', shortName: 'MI' });
  });

  it('treats a blank short name as absent', async () => {
    const { token } = await createTestUser();

    const res = await post(token, { name: 'Sunday Sixers', shortName: '   ' });

    expect(res.status).toBe(200);
    expect(res.body.data.shortName).toBeNull();
    const stored = await Team.findById(res.body.data.id);
    expect(stored.shortName).toBeUndefined();
  });

  it('accepts a short name that is omitted entirely', async () => {
    const { token } = await createTestUser();

    const res = await post(token, { name: 'Office XI' });

    expect(res.status).toBe(200);
    expect(res.body.data.shortName).toBeNull();
  });

  it('accepts a name of exactly 50 characters and a short name of exactly 5', async () => {
    const { token } = await createTestUser();

    const res = await post(token, { name: 'a'.repeat(50), shortName: 'abcde' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toHaveLength(50);
    expect(res.body.data.shortName).toBe('ABCDE');
  });

  it.each([
    ['a missing name', { shortName: 'MI' }],
    ['an empty name', { name: '' }],
    ['a whitespace-only name', { name: '    ' }],
    ['a non-string name', { name: 42 }],
  ])('400 TEAM_NAME_REQUIRED for %s', async (_label, body) => {
    const { token } = await createTestUser();

    const res = await post(token, body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NAME_REQUIRED');
  });

  it('400 TEAM_NAME_REQUIRED when there is no body at all', async () => {
    const { token } = await createTestUser();

    const res = await post(token);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NAME_REQUIRED');
  });

  it('400 TEAM_NAME_TOO_LONG for a 51-character name, never a 500', async () => {
    const { token } = await createTestUser();

    const res = await post(token, { name: 'a'.repeat(51) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NAME_TOO_LONG');
  });

  it('400 TEAM_SHORT_NAME_TOO_LONG for a 6-character short name', async () => {
    const { token } = await createTestUser();

    const res = await post(token, { name: 'Sunday Sixers', shortName: 'abcdef' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_SHORT_NAME_TOO_LONG');
  });

  it('creates nothing when validation fails', async () => {
    const { token } = await createTestUser();

    await post(token, { name: 'a'.repeat(51) });

    expect(await Team.countDocuments()).toBe(0);
  });

  it('401s without a token', async () => {
    const res = await post(undefined, { name: 'Sunday Sixers' });

    expect(res.status).toBe(401);
  });

  it('shows the new team in GET /v1/team', async () => {
    const { token } = await createTestUser();
    const created = await post(token, { name: 'Sunday Sixers' });

    const list = await request(app).get('/api/v1/team').set('Authorization', `Bearer ${token}`);

    expect(list.status).toBe(200);
    expect(list.body.data.teams.map((t) => t.id)).toContain(created.body.data.id);
  });

  it("does not show one caller's team to another", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: otherToken } = await createTestUser({ email: 'other@example.com' });
    const created = await post(ownerToken, { name: 'Sunday Sixers' });

    const list = await request(app).get('/api/v1/team').set('Authorization', `Bearer ${otherToken}`);

    expect(list.body.data.teams.map((t) => t.id)).not.toContain(created.body.data.id);
  });
});
