import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Tournament } from '../src/models/tournament.model.js';
import { Fixture } from '../src/models/fixture.model.js';

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

const removeTeamFromTournament = (token, tournamentId, teamId) =>
    request(app).delete(`/api/v1/tournament/${tournamentId}/teams/${teamId}`).set('Authorization', `Bearer ${token}`).send();

const generateFixtures = (token, tournamentId) =>
    request(app).post(`/api/v1/tournament/${tournamentId}/fixtures`).set('Authorization', `Bearer ${token}`).send();

const listFixtures = (token, tournamentId) =>
    request(app).get(`/api/v1/tournament/${tournamentId}/fixtures`).set('Authorization', `Bearer ${token}`).send();

// Creates an org, a tournament of `format`, and `count` teams already
// enrolled into it (in creation order, matching enrollment/seeding order).
// Returns { token, orgId, tournamentId, teamIds }.
const setupTournamentWithTeams = async (format, count) => {
    const { token } = await createTestUser();
    const orgRes = await createOrg(token, { name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    const tournamentRes = await createTournament(token, orgId, { name: 'Summer Cup', format });
    const tournamentId = tournamentRes.body.data.id;

    const teamIds = [];
    for (let i = 0; i < count; i += 1) {
        const teamRes = await createOrgTeam(token, orgId, { name: `Team ${i}` });
        const teamId = teamRes.body.data.id;
        await addTeamToTournament(token, tournamentId, teamId);
        teamIds.push(teamId);
    }

    return { token, orgId, tournamentId, teamIds };
};

describe('POST /v1/tournament/:tournamentId/fixtures', () => {
    it('generates a full round-robin schedule for 4 teams in one call', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 4);

        const res = await generateFixtures(token, tournamentId);

        expect(res.status).toBe(200);
        expect(res.body.data.round).toBe(1);
        expect(res.body.data.fixtures).toHaveLength(2); // round 1 only, in the response

        const all = await listFixtures(token, tournamentId);
        expect(all.body.data.fixtures).toHaveLength(6); // C(4,2) total across 3 rounds
        expect(all.body.data.fixtures.every((f) => f.status === 'scheduled')).toBe(true);
    });

    it('generates a doubled schedule for a league of 4 teams', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('league', 4);

        await generateFixtures(token, tournamentId);

        const all = await listFixtures(token, tournamentId);
        expect(all.body.data.fixtures).toHaveLength(12); // 2x round-robin
    });

    it('generates only round 1 for a knockout, with byes for the earliest-enrolled teams', async () => {
        const { token, tournamentId, teamIds } = await setupTournamentWithTeams('knockout', 6);

        const res = await generateFixtures(token, tournamentId);

        expect(res.status).toBe(200);
        expect(res.body.data.round).toBe(1);
        expect(res.body.data.fixtures).toHaveLength(4); // 2 byes + 2 real matches (field of 8)

        const byes = res.body.data.fixtures.filter((f) => f.isBye);
        expect(byes).toHaveLength(2);
        expect(byes.map((f) => f.teamA.id).sort()).toEqual([teamIds[0], teamIds[1]].sort());
        byes.forEach((f) => {
            expect(f.status).toBe('bye');
            expect(f.winner.id).toBe(f.teamA.id);
        });
    });

    it('400s for a round_robin tournament with fewer than 3 teams', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 2);

        const res = await generateFixtures(token, tournamentId);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INSUFFICIENT_TEAMS_FOR_FORMAT');
    });

    it('allows a knockout with exactly 2 teams and does not complete the tournament yet (round 1 is still scheduled)', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', 2);

        const res = await generateFixtures(token, tournamentId);
        expect(res.status).toBe(200);
        expect(res.body.data.fixtures).toHaveLength(1);

        const tournament = await Tournament.findById(tournamentId);
        expect(tournament.status).toBe('upcoming');
    });

    it('409s calling generate again on an already-generated round_robin tournament', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);

        const res = await generateFixtures(token, tournamentId);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('FIXTURES_ALREADY_GENERATED');
    });

    it('400s advancing a knockout round before its current round is fully resolved', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', 4);
        await generateFixtures(token, tournamentId); // round 1, 2 scheduled matches, no byes

        const res = await generateFixtures(token, tournamentId);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ROUND_NOT_COMPLETE');
    });

    it('403s when a non-owner member tries to generate fixtures', async () => {
        const { token: ownerToken, orgId, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
        await request(app)
            .post(`/api/v1/organization/${orgId}/members`)
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ email: 'member@example.com' });

        const res = await generateFixtures(memberToken, tournamentId);

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TOURNAMENT_NOT_OWNED');
    });
});

describe('GET /v1/tournament/:tournamentId/fixtures', () => {
    it('lists fixtures sorted by round then order with populated team names', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);

        const res = await listFixtures(token, tournamentId);

        expect(res.status).toBe(200);
        expect(res.body.data.fixtures.length).toBeGreaterThan(0);
        res.body.data.fixtures.forEach((f) => {
            expect(f.teamA.name).toEqual(expect.any(String));
        });
    });
});

describe('tournament roster lock', () => {
    it('blocks enrolling a new team once fixtures exist', async () => {
        const { token, orgId, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const extraTeamRes = await createOrgTeam(token, orgId, { name: 'Latecomer FC' });

        const res = await addTeamToTournament(token, tournamentId, extraTeamRes.body.data.id);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TOURNAMENT_FIXTURES_LOCKED');
    });

    it('blocks removing a team once fixtures exist', async () => {
        const { token, tournamentId, teamIds } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);

        const res = await removeTeamFromTournament(token, tournamentId, teamIds[0]);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TOURNAMENT_FIXTURES_LOCKED');
    });
});
