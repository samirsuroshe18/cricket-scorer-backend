import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';

describe('PATCH /v1/team/:teamId/organization', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    await Organization.init();
    app = buildTestApp({ withTeam: true, withOrganization: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const createOrg = (token, body) =>
    request(app).post('/api/v1/organization').set('Authorization', `Bearer ${token}`).send(body);

  const updateTeamOrg = (token, teamId, body) =>
    request(app).patch(`/api/v1/team/${teamId}/organization`).set('Authorization', `Bearer ${token}`).send(body);

  const createTeamViaMatch = async (token) => {
    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings', totalOvers: 5 });
    return res.body.data.teamA.id;
  };

  it('attaches a standalone team the caller owns to an org the caller owns', async () => {
    const { token } = await createTestUser();
    const teamId = await createTeamViaMatch(token);
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const res = await updateTeamOrg(token, teamId, { organizationId: orgId });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: teamId, organization: orgId });
  });

  it('detaches an org-owned team back to standalone', async () => {
    const { token } = await createTestUser();
    const teamId = await createTeamViaMatch(token);
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await updateTeamOrg(token, teamId, { organizationId: orgId });

    const res = await updateTeamOrg(token, teamId, { organizationId: null });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: teamId, organization: null });
  });

  it("403s when attaching a team the caller doesn't own", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const teamId = await createTeamViaMatch(ownerToken);
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await updateTeamOrg(strangerToken, teamId, { organizationId: orgId });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_OWNED');
  });

  it("403s when attaching to an org the caller doesn't own", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const teamId = await createTeamViaMatch(ownerToken);
    const { token: otherOwnerToken } = await createTestUser({ email: 'other@example.com' });
    const orgRes = await createOrg(otherOwnerToken, { name: 'Other CC' });
    const orgId = orgRes.body.data.id;

    const res = await updateTeamOrg(ownerToken, teamId, { organizationId: orgId });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORG_NOT_OWNED');
  });

  it('409s when attaching a team that already belongs to an organization', async () => {
    const { token } = await createTestUser();
    const teamId = await createTeamViaMatch(token);
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await updateTeamOrg(token, teamId, { organizationId: orgId });
    const secondOrgRes = await createOrg(token, { name: 'Second CC' });

    const res = await updateTeamOrg(token, teamId, { organizationId: secondOrgRes.body.data.id });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEAM_ALREADY_IN_ORGANIZATION');
  });

  it("404s when attaching to an organizationId that doesn't exist", async () => {
    const { token } = await createTestUser();
    const teamId = await createTeamViaMatch(token);

    const res = await updateTeamOrg(token, teamId, { organizationId: '665f3b1c2d3e4f5a6b7c8d90' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ORG_NOT_FOUND');
  });
});
