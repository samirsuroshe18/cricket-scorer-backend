import { Router } from "express";
import { createOrganization, listMyOrganizations, getOrganization } from "../controllers/organization.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/')
    .post(verifyJwt, createOrganization)
    .get(verifyJwt, listMyOrganizations);
router.route('/:orgId').get(verifyJwt, getOrganization);

export default router;
