import { Router } from "express";
import { changeCurrentPassword, forgotPassword, getCurrentUser, getUserLanguage, loginUser, logoutUser, refreshAccessToken, registerUser, resendOtp, setPassword, updateFCMToken, updateProfile, updateUserLanguage, verifyOtp } from "../controllers/user.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import { upload } from "../middlewares/multer.middleware.js";
import { authLimiter } from "../middlewares/rateLimit.middleware.js";

const router = Router();

router.route('/register').post(authLimiter, registerUser);
router.route('/login').post(authLimiter, loginUser);
router.route('/forgot-password').post(authLimiter, forgotPassword);
router.route('/logout').get(logoutUser);
router.route('/refresh-token').get(refreshAccessToken);
router.route('/verify-otp').post(authLimiter, verifyOtp);
router.route('/resend-otp').post(authLimiter, resendOtp);
router.route('/set-password').post(authLimiter, setPassword);
router.route('/language').get(verifyJwt, getUserLanguage);
router.route('/language').put(verifyJwt, updateUserLanguage);

//Secure routes
router.route('/update-fcm').post(verifyJwt, updateFCMToken);
router.route('/get-current-user').get(verifyJwt, getCurrentUser);
router.route('/change-password').post(verifyJwt, changeCurrentPassword);
router.route('/update-profile').post(verifyJwt, upload.single('file'), updateProfile);

export default router;