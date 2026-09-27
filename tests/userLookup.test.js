import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

describe('GET /v1/user/lookup', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withUser: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const lookup = (token, email) => {
    const req = request(app).get('/api/v1/user/lookup');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return email === undefined ? req : req.query({ email });
  };

  it('finds an active user by exact email, ignoring case and surrounding whitespace', async () => {
    const { token } = await createTestUser();
    const { user: target } = await createTestUser({
      email: 'rahul.sharma@example.com',
      fullName: 'Rahul Sharma',
      userName: 'rahul_s',
      photoUrl: 'https://res.cloudinary.com/x/rahul.png',
    });

    const res = await lookup(token, '  Rahul.Sharma@Example.COM ');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      userId: String(target._id),
      fullName: 'Rahul Sharma',
      userName: 'rahul_s',
      photoUrl: 'https://res.cloudinary.com/x/rahul.png',
    });
  });

  it('returns exactly userId, fullName, userName and photoUrl and nothing else', async () => {
    const { token } = await createTestUser();
    await createTestUser({ email: 'keys@example.com', fullName: 'Keys Person' });

    const res = await lookup(token, 'keys@example.com');

    expect(Object.keys(res.body.data).sort()).toEqual(['fullName', 'photoUrl', 'userId', 'userName']);
  });

  it('does not match a partial address or a name', async () => {
    const { token } = await createTestUser();
    await createTestUser({ email: 'rahul.sharma@example.com', fullName: 'Rahul Sharma' });

    const partial = await lookup(token, 'rahul.sharma@example');
    const prefix = await lookup(token, 'rahul@example.com');
    const name = await lookup(token, 'Rahul Sharma');

    expect(partial.status).toBe(400);
    expect(prefix.status).toBe(404);
    expect(name.status).toBe(400);
  });

  it('returns the same 404 USER_NOT_FOUND for a missing, deleted, blocked or unverified account', async () => {
    const { token } = await createTestUser();
    await createTestUser({ email: 'deleted@example.com', isDeleted: true });
    await createTestUser({ email: 'blocked@example.com', accountStatus: 'blocked' });
    await createTestUser({ email: 'suspended@example.com', accountStatus: 'suspended' });
    await createTestUser({ email: 'unverified@example.com', isEmailVerified: false });

    const responses = await Promise.all(
      ['nobody@example.com', 'deleted@example.com', 'blocked@example.com', 'suspended@example.com', 'unverified@example.com']
        .map((email) => lookup(token, email)),
    );

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('USER_NOT_FOUND');
    }
    expect(new Set(responses.map((r) => r.body.message)).size).toBe(1);
  });

  it('returns 400 INVALID_EMAIL for a missing, malformed or regex-shaped value', async () => {
    const { token } = await createTestUser();
    await createTestUser({ email: 'victim@x.com' });

    for (const email of [undefined, '', '   ', 'plain', 'a@b', '.*@x.com', '.*', ['a@x.com', 'b@x.com']]) {
      const res = await lookup(token, email);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_EMAIL');
    }
  });

  it('returns 400 CANNOT_INVITE_SELF for the caller\'s own address', async () => {
    const { user, token } = await createTestUser({ email: 'me@example.com' });

    const res = await lookup(token, user.email.toUpperCase());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANNOT_INVITE_SELF');
  });

  it('returns 401 without a token', async () => {
    const res = await lookup(null, 'a@example.com');

    expect(res.status).toBe(401);
  });
});
