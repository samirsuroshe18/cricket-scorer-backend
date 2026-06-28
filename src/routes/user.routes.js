import { Router } from "express";
import { changeCurrentPassword, forgotPassword, getCurrentUser, getUserLanguage, loginUser, logoutUser, refreshAccessToken, registerUser, resendOtp, setPassword, updateFCMToken, updateProfile, updateUserLanguage, verifyOtp } from "../controllers/user.controller.js";
import { verifyJwt } from "../middlewares/auth.middleware.js";
import { upload } from "../middlewares/multer.middleware.js";

const router = Router();

router.route('/register').post(registerUser);
router.route('/login').post(loginUser);
router.route('/forgot-password').post(forgotPassword);
router.route('/logout').get(logoutUser);
router.route('/refresh-token').get(refreshAccessToken);
router.route('/verify-otp').post(verifyOtp);
router.route('/resend-otp').post(resendOtp);
router.route('/set-password').post(setPassword);
router.route('/language').get(verifyJwt, getUserLanguage);
router.route('/language').put(verifyJwt, updateUserLanguage);

//Secure routes
router.route('/update-fcm').post(verifyJwt, updateFCMToken);
router.route('/get-current-user').get(verifyJwt, getCurrentUser);
router.route('/change-password').post(verifyJwt, changeCurrentPassword);
router.route('/update-profile').post(verifyJwt, upload.single('file'), updateProfile);

export default router;