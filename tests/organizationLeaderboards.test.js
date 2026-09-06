import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Fixture } from '../src/models/fixture.model.js';
import { startLiveInnings, scoreDotBall } from './helpers/matchSetup.js';

let app;

beforeAll(async () => {
    await connectTestDb();
    await Tournament.init();
    await Fixture.init();
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

const createTournament = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/tournaments`).set('Authorization', `Bearer ${token}`).send(body);

const createOrgTeam = (token, orgId, body) =>
    request(app).post(`/api/v1/organization/${orgId}/teams`).set('Authorization', `Bearer ${token}`).send(body);

const addTeamToTournament = (token, tournamentId, teamId) =>
    request(app).post(`/api/v1/tournament/${tournamentId}/teams`).set('Authorization', `Bearer ${token}`).send({ teamId });

const generateFixtures = (token, tournamentId) =>
    request(app).post(`/api/v1/tournament/${tournamentId}/fixtures`).set('Authorization', `Bearer ${token}`).send();

const listFixtures = (token, tournamentId) =>
    request(app).get(`/api/v1/tournament/${tournamentId}/fixtures`).set('Authorization', `Bearer ${token}`).send();

const startFixtureMatch = (token, tournamentId, fixtureId, body) =>
    request(app)
        .post(`/api/v1/tournament/${tournamentId}/fixtures/${fixtureId}/start-match`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

const getOrgLeaderboards = (token, orgId) =>
    request(app).get(`/api/v1/organization/${orgId}/leaderboards`).set('Authorization', `Bearer ${token}`).send();

const playInnings = async (token, matchId, { striker, nonStriker, bowler, runsPerBall }) => {
    await startLiveInnings(app, token, matchId, {
        strikerName: striker, nonStrikerName: nonStriker, bowlerName: bowler,
    });
    for (let i = 0; i < 6; i += 1) {
        const res = await scoreDotBall(app, token, matchId, { runs: runsPerBall });
        expect(res.status).toBe(200);
    }
};

const fixtureBetween = (fixtures, a, b) =>
    fixtures.find((f) => f.teamB && [f.teamA.name, f.teamB.name].includes(a) && [f.teamA.name, f.teamB.name].includes(b));

describe('GET /v1/organization/:orgId/leaderboards', () => {
    it('401s with no token', async () => {
        const { token } = await createTestUser();
        const orgRes = await createOrg(token, { name: 'Riverside CC' });
        const res = await request(app).get(`/api/v1/organization/${orgRes.body.data.id}/leaderboards`).send();
        expect(res.status).toBe(401);
    });

    it('404s for an organization that does not exist', async () => {
        const { token } = await createTestUser();
        const res = await getOrgLeaderboards(token, '665f1a2b3c4d5e6f7a8b9c99');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ORG_NOT_FOUND');
    });

    it("403s for a user who isn't a member of the organization", async () => {
        const owner = await createTestUser({ email: 'owner@example.com' });
        const orgRes = await createOrg(owner.token, { name: 'Riverside CC' });

        const stranger = await createTestUser({ email: 'stranger@example.com' });
        const res = await getOrgLeaderboards(stranger.token, orgRes.body.data.id);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('NOT_ORG_MEMBER');
    });

    it('returns empty leaderboards for an organization with no tournaments yet', async () => {
        const { token } = await createTestUser();
        const orgRes = await createOrg(token, { name: 'Riverside CC' });
        const res = await getOrgLeaderboards(token, orgRes.body.data.id);
        expect(res.status).toBe(200);
        expect(res.body.data.battingLeaderboard).toEqual([]);
        expect(res.body.data.bowlingLeaderboard).toEqual([]);
    });

    it('aggregates a player\'s batting across two different tournaments run by the same organization', async () => {
        const { token } = await createTestUser();
        const orgRes = await createOrg(token, { name: 'Riverside CC' });
        const orgId = orgRes.body.data.id;

        const alphaRes = await createOrgTeam(token, orgId, { name: 'Alpha' });
        const bravoRes = await createOrgTeam(token, orgId, { name: 'Bravo' });
        const charlieRes = await createOrgTeam(token, orgId, { name: 'Charlie' });
        const alphaId = alphaRes.body.data.id;
        const bravoId = bravoRes.body.data.id;
        const charlieId = charlieRes.body.data.id;

        // Tournament 1: Alpha vs Bravo. Rahul bats for Alpha.
        const t1Res = await createTournament(token, orgId, { name: 'Spring Cup', format: 'knockout' });
        const t1Id = t1Res.body.data.id;
        await addTeamToTournament(token, t1Id, alphaId);
        await addTeamToTournament(token, t1Id, bravoId);
        await generateFixtures(token, t1Id);
        const t1Fixtures = (await listFixtures(token, t1Id)).body.data.fixtures;
        const t1Match = await startFixtureMatch(token, t1Id, fixtureBetween(t1Fixtures, 'Alpha', 'Bravo').id, { totalOvers: 1 });
        const match1 = t1Match.body.data.matchId;
        await playInnings(token, match1, { striker: 'Rahul', nonStriker: 'Kiran', bowler: 'Vijay', runsPerBall: 2 }); // 12 runs
        await playInnings(token, match1, { striker: 'Suresh', nonStriker: 'Naveen', bowler: 'Rahul', runsPerBall: 0 });

        // Tournament 2 (a completely different tournament under the SAME
        // org): Alpha vs Charlie. Rahul bats for Alpha again.
        const t2Res = await createTournament(token, orgId, { name: 'Summer Cup', format: 'knockout' });
        const t2Id = t2Res.body.data.id;
        await addTeamToTournament(token, t2Id, alphaId);
        await addTeamToTournament(token, t2Id, charlieId);
        await generateFixtures(token, t2Id);
        const t2Fixtures = (await listFixtures(token, t2Id)).body.data.fixtures;
        const t2Match = await startFixtureMatch(token, t2Id, fixtureBetween(t2Fixtures, 'Alpha', 'Charlie').id, { totalOvers: 1 });
        const match2 = t2Match.body.data.matchId;
        // Even runs per ball, same as match1 — odd runs rotate the strike
        // after every ball, which would mean Rahul (the starting striker)
        // only faces every other delivery instead of all six.
        await playInnings(token, match2, { striker: 'Rahul', nonStriker: 'Kiran', bowler: 'Deepak', runsPerBall: 4 }); // 24 runs
        await playInnings(token, match2, { striker: 'Manoj', nonStriker: 'Anil', bowler: 'Rahul', runsPerBall: 0 });

        const res = await getOrgLeaderboards(token, orgId);
        expect(res.status).toBe(200);

        const rahul = res.body.data.battingLeaderboard.find((r) => r.playerName === 'Rahul');
        expect(rahul.inningsBatted).toBe(2); // both tournaments' innings counted
        expect(rahul.runs).toBe(36); // 12 + 24, summed across tournaments
    });

    it('excludes matches from a tournament run by a different organization', async () => {
        const owner = await createTestUser();
        const orgARes = await createOrg(owner.token, { name: 'Org A' });
        const orgBRes = await createOrg(owner.token, { name: 'Org B' });
        const orgAId = orgARes.body.data.id;
        const orgBId = orgBRes.body.data.id;

        const alphaRes = await createOrgTeam(owner.token, orgBId, { name: 'Alpha' });
        const bravoRes = await createOrgTeam(owner.token, orgBId, { name: 'Bravo' });

        // A tournament (and match) entirely under Org B.
        const tRes = await createTournament(owner.token, orgBId, { name: 'Org B Cup', format: 'knockout' });
        const tId = tRes.body.data.id;
        await addTeamToTournament(owner.token, tId, alphaRes.body.data.id);
        await addTeamToTournament(owner.token, tId, bravoRes.body.data.id);
        await generateFixtures(owner.token, tId);
        const fixtures = (await listFixtures(owner.token, tId)).body.data.fixtures;
        const started = await startFixtureMatch(owner.token, tId, fixtureBetween(fixtures, 'Alpha', 'Bravo').id, { totalOvers: 1 });
        const matchId = started.body.data.matchId;
        await playInnings(owner.token, matchId, { striker: 'OrgBOnlyPlayer', nonStriker: 'X', bowler: 'Y', runsPerBall: 1 });
        await playInnings(owner.token, matchId, { striker: 'Z', nonStriker: 'W', bowler: 'OrgBOnlyPlayer', runsPerBall: 0 });

        // Org A has no tournaments/matches of its own.
        const res = await getOrgLeaderboards(owner.token, orgAId);
        expect(res.status).toBe(200);
        expect(res.body.data.battingLeaderboard).toEqual([]);
    });
});
