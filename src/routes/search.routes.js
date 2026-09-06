import { Router } from "express";
import { search } from "../controllers/search.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";

const router = Router();

router.route('/').get(verifyJwt, search);

export default router;
