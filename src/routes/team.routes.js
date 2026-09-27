import { Router } from "express";
import { listPlayingForTeams, getTeamPlayerView, getTeamPlayerMatches, addTeamPlayer, inviteTeamPlayer, updateTeamPlayer, getTeamProfile, getTeamMatches, listMyTeams, createTeam, updateTeam, deleteTeam, updateTeamOrganization, updateTeamLogo } from "../controllers/team.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import { upload } from "../middlewares/multer.middleware.js";

const router = Router();

router.route('/').post(verifyJwt, createTeam);
router.route('/').get(verifyJwt, listMyTeams);
router.route('/playing-for').get(verifyJwt, listPlayingForTeams);
router.route('/:teamId')
    .get(verifyJwt, getTeamProfile)
    .patch(verifyJwt, updateTeam)
    .delete(verifyJwt, deleteTeam);
router.route('/:teamId/player-view').get(verifyJwt, getTeamPlayerView);
router.route('/:teamId/player-view/matches').get(verifyJwt, getTeamPlayerMatches);
router.route('/:teamId/matches').get(verifyJwt, getTeamMatches);
router.route('/:teamId/players').post(verifyJwt, addTeamPlayer);
router.route('/:teamId/invites').post(verifyJwt, inviteTeamPlayer);
router.route('/:teamId/players/:playerId').patch(verifyJwt, updateTeamPlayer);
router.route('/:teamId/organization').patch(verifyJwt, updateTeamOrganization);
router.route('/:teamId/logo').post(verifyJwt, upload.single('file'), updateTeamLogo);

export default router;
