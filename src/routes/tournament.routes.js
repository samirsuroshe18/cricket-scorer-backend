import { Router } from "express";
import { getTournament, updateTournament, deleteTournament, addTournamentTeam } from "../controllers/tournament.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/:tournamentId')
    .get(verifyJwt, getTournament)
    .patch(verifyJwt, updateTournament)
    .delete(verifyJwt, deleteTournament);
router.route('/:tournamentId/teams').post(verifyJwt, addTournamentTeam);

export default router;
