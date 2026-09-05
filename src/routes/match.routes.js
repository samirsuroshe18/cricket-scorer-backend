import { Router } from "express";
import { createMatch, startInnings, selectBowler, scoreBall, undoBall, syncMatch, getMatchScorecard, getPublicMatch, abandonMatch, deleteMatch, getMatchHistory, assignScorer, getScorerCandidates } from "../controllers/match.controller.js";
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
// A literal `/history`, same reasoning as `/public/:code` above: it cannot
// collide with a `:matchId` param route at the same single-segment depth as
// long as no bare `GET /:matchId` is ever added at this level.
router.route('/history').get(verifyJwt, getMatchHistory);
router.route('/:matchId/start-innings').post(verifyJwt, startInnings);
router.route('/:matchId/select-bowler').post(verifyJwt, selectBowler);
router.route('/:matchId/score-ball').post(verifyJwt, scoreBall);
router.route('/:matchId/undo-ball').post(verifyJwt, undoBall);
router.route('/:matchId/sync').post(verifyJwt, syncMatch);
router.route('/:matchId/scorecard').get(verifyJwt, getMatchScorecard);
router.route('/:matchId/scorer').patch(verifyJwt, assignScorer);
router.route('/:matchId/scorer-candidates').get(verifyJwt, getScorerCandidates);
router.route('/:matchId/abandon').post(verifyJwt, abandonMatch);
router.route('/:matchId').delete(verifyJwt, deleteMatch);

export default router;
