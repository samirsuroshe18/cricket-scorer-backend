import { Router } from "express";
import { getTournament } from "../controllers/tournament.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/:tournamentId').get(verifyJwt, getTournament);

export default router;
