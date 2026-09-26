import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match } from '../src/models/match.model.js';

describe('GET /v1/team/:teamId stats', () => {
    let app;

    beforeAll(async () => {
        await connectTestDb();
        app = buildTestApp({ withTeam: true, withOrganization: true, withTournament: true });
    });

    afterEach(async () => {
        await clearTestDb();
    });

    afterAll(async () => {
        await disconnectTestDb();
    });

    const createTeam = async (token, name) => {
        const res = await request(app).post('/api/v1/team').set('Authorization', `Bearer ${token}`).send({ name });
        return res.body.data.id;
    };

    const getProfile = (token, teamId) =>
        request(app).get(`/api/v1/team/${teamId}`).set('Authorization', `Bearer ${token}`).send();

    const seedMatch = (user, teamA, teamB, fields = {}) =>
        Match.create({ teamA, teamB, totalOvers: 5, createdBy: user._id, ...fields });

    it('profile stats are zero for a team with no matches', async () => {
        const { token } = await createTestUser();
        const teamId = await createTeam(token, 'Mumbai Indians');

        const res = await getProfile(token, teamId);

        expect(res.status).toBe(200);
        expect(res.body.data.stats).toEqual({
            played: 0, won: 0, lost: 0, tied: 0, noResult: 0, winPercentage: 0, form: [],
        });
    });

    it('profile stats count completed matches for both sides', async () => {
        const { user, token } = await createTestUser();
        const teamId = await createTeam(token, 'Mumbai Indians');
        const rivalId = await createTeam(token, 'CSK');

        await seedMatch(user, teamId, rivalId, { status: 'completed', result: { winner: 'teamA' } });
        await seedMatch(user, rivalId, teamId, { status: 'completed', result: { winner: 'teamB' } });
        await seedMatch(user, teamId, rivalId, { status: 'completed', result: { winner: 'teamB' } });
        await seedMatch(user, rivalId, teamId, { status: 'completed', result: { winner: 'tie' } });

        const res = await getProfile(token, teamId);

        expect(res.body.data.stats).toMatchObject({
            played: 4, won: 2, lost: 1, tied: 1, noResult: 0, winPercentage: 50,
        });
        expect(res.body.data.stats.form).toHaveLength(4);
    });

    it('abandoned, upcoming, live and soft-deleted matches are excluded from stats', async () => {
        const { user, token } = await createTestUser();
        const teamId = await createTeam(token, 'Mumbai Indians');
        const rivalId = await createTeam(token, 'CSK');

        await seedMatch(user, teamId, rivalId, { status: 'abandoned', result: { winner: 'teamA' } });
        await seedMatch(user, teamId, rivalId, { status: 'upcoming' });
        await seedMatch(user, teamId, rivalId, { status: 'live' });
        await seedMatch(user, teamId, rivalId, {
            status: 'completed', result: { winner: 'teamA' }, isDeleted: true,
        });

        const res = await getProfile(token, teamId);

        expect(res.body.data.stats.played).toBe(0);
        expect(res.body.data.stats.form).toEqual([]);
    });
});
