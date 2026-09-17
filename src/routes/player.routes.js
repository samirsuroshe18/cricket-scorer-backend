import { Router } from "express";
import { getCareerStats, updatePlayer, claimPlayer, unclaimPlayer } from "../controllers/player.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/:playerId').patch(verifyJwt, updatePlayer);
router.route('/:playerId/career-stats').get(verifyJwt, getCareerStats);
router.route('/:playerId/claim').post(verifyJwt, claimPlayer);
router.route('/:playerId/unclaim').post(verifyJwt, unclaimPlayer);

export default router;
