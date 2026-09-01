import express from 'express';
import request from 'supertest';
import { resolveTrustProxyHops } from '../src/utils/trustProxy.js';

describe('resolveTrustProxyHops', () => {
  it('defaults to 0 (trust nothing) when unset', () => {
    expect(resolveTrustProxyHops(undefined)).toBe(0);
    expect(resolveTrustProxyHops('')).toBe(0);
  });

  it('parses a valid hop count', () => {
    expect(resolveTrustProxyHops('0')).toBe(0);
    expect(resolveTrustProxyHops('1')).toBe(1);
    expect(resolveTrustProxyHops('2')).toBe(2);
  });

  it('falls back to 0 for garbage input rather than throwing or trusting everything', () => {
    expect(resolveTrustProxyHops('not-a-number')).toBe(0);
  });
});

// rateLimit.middleware.js's globalLimiter/authLimiter key on `req.ip`, and
// `req.ip` is only as trustworthy as Express's own `trust proxy` setting —
// app.js used to leave it unset (Express's default, `false`). These prove
// the two failure modes the app.js comment describes, using Express's own
// numeric trust-proxy semantics directly (not a reimplementation of them):
// trust proxy = 0 must ignore X-Forwarded-For outright (today's correct
// setting, no proxy in front), and trust proxy = 1 (a single real proxy)
// must honor exactly one hop of it while still ignoring anything an
// attacker prepends beyond that.
describe('Express trust proxy setting governs whether X-Forwarded-For can influence req.ip', () => {
  const buildApp = (trustProxyHops) => {
    const app = express();
    app.set('trust proxy', trustProxyHops);
    app.get('/whoami', (req, res) => res.json({ ip: req.ip }));
    return app;
  };

  it('trust proxy 0: a spoofed X-Forwarded-For has no effect — req.ip is the raw socket peer', async () => {
    const app = buildApp(0);

    const res = await request(app)
      .get('/whoami')
      .set('X-Forwarded-For', '6.6.6.6');

    expect(res.body.ip).not.toBe('6.6.6.6');
  });

  it('trust proxy 1: a single real proxy hop is honored', async () => {
    const app = buildApp(1);

    const res = await request(app)
      .get('/whoami')
      .set('X-Forwarded-For', '9.9.9.9');

    expect(res.body.ip).toBe('9.9.9.9');
  });

  it('trust proxy 1: an extra hop prepended by an attacker beyond the one real proxy is ignored', async () => {
    const app = buildApp(1);

    // 6.6.6.6 is the attacker's own fake prefix; 9.9.9.9 is what the one
    // real, trusted proxy actually appended as the peer it saw. Only the
    // rightmost `trust proxy` hops are trusted, so this must resolve to
    // 9.9.9.9, never the attacker-supplied value.
    const res = await request(app)
      .get('/whoami')
      .set('X-Forwarded-For', '6.6.6.6, 9.9.9.9');

    expect(res.body.ip).toBe('9.9.9.9');
  });
});
