import { Router } from "express";
import { getTournament, updateTournament } from "../controllers/tournament.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/:tournamentId')
    .get(verifyJwt, getTournament)
    .patch(verifyJwt, updateTournament);

export default router;
