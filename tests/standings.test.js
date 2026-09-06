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

const getStandings = (token, tournamentId) =>
    request(app).get(`/api/v1/tournament/${tournamentId}/standings`).set('Authorization', `Bearer ${token}`).send();

// Plays out a 1-over-per-side match with a fixed total for each innings, so
// the margin (and therefore each team's NRR contribution) is controlled by
// the caller rather than always 6 runs. Each `*InningsRuns` value must be a
// multiple of 6 (one run count per ball, no wickets) so the match completes
// cleanly via overs_complete on both sides.
const playOutMatch = async (token, matchId, firstInningsRuns, secondInningsRuns) => {
    const suffix = matchId.slice(-6);
    const perBall1 = firstInningsRuns / 6;
    await startLiveInnings(app, token, matchId, {
        strikerName: `A1-${suffix}`, nonStrikerName: `A2-${suffix}`, bowlerName: `B1-${suffix}`,
    });
    for (let i = 0; i < 6; i += 1) {
        const res = await scoreDotBall(app, token, matchId, { runs: perBall1 });
        expect(res.status).toBe(200);
    }
    const perBall2 = secondInningsRuns / 6;
    await startLiveInnings(app, token, matchId, {
        strikerName: `B1-${suffix}`, nonStrikerName: `B2-${suffix}`, bowlerName: `A1-${suffix}`,
    });
    for (let i = 0; i < 6; i += 1) {
        const res = await scoreDotBall(app, token, matchId, { runs: perBall2 });
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

describe('GET /v1/tournament/:tournamentId/standings', () => {
    it('400s for a knockout tournament', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', ['A', 'B']);
        const res = await getStandings(token, tournamentId);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('STANDINGS_NOT_APPLICABLE');
    });

    it('404s for a tournament that does not exist', async () => {
        const { token } = await setupTournamentWithTeams('round_robin', ['A', 'B', 'C']);
        const res = await getStandings(token, '665f1a2b3c4d5e6f7a8b9c99');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('TOURNAMENT_NOT_FOUND');
    });

    it('401s with no token', async () => {
        const { tournamentId } = await setupTournamentWithTeams('round_robin', ['A', 'B', 'C']);
        const res = await request(app).get(`/api/v1/tournament/${tournamentId}/standings`).send();
        expect(res.status).toBe(401);
    });

    it('lists every enrolled team at zero before any fixture is played', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo', 'Charlie']);
        const res = await getStandings(token, tournamentId);
        expect(res.status).toBe(200);
        expect(res.body.data.format).toBe('round_robin');
        expect(res.body.data.standings).toHaveLength(3);
        expect(res.body.data.standings.every((r) => r.played === 0 && r.points === 0)).toBe(true);
    });

    it('ranks a bigger win above a smaller win when both teams are level on points (NRR tiebreak)', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo', 'Charlie']);
        await generateFixtures(token, tournamentId);
        const fixtures = (await listFixtures(token, tournamentId)).body.data.fixtures;

        const alphaVsCharlie = fixtures.find((f) =>
            f.teamB && [f.teamA.name, f.teamB.name].includes('Alpha') && [f.teamA.name, f.teamB.name].includes('Charlie'));
        const bravoVsCharlie = fixtures.find((f) =>
            f.teamB && [f.teamA.name, f.teamB.name].includes('Bravo') && [f.teamA.name, f.teamB.name].includes('Charlie'));

        const started1 = await startFixtureMatch(token, tournamentId, alphaVsCharlie.id, { totalOvers: 1 });
        await playOutMatch(token, started1.body.data.matchId, 30, 0); // Alpha smashes it, wins by 30

        const started2 = await startFixtureMatch(token, tournamentId, bravoVsCharlie.id, { totalOvers: 1 });
        await playOutMatch(token, started2.body.data.matchId, 6, 0); // Bravo wins narrowly

        const res = await getStandings(token, tournamentId);
        expect(res.status).toBe(200);
        const rows = res.body.data.standings;
        const alpha = rows.find((r) => r.teamName === 'Alpha');
        const bravo = rows.find((r) => r.teamName === 'Bravo');
        expect(alpha.points).toBe(bravo.points);
        expect(alpha.nrr).toBeGreaterThan(bravo.nrr);
        expect(rows.indexOf(alpha)).toBeLessThan(rows.indexOf(bravo));
    });

    it('counts an abandoned match as a no-result, excluded from NRR, even after the fixture is force-resolved to a winner', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', ['Alpha', 'Bravo', 'Charlie']);
        await generateFixtures(token, tournamentId);
        const fixtures = (await listFixtures(token, tournamentId)).body.data.fixtures;
        const alphaVsBravo = fixtures.find((f) =>
            f.teamB && [f.teamA.name, f.teamB.name].includes('Alpha') && [f.teamA.name, f.teamB.name].includes('Bravo'));
        const alphaId = alphaVsBravo.teamA.name === 'Alpha' ? alphaVsBravo.teamA.id : alphaVsBravo.teamB.id;

        const started = await startFixtureMatch(token, tournamentId, alphaVsBravo.id, { totalOvers: 20 });
        await abandonMatch(token, started.body.data.matchId);

        // Force-resolve the now-unresolved fixture, picking Alpha as the
        // "advancing" team — this only matters for knockout brackets, and
        // must NOT turn into a win/loss in the points table, which reads
        // Match, not Fixture.winner.
        await request(app)
            .patch(`/api/v1/tournament/${tournamentId}/fixtures/${alphaVsBravo.id}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ winner: alphaId });

        const res = await getStandings(token, tournamentId);
        const rows = res.body.data.standings;
        const alpha = rows.find((r) => r.teamName === 'Alpha');
        const bravo = rows.find((r) => r.teamName === 'Bravo');
        expect(alpha.played).toBe(1);
        expect(alpha.won).toBe(0);
        expect(alpha.noResult).toBe(1);
        expect(alpha.points).toBe(1);
        expect(alpha.nrr).toBe(0);
        expect(bravo.played).toBe(1);
        expect(bravo.lost).toBe(0);
        expect(bravo.noResult).toBe(1);
        expect(bravo.points).toBe(1);
    });
});
