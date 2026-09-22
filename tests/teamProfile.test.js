import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { createMatch, startLiveInnings } from './helpers/matchSetup.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Team } from '../src/models/team.model.js';
import { Player } from '../src/models/player.model.js';

// Team profile: name + roster. Roster fields mirror the lightweight identity
// fields already used elsewhere (Scorecard's battingScores/bowlingScores),
// not the much heavier career-stats payload — there is no existing
// "player-summary" object to reuse verbatim, so this is the natural shape.
describe('GET /v1/team/:teamId', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true, withOrganization: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const getTeamProfile = (token, teamId) =>
    request(app)
      .get(`/api/v1/team/${teamId}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

  it('404s for a teamId that does not exist', async () => {
    const { token } = await createTestUser();

    const res = await getTeamProfile(token, '665f3b1c2d3e4f5a6b7c8d90');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_FOUND');
  });

  it("403s for a team that belongs to a different scorer's account", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const matchId = await createMatch(app, ownerToken);
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ teamAName: 'Owner A', teamBName: 'Owner B', totalOvers: 5 });
    const teamId = createRes.body.data.teamA.id;

    const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });
    const res = await getTeamProfile(strangerToken, teamId);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_OWNED');
  });

  it('returns the team name and an empty roster before any player is rostered', async () => {
    const { token } = await createTestUser();
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings', totalOvers: 5 });
    const teamId = createRes.body.data.teamA.id;

    const res = await getTeamProfile(token, teamId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      teamId,
      name: 'Mumbai Indians',
      roster: [],
    });
  });

  it('canManage is true for the creator of a standalone team', async () => {
    const { token } = await createTestUser();
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings', totalOvers: 5 });
    const teamId = createRes.body.data.teamA.id;

    const res = await getTeamProfile(token, teamId);

    expect(res.body.data.canManage).toBe(true);
  });

  it('canManage is false for an organization member who is not the org owner', async () => {
    const { token: ownerToken, user: owner } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await request(app)
      .post('/api/v1/organization')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
    await request(app)
      .post(`/api/v1/organization/${orgId}/members`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'member@example.com' });

    const teamRes = await request(app)
      .post(`/api/v1/organization/${orgId}/teams`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;

    const res = await getTeamProfile(memberToken, teamId);

    expect(res.status).toBe(200);
    expect(res.body.data.canManage).toBe(false);
  });

  // canManageTeam runs on the team AFTER getTeamProfile populates
  // team.organization (team.controller.js), so it's handed a populated
  // Organization document rather than a bare id. Mongoose casts that back
  // to an id for the query today, but nothing pins that down — this
  // regression test is what would catch a future populate/select change
  // silently making every org owner lose their edit/delete buttons.
  it('canManage is true for the organization owner, through the populated team', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
    const orgRes = await request(app)
      .post('/api/v1/organization')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;

    const teamRes = await request(app)
      .post(`/api/v1/organization/${orgId}/teams`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;

    const res = await getTeamProfile(ownerToken, teamId);

    expect(res.status).toBe(200);
    expect(res.body.data.canManage).toBe(true);
  });

  it('returns a roster entry for each player rostered onto the team', async () => {
    const { token } = await createTestUser();
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Team A', teamBName: 'Team B', totalOvers: 1 });
    const matchId = createRes.body.data.matchId;
    const teamId = createRes.body.data.teamA.id;

    // No toss given, so battingFirst defaults to teamA (resolveToss.js) —
    // striker/non-striker/bowler all roster onto teamA here.
    await startLiveInnings(app, token, matchId, {
      strikerName: 'Rahul',
      nonStrikerName: 'Ravi',
      bowlerName: 'BowlerB1',
    });

    const res = await getTeamProfile(token, teamId);

    expect(res.status).toBe(200);
    const names = res.body.data.roster.map((p) => p.playerName);
    expect(names).toEqual(expect.arrayContaining(['Rahul', 'Ravi']));
    expect(res.body.data.roster[0]).toHaveProperty('playerId');
    expect(res.body.data.roster[0]).toHaveProperty('role');
  });

  it('404s for a soft-deleted team, same as one that never existed', async () => {
    const { token } = await createTestUser();
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings', totalOvers: 5 });
    const teamId = createRes.body.data.teamA.id;
    await Team.findByIdAndUpdate(teamId, { isDeleted: true });

    const res = await getTeamProfile(token, teamId);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_FOUND');
  });

  it('excludes a soft-deleted player from the roster', async () => {
    const { token } = await createTestUser();
    const createRes = await request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ teamAName: 'Team A', teamBName: 'Team B', totalOvers: 1 });
    const matchId = createRes.body.data.matchId;
    const teamId = createRes.body.data.teamA.id;
    await startLiveInnings(app, token, matchId, {
      strikerName: 'Rahul',
      nonStrikerName: 'Ravi',
      bowlerName: 'BowlerB1',
    });
    await Player.findOneAndUpdate({ nameLower: 'ravi' }, { isDeleted: true });

    const res = await getTeamProfile(token, teamId);

    const names = res.body.data.roster.map((p) => p.playerName);
    expect(names).toEqual(['Rahul']);
  });
});
