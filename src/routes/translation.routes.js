import { Router } from "express";
import { verifyJwt, verifyAdmin } from "../middlewares/auth.middleware.js";
import { bulkSetTranslations, deleteTranslationKey, getAllTranslations, getTranslationByLang, getTranslationsVersion, setTranslationKey } from "../controllers/translation.controller.js";

const router = Router();

// Public routes — read only
router.route('/all').get(getAllTranslations);
router.route('/version').get(getTranslationsVersion);
router.route('/:lang').get(getTranslationByLang);

// Admin-only routes — write operations. `verifyJwt` alone used to guard
// these, which meant any self-registered account could rewrite or delete
// the i18n strings every client renders; `verifyAdmin` (ADMIN_EMAILS
// allowlist) is the actual authorization check.
router.route('/bulk-update').post(verifyJwt, verifyAdmin, bulkSetTranslations);
router.route('/:lang/set-key').post(verifyJwt, verifyAdmin, setTranslationKey);
router.route('/:lang/key/:key').delete(verifyJwt, verifyAdmin, deleteTranslationKey);

export default router;