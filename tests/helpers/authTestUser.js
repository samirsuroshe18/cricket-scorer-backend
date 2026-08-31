import { User } from '../../src/models/user.model.js';

// No `.env.test` exists (only `.env.development`/`.env.production` do — see
// the backend CLAUDE.md). `User.generateAccessToken` and `verifyJwt` both
// read these from `process.env` at call time, so setting dummy values here,
// once, before any test signs or verifies a token, is sufficient.
process.env.ACCESS_TOKEN_SECRET ||= 'test-access-token-secret';
process.env.ACCESS_TOKEN_EXPIRY ||= '1h';

let counter = 0;

/**
 * Creates a real, persisted `User` and a real access token signed the same
 * way `login`/`refresh-token` do, so `verifyJwt` and each controller's own
 * `createdBy` ownership check run unmodified — never a stubbed `req.user`.
 */
export const createTestUser = async (overrides = {}) => {
  counter += 1;
  const user = await User.create({
    email: `test-user-${Date.now()}-${counter}@example.com`,
    password: 'password123',
    fullName: 'Test User',
    isEmailVerified: true,
    ...overrides,
  });

  return { user, token: user.generateAccessToken() };
};
