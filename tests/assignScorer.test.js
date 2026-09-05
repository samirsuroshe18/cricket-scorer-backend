import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';

describe('PATCH /:matchId/scorer', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
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

  const addMember = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${token}`).send(body);

  const createOrgTeam = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

  const assignScorer = (token, matchId, body) =>
    request(app).patch(`/api/v1/match/${matchId}/scorer`).set('Authorization', `Bearer ${token}`).send(body);

  // teamA belongs to an org with owner + one member; teamB is a plain
  // ad-hoc team. The match is created by the org owner using that org's
  // team, matching the real flow (createMatch with teamAId).
  const setupOrgMatch = async () => {
    const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
    const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const orgRes = await createOrg(ownerToken, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await addMember(ownerToken, orgId, { email: 'member@example.com' });
    const teamRes = await createOrgTeam(ownerToken, orgId, { name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;
    const matchId = await createMatch(app, ownerToken, { teamAId: teamId, teamBName: 'Visitors' });
    return { ownerToken, owner, memberToken, member, strangerToken, orgId, teamId, matchId };
  };

  it('lets the creator assign a member of the org that owns teamA as scorer', async () => {
    const { ownerToken, member, matchId } = await setupOrgMatch();

    const res = await assignScorer(ownerToken, matchId, { scorerId: String(member._id) });

    expect(res.status).toBe(200);
    expect(res.body.data.assignedScorer).toMatchObject({ id: String(member._id), name: 'Test User' });
    const match = await Match.findById(matchId);
    expect(match.assignedScorer.equals(member._id)).toBe(true);
  });

  it('lets the org owner assign a scorer even on a match they did not create', async () => {
    const { ownerToken, memberToken, member, teamId } = await setupOrgMatch();
    // A second match, created by the member (not the owner) using the same org team.
    const matchId = await createMatch(app, memberToken, { teamAId: teamId, teamBName: 'Visitors 2' });

    const res = await assignScorer(ownerToken, matchId, { scorerId: String(member._id) });

    expect(res.status).toBe(200);
    expect(res.body.data.assignedScorer.id).toBe(String(member._id));
  });

  it('rejects a plain org member (not owner, not creator) trying to assign', async () => {
    const { memberToken, member, matchId } = await setupOrgMatch();

    const res = await assignScorer(memberToken, matchId, { scorerId: String(member._id) });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });

  it('rejects a stranger with no relationship to the match', async () => {
    const { strangerToken, member, matchId } = await setupOrgMatch();

    const res = await assignScorer(strangerToken, matchId, { scorerId: String(member._id) });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCH_NOT_OWNED');
  });

  it('rejects assigning a user who is not a member of any qualifying org', async () => {
    const { ownerToken, matchId } = await setupOrgMatch();
    const { user: outsider } = await createTestUser({ email: 'outsider@example.com' });

    const res = await assignScorer(ownerToken, matchId, { scorerId: String(outsider._id) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SCORER');
  });

  it('rejects assigning on a match with no org-linked team', async () => {
    const { token } = await createTestUser({ email: 'adhoc@example.com' });
    const { user: other } = await createTestUser({ email: 'other@example.com' });
    const matchId = await createMatch(app, token);

    const res = await assignScorer(token, matchId, { scorerId: String(other._id) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MATCH_NOT_ORG_LINKED');
  });

  it('clears the assignment when scorerId is null', async () => {
    const { ownerToken, member, matchId } = await setupOrgMatch();
    await assignScorer(ownerToken, matchId, { scorerId: String(member._id) });

    const res = await assignScorer(ownerToken, matchId, { scorerId: null });

    expect(res.status).toBe(200);
    expect(res.body.data.assignedScorer).toBeNull();
    const match = await Match.findById(matchId);
    expect(match.assignedScorer).toBeNull();
  });

  it('reassigns to a different member, replacing the previous assignee', async () => {
    const { ownerToken, owner, member, matchId } = await setupOrgMatch();
    await assignScorer(ownerToken, matchId, { scorerId: String(member._id) });

    const res = await assignScorer(ownerToken, matchId, { scorerId: String(owner._id) });

    expect(res.status).toBe(200);
    expect(res.body.data.assignedScorer.id).toBe(String(owner._id));
  });

  it('works on a completed match, not just upcoming/live', async () => {
    const { ownerToken, member, matchId } = await setupOrgMatch();
    await Match.updateOne({ _id: matchId }, { $set: { status: 'completed' } });

    const res = await assignScorer(ownerToken, matchId, { scorerId: String(member._id) });

    expect(res.status).toBe(200);
  });

  it('rejects with MATCH_NOT_FOUND for an unknown matchId', async () => {
    const { token } = await createTestUser();

    const res = await assignScorer(token, '000000000000000000000000', { scorerId: null });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('MATCH_NOT_FOUND');
  });
});
