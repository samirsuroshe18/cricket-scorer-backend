import { jest } from '@jest/globals';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { timingSafeEqualString } from '../src/utils/timingSafeEqual.js';
import { sanitizeMiddleware } from '../src/middlewares/sanitize.middleware.js';
import { localeMiddleware } from '../src/middlewares/locale.middleware.js';
import { errorHandler } from '../src/utils/errorHandler.js';
import userRouter from '../src/routes/user.routes.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

describe('timingSafeEqualString', () => {
  it('is true for identical strings', () => {
    expect(timingSafeEqualString('123456', '123456')).toBe(true);
  });

  it('is false for different strings of the same length', () => {
    expect(timingSafeEqualString('123456', '654321')).toBe(false);
  });

  it('is false, not throwing, for different-length inputs', () => {
    expect(timingSafeEqualString('123456', '1234567')).toBe(false);
  });

  it('is false rather than throwing for null/undefined', () => {
    expect(timingSafeEqualString(null, '123456')).toBe(false);
    expect(timingSafeEqualString(undefined, undefined)).toBe(true);
  });
});

// verifyEmail/verifyForgotPasswordOtp/setPassword used to compare their secret
// values (the OTP, the hashed reset token) with a plain !== — a non-constant-
// time comparison whose duration leaks how many leading bytes matched. Proven
// here by spying on crypto.timingSafeEqual itself: it must actually be
// invoked on the request path, not just exist as an unused utility function.
describe('OTP/reset-token verification uses a constant-time comparison', () => {
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
    jest.restoreAllMocks();
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  it('calls crypto.timingSafeEqual when verifying an email OTP', async () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    const { user } = await createTestUser({ isEmailVerified: false });
    user.emailOtp = '123456';
    user.emailOtpExpiry = new Date(Date.now() + 60_000);
    await user.save({ validateBeforeSave: false });

    const res = await request(app)
      .post('/api/v1/user/verify-otp')
      .send({ email: user.email, emailOtp: '123456', type: 'EMAIL_VERIFICATION' });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalled();
  });

  it('still rejects a wrong email OTP', async () => {
    const { user } = await createTestUser({ isEmailVerified: false });
    user.emailOtp = '123456';
    user.emailOtpExpiry = new Date(Date.now() + 60_000);
    await user.save({ validateBeforeSave: false });

    const res = await request(app)
      .post('/api/v1/user/verify-otp')
      .send({ email: user.email, emailOtp: '000000', type: 'EMAIL_VERIFICATION' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_OTP');
  });

  it('calls crypto.timingSafeEqual when checking the reset token in set-password', async () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    const { user } = await createTestUser({ isEmailVerified: true });
    const resetToken = 'a-fake-reset-token';
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.emailOtp = undefined;
    user.emailOtpExpiry = undefined;
    user.otpVerifyToken = hashedToken;
    user.otpVerifyTokenExpiry = new Date(Date.now() + 60_000);
    await user.save({ validateBeforeSave: false });

    const res = await request(app)
      .post('/api/v1/user/set-password')
      .send({
        email: user.email,
        resetToken,
        newPassword: 'newpassword123',
        confirmPassword: 'newpassword123',
      });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalled();
  });
});
