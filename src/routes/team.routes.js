import { Router } from "express";
import { getTeamProfile, getTeamMatches, listMyTeams, createTeam, updateTeam, deleteTeam, updateTeamOrganization, updateTeamLogo } from "../controllers/team.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import { upload } from "../middlewares/multer.middleware.js";

const router = Router();

router.route('/').post(verifyJwt, createTeam);
router.route('/').get(verifyJwt, listMyTeams);
router.route('/:teamId')
    .get(verifyJwt, getTeamProfile)
    .patch(verifyJwt, updateTeam)
    .delete(verifyJwt, deleteTeam);
router.route('/:teamId/matches').get(verifyJwt, getTeamMatches);
router.route('/:teamId/organization').patch(verifyJwt, updateTeamOrganization);
router.route('/:teamId/logo').post(verifyJwt, upload.single('file'), updateTeamLogo);

export default router;
