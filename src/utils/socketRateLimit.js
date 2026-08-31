// A minimal, in-memory fixed-window counter for Socket.io events. Express's
// `globalLimiter`/`authLimiter` (rateLimit.middleware.js) don't apply here at
// all — Socket.io has no per-event middleware layer the way Express routes
// do, and `express-rate-limit` itself is HTTP-middleware-shaped, not
// reusable standalone for an arbitrary key. This exists specifically for
// `match:join`, whose join-code space (six characters, ~30-character
// alphabet) is otherwise brute-forceable with zero friction: no auth on the
// event, and a miss returns nothing (see `findMatchByIdOrCode`'s own doc
// comment on why that silence is deliberate and stays that way).
//
// Keyed by whatever the caller passes — the connecting IP, at the one call
// site — rather than per-socket, so opening a fresh connection to reset a
// per-socket counter doesn't help. Same IP-based keying (and the same
// caveat about proxies/shared IPs) as the existing HTTP limiters; solving
// that more precisely is out of scope here.
const attemptsByKey = new Map();

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 20;

/**
 * Records one attempt for `key` and reports whether it should be refused.
 * Windows reset on their own — there is no cleanup pass, since a Map entry
 * only exists per distinct key ever seen and this process's lifetime is
 * short relative to any real growth here.
 */
export const isRateLimited = (
    key,
    { windowMs = DEFAULT_WINDOW_MS, max = DEFAULT_MAX_ATTEMPTS } = {}
) => {
    const now = Date.now();
    const entry = attemptsByKey.get(key);

    if (!entry || now >= entry.resetAt) {
        attemptsByKey.set(key, { count: 1, resetAt: now + windowMs });
        return false;
    }

    entry.count += 1;
    return entry.count > max;
};

// Test-only: attemptsByKey is otherwise never inspectable or resettable from
// outside this module, which real callers should never need to do.
export const _resetForTests = () => attemptsByKey.clear();
