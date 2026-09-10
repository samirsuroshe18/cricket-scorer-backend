import express from 'express';
import http from 'http';
import { localeMiddleware } from '../../src/middlewares/locale.middleware.js';
import { sanitizeMiddleware } from '../../src/middlewares/sanitize.middleware.js';
import { errorHandler } from '../../src/utils/errorHandler.js';
import matchRouter from '../../src/routes/match.routes.js';
import translationRouter from '../../src/routes/translation.routes.js';
import playerRouter from '../../src/routes/player.routes.js';
import teamRouter from '../../src/routes/team.routes.js';
import organizationRouter from '../../src/routes/organization.routes.js';
import tournamentRouter from '../../src/routes/tournament.routes.js';
import searchRouter from '../../src/routes/search.routes.js';

/**
 * A minimal Express app, not the real `src/app.js` — that file initializes
 * Firebase Admin at import time and needs a service-account file this suite
 * has no reason to provide. Mirrors the pattern
 * `tests/sanitize.middleware.test.js` already established: mount only what
 * the routes under test actually need. No `io` is set on the app, so any
 * handler's `req.app.get('io')` resolves to `undefined` and its socket
 * emission is skipped — every emit call site already guards on that.
 *
 * `withTranslations`/`withPlayer` are opt-in rather than always-mounted,
 * same reasoning: every existing caller only exercises `matchRouter` and
 * shouldn't pay for (or accidentally rely on) a router it never asked for.
 *
 * Returns an already-`listen()`ing `http.Server`, not the bare Express app
 * function — `supertest` is duck-typed on this at every call site
 * (`request(app)` works identically whether `app` names a listening server
 * or a plain function), so no caller needs to change. The reason: passed a
 * plain function, supertest's own `Test` constructor calls
 * `http.createServer(app).listen(0)` **on every single request**, not once
 * per file — across this suite's full run (99 files, thousands of requests
 * in one `--runInBand` process) that churns through thousands of ephemeral
 * ports in rapid succession, and rarely the OS recycles a port fast enough
 * to collide with lingering client-side connection state, producing a
 * response from one ephemeral server bleeding into a request meant for
 * another (reproduced in isolation: a bare Express+supertest loop with no
 * app code at all threw a stray `301` with an empty body by request #990).
 * One persistent server per file removes the churn entirely — confirmed
 * clean over 3000 iterations in the same isolated repro. `.unref()` so this
 * server (up to ~50 of them accumulate for the process lifetime, one per
 * file, never explicitly closed) doesn't hold the event loop open and hang
 * Jest's own process exit at the end of a run.
 */
export const buildTestApp = ({ withTranslations = false, withPlayer = false, withTeam = false, withOrganization = false, withTournament = false, withSearch = false } = {}) => {
  const app = express();
  app.use(express.json());
  app.use(sanitizeMiddleware);
  app.use(localeMiddleware);
  app.use('/api/v1/match', matchRouter);
  if (withTranslations) {
    app.use('/api/v1/translations', translationRouter);
  }
  if (withPlayer) {
    app.use('/api/v1/player', playerRouter);
  }
  if (withTeam) {
    app.use('/api/v1/team', teamRouter);
  }
  if (withOrganization) {
    app.use('/api/v1/organization', organizationRouter);
  }
  if (withTournament) {
    app.use('/api/v1/tournament', tournamentRouter);
  }
  if (withSearch) {
    app.use('/api/v1/search', searchRouter);
  }
  app.use(errorHandler);

  const server = http.createServer(app);
  server.listen(0);
  server.unref();
  // Exposed so a test that needs to assert on a real `req.app.get('io')`
  // emission (rather than just that it was skipped) can call
  // `server.app.set('io', fakeIo)` before making its request.
  server.app = app;
  return server;
};
