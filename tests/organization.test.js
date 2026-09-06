import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';
import { Team } from '../src/models/team.model.js';
import { Tournament } from '../src/models/tournament.model.js';
import { User } from '../src/models/user.model.js';

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

describe('GET /v1/organization/:orgId', () => {
  const getOrg = (token, orgId) =>
    request(app).get(`/api/v1/organization/${orgId}`).set('Authorization', `Bearer ${token}`).send();

  it("404s for an orgId that doesn't exist", async () => {
    const { token } = await createTestUser();

    const res = await getOrg(token, '665f3b1c2d3e4f5a6b7c8d90');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ORG_NOT_FOUND');
  });

  it('403s for a caller who is not a member', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const res = await getOrg(strangerToken, orgId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ORG_MEMBER');
  });

  it('returns members and teams for the owner', async () => {
    const { token } = await createTestUser({ fullName: 'Asha' });
    const createRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await getOrg(token, orgId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Riverside CC',
      owner: { name: 'Asha' },
      members: [{ name: 'Asha', role: 'owner' }],
      teams: [],
    });
  });

  it("includes the organization's tournaments", async () => {
    const { token } = await createTestUser();
    const createRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    await request(app)
      .post(`/api/v1/organization/${orgId}/tournaments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Summer T20', format: 'knockout' });

    const res = await getOrg(token, orgId);

    expect(res.status).toBe(200);
    expect(res.body.data.tournaments).toMatchObject([
      { name: 'Summer T20', format: 'knockout', status: 'upcoming', teamCount: 0 },
    ]);
  });

  it('omits a member whose user account no longer exists instead of 500ing', async () => {
    const { token, user: owner } = await createTestUser({ fullName: 'Asha', email: 'owner@example.com' });
    const createRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    const { user: gone } = await createTestUser({ fullName: 'Gone', email: 'gone@example.com' });
    await request(app)
      .post(`/api/v1/organization/${orgId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'gone@example.com' });
    await User.findByIdAndDelete(gone._id);

    const res = await getOrg(token, orgId);

    expect(res.status).toBe(200);
    expect(res.body.data.members).toMatchObject([{ name: 'Asha', role: 'owner' }]);
  });
});

describe('POST /v1/organization/:orgId/members', () => {
  const addMember = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${token}`).send(body);

  it('adds an existing user as a member', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { user: vikram } = await createTestUser({ email: 'vikram@example.com', fullName: 'Vikram' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await addMember(ownerToken, orgId, { email: 'vikram@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: String(vikram._id), name: 'Vikram', role: 'member' });
  });

  it('403s when a non-owner tries to add a member', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    await createTestUser({ email: 'vikram@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await addMember(strangerToken, orgId, { email: 'vikram@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });

  it("404s for an email with no matching account", async () => {
    const { token } = await createTestUser();
    const createRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await addMember(token, orgId, { email: 'nobody@example.com' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('409s when adding someone already a member', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    await createTestUser({ email: 'vikram@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'vikram@example.com' });

    const res = await addMember(ownerToken, orgId, { email: 'vikram@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ORG_MEMBER');
  });
});

describe('DELETE /v1/organization/:orgId/members/:userId', () => {
  const addMember = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${token}`).send(body);

  const removeMember = (token, orgId, userId) =>
    request(app).delete(`/api/v1/organization/${orgId}/members/${userId}`).set('Authorization', `Bearer ${token}`).send();

  it('lets the owner remove a member', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { user: vikram } = await createTestUser({ email: 'vikram@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'vikram@example.com' });

    const res = await removeMember(ownerToken, orgId, vikram._id);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orgId, userId: String(vikram._id) });
  });

  it('lets a member remove themselves', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: vikramToken, user: vikram } = await createTestUser({ email: 'vikram@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'vikram@example.com' });

    const res = await removeMember(vikramToken, orgId, vikram._id);

    expect(res.status).toBe(200);
  });

  it('403s when a member (not the owner) tries to remove someone else', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: vikramToken } = await createTestUser({ email: 'vikram@example.com' });
    const { user: raj } = await createTestUser({ email: 'raj@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'vikram@example.com' });
    await addMember(ownerToken, orgId, { email: 'raj@example.com' });

    const res = await removeMember(vikramToken, orgId, raj._id);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });

  it('400s when anyone, including the owner, targets the owner', async () => {
    const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await removeMember(ownerToken, orgId, owner._id);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANNOT_REMOVE_OWNER');
  });
});

describe('POST /v1/organization/:orgId/teams', () => {
  const createOrgTeam = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

  it('creates a new team directly under the organization', async () => {
    const { token } = await createTestUser();
    const createRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await createOrgTeam(token, orgId, { name: 'Riverside U19', shortName: 'ru19' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Riverside U19',
      shortName: 'RU19',
      organization: orgId,
    });
  });

  it('403s when a non-owner tries to create a team under the org', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const createRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await createOrgTeam(strangerToken, orgId, { name: 'Riverside U19' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });

  it('400s for an empty name', async () => {
    const { token } = await createTestUser();
    const createRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = createRes.body.data.id;

    const res = await createOrgTeam(token, orgId, { name: '  ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEAM_NAMES_REQUIRED');
  });
});

describe('DELETE /v1/organization/:orgId', () => {
  const createOrgTeam = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

  const deleteOrg = (token, orgId) =>
    request(app).delete(`/api/v1/organization/${orgId}`).set('Authorization', `Bearer ${token}`).send();

  const getOrg = (token, orgId) =>
    request(app).get(`/api/v1/organization/${orgId}`).set('Authorization', `Bearer ${token}`).send();

  it('soft-deletes the organization and orphans its teams back to standalone', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const teamRes = await createOrgTeam(token, orgId, { name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;

    const res = await deleteOrg(token, orgId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ orgId });

    const team = await Team.findById(teamId);
    expect(team.organization).toBeNull();

    const afterDelete = await getOrg(token, orgId);
    expect(afterDelete.status).toBe(404);
    expect(afterDelete.body.code).toBe('ORG_NOT_FOUND');
  });

  it('soft-deletes tournaments under the organization (they cannot be orphaned like teams)', async () => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await request(app)
      .post(`/api/v1/organization/${orgId}/tournaments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Summer T20', format: 'knockout' });
    const tournamentId = tournamentRes.body.data.id;

    await deleteOrg(token, orgId);

    const tournament = await Tournament.findById(tournamentId);
    expect(tournament.isDeleted).toBe(true);
  });

  it('403s when a non-owner tries to delete', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await deleteOrg(strangerToken, orgId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });
});
