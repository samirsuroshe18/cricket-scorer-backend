import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Team } from '../src/models/team.model.js';

const LOGO = 'https://res.cloudinary.com/demo/image/upload/mumbai.png';

describe('Team.logoUrl is exposed everywhere a team is serialized for a card', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  const createMatch = (token, body) =>
    request(app)
      .post('/api/v1/match/create')
      .set(auth(token))
      .send({ totalOvers: 5, ...body });

  // A match whose teamA already has a logo, plus the ids a test needs.
  const seedMatchWithLogo = async () => {
    const { token } = await createTestUser();
    const first = await createMatch(token, {
      teamAName: 'Mumbai Indians',
      teamBName: 'Chennai Super Kings',
    });
    const teamAId = first.body.data.teamA.id;
    await Team.updateOne({ _id: teamAId }, { logoUrl: LOGO });
    return { token, teamAId };
  };

  it('createMatch reports logoUrl null for a fresh team', async () => {
    const { token } = await createTestUser();

    const res = await createMatch(token, {
      teamAName: 'Mumbai Indians',
      teamBName: 'Chennai Super Kings',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.teamA.logoUrl).toBeNull();
    expect(res.body.data.teamB.logoUrl).toBeNull();
  });

  it('createMatch returns the stored logoUrl for a team reused by id', async () => {
    const { token, teamAId } = await seedMatchWithLogo();

    const res = await createMatch(token, { teamAId, teamBName: 'Delhi Capitals' });

    expect(res.status).toBe(200);
    expect(res.body.data.teamA.logoUrl).toBe(LOGO);
    expect(res.body.data.teamB.logoUrl).toBeNull();
  });

  it('GET /v1/match/history carries logoUrl on teamA and teamB', async () => {
    const { token } = await seedMatchWithLogo();

    const res = await request(app).get('/api/v1/match/history').set(auth(token));

    expect(res.status).toBe(200);
    const [match] = res.body.data.matches;
    expect(match.teamA.logoUrl).toBe(LOGO);
    expect(match.teamB.logoUrl).toBeNull();
  });

  it('GET /v1/team/:teamId carries logoUrl at the root', async () => {
    const { token, teamAId } = await seedMatchWithLogo();

    const res = await request(app).get(`/api/v1/team/${teamAId}`).set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.data.logoUrl).toBe(LOGO);
  });

  it('GET /v1/team/:teamId/matches carries logoUrl on teamA and teamB', async () => {
    const { token, teamAId } = await seedMatchWithLogo();

    const res = await request(app).get(`/api/v1/team/${teamAId}/matches`).set(auth(token));

    expect(res.status).toBe(200);
    const [match] = res.body.data.matches;
    expect(match.teamA.logoUrl).toBe(LOGO);
    expect(match.teamB.logoUrl).toBeNull();
  });

  it('GET /v1/team lists logoUrl per team', async () => {
    const { token, teamAId } = await seedMatchWithLogo();

    const res = await request(app).get('/api/v1/team').set(auth(token));

    expect(res.status).toBe(200);
    const withLogo = res.body.data.teams.find((t) => t.id === teamAId);
    expect(withLogo.logoUrl).toBe(LOGO);
    const without = res.body.data.teams.find((t) => t.id !== teamAId);
    expect(without.logoUrl).toBeNull();
  });
});
