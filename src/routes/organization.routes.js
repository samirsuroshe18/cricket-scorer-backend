import { Router } from "express";
import { createOrganization, listMyOrganizations, getOrganization, addOrganizationMember } from "../controllers/organization.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/')
    .post(verifyJwt, createOrganization)
    .get(verifyJwt, listMyOrganizations);
router.route('/:orgId').get(verifyJwt, getOrganization);
router.route('/:orgId/members').post(verifyJwt, addOrganizationMember);

export default router;
