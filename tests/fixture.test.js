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

const startFixtureMatch = (token, tournamentId, fixtureId, body) =>
    request(app)
        .post(`/api/v1/tournament/${tournamentId}/fixtures/${fixtureId}/start-match`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

describe('POST /v1/tournament/:tournamentId/fixtures/:fixtureId/start-match', () => {
    it('creates a real match for a scheduled fixture', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const fixtures = (await listFixtures(token, tournamentId)).body.data.fixtures;
        const scheduled = fixtures.find((f) => f.status === 'scheduled');

        const res = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });

        expect(res.status).toBe(200);
        expect(res.body.data.matchId).toEqual(expect.any(String));
        expect(res.body.data.fixtureId).toBe(scheduled.id);
        expect(res.body.data.joinCode).toHaveLength(6);

        const updatedFixture = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.id === scheduled.id);
        expect(updatedFixture.matchId).toBe(res.body.data.matchId);
    });

    it('409s starting a fixture that already has a match', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');
        await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });

        const res = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('FIXTURE_ALREADY_STARTED');
    });

    it('400s starting a bye fixture', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', 3);
        await generateFixtures(token, tournamentId);
        const bye = (await listFixtures(token, tournamentId)).body.data.fixtures.find((f) => f.isBye);

        const res = await startFixtureMatch(token, tournamentId, bye.id, { totalOvers: 20 });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('FIXTURE_NOT_SCHEDULED');
    });

    it('400s an invalid overs value, same rule as POST /v1/match', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');

        const res = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 0 });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_OVERS_FORMAT');
    });
});

const abandonMatch = (token, matchId) =>
    request(app).post(`/api/v1/match/${matchId}/abandon`).set('Authorization', `Bearer ${token}`).send();

const resolveFixture = (token, tournamentId, fixtureId, body) =>
    request(app)
        .patch(`/api/v1/tournament/${tournamentId}/fixtures/${fixtureId}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body);

// Plays out a 1-over-per-side match: 6 balls at 1 run each for the team
// batting first (total 6), then 6 dot balls for the team batting second
// (total 0) — deterministic win for whichever team the fixture set as
// battingFirst, no wickets, no extras, so the match completes cleanly with
// a real winner rather than a tie.
// Player identity is scorer-scoped (createdBy + nameLower), not match-scoped
// — a name reused across two matches created by the same token resolves to
// the same Player document, and rosterPlayer refuses to add a Player who is
// already on the opposing side's roster in another match. Each match this
// helper plays needs its own unique names, so a bracket-progression test
// that plays several matches with the same token doesn't collide once two
// fixtures' winners meet in a later round. `matchId` is unique per call and
// makes a convenient, deterministic per-match name suffix.
const playOutMatch = async (token, matchId) => {
    const suffix = matchId.slice(-6);
    await startLiveInnings(app, token, matchId, {
        strikerName: `A1-${suffix}`, nonStrikerName: `A2-${suffix}`, bowlerName: `B1-${suffix}`,
    });
    for (let i = 0; i < 6; i += 1) {
        const res = await scoreDotBall(app, token, matchId, { runs: 1 });
        expect(res.status).toBe(200);
    }
    await startLiveInnings(app, token, matchId, {
        strikerName: `B1-${suffix}`, nonStrikerName: `B2-${suffix}`, bowlerName: `A1-${suffix}`,
    });
    for (let i = 0; i < 6; i += 1) {
        const res = await scoreDotBall(app, token, matchId);
        expect(res.status).toBe(200);
    }
};

describe('match completion resolves the linked fixture', () => {
    it('marks the fixture completed with the winning team once the match finishes', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');
        const started = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 1 });

        await playOutMatch(token, started.body.data.matchId);

        const updated = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.id === scheduled.id);
        expect(updated.status).toBe('completed');
        expect(updated.winner).not.toBeNull();
    });

    it('marks the fixture unresolved when the match is abandoned', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');
        const started = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });

        await abandonMatch(token, started.body.data.matchId);

        const updated = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.id === scheduled.id);
        expect(updated.status).toBe('unresolved');
        expect(updated.winner).toBeNull();
    });
});

describe('PATCH /v1/tournament/:tournamentId/fixtures/:fixtureId', () => {
    it('lets the owner manually resolve an unresolved fixture', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');
        const started = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });
        await abandonMatch(token, started.body.data.matchId);

        const res = await resolveFixture(token, tournamentId, scheduled.id, { winner: scheduled.teamA.id });

        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('completed');
        expect(res.body.data.winner.id).toBe(scheduled.teamA.id);
    });

    it("400s resolving a fixture that isn't unresolved", async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');

        const res = await resolveFixture(token, tournamentId, scheduled.id, { winner: scheduled.teamA.id });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('FIXTURE_NOT_UNRESOLVED');
    });

    it("400s a winner that isn't one of the fixture's two teams", async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('round_robin', 3);
        await generateFixtures(token, tournamentId);
        const scheduled = (await listFixtures(token, tournamentId)).body.data.fixtures
            .find((f) => f.status === 'scheduled');
        const started = await startFixtureMatch(token, tournamentId, scheduled.id, { totalOvers: 20 });
        await abandonMatch(token, started.body.data.matchId);

        const res = await resolveFixture(token, tournamentId, scheduled.id, { winner: '665f1a2b3c4d5e6f7a8b9c99' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_FIXTURE_WINNER');
    });
});

describe('knockout bracket progression end-to-end', () => {
    it('advances a 4-team knockout through both rounds and auto-completes the tournament', async () => {
        const { token, tournamentId } = await setupTournamentWithTeams('knockout', 4);
        await generateFixtures(token, tournamentId); // round 1: 2 matches, no byes

        let round1 = (await listFixtures(token, tournamentId)).body.data.fixtures
            .filter((f) => f.round === 1);
        for (const fixture of round1) {
            const started = await startFixtureMatch(token, tournamentId, fixture.id, { totalOvers: 1 });
            await playOutMatch(token, started.body.data.matchId);
        }

        const round2Res = await generateFixtures(token, tournamentId);
        expect(round2Res.status).toBe(200);
        expect(round2Res.body.data.round).toBe(2);
        expect(round2Res.body.data.fixtures).toHaveLength(1); // the final

        const final = round2Res.body.data.fixtures[0];
        const startedFinal = await startFixtureMatch(token, tournamentId, final.id, { totalOvers: 1 });
        await playOutMatch(token, startedFinal.body.data.matchId);

        const tournament = await Tournament.findById(tournamentId);
        expect(tournament.status).toBe('completed');

        // No further round to generate.
        const afterFinal = await generateFixtures(token, tournamentId);
        expect(afterFinal.status).toBe(409);
        expect(afterFinal.body.code).toBe('TOURNAMENT_ALREADY_COMPLETE');
    });
});
