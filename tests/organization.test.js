import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';

// DB connect/disconnect is shared across every describe block below — Jest
// runs describe blocks in the same file sequentially, but a describe's own
// afterAll fires as soon as that describe's tests finish, not at the end of
// the file. Scoping connectTestDb/disconnectTestDb to one describe would
// close the connection before the next describe's tests ever ran.
let app;

beforeAll(async () => {
  await connectTestDb();
  await Organization.init();
  app = buildTestApp({ withOrganization: true });
});

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

const createOrg = (token, body) =>
  request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

describe('POST /v1/organization', () => {
  it('creates an organization with the caller as owner and sole member', async () => {
    const { token, user } = await createTestUser({ fullName: 'Asha' });

    const res = await createOrg(token, { name: 'Riverside Cricket Club' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Riverside Cricket Club',
      owner: { id: String(user._id), name: 'Asha' },
      members: [{ id: String(user._id), name: 'Asha', role: 'owner' }],
      teams: [],
    });
  });

  it('400s for an empty name', async () => {
    const { token } = await createTestUser();

    const res = await createOrg(token, { name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORG_NAME_REQUIRED');
  });

  it("409s when the same owner reuses a name, case-insensitively", async () => {
    const { token } = await createTestUser();
    await createOrg(token, { name: 'Riverside CC' });

    const res = await createOrg(token, { name: 'riverside cc' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ORG_NAME_TAKEN');
  });

  it('allows two different owners to use the same name', async () => {
    const { token: token1 } = await createTestUser({ email: 'owner1@example.com' });
    const { token: token2 } = await createTestUser({ email: 'owner2@example.com' });
    await createOrg(token1, { name: 'Riverside CC' });

    const res = await createOrg(token2, { name: 'Riverside CC' });

    expect(res.status).toBe(200);
  });
});

describe('GET /v1/organization', () => {
  const listOrgs = (token) =>
    request(app).get('/api/v1/organization').set('Authorization', `Bearer ${token}`).send();

  it('lists an organization the caller owns', async () => {
    const { token } = await createTestUser();
    await createOrg(token, { name: 'Riverside CC' });

    const res = await listOrgs(token);

    expect(res.status).toBe(200);
    expect(res.body.data.organizations).toMatchObject([
      { name: 'Riverside CC', myRole: 'owner', memberCount: 1, teamCount: 0 },
    ]);
  });

  it('returns an empty list for a caller in no organizations', async () => {
    const { token } = await createTestUser();

    const res = await listOrgs(token);

    expect(res.status).toBe(200);
    expect(res.body.data.organizations).toEqual([]);
  });
});
