import { jest } from '@jest/globals';

const sendMailMock = jest.fn().mockResolvedValue({ accepted: ['someone@example.com'] });

// registerUser calls the real mailSender (nodemailer) on every success path
// once this fix reuses/creates a user — mocked so tests never attempt a real
// SMTP connection and so call counts can prove the "already verified" branch
// sends nothing.
jest.unstable_mockModule('../src/utils/mailSender.js', () => ({
  default: sendMailMock,
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const { sanitizeMiddleware } = await import('../src/middlewares/sanitize.middleware.js');
const { localeMiddleware } = await import('../src/middlewares/locale.middleware.js');
const { errorHandler } = await import('../src/utils/errorHandler.js');
const userRouter = (await import('../src/routes/user.routes.js')).default;
const { User } = await import('../src/models/user.model.js');
const { connectTestDb, disconnectTestDb, clearTestDb } = await import('./setup/testDb.js');

// registerUser used to throw a verbatim 409 EMAIL_ALREADY_EXISTS whenever the
// email was already taken — regardless of whether that account was verified,
// unverified, or belonged to someone else entirely. Combined with H7's login
// fix, this was the last of three separate account-existence oracles.
// Now every case (new email, unverified pending signup, already-verified
// account) returns the exact same 200 REGISTRATION_OTP_SENT response.
describe('POST /user/register does not leak account existence via its response', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = express();
    app.use(express.json());
    app.use(sanitizeMiddleware);
    app.use(localeMiddleware);
    app.use('/api/v1/user', userRouter);
    app.use(errorHandler);
  });

  afterEach(async () => {
    sendMailMock.mockClear();
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const register = (body) => request(app).post('/api/v1/user/register').send(body);

  it('a brand-new email registers normally', async () => {
    const res = await register({
      fullName: 'New Person',
      email: 'new-person@example.com',
      password: 'password123',
    });

    expect(res.status).toBe(200);
    expect(res.body.code).toBeUndefined();
    expect(res.body.message).toBe('An email sent to your account, please verify within 10 minutes');
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const stored = await User.findOne({ email: 'new-person@example.com' });
    expect(stored.isEmailVerified).toBe(false);
  });

  it('an already-verified account gets the identical response, with nothing sent and nothing changed', async () => {
    const existing = await User.create({
      email: 'verified@example.com',
      password: 'original-password',
      fullName: 'Original Name',
      isEmailVerified: true,
    });

    const res = await register({
      fullName: 'Attacker Supplied Name',
      email: 'verified@example.com',
      password: 'attacker-password',
    });

    // Byte-for-byte the same shape and message as the brand-new-email case —
    // that convergence is the fix, not this status code in isolation.
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('An email sent to your account, please verify within 10 minutes');
    expect(sendMailMock).not.toHaveBeenCalled();

    const stored = await User.findById(existing._id);
    expect(stored.fullName).toBe('Original Name');
    expect(await stored.isPasswordCorrect('original-password')).toBe(true);
    expect(await User.countDocuments({ email: 'verified@example.com' })).toBe(1);
  });

  it('an unverified pending signup is refreshed in place, not duplicated or rejected', async () => {
    const pending = await User.create({
      email: 'pending@example.com',
      password: 'first-password',
      fullName: 'First Name',
      isEmailVerified: false,
    });

    const res = await register({
      fullName: 'Second Name',
      email: 'pending@example.com',
      password: 'second-password',
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('An email sent to your account, please verify within 10 minutes');
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    expect(await User.countDocuments({ email: 'pending@example.com' })).toBe(1);
    const stored = await User.findById(pending._id);
    expect(stored.fullName).toBe('Second Name');
    expect(await stored.isPasswordCorrect('second-password')).toBe(true);
  });
});
