import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// Powers the "reuse an existing team" picker: lets the client offer the
// scorer their own past teams to attach via teamAId/teamBId on createMatch,
// rather than guessing identity from a typed name (see resolveTeamSide in
// match.controller.js for why guessing was rejected).
describe('GET /v1/team', () => {
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

  const createMatch = (token, body) =>
    request(app)
      .post('/api/v1/match/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ totalOvers: 5, ...body });

  const myTeams = (token, query = '') =>
    request(app)
      .get(`/api/v1/team${query}`)
      .set('Authorization', `Bearer ${token}`)
      .send();

  it("returns only the caller's own teams", async () => {
    const { token: mine } = await createTestUser();
    const { token: theirs } = await createTestUser();
    await createMatch(mine, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    await createMatch(theirs, { teamAName: 'Delhi Capitals', teamBName: 'Punjab Kings' });

    const res = await myTeams(mine);

    expect(res.status).toBe(200);
    const names = res.body.data.teams.map((t) => t.name);
    expect(names.sort()).toEqual(['Chennai Super Kings', 'Mumbai Indians']);
  });

  it('does not duplicate a team reused across two matches', async () => {
    const { token } = await createTestUser();
    const first = await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    const teamId = first.body.data.teamA.id;
    await createMatch(token, { teamAId: teamId, teamBName: 'Delhi Capitals' });

    const res = await myTeams(token);

    const mumbaiEntries = res.body.data.teams.filter((t) => t.id === teamId);
    expect(mumbaiEntries).toHaveLength(1);
  });

  it('returns an empty list for a scorer with no teams yet', async () => {
    const { token } = await createTestUser();

    const res = await myTeams(token);

    expect(res.status).toBe(200);
    expect(res.body.data.teams).toEqual([]);
  });

  it('carries page/limit/total alongside the default page', async () => {
    const { token } = await createTestUser();
    await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });

    const res = await myTeams(token);

    expect(res.body.data.page).toBe(1);
    expect(res.body.data.limit).toBe(20);
    expect(res.body.data.total).toBe(2);
  });

  it('paginates with ?page and ?limit, newest team first', async () => {
    const { token } = await createTestUser();
    // A shared opponent reused as teamBId keeps team creation to exactly one
    // new Team per loop iteration (teamA only), so creation order — and
    // therefore the newest-first sort — is deterministic.
    const seed = await createMatch(token, { teamAName: 'Seed Team', teamBName: 'Seed Opponent' });
    const opponentId = seed.body.data.teamB.id;
    for (const name of ['Mumbai Indians', 'Chennai Super Kings', 'Delhi Capitals']) {
      await createMatch(token, { teamAName: name, teamBId: opponentId });
    }

    const page1 = await myTeams(token, '?page=1&limit=2');
    expect(page1.body.data.teams).toHaveLength(2);
    expect(page1.body.data.total).toBe(5);
    expect(page1.body.data.teams[0].name).toBe('Delhi Capitals');

    const page2 = await myTeams(token, '?page=2&limit=2');
    expect(page2.body.data.teams).toHaveLength(2);
  });

  it('rejects an over-large limit rather than returning an unbounded list', async () => {
    const { token } = await createTestUser();

    const res = await myTeams(token, '?limit=10000');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAGINATION');
  });

  it('filters by ?q against name, case-insensitively', async () => {
    const { token } = await createTestUser();
    await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    await createMatch(token, { teamAName: 'Delhi Capitals', teamBName: 'Punjab Kings' });

    const res = await myTeams(token, '?q=mumbai');

    expect(res.status).toBe(200);
    expect(res.body.data.teams.map((t) => t.name)).toEqual(['Mumbai Indians']);
    expect(res.body.data.total).toBe(1);
  });

  it('filters by ?q against shortName too', async () => {
    const { token } = await createTestUser();
    const created = await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    const teamId = created.body.data.teamA.id;
    await request(app)
      .patch(`/api/v1/team/${teamId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Mumbai Indians', shortName: 'MI' });

    const res = await myTeams(token, '?q=mi');

    expect(res.body.data.teams.map((t) => t.name)).toEqual(['Mumbai Indians']);
  });

  it('returns an empty list, not an error, when nothing matches ?q', async () => {
    const { token } = await createTestUser();
    await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });

    const res = await myTeams(token, '?q=zzz-no-match');

    expect(res.status).toBe(200);
    expect(res.body.data.teams).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('rejects a search text over the max length', async () => {
    const { token } = await createTestUser();

    const res = await myTeams(token, `?q=${'a'.repeat(51)}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SEARCH_QUERY');
  });

  it('treats a regex special character in ?q as a literal, not a pattern', async () => {
    const { token } = await createTestUser();
    await createMatch(token, { teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });

    const res = await myTeams(token, `?q=${encodeURIComponent('.*')}`);

    expect(res.status).toBe(200);
    expect(res.body.data.teams).toEqual([]);
  });

  describe('?owner filter', () => {
    // Only an org's owner can create a team under it (createOrganizationTeam
    // requires findOwnedOrganization) — a plain member can only view those
    // teams via canAccessTeam's organization-membership branch. So "a team
    // created by someone else" only ever happens from the member's side:
    // the owner's org team, seen by a member who didn't create it.
    const setUpOrgTeam = async () => {
      const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
      const { token: memberToken, user: member } = await createTestUser({ email: 'member@example.com' });
      const orgRes = await request(app).post('/api/v1/organization').set('Authorization', `Bearer ${ownerToken}`).send({ name: 'Riverside CC' });
      const orgId = orgRes.body.data.id;
      await request(app).post(`/api/v1/organization/${orgId}/members`).set('Authorization', `Bearer ${ownerToken}`).send({ email: member.email });
      await request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${ownerToken}`).send({ name: "Owner's XI" });
      return { ownerToken, memberToken };
    };

    it('?owner=mine returns only teams the caller created directly', async () => {
      const { memberToken } = await setUpOrgTeam();
      await createMatch(memberToken, { teamAName: 'My Standalone Team', teamBName: 'Opponent' });

      const res = await myTeams(memberToken, '?owner=mine');

      expect(res.body.data.teams.map((t) => t.name).sort()).toEqual(['My Standalone Team', 'Opponent']);
    });

    it('?owner=others returns teams visible only through organization membership', async () => {
      const { memberToken } = await setUpOrgTeam();
      await createMatch(memberToken, { teamAName: 'My Standalone Team', teamBName: 'Opponent' });

      const res = await myTeams(memberToken, '?owner=others');

      expect(res.body.data.teams.map((t) => t.name)).toEqual(["Owner's XI"]);
    });

    it('omitting ?owner returns both, same as before the filter existed', async () => {
      const { memberToken } = await setUpOrgTeam();
      await createMatch(memberToken, { teamAName: 'My Standalone Team', teamBName: 'Opponent' });

      const res = await myTeams(memberToken);

      expect(res.body.data.teams.map((t) => t.name).sort()).toEqual([
        "Owner's XI",
        'My Standalone Team',
        'Opponent',
      ].sort());
    });

    it('rejects an unrecognized ?owner value', async () => {
      const { token } = await createTestUser();

      const res = await myTeams(token, '?owner=everyone');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_TEAM_OWNER_FILTER');
    });
  });
});
