import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Player } from '../src/models/player.model.js';
import { Team } from '../src/models/team.model.js';

describe('team roster endpoints', () => {
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

    const createTeam = async (token, name = 'Mumbai Indians') => {
        const res = await request(app).post('/api/v1/team').set(auth(token)).send({ name });
        return res.body.data.id;
    };

    const addPlayer = (token, teamId, body) =>
        request(app).post(`/api/v1/team/${teamId}/players`).set(auth(token)).send(body);

    const patchPlayer = (token, teamId, playerId, body) =>
        request(app).patch(`/api/v1/team/${teamId}/players/${playerId}`).set(auth(token)).send(body);

    const getProfile = (token, teamId) =>
        request(app).get(`/api/v1/team/${teamId}`).set(auth(token)).send();

    const createOrgTeam = async () => {
        const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
        const orgRes = await request(app).post('/api/v1/organization').set(auth(ownerToken)).send({ name: 'Riverside CC' });
        const orgId = orgRes.body.data.id;
        const { token: memberToken } = await createTestUser({ email: 'member@example.com' });
        await request(app).post(`/api/v1/organization/${orgId}/members`).set(auth(ownerToken)).send({ email: 'member@example.com' });
        const teamRes = await request(app).post(`/api/v1/organization/${orgId}/teams`).set(auth(ownerToken)).send({ name: 'Riverside U19' });
        return { ownerToken, memberToken, teamId: teamRes.body.data.id };
    };

    describe('POST /v1/team/:teamId/players', () => {
        it('adds a new player and returns 201 with the roster row', async () => {
            const { token } = await createTestUser();
            const teamId = await createTeam(token);

            const res = await addPlayer(token, teamId, { name: 'Rohit', role: 'batsman', jerseyNumber: 45 });

            expect(res.status).toBe(201);
            expect(res.body.data).toEqual({
                playerId: expect.any(String),
                playerName: 'Rohit',
                jerseyNumber: 45,
                role: 'batsman',
                isCaptain: false,
                isViceCaptain: false,
            });
        });

        it('defaults role to unknown and jerseyNumber to null', async () => {
            const { token } = await createTestUser();
            const teamId = await createTeam(token);

            const res = await addPlayer(token, teamId, { name: 'Rohit' });

            expect(res.body.data).toMatchObject({ role: 'unknown', jerseyNumber: null });
        });

        it('re-adding the same name in a different case returns 200 and does not duplicate the Player or roster entry', async () => {
            const { token } = await createTestUser();
            const teamId = await createTeam(token);
            const first = await addPlayer(token, teamId, { name: 'Rohit' });

            const second = await addPlayer(token, teamId, { name: '  rOHIT ' });

            expect(second.status).toBe(200);
            expect(second.body.data.playerId).toBe(first.body.data.playerId);
            expect(await Player.countDocuments({ nameLower: 'rohit' })).toBe(1);
            const team = await Team.findById(teamId);
            expect(team.players).toHaveLength(1);
        });

        it.each([
            ['blank', ''],
            ['whitespace-only', '   '],
            ['numeric', 42],
            ['missing', undefined],
            ['51 characters', 'x'.repeat(51)],
        ])('rejects a %s name with 400 TEAM_PLAYER_NAME_INVALID', async (_label, name) => {
            const { token } = await createTestUser();
            const teamId = await createTeam(token);

            const res = await addPlayer(token, teamId, { name });

            expect(res.status).toBe(400);
            expect(res.body.code).toBe('TEAM_PLAYER_NAME_INVALID');
        });

        it('rejects an invalid role and an out-of-range jersey number, adding nothing', async () => {
            const { token } = await createTestUser();
            const teamId = await createTeam(token);

            const badRole = await addPlayer(token, teamId, { name: 'Rohit', role: 'umpire' });
            const badJersey = await addPlayer(token, teamId, { name: 'Rohit', jerseyNumber: 1000 });

            expect(badRole.body.code).toBe('INVALID_PLAYER_ROLE');
            expect(badJersey.body.code).toBe('INVALID_JERSEY_NUMBER');
            expect(await Player.countDocuments()).toBe(0);
        });

        it('403s TEAM_NOT_OWNED for a stranger', async () => {
            const { token: ownerToken } = await createTestUser({ email: 'owner@example.com' });
            const teamId = await createTeam(ownerToken);
            const { token: strangerToken } = await createTestUser({ email: 'stranger@example.com' });

            const res = await addPlayer(strangerToken, teamId, { name: 'Rohit' });

            expect(res.status).toBe(403);
            expect(res.body.code).toBe('TEAM_NOT_OWNED');
        });

        it('403s TEAM_NOT_MANAGEABLE for a non-owner org member, and lets the org owner add', async () => {
            const { ownerToken, memberToken, teamId } = await createOrgTeam();

            const denied = await addPlayer(memberToken, teamId, { name: 'Rohit' });
            const allowed = await addPlayer(ownerToken, teamId, { name: 'Rohit' });

            expect(denied.status).toBe(403);
            expect(denied.body.code).toBe('TEAM_NOT_MANAGEABLE');
            expect(allowed.status).toBe(201);
        });

        it('added player appears in GET /v1/team/:id roster', async () => {
            const { token } = await createTestUser();
            const teamId = await createTeam(token);
            await addPlayer(token, teamId, { name: 'Rohit', role: 'batsman' });

            const res = await getProfile(token, teamId);

            expect(res.body.data.roster).toEqual([
                expect.objectContaining({ playerName: 'Rohit', role: 'batsman', isCaptain: false, isViceCaptain: false }),
            ]);
        });
    });

    describe('PATCH /v1/team/:teamId/players/:playerId', () => {
        it('updates role and jerseyNumber', async () => {
            const { token } = await createTestUser();
            const teamId = await createTeam(token);
            const { body } = await addPlayer(token, teamId, { name: 'Rohit' });

            const res = await patchPlayer(token, teamId, body.data.playerId, { role: 'bowler', jerseyNumber: 7 });

            expect(res.status).toBe(200);
            expect(res.body.data).toMatchObject({ playerId: body.data.playerId, role: 'bowler', jerseyNumber: 7 });
        });

        it('leaves omitted fields untouched', async () => {
            const { token } = await createTestUser();
            const teamId = await createTeam(token);
            const { body } = await addPlayer(token, teamId, { name: 'Rohit', role: 'batsman', jerseyNumber: 45 });

            const res = await patchPlayer(token, teamId, body.data.playerId, { role: 'allrounder' });

            expect(res.body.data).toMatchObject({ role: 'allrounder', jerseyNumber: 45 });
        });

        it('rejects an invalid role and an out-of-range jersey number', async () => {
            const { token } = await createTestUser();
            const teamId = await createTeam(token);
            const { body } = await addPlayer(token, teamId, { name: 'Rohit' });

            const badRole = await patchPlayer(token, teamId, body.data.playerId, { role: 'umpire' });
            const badJersey = await patchPlayer(token, teamId, body.data.playerId, { jerseyNumber: -1 });

            expect(badRole.body.code).toBe('INVALID_PLAYER_ROLE');
            expect(badJersey.body.code).toBe('INVALID_JERSEY_NUMBER');
        });

        it('404s PLAYER_NOT_ON_TEAM for a player not on the roster', async () => {
            const { token } = await createTestUser();
            const teamId = await createTeam(token, 'Team One');
            const otherTeamId = await createTeam(token, 'Team Two');
            const { body } = await addPlayer(token, otherTeamId, { name: 'Rohit' });

            const res = await patchPlayer(token, teamId, body.data.playerId, { role: 'bowler' });

            expect(res.status).toBe(404);
            expect(res.body.code).toBe('PLAYER_NOT_ON_TEAM');
        });

        it('an organization owner can edit a player another user created', async () => {
            const { ownerToken, teamId } = await createOrgTeam();
            const { body } = await addPlayer(ownerToken, teamId, { name: 'Rohit' });

            const res = await patchPlayer(ownerToken, teamId, body.data.playerId, { role: 'bowler' });

            expect(res.status).toBe(200);
        });

        it('403s TEAM_NOT_MANAGEABLE for a non-owner org member', async () => {
            const { ownerToken, memberToken, teamId } = await createOrgTeam();
            const { body } = await addPlayer(ownerToken, teamId, { name: 'Rohit' });

            const res = await patchPlayer(memberToken, teamId, body.data.playerId, { role: 'bowler' });

            expect(res.status).toBe(403);
            expect(res.body.code).toBe('TEAM_NOT_MANAGEABLE');
        });
    });
});
