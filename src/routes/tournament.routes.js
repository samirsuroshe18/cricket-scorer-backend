import { Router } from "express";
import { getTournament, updateTournament, deleteTournament } from "../controllers/tournament.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/:tournamentId')
    .get(verifyJwt, getTournament)
    .patch(verifyJwt, updateTournament)
    .delete(verifyJwt, deleteTournament);

export default router;
