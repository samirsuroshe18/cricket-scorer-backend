import { Router } from "express";
import { createMatch, startInnings, selectBowler, scoreBall } from "../controllers/match.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/create').post(verifyJwt, createMatch);
router.route('/:matchId/start-innings').post(verifyJwt, startInnings);
router.route('/:matchId/select-bowler').post(verifyJwt, selectBowler);
router.route('/:matchId/score-ball').post(verifyJwt, scoreBall);

export default router;
