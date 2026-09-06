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

const abandonMatch = (token, matchId) =>
    request(app).post(`/api/v1/match/${matchId}/abandon`).set('Authorization', `Bearer ${token}`).send();

const getLeaderboards = (token, tournamentId) =>
    request(app).get(`/api/v1/tournament/${tournamentId}/leaderboards`).set('Authorization', `Bearer ${token}`).send();

// Plays one full innings (6 balls, no wickets) with named players, then
// leaves the match wherever that puts it — caller decides whether to start
// a second innings or abandon. Distinct from standings.test.js's own helper,
// which uses per-match-unique names: this one takes explicit names so the
// same Player resolves across multiple matches, which is exactly what the
// multi-match summation tests below need to prove.
const playInnings = async (app, token, matchId, { striker, nonStriker, bowler, runsPerBall }) => {
    await startLiveInnings(app, token, matchId, {
        strikerName: striker, nonStrikerName: nonStriker, bowlerName: bowler,
    });
    for (let i = 0; i < 6; i += 1) {
        const res = await scoreDotBall(app, token, matchId, { runs: runsPerBall });
        expect(res.status).toBe(200);
    }
};

const setupTournamentWithTeams = async (format, names) => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer Cup', format });
    const tournamentId = tournamentRes.body.data.id;

    const teamIds = [];
    for (const name of names) {
        const teamRes = await createOrgTeam(token, orgId, { name });
        const teamId = teamRes.body.data.id;
        await addTeamToTournament(token, tournamentId, teamId);
        teamIds.push(teamId);
    }
    return { token, orgId, tournamentId, teamIds };
};

const fixtureBetween = (fixtures, a, b) =>
    fixtures.find((f) => f.teamB && [f.teamA.name, f.teamB.name].includes(a) && [f.teamA.name, f.teamB.name].includes(b));

describe('GET /v1/tournament/:tournamentId/leaderboards', () => {
    it('401s with no token', async () => {
        const { tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo']);
        const res = await request(app).get(`/api/v1/tournament/${tournamentId}/leaderboards`).send();
        expect(res.status).toBe(401);
    });

    it('404s for a tournament that does not exist', async () => {
        const { token } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo']);
        const res = await getLeaderboards(token, '665f1a2b3c4d5e6f7a8b9c99');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
    });

    it('returns empty leaderboards before any match is played', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo']);
        const res = await getLeaderboards(token, tournamentId);
        expect(res.status).toBe(200);
        expect(res.body.data.battingLeaderboard).toEqual([]);
        expect(res.body.data.bowlingLeaderboard).toEqual([]);
    });

    it('is allowed for a knockout tournament, unlike standings', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', ['Alpha', 'Bravo']);
        const res = await getLeaderboards(token, tournamentId);
        expect(res.status).toBe(200);
        expect(res.body.data.battingLeaderboard).toEqual([]);
    });

    it('aggregates a player\'s batting and a bowler\'s figures across two completed matches, excluding an abandoned third', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo', 'Charlie']);
        await generateFixtures(token, tournamentId);
        const fixtures = (await listFixtures(token, tournamentId)).body.data.fixtures;

        // Match 1 (completed): Alpha vs Charlie. Rahul opens for Alpha,
        // Vijay bowls for Charlie.
        const started1 = await startFixtureMatch(token, tournamentId, fixtureBetween(fixtures, 'Alpha', 'Charlie').id, { totalOvers: 1 });
        const match1 = started1.body.data.matchId;
        await playInnings(app, token, match1, { striker: 'Rahul', nonStriker: 'Kiran', bowler: 'Vijay', runsPerBall: 2 }); // Rahul: 12 off 6
        await playInnings(app, token, match1, { striker: 'Suresh', nonStriker: 'Naveen', bowler: 'Rahul', runsPerBall: 0 });

        // Match 2 (completed): Bravo vs Charlie. Vijay bowls for Charlie again.
        const started2 = await startFixtureMatch(token, tournamentId, fixtureBetween(fixtures, 'Bravo', 'Charlie').id, { totalOvers: 1 });
        const match2 = started2.body.data.matchId;
        await playInnings(app, token, match2, { striker: 'Manoj', nonStriker: 'Deepak', bowler: 'Vijay', runsPerBall: 1 }); // Vijay concedes 6 more
        await playInnings(app, token, match2, { striker: 'Suresh', nonStriker: 'Naveen', bowler: 'Manoj', runsPerBall: 0 });

        // Match 3 (abandoned mid-innings): Alpha vs Bravo. Rahul opens again
        // and faces 2 balls (8 runs) before the match is abandoned — this
        // must NOT add to Rahul's leaderboard total, proving
        // PlayerMatchStats is never written for an abandoned match even
        // when real deliveries were bowled.
        const started3 = await startFixtureMatch(token, tournamentId, fixtureBetween(fixtures, 'Alpha', 'Bravo').id, { totalOvers: 20 });
        const match3 = started3.body.data.matchId;
        await startLiveInnings(app, token, match3, { strikerName: 'Rahul', nonStrikerName: 'Kiran', bowlerName: 'Manoj' });
        for (let i = 0; i < 2; i += 1) {
            const res = await scoreDotBall(app, token, match3, { runs: 4 });
            expect(res.status).toBe(200);
        }
        const abandonRes = await abandonMatch(token, match3);
        expect(abandonRes.status).toBe(200);

        const res = await getLeaderboards(token, tournamentId);
        expect(res.status).toBe(200);

        const rahul = res.body.data.battingLeaderboard.find((r) => r.playerName === 'Rahul');
        expect(rahul.inningsBatted).toBe(1); // only match1's innings, not match3's abandoned one
        expect(rahul.runs).toBe(12);
        expect(rahul.ballsFaced).toBe(6);

        const vijay = res.body.data.bowlingLeaderboard.find((r) => r.playerName === 'Vijay');
        expect(vijay.inningsBowled).toBe(2); // match1 + match2
        expect(vijay.legalDeliveries).toBe(12);
        expect(vijay.runsConceded).toBe(18); // 12 (match1) + 6 (match2)
    });
});
