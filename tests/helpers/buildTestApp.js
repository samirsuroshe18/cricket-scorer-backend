import express from 'express';
import { localeMiddleware } from '../../src/middlewares/locale.middleware.js';
import { sanitizeMiddleware } from '../../src/middlewares/sanitize.middleware.js';
import { errorHandler } from '../../src/utils/errorHandler.js';
import matchRouter from '../../src/routes/match.routes.js';

/**
 * A minimal Express app, not the real `src/app.js` — that file initializes
 * Firebase Admin at import time and needs a service-account file this suite
 * has no reason to provide. Mirrors the pattern
 * `tests/sanitize.middleware.test.js` already established: mount only what
 * the routes under test actually need. No `io` is set on the app, so any
 * handler's `req.app.get('io')` resolves to `undefined` and its socket
 * emission is skipped — every emit call site already guards on that.
 */
export const buildTestApp = () => {
  const app = express();
  app.use(express.json());
  app.use(sanitizeMiddleware);
  app.use(localeMiddleware);
  app.use('/api/v1/match', matchRouter);
  app.use(errorHandler);
  return app;
};
