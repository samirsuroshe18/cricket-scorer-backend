import { Router } from "express";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import { bulkSetTranslations, deleteTranslationKey, getAllTranslations, getTranslationByLang, getTranslationsVersion, setTranslationKey } from "../controllers/translation.controller.js";

const router = Router();

// Public routes — read only
router.route('/all').get(getAllTranslations);
router.route('/version').get(getTranslationsVersion);
router.route('/:lang').get(getTranslationByLang);

// Protected routes — write operations
router.route('/bulk-update').post(verifyJwt, bulkSetTranslations);
router.route('/:lang/set-key').post(verifyJwt, setTranslationKey);
router.route('/:lang/key/:key').delete(verifyJwt, deleteTranslationKey);

export default router;