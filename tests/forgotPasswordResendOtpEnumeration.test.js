import { jest } from '@jest/globals';

const sendMailMock = jest.fn().mockResolvedValue({ accepted: ['someone@example.com'] });

// Both endpoints call the real mailSender (nodemailer) on their real-account
// path — mocked so tests never attempt a real SMTP connection and so call
// counts can prove the no-such-account branch sends nothing.
jest.unstable_mockModule('../src/utils/mailSender.js', () => ({
  default: sendMailMock,
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const { sanitizeMiddleware } = await import('../src/middlewares/sanitize.middleware.js');
const { localeMiddleware } = await import('../src/middlewares/locale.middleware.js');
const { errorHandler } = await import('../src/utils/errorHandler.js');
const userRouter = (await import('../src/routes/user.routes.js')).default;
const { createTestUser } = await import('./helpers/authTestUser.js');
const { connectTestDb, disconnectTestDb, clearTestDb } = await import('./setup/testDb.js');

// forgotPassword and resendOtp each threw a distinguishable 404
// (INVALID_EMAIL_OR_NOT_VERIFIED / NO_ACCOUNT_FOUND) whenever no account
// matched, versus 200 whenever one did — a live account-existence oracle
// reachable with no credential at all, the same bug class already closed
// for login (INVALID_CREDENTIALS convergence) and registration
// (REGISTRATION_OTP_SENT convergence). Both now return the identical
// success response regardless of whether a matching account exists; the
// no-match case is a silent no-op (no email sent), same shape as
// registerUser's already-verified branch.
describe('forgotPassword and resendOtp do not leak account existence via their response', () => {
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

  describe('POST /user/forgot-password', () => {
    const forgotPassword = (email) =>
      request(app).post('/api/v1/user/forgot-password').send({ email });

    it('a registered, verified email sends a real OTP and returns 200', async () => {
      const { user } = await createTestUser();

      const res = await forgotPassword(user.email);

      expect(res.status).toBe(200);
      expect(res.body.code).toBeUndefined();
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });

    it('an email with no matching verified account returns the identical 200, sending nothing', async () => {
      const res = await forgotPassword('no-such-account@example.com');

      expect(res.status).toBe(200);
      expect(res.body.code).toBeUndefined();
      expect(sendMailMock).not.toHaveBeenCalled();
    });

    it('an unverified account\'s email also returns the identical 200, sending nothing', async () => {
      const { user } = await createTestUser({ isEmailVerified: false });

      const res = await forgotPassword(user.email);

      expect(res.status).toBe(200);
      expect(res.body.code).toBeUndefined();
      expect(sendMailMock).not.toHaveBeenCalled();
    });
  });

  describe('POST /user/resend-otp', () => {
    const resendOtp = (email, type) =>
      request(app).post('/api/v1/user/resend-otp').send({ email, type });

    it('a pending (unverified) signup resends its verification OTP and returns 200', async () => {
      const { user } = await createTestUser({ isEmailVerified: false });

      const res = await resendOtp(user.email, 'EMAIL_VERIFICATION');

      expect(res.status).toBe(200);
      expect(res.body.code).toBeUndefined();
      expect(sendMailMock).toHaveBeenCalledTimes(1);
    });

    it('an email with no matching pending signup returns the identical 200, sending nothing', async () => {
      const res = await resendOtp('no-such-account@example.com', 'EMAIL_VERIFICATION');

      expect(res.status).toBe(200);
      expect(res.body.code).toBeUndefined();
      expect(sendMailMock).not.toHaveBeenCalled();
    });

    it('an email with no matching verified account (forgot-password resend) returns the identical 200, sending nothing', async () => {
      const res = await resendOtp('no-such-account@example.com', 'FORGOT_PASSWORD');

      expect(res.status).toBe(200);
      expect(res.body.code).toBeUndefined();
      expect(sendMailMock).not.toHaveBeenCalled();
    });
  });
});
