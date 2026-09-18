import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const LOGO_URL = 'https://res.cloudinary.com/demo/image/upload/team.png';

// The real uploadOnCloudinary deletes the staged temp file on success and on
// failure; the mock does the same so the "no leaked temp file" assertions
// mean something.
const uploadOnCloudinaryMock = jest.fn(async (filePath) => {
  fs.unlinkSync(filePath);
  return { secure_url: LOGO_URL };
});
jest.unstable_mockModule('../src/utils/cloudinary.js', () => ({
  uploadOnCloudinary: uploadOnCloudinaryMock,
  deleteCloudinary: jest.fn(),
}));

const request = (await import('supertest')).default;
const { buildTestApp } = await import('./helpers/buildTestApp.js');
const { createTestUser } = await import('./helpers/authTestUser.js');
const { connectTestDb, disconnectTestDb, clearTestDb } = await import('./setup/testDb.js');
const { Team } = await import('../src/models/team.model.js');

// Signature bytes sniffImageType recognises (see multerMiddleware.test.js).
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'temp');

// uploads/temp is shared with other test files running in parallel jest
// workers (multerMiddleware.test.js stages real files there), so a raw count
// can move for unrelated reasons. Compare contents instead: a file staged by
// THIS request that is still present after a short poll is a genuine leak,
// whereas a neighbouring worker's file comes and goes.
const snapshotStaged = () => new Set(fs.readdirSync(UPLOAD_DIR));
const leakedSince = async (before, timeoutMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  let leaked;
  do {
    leaked = fs.readdirSync(UPLOAD_DIR).filter((name) => !before.has(name));
    if (leaked.length === 0) return leaked;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return leaked;
};

describe('POST /v1/team/:teamId/logo', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTeam: true, withOrganization: true });
  });

  beforeEach(() => {
    uploadOnCloudinaryMock.mockClear();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  const makeTeam = async (token) => {
    const res = await request(app)
      .post('/api/v1/match/create')
      .set(auth(token))
      .send({ totalOvers: 5, teamAName: 'Mumbai Indians', teamBName: 'Chennai Super Kings' });
    return res.body.data.teamA.id;
  };

  const uploadLogo = (token, teamId) =>
    request(app).post(`/api/v1/team/${teamId}/logo`).set(auth(token));

  it('200s for the owner, stores the URL, and returns it', async () => {
    const { token } = await createTestUser();
    const teamId = await makeTeam(token);

    const res = await uploadLogo(token, teamId).attach('file', PNG_BYTES, {
      filename: 'logo.png',
      contentType: 'image/png',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: teamId, logoUrl: LOGO_URL });
    expect(uploadOnCloudinaryMock).toHaveBeenCalledTimes(1);
    const stored = await Team.findById(teamId);
    expect(stored.logoUrl).toBe(LOGO_URL);
  });

  it('400s with LOGO_REQUIRED when no file is attached', async () => {
    const { token } = await createTestUser();
    const teamId = await makeTeam(token);

    const res = await uploadLogo(token, teamId).send();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('LOGO_REQUIRED');
    expect(uploadOnCloudinaryMock).not.toHaveBeenCalled();
  });

  it("404s for a team that doesn't exist", async () => {
    const { token } = await createTestUser();

    const res = await uploadLogo(token, '665f3b1c2d3e4f5a6b7c8d90').send();

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEAM_NOT_FOUND');
  });

  it("403s a non-owner and leaves no staged file behind", async () => {
    const { token: ownerToken } = await createTestUser({ email: 'owner-logo@example.com' });
    const teamId = await makeTeam(ownerToken);
    const { token: strangerToken } = await createTestUser({ email: 'stranger-logo@example.com' });
    const before = snapshotStaged();

    const res = await uploadLogo(strangerToken, teamId).attach('file', PNG_BYTES, {
      filename: 'logo.png',
      contentType: 'image/png',
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEAM_NOT_OWNED');
    expect(uploadOnCloudinaryMock).not.toHaveBeenCalled();
    expect(await leakedSince(before)).toEqual([]);
    const stored = await Team.findById(teamId);
    expect(stored.logoUrl).toBeNull();
  });

  it('200s for a non-creator member of the team\'s organization and stores the logo', async () => {
    const { token: ownerToken } = await createTestUser({ email: 'org-owner-logo@example.com' });
    const { token: memberToken } = await createTestUser({ email: 'org-member-logo@example.com' });
    const orgRes = await request(app)
      .post('/api/v1/organization')
      .set(auth(ownerToken))
      .send({ name: 'Riverside CC' });
    const orgId = orgRes.body.data.id;
    await request(app)
      .post(`/api/v1/organization/${orgId}/members`)
      .set(auth(ownerToken))
      .send({ email: 'org-member-logo@example.com' });
    const teamRes = await request(app)
      .post(`/api/v1/organization/${orgId}/teams`)
      .set(auth(ownerToken))
      .send({ name: 'Riverside U19' });
    const teamId = teamRes.body.data.id;

    const res = await uploadLogo(memberToken, teamId).attach('file', PNG_BYTES, {
      filename: 'logo.png',
      contentType: 'image/png',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: teamId, logoUrl: LOGO_URL });
    expect(uploadOnCloudinaryMock).toHaveBeenCalledTimes(1);
    const stored = await Team.findById(teamId);
    expect(stored.logoUrl).toBe(LOGO_URL);
  });

  it('500s with LOGO_UPLOAD_FAILED when Cloudinary fails, leaving logoUrl unchanged', async () => {
    const { token } = await createTestUser();
    const teamId = await makeTeam(token);
    uploadOnCloudinaryMock.mockImplementationOnce(async (filePath) => {
      fs.unlinkSync(filePath);
      return null;
    });

    const res = await uploadLogo(token, teamId).attach('file', PNG_BYTES, {
      filename: 'logo.png',
      contentType: 'image/png',
    });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('LOGO_UPLOAD_FAILED');
    const stored = await Team.findById(teamId);
    expect(stored.logoUrl).toBeNull();
  });

  it('401s without a token', async () => {
    const res = await request(app).post('/api/v1/team/665f3b1c2d3e4f5a6b7c8d90/logo').send();

    expect(res.status).toBe(401);
  });
});
