import express from 'express';
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
  return app;
};
