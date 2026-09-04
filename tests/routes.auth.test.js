import matchRouter from '../src/routes/match.routes.js';
import userRouter from '../src/routes/user.routes.js';
import translationRouter from '../src/routes/translation.routes.js';
import playerRouter from '../src/routes/player.routes.js';
import teamRouter from '../src/routes/team.routes.js';
import { verifyJwt } from '../src/middlewares/auth.middleware.js';

// Auth in this app is opt-in, per-route and positional: `verifyJwt` is an
// argument you remember to pass, and omitting it produces a silently public
// endpoint that looks exactly like working code.
//
//   router.route('/x').post(verifyJwt, handler);  // protected
//   router.route('/x').post(handler);             // public. Nothing warns.
//
// That was survivable while every match route carried verifyJwt, because a line
// without it was obviously wrong. Adding a deliberately public spectator route
// ended that: "forgot the middleware" and "meant it" now look identical.
//
// This suite is the replacement for reading carefully. Every route must either
// carry verifyJwt or be named below, so opening a route stops being an omission
// and becomes an edit to a list of public routes — in the same commit, visible
// in the diff. That is the difference between a convention and a control.
//
// The allowlist is the security boundary. Adding a line to it is a decision
// about what strangers can reach; treat it as one.
const PUBLIC_ROUTES = {
    match: [
        // Read-only spectator access. Takes no body, writes nothing.
        'GET /public/:code',
    ],
    user: [
        // Credential and account-recovery endpoints: they cannot require a
        // token, because obtaining one is what they are for. Each is separately
        // rate limited by authLimiter.
        'POST /register',
        'POST /login',
        'POST /forgot-password',
        'POST /verify-otp',
        'POST /resend-otp',
        'POST /set-password',
        // These two authenticate from a token they carry themselves rather than
        // via verifyJwt: refresh-token reads x-refresh-token, and logout matches
        // on the refresh token in the Authorization header. Neither is reachable
        // without holding a valid token, but neither can use the access-token
        // middleware to prove it.
        'GET /refresh-token',
        'GET /logout',
    ],
    translation: [
        // The client's UI-string CMS, read side. Fetched before login — the app
        // is translated on its own login screen.
        'GET /all',
        'GET /version',
        'GET /:lang',
    ],
    // Every player route reads a specific scorer's own private data
    // (career-stats), so none of them belong on this allowlist.
    player: [],
    // Every team route reads or lists a specific scorer's own teams/rosters,
    // same reasoning as player above.
    team: [],
};

// `catchAsync` returns an anonymous arrow, so `verifyJwt.name` is the empty
// string and any name-based check would match every unnamed handler and pass
// vacuously — proving nothing while looking thorough. Comparing against the
// imported reference by identity is what actually holds.
const isProtected = (route) =>
    (route.stack ?? []).some((layer) => layer.handle === verifyJwt);

const routesOf = (router) =>
    router.stack
        .filter((layer) => layer.route)
        .flatMap((layer) =>
            Object.keys(layer.route.methods)
                .filter((method) => method !== '_all')
                .map((method) => ({
                    signature: `${method.toUpperCase()} ${layer.route.path}`,
                    route: layer.route,
                }))
        );

const ROUTERS = {
    match: matchRouter,
    user: userRouter,
    translation: translationRouter,
    player: playerRouter,
    team: teamRouter,
};

describe('every route is authenticated unless explicitly allowlisted', () => {
    it.each(Object.keys(ROUTERS))('%s router', (name) => {
        const allowed = PUBLIC_ROUTES[name];

        const unprotected = routesOf(ROUTERS[name])
            .filter(({ route }) => !isProtected(route))
            .map(({ signature }) => signature)
            .filter((signature) => !allowed.includes(signature));

        expect(unprotected).toEqual([]);
    });

    // Guards the guard. If the identity check silently stopped matching — a
    // refactor of catchAsync, a duplicate module instance — every route would
    // look unprotected, `unprotected` would be non-empty, and the tests above
    // would fail loudly. The real danger is the opposite: a check that matches
    // nothing would make everything look FINE. So assert it finds something.
    it('detects verifyJwt on a route known to carry it', () => {
        const scoreBall = routesOf(matchRouter)
            .find(({ signature }) => signature === 'POST /:matchId/score-ball');

        expect(scoreBall).toBeDefined();
        expect(isProtected(scoreBall.route)).toBe(true);
    });

    // The allowlist must not rot into a list of routes that no longer exist,
    // which is how an allowlist quietly stops describing reality.
    it.each(Object.keys(ROUTERS))('%s allowlist has no stale entries', (name) => {
        const signatures = routesOf(ROUTERS[name]).map((r) => r.signature);
        const stale = PUBLIC_ROUTES[name].filter((s) => !signatures.includes(s));

        expect(stale).toEqual([]);
    });
});

describe('the public spectator route is read-only', () => {
    // A public route that accepted a write verb would be the whole failure this
    // slice is meant to avoid, so it is asserted rather than assumed.
    it('exposes only GET under /public', () => {
        const publicRoutes = routesOf(matchRouter)
            .filter(({ signature }) => signature.includes('/public/'));

        expect(publicRoutes.map((r) => r.signature)).toEqual(['GET /public/:code']);
    });

    it('leaves every scoring route protected', () => {
        const scoring = routesOf(matchRouter)
            .filter(({ signature }) => !signature.includes('/public/'));

        expect(scoring.length).toBeGreaterThan(0);
        for (const { signature, route } of scoring) {
            expect([signature, isProtected(route)]).toEqual([signature, true]);
        }
    });
});
