import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Organization } from '../src/models/organization.model.js';
import { Tournament } from '../src/models/tournament.model.js';

let app;

beforeAll(async () => {
    await connectTestDb();
    await Organization.init();
    await Tournament.init();
    app = buildTestApp({ withOrganization: true, withTournament: true, withSearch: true });
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

const deleteOrg = (token, orgId) =>
    request(app).delete(`/api/v1/organization/${orgId}`).set('Authorization', `Bearer ${token}`).send();

const deleteTournament = (token, orgId, tournamentId) =>
    request(app).delete(`/api/v1/tournament/${tournamentId}`).set('Authorization', `Bearer ${token}`).send();

const search = (token, q) =>
    request(app).get(`/api/v1/search${q === undefined ? '' : `?q=${encodeURIComponent(q)}`}`)
        .set('Authorization', `Bearer ${token}`).send();

describe('GET /v1/search', () => {
    it('401s with no token', async () => {
        const res = await request(app).get('/api/v1/search?q=cup').send();
        expect(res.status).toBe(401);
    });

    it('400s when q is missing', async () => {
        const { token } = await createTestUser();
        const res = await search(token, undefined);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SEARCH_QUERY_REQUIRED');
    });

    it('400s when q is empty', async () => {
        const { token } = await createTestUser();
        const res = await search(token, '   ');
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SEARCH_QUERY_REQUIRED');
    });

    it('returns empty arrays when nothing matches', async () => {
        const { token } = await createTestUser();
        const res = await search(token, 'zzz-no-match-zzz');
        expect(res.status).toBe(200);
        expect(res.body.data.organizations).toEqual([]);
        expect(res.body.data.tournaments).toEqual([]);
    });

    it('finds an organization by name for a user who is not a member — search is public across all orgs', async () => {
        const owner = await createTestUser();
        const orgRes = await createOrg(owner.token, { name: 'Riverside Cricket Club' });
        expect(orgRes.status).toBe(200);

        const stranger = await createTestUser();
        const res = await search(stranger.token, 'Riverside');

        expect(res.status).toBe(200);
        expect(res.body.data.organizations).toHaveLength(1);
        expect(res.body.data.organizations[0]).toMatchObject({
            name: 'Riverside Cricket Club',
            memberCount: 1,
        });
    });

    it('finds a tournament by name, including its organization name, for a non-member', async () => {
        const owner = await createTestUser();
        const orgRes = await createOrg(owner.token, { name: 'Harbor CC' });
        const orgId = orgRes.body.data.id;
        const tRes = await createTournament(owner.token, orgId, { name: 'Summer Cup', format: 'round_robin' });
        expect(tRes.status).toBe(200);

        const stranger = await createTestUser();
        const res = await search(stranger.token, 'Summer');

        expect(res.status).toBe(200);
        expect(res.body.data.tournaments).toHaveLength(1);
        expect(res.body.data.tournaments[0]).toMatchObject({
            name: 'Summer Cup',
            organizationName: 'Harbor CC',
            format: 'round_robin',
            status: 'upcoming',
        });
    });

    it('excludes a soft-deleted organization', async () => {
        const owner = await createTestUser();
        const orgRes = await createOrg(owner.token, { name: 'Ghost Town CC' });
        const orgId = orgRes.body.data.id;
        const delRes = await deleteOrg(owner.token, orgId);
        expect(delRes.status).toBe(200);

        const res = await search(owner.token, 'Ghost');
        expect(res.status).toBe(200);
        expect(res.body.data.organizations).toEqual([]);
    });

    it('excludes a soft-deleted tournament', async () => {
        const owner = await createTestUser();
        const orgRes = await createOrg(owner.token, { name: 'Lakeside CC' });
        const orgId = orgRes.body.data.id;
        const tRes = await createTournament(owner.token, orgId, { name: 'Winter Trophy', format: 'knockout' });
        const tournamentId = tRes.body.data.id;
        const delRes = await deleteTournament(owner.token, orgId, tournamentId);
        expect(delRes.status).toBe(200);

        const res = await search(owner.token, 'Winter');
        expect(res.status).toBe(200);
        expect(res.body.data.tournaments).toEqual([]);
    });
});
