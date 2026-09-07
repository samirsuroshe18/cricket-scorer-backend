import { Router } from "express";
import { getTournament, updateTournament, deleteTournament, addTournamentTeam, removeTournamentTeam } from "../controllers/tournament.controller.js";
import { generateFixtures, listFixtures, startFixtureMatch, resolveFixture } from "../controllers/fixture.controller.js";
import { getStandings } from "../controllers/standings.controller.js";
import { getLeaderboards } from "../controllers/leaderboard.controller.js";
import { registerPoolPlayer, listPoolEntries } from "../controllers/playerPool.controller.js";
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
router.route('/:tournamentId/fixtures/:fixtureId')
    .patch(verifyJwt, resolveFixture);
router.route('/:tournamentId/fixtures/:fixtureId/start-match').post(verifyJwt, startFixtureMatch);
router.route('/:tournamentId/standings').get(verifyJwt, getStandings);
router.route('/:tournamentId/leaderboards').get(verifyJwt, getLeaderboards);
router.route('/:tournamentId/pool')
    .post(verifyJwt, registerPoolPlayer)
    .get(verifyJwt, listPoolEntries);

export default router;
