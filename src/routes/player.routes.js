import { Router } from "express";
import { getCareerStats, updatePlayer } from "../controllers/player.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/:playerId').patch(verifyJwt, updatePlayer);
router.route('/:playerId/career-stats').get(verifyJwt, getCareerStats);

export default router;
