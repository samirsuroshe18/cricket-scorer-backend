import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Match, MATCH_STATUS } from '../src/models/match.model.js';

describe('GET /v1/team/:teamId/matches ?status=', () => {
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

    // One match per status for the same team.
    const seed = async () => {
        const { user, token } = await createTestUser();
        const teamId = await createTeam(token, 'Mumbai Indians');
        const rivalId = await createTeam(token, 'CSK');
        for (const status of MATCH_STATUS) {
            await Match.create({ teamA: teamId, teamB: rivalId, totalOvers: 5, createdBy: user._id, status });
        }
        return { token, teamId };
    };

    const list = (token, teamId, query = '') =>
        request(app).get(`/api/v1/team/${teamId}/matches${query}`).set('Authorization', `Bearer ${token}`).send();

    const statusesOf = (res) => res.body.data.matches.map((m) => m.status).sort();

    it('no status returns every status', async () => {
        const { token, teamId } = await seed();
        const res = await list(token, teamId);
        expect(res.status).toBe(200);
        expect(statusesOf(res)).toEqual([...MATCH_STATUS].sort());
    });

    it('status=all behaves like no filter', async () => {
        const { token, teamId } = await seed();
        const res = await list(token, teamId, '?status=all');
        expect(res.body.data.total).toBe(MATCH_STATUS.length);
    });

    it('status=live returns live and innings_break only', async () => {
        const { token, teamId } = await seed();
        const res = await list(token, teamId, '?status=live');
        expect(statusesOf(res)).toEqual(['innings_break', 'live']);
    });

    it('status=upcoming returns only upcoming', async () => {
        const { token, teamId } = await seed();
        const res = await list(token, teamId, '?status=upcoming');
        expect(statusesOf(res)).toEqual(['upcoming']);
    });

    it('status=completed returns only completed', async () => {
        const { token, teamId } = await seed();
        const res = await list(token, teamId, '?status=completed');
        expect(statusesOf(res)).toEqual(['completed']);
    });

    it('total reflects the filter, not the whole list', async () => {
        const { token, teamId } = await seed();
        const res = await list(token, teamId, '?status=live');
        expect(res.body.data.total).toBe(2);
    });

    it.each(['?status=bogus', '?status=live&status=upcoming', '?status=', '?status=LIVE'])(
        '%s is rejected with 400 INVALID_STATUS_FILTER',
        async (query) => {
            const { token, teamId } = await seed();
            const res = await list(token, teamId, query);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('INVALID_STATUS_FILTER');
        }
    );
});
