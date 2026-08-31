import { isRateLimited, _resetForTests } from '../src/utils/socketRateLimit.js';

describe('isRateLimited', () => {
  afterEach(() => {
    _resetForTests();
  });

  it('allows attempts up to the configured max within the window', () => {
    for (let i = 0; i < 5; i += 1) {
      expect(isRateLimited('key-a', { windowMs: 60_000, max: 5 })).toBe(false);
    }
  });

  it('refuses the attempt that exceeds the max within the window', () => {
    for (let i = 0; i < 5; i += 1) {
      isRateLimited('key-b', { windowMs: 60_000, max: 5 });
    }

    expect(isRateLimited('key-b', { windowMs: 60_000, max: 5 })).toBe(true);
  });

  it('tracks each key independently', () => {
    for (let i = 0; i < 5; i += 1) {
      isRateLimited('key-c', { windowMs: 60_000, max: 5 });
    }

    // A different key (a different connecting IP) starts with its own
    // fresh budget — this is what stops the limiter from becoming a
    // single global switch that one noisy IP could flip for everyone else.
    expect(isRateLimited('key-d', { windowMs: 60_000, max: 5 })).toBe(false);
  });

  it('resets once the window has elapsed', () => {
    for (let i = 0; i < 5; i += 1) {
      isRateLimited('key-e', { windowMs: 50, max: 5 });
    }
    expect(isRateLimited('key-e', { windowMs: 50, max: 5 })).toBe(true);

    return new Promise((resolve) => {
      setTimeout(() => {
        expect(isRateLimited('key-e', { windowMs: 50, max: 5 })).toBe(false);
        resolve();
      }, 60);
    });
  });
});
