import { Router } from "express";
import { getTeamProfile, getTeamMatches, listMyTeams } from "../controllers/team.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/').get(verifyJwt, listMyTeams);
router.route('/:teamId').get(verifyJwt, getTeamProfile);
router.route('/:teamId/matches').get(verifyJwt, getTeamMatches);

export default router;
