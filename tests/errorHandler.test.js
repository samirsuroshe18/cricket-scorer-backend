import express from 'express';
import request from 'supertest';
import { localeMiddleware } from '../src/middlewares/locale.middleware.js';
import { errorHandler } from '../src/utils/errorHandler.js';

// errorHandler falls back to the literal string "INTERNAL_SERVER_ERROR" as
// both `code` and the key passed to req.t() for any error that isn't a
// recognised ApiError — the one path every genuinely unexpected bug takes.
// With no such key in any locale file, i18next's missing-key fallback is the
// raw key itself, so a real crash showed the client that literal string
// instead of a translated message — the fallback for the unknown case was
// itself unhandled.
describe('errorHandler falls back to a translated message for unexpected errors', () => {
  const buildApp = () => {
    const app = express();
    app.use(localeMiddleware);
    app.get('/boom', () => {
      throw new Error('anything not shaped like an ApiError');
    });
    app.use(errorHandler);
    return app;
  };

  it('does not surface the raw INTERNAL_SERVER_ERROR key as the message', async () => {
    const app = buildApp();

    const res = await request(app).get('/boom');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.message).not.toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  it('translates it per the accept-language header, same as every other error code', async () => {
    const app = buildApp();

    const en = await request(app).get('/boom').set('accept-language', 'en');
    const hi = await request(app).get('/boom').set('accept-language', 'hi');

    expect(en.body.message).not.toBe('INTERNAL_SERVER_ERROR');
    expect(hi.body.message).not.toBe('INTERNAL_SERVER_ERROR');
    expect(hi.body.message).not.toBe(en.body.message);
  });
});
