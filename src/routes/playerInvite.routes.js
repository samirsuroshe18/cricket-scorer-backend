import { Router } from "express";
import { getPlayerInvite, acceptPlayerInvite, declinePlayerInvite } from "../controllers/playerInvite.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/:inviteId').get(verifyJwt, getPlayerInvite);
router.route('/:inviteId/accept').post(verifyJwt, acceptPlayerInvite);
router.route('/:inviteId/decline').post(verifyJwt, declinePlayerInvite);

export default router;
