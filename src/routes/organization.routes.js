import { Router } from "express";
import { createOrganization } from "../controllers/organization.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/').post(verifyJwt, createOrganization);

export default router;
