import { Router } from "express";
import { getTournament, updateTournament, deleteTournament, addTournamentTeam, removeTournamentTeam } from "../controllers/tournament.controller.js";
import { generateFixtures, listFixtures, startFixtureMatch } from "../controllers/fixture.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/:tournamentId')
    .get(verifyJwt, getTournament)
    .patch(verifyJwt, updateTournament)
    .delete(verifyJwt, deleteTournament);
router.route('/:tournamentId/teams').post(verifyJwt, addTournamentTeam);
router.route('/:tournamentId/teams/:teamId').delete(verifyJwt, removeTournamentTeam);
router.route('/:tournamentId/fixtures')
    .post(verifyJwt, generateFixtures)
    .get(verifyJwt, listFixtures);
router.route('/:tournamentId/fixtures/:fixtureId/start-match').post(verifyJwt, startFixtureMatch);

export default router;
