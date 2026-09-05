import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';

describe('organization membership widens team access', () => {
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

  const addMember = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${token}`).send(body);

  const createOrgTeam = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

  const setupOrgWithTeamAndMember = async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'member@example.com' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;
    return { ownerToken, memberToken, member, orgId, teamId };
  };

  it('lets an org member create a match using an org-owned team', async () => {
    const { memberToken, teamId } = await setupOrgWithTeamAndMember();

    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ teamAId: teamId, teamBName: 'Visitors', totalOvers: 5 });

    expect(res.status).toBe(200);
    expect(res.body.data.teamA).toMatchObject({ id: teamId, name: 'Riverside U19' });
  });

  it('still 403s a non-member trying to use an org-owned team', async () => {
    const { teamId } = await setupOrgWithTeamAndMember();
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({ teamAId: teamId, teamBName: 'Visitors', totalOvers: 5 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_OWNED');
  });

  it('lets an org member view an org-owned team profile, with the organization populated', async () => {
    const { memberToken, teamId, orgId } = await setupOrgWithTeamAndMember();

    const res = await request(app)
      .get(`/api/v1/team/${teamId}`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: 'Riverside U19',
      organization: { id: orgId, name: 'Riverside CC' },
    });
  });

  it('returns organization: null on a standalone team profile', async () => {
    const { token } = await createTestUser();
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Standalone A', teamBName: 'Standalone B', totalOvers: 5 });
    const teamId = createRes.body.data.teamA.id;

    const res = await request(app)
      .get(`/api/v1/team/${teamId}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.body.data.organization).toBeNull();
  });

  it("lets an org member view an org-owned team's match history", async () => {
    const { memberToken, teamId } = await setupOrgWithTeamAndMember();

    const res = await request(app)
      .get(`/api/v1/team/${teamId}/matches`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.matches).toEqual([]);
  });

  it("includes an org's teams in GET /v1/team for every member, alongside their own, with organization populated", async () => {
    const { memberToken, teamId, orgId } = await setupOrgWithTeamAndMember();
    const standaloneRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ teamAName: "Member's Own Team", teamBName: 'Someone Else', totalOvers: 5 });
    const standaloneTeamId = standaloneRes.body.data.teamA.id;

    const res = await request(app)
      .get('/api/v1/team')
      .set('Authorization', `Bearer ${memberToken}`)
      .send();

    expect(res.status).toBe(200);
    const byId = new Map(res.body.data.teams.map((t) => [t.id, t]));
    expect(byId.get(teamId)).toMatchObject({ organization: { id: orgId, name: 'Riverside CC' } });
    expect(byId.get(standaloneTeamId)).toMatchObject({ organization: null });
  });

  it("does not include an org's teams for a non-member", async () => {
    const { teamId } = await setupOrgWithTeamAndMember();
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

    const res = await request(app)
      .get('/api/v1/team')
      .set('Authorization', `Bearer ${strangerToken}`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.data.teams.map((t) => t.id)).not.toContain(teamId);
  });

  it('ad-hoc match creation with two typed names is completely unaffected — both teams remain standalone', async () => {
    const { token } = await createTestUser();

    const res = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Ad Hoc A', teamBName: 'Ad Hoc B', totalOvers: 5 });

    expect(res.status).toBe(200);
    const teamsRes = await request(app)
      .get('/api/v1/team')
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(teamsRes.body.data.teams.every((t) => t.organization === null)).toBe(true);
  });
});
