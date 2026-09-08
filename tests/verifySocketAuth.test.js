import jwt from 'jsonwebtoken';
import { verifySocketAuth } from '../src/utils/verifySocketAuth.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

describe('verifySocketAuth', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterEach(async () => { await clearTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });

  it('resolves the user for a valid access token', async () => {
    const { user, token } = await createTestUser();
    const resolved = await verifySocketAuth(token);
    expect(String(resolved._id)).toBe(String(user._id));
  });

  it('returns null for a missing token', async () => {
    expect(await verifySocketAuth(undefined)).toBeNull();
    expect(await verifySocketAuth('')).toBeNull();
  });

  it('returns null for a malformed token', async () => {
    expect(await verifySocketAuth('not-a-jwt')).toBeNull();
  });

  it('returns null for a token signed with the wrong secret', async () => {
    const bad = jwt.sign({ _id: '507f1f77bcf86cd799439011' }, 'wrong-secret');
    expect(await verifySocketAuth(bad)).toBeNull();
  });

  it('returns null when the token resolves to a nonexistent user', async () => {
    const token = jwt.sign({ _id: '507f1f77bcf86cd799439011' }, process.env.ACCESS_TOKEN_SECRET);
    expect(await verifySocketAuth(token)).toBeNull();
  });
});
