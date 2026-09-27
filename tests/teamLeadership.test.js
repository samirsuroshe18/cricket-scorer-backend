import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';

describe('team captain and vice-captain', () => {
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

    const auth = (token) => ({ Authorization: `Bearer ${token}` });

    // A team with two rostered players, returned with their ids.
    const setup = async () => {
        const { token } = await createTestUser();
        const teamRes = await request(app).post('/api/v1/team').set(auth(token)).send({ name: 'Mumbai Indians', shortName: 'MI' });
        const teamId = teamRes.body.data.id;
        const rohit = await request(app).post(`/api/v1/team/${teamId}/players`).set(auth(token)).send({ name: 'Rohit' });
        const hardik = await request(app).post(`/api/v1/team/${teamId}/players`).set(auth(token)).send({ name: 'Hardik' });
        return { token, teamId, rohitId: rohit.body.data.playerId, hardikId: hardik.body.data.playerId };
    };

    const patchTeam = (token, teamId, body) =>
        request(app).patch(`/api/v1/team/${teamId}`).set(auth(token)).send({ name: 'Mumbai Indians', shortName: 'MI', ...body });

    const getProfile = (token, teamId) =>
        request(app).get(`/api/v1/team/${teamId}`).set(auth(token)).send();

    it('profile has null leaders by default', async () => {
        const { token, teamId } = await setup();
        const res = await getProfile(token, teamId);
        expect(res.body.data.captainId).toBeNull();
        expect(res.body.data.viceCaptainId).toBeNull();
    });

    it('sets captain and vice-captain and returns them on the profile with row flags', async () => {
        const { token, teamId, rohitId, hardikId } = await setup();

        const patch = await patchTeam(token, teamId, { captainId: rohitId, viceCaptainId: hardikId });
        const res = await getProfile(token, teamId);

        expect(patch.status).toBe(200);
        expect(res.body.data.captainId).toBe(rohitId);
        expect(res.body.data.viceCaptainId).toBe(hardikId);
        const rows = Object.fromEntries(res.body.data.roster.map((r) => [r.playerId, r]));
        expect(rows[rohitId]).toMatchObject({ isCaptain: true, isViceCaptain: false });
        expect(rows[hardikId]).toMatchObject({ isCaptain: false, isViceCaptain: true });
    });

    it('omitting both keys leaves existing leaders untouched', async () => {
        const { token, teamId, rohitId, hardikId } = await setup();
        await patchTeam(token, teamId, { captainId: rohitId, viceCaptainId: hardikId });

        await patchTeam(token, teamId, { name: 'Mumbai Indians XI' });
        const res = await getProfile(token, teamId);

        expect(res.body.data.name).toBe('Mumbai Indians XI');
        expect(res.body.data.captainId).toBe(rohitId);
        expect(res.body.data.viceCaptainId).toBe(hardikId);
    });

    it('sending one key leaves the other untouched', async () => {
        const { token, teamId, rohitId, hardikId } = await setup();
        await patchTeam(token, teamId, { captainId: rohitId, viceCaptainId: hardikId });

        await patchTeam(token, teamId, { captainId: hardikId, viceCaptainId: rohitId });
        const swapped = await getProfile(token, teamId);
        expect(swapped.body.data.captainId).toBe(hardikId);
        expect(swapped.body.data.viceCaptainId).toBe(rohitId);
    });

    it('null clears a leader and leaves the other', async () => {
        const { token, teamId, rohitId, hardikId } = await setup();
        await patchTeam(token, teamId, { captainId: rohitId, viceCaptainId: hardikId });

        await patchTeam(token, teamId, { captainId: null });
        const res = await getProfile(token, teamId);

        expect(res.body.data.captainId).toBeNull();
        expect(res.body.data.viceCaptainId).toBe(hardikId);
    });

    it('400 TEAM_LEADER_NOT_ON_ROSTER for a player not on the roster, saving nothing', async () => {
        const { token, teamId, rohitId } = await setup();
        const stranger = await Player.create({ name: 'Virat', nameLower: 'virat' });

        const res = await patchTeam(token, teamId, { name: 'Changed', captainId: String(stranger._id) });
        const profile = await getProfile(token, teamId);

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TEAM_LEADER_NOT_ON_ROSTER');
        expect(profile.body.data.name).toBe('Mumbai Indians');
        expect(profile.body.data.captainId).toBeNull();
        expect(rohitId).toBeTruthy();
    });

    it('400 TEAM_LEADERS_MUST_DIFFER when both ids are equal', async () => {
        const { token, teamId, rohitId } = await setup();
        const res = await patchTeam(token, teamId, { captainId: rohitId, viceCaptainId: rohitId });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TEAM_LEADERS_MUST_DIFFER');
    });

    it('400 TEAM_LEADERS_MUST_DIFFER when setting one to the stored other', async () => {
        const { token, teamId, rohitId } = await setup();
        await patchTeam(token, teamId, { captainId: rohitId });

        const res = await patchTeam(token, teamId, { viceCaptainId: rohitId });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TEAM_LEADERS_MUST_DIFFER');
    });

    it.each(['not-an-id', 123, {}])('400 INVALID_PLAYER_ID for a malformed id (%p)', async (bad) => {
        const { token, teamId } = await setup();
        const res = await patchTeam(token, teamId, { captainId: bad });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_PLAYER_ID');
    });

    it('profile reports null for a captain whose Player is soft-deleted', async () => {
        const { token, teamId, rohitId } = await setup();
        await patchTeam(token, teamId, { captainId: rohitId });
        await Player.updateOne({ _id: rohitId }, { isDeleted: true });

        const res = await getProfile(token, teamId);

        expect(res.body.data.captainId).toBeNull();
        expect(res.body.data.roster.map((r) => r.playerId)).not.toContain(rohitId);
    });

    it('403 TEAM_NOT_MANAGEABLE for a non-owner org member', async () => {
        const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
        const orgRes = await request(app).post('/api/v1/organization').set(auth(ownerToken)).send({ name: 'Riverside CC' });
        const orgId = orgRes.body.data.id;
        const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
        await request(app).post(`/api/v1/organization/${orgId}/members`).set(auth(ownerToken)).send({ email: 'member@example.com' });
        const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set(auth(ownerToken)).send({ name: 'Riverside U19' });
        const teamId = teamRes.body.data.id;

        const res = await request(app).patch(`/api/v1/team/${teamId}`).set(auth(memberToken)).send({ name: 'Riverside U19', captainId: null });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('TEAM_NOT_MANAGEABLE');
    });
});
