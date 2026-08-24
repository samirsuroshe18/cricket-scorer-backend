import { Router } from "express";
import { createMatch, startInnings, selectBowler, scoreBall, undoBall, getPublicMatch } from "../controllers/match.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

// --- Public: no verifyJwt, read-only ----------------------------------------
// Mounted under the literal `/public/` prefix rather than as `GET /:code` so it
// cannot share a namespace with the `/:matchId/...` action routes below and
// cannot shadow a sibling GET declared later. The prefix also makes "this one is
// unauthenticated" readable in the URL, not just here.
//
// This comment is documentation, not enforcement. tests/routes.auth.test.js is
// the enforcement: it fails unless every route either carries verifyJwt or is
// named in its PUBLIC_ROUTES allowlist.
router.route('/public/:code').get(getPublicMatch);

// --- Scoring: verifyJwt, plus a createdBy ownership check in each controller -
router.route('/create').post(verifyJwt, createMatch);
router.route('/:matchId/start-innings').post(verifyJwt, startInnings);
router.route('/:matchId/select-bowler').post(verifyJwt, selectBowler);
router.route('/:matchId/score-ball').post(verifyJwt, scoreBall);
router.route('/:matchId/undo-ball').post(verifyJwt, undoBall);

export default router;
