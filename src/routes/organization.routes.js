import { Router } from "express";
import { createOrganization, listMyOrganizations, getOrganization, addOrganizationMember, removeOrganizationMember } from "../controllers/organization.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/')
    .post(verifyJwt, createOrganization)
    .get(verifyJwt, listMyOrganizations);
router.route('/:orgId').get(verifyJwt, getOrganization);
router.route('/:orgId/members').post(verifyJwt, addOrganizationMember);
router.route('/:orgId/members/:userId').delete(verifyJwt, removeOrganizationMember);

export default router;
