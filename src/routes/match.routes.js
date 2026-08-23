import { Router } from "express";
import { createMatch, scoreBall } from "../controllers/match.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/create').post(verifyJwt, createMatch);
router.route('/:matchId/score-ball').post(verifyJwt, scoreBall);

export default router;
