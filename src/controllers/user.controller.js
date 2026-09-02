import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import mailSender from '../utils/mailSender.js';
import { User } from '../models/user.model.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { uploadOnCloudinary } from '../utils/cloudinary.js';
import { generateSecureToken } from "../utils/token.js";
import { timingSafeEqualString } from "../utils/timingSafeEqual.js";
import { OTP_TYPES } from "../constants/otp.constants.js";
import { SUPPORTED_LANGUAGES } from "../constants/language.constants.js";
import { MIN_PASSWORD_LENGTH } from "../constants/password.constants.js";

// `expectedRefreshToken`, when passed, turns the write into a compare-and-
// swap: refreshAccessToken's caller already verified this exact value was
// current, but that read is stale by the time this function's own write
// runs. Two concurrent refreshes of the same still-valid token would
// otherwise both pass their own check off the same stale read, both mint a
// distinct pair, and only the LAST save win -- silently invalidating the
// OTHER caller's brand-new token, which then fails its own next use with
// REFRESH_TOKEN_EXPIRED_OR_USED, indistinguishable from a stolen token.
// Same shape as applyBowlerSelection's/abandonMatch's own CAS fixes.
// loginUser never passes it: a fresh login has no prior session to race
// against, so its plain, unconditional save is correct as-is.
const generateAccessAndRefreshToken = async (userId, isRemember = false, expectedRefreshToken = undefined) => {
    try {
        const user = await User.findById(userId);

        if (!user) {
            throw new ApiError(404, "USER_NOT_FOUND");
        }

        const refreshExpiry = isRemember ? "30d" : undefined;
        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken(refreshExpiry);

        if (expectedRefreshToken !== undefined) {
            const updated = await User.findOneAndUpdate(
                { _id: userId, refreshToken: expectedRefreshToken },
                { $set: { refreshToken } }
            );
            if (!updated) {
                return null;
            }
        } else {
            user.refreshToken = refreshToken;
            // when we use save() method is used then all the fields are neccesary so to avoid that we have to pass an object with property {validatBeforeSave:false}
            await user.save({ validateBeforeSave: false });
        }

        return { accessToken, refreshToken }
    } catch (error) {
        if (error.isApiError) throw error; // re-throw as-is, don't reclassify
        throw new ApiError(500, "TOKEN_GENERATION_FAILED");
    }
}

const registerUser = catchAsync(async (req, res) => {
    const { fullName, email, password } = req.body;

    if (!fullName?.trim() || !email?.trim() || !password?.trim()) {
        throw new ApiError(400, "ALL_FIELDS_REQUIRED");
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
        throw new ApiError(400, "PASSWORD_TOO_SHORT", {
            params: { min: MIN_PASSWORD_LENGTH }
        });
    }

    const existedUser = await User.findOne({ email });

    // Never reported back to the caller — same reasoning as loginUser's
    // INVALID_CREDENTIALS convergence above. A verified account already owns
    // this email, so there's nothing left for this request to do, but a 409
    // (or any response distinguishable from a fresh registration) would let
    // this endpoint enumerate which emails have accounts. Combined with H7's
    // login fix, this closes the last of this API's account-existence
    // oracles.
    if (existedUser?.isEmailVerified) {
        return res.status(200).json(
            new ApiResponse(200, {}, req.t("REGISTRATION_OTP_SENT"))
        );
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    if (existedUser) {
        // An unverified, still-pending signup for this email — refreshed in
        // place rather than reported as a conflict, so retrying (or a second
        // device) restarts the same registration instead of a dead end.
        existedUser.fullName = fullName;
        existedUser.password = password;
        existedUser.emailOtp = otp;
        existedUser.emailOtpExpiry = otpExpiry;
        existedUser.expireDocAfterSeconds = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await existedUser.save();
    } else {
        const user = await User.create({
            email,
            password,
            fullName,
            emailOtp: otp,
            emailOtpExpiry: otpExpiry,
            expireDocAfterSeconds: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });

        const createdUser = await User.findById(user._id);
        if (!createdUser) {
            throw new ApiError(500, "USER_REGISTRATION_FAILED");
        }
    }

    const mailResponse = await mailSender(email, OTP_TYPES.EMAIL_VERIFICATION, otp);

    if (mailResponse) {
        return res.status(200).json(
            new ApiResponse(200, {}, req.t("REGISTRATION_OTP_SENT"))
        );
    }

    throw new ApiError(500, "EMAIL_SEND_FAILED");
});

// A fixed, valid bcrypt hash with no known corresponding password — compared
// against on a login attempt for an email that doesn't exist, purely so
// `bcrypt.compare` still runs (and costs roughly the same as a real one).
// Skipping it entirely for a nonexistent account would make "no such email"
// measurably faster than "wrong password", a timing side-channel on top of
// the same enumeration `INVALID_CREDENTIALS` below already closes at the
// response-content level.
const DUMMY_PASSWORD_HASH = '$2b$10$prMXiJ8DkadOCQf/ySQP3OF694/IfqrEIO9qILM52WZFTGikoGbO.';

const loginUser = catchAsync(async (req, res) => {
    const { email, password, fcmToken, isRemember } = req.body;

    if (!email?.trim() || !password?.trim()) {
        throw new ApiError(400, "EMAIL_PASSWORD_REQUIRED");
    }

    const user = await User.findOne({ email });

    // The password check runs — and must fail the same way — before
    // anything about the account is revealed, checked, or acted on.
    // Previously, isEmailVerified/accountStatus were checked (and, for an
    // unverified account, a fresh OTP actually sent) before the password
    // was looked at at all: any caller who merely knew a registered email
    // could tell it apart from an unregistered one, tell an unverified
    // account apart from a blocked one, and trigger unlimited OTP emails to
    // it — all with no credential whatsoever, limited only by the generic
    // per-IP authLimiter every other login attempt also shares.
    const isPasswordValid = user
        ? await user.isPasswordCorrect(password)
        : await bcrypt.compare(password, DUMMY_PASSWORD_HASH);

    if (!user || !isPasswordValid) {
        throw new ApiError(401, "INVALID_CREDENTIALS");
    }

    // Reached only once the password is confirmed correct — the caller has
    // proven ownership, so the account's own state is now safe (and useful)
    // to act on and report.
    if (!user.isEmailVerified) {
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        user.emailOtp = otp;
        user.emailOtpExpiry = otpExpiry;
        await user.save({ validateBeforeSave: false });
        await mailSender(email, OTP_TYPES.EMAIL_VERIFICATION, otp);
        throw new ApiError(403, "EMAIL_NOT_VERIFIED");
    }

    if (user.accountStatus !== "active") {
        throw new ApiError(
            403,
            "ACCOUNT_STATUS_ISSUE",
            { params: {status: req.t(`ACCOUNT_STATUS.${user.accountStatus}`)} }
        );
    }

    const { accessToken, refreshToken } = await generateAccessAndRefreshToken(
        user._id,
        isRemember
    );

    // Only update fcmToken if provided
    if (fcmToken?.trim()) {
        user.fcmToken = fcmToken;
    }

    user.refreshToken = refreshToken;
    user.lastLoginAt = new Date();
    await user.save({ validateBeforeSave: false });

    // Strip sensitive fields before sending — never trust select() alone in responses
    const loggedInUser = user.toObject();
    delete loggedInUser.password;
    delete loggedInUser.refreshToken;
    delete loggedInUser.emailOtp;
    delete loggedInUser.emailOtpExpiry;

    return res.status(200).json(
        new ApiResponse(
            200,
            { loggedInUser, accessToken, refreshToken },
            req.t("LOGIN_SUCCESS")
        )
    );
});

const logoutUser = catchAsync(async (req, res) => {
    const refreshToken = req.header("Authorization")?.replace("Bearer ", "");

    if (!refreshToken) {
        throw new ApiError(400, "REFRESH_TOKEN_REQUIRED");
    }

    await User.findOneAndUpdate(
        { refreshToken: refreshToken },
        { $unset: { refreshToken: 1, fcmToken: 1 } },
        { returnDocument: 'after' }
    );

    return res.status(200).json(new ApiResponse(200, {}, req.t("LOGOUT_SUCCESS")));
});

const getCurrentUser = catchAsync(async (req, res) => {
    return res.status(200).json(
        new ApiResponse(200, req.user, req.t("CURRENT_USER_FETCHED"))
    );
});

const refreshAccessToken = catchAsync(async (req, res) => {
    const incomingRefreshToken = req.header("x-refresh-token");

    if (!incomingRefreshToken || incomingRefreshToken === "null" || incomingRefreshToken === "undefined") {
        throw new ApiError(401, "UNAUTHORIZED_REQUEST");
    }

    let decodedToken;
    try {
        // Pinned for the same reason as verifyJwt's identical comment: every
        // refresh token this app issues is signed HS256 (see
        // User.generateRefreshToken), so that's the only algorithm a valid
        // one can ever carry.
        decodedToken = jwt.verify(incomingRefreshToken, process.env.REFRESH_TOKEN_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            throw new ApiError(401, "REFRESH_TOKEN_EXPIRED");
        }
        // 401, matching the no-user-found INVALID_REFRESH_TOKEN branch right
        // below and docs/api.md's uniformly-401 row for it — same reasoning
        // as verifyJwt's identical fix.
        throw new ApiError(401, "INVALID_REFRESH_TOKEN");
    }

    const user = await User.findById(decodedToken?._id);
    if (!user || user.accountStatus !== "active") {
        throw new ApiError(401, "INVALID_REFRESH_TOKEN");
    }

    if (incomingRefreshToken !== user.refreshToken) {
        throw new ApiError(401, "REFRESH_TOKEN_EXPIRED_OR_USED");
    }

    const result = await generateAccessAndRefreshToken(user._id, false, incomingRefreshToken);

    // A concurrent refresh of this same token already won the race and
    // rotated it out from under this request — the check above only saw
    // this token as current as of its own stale read.
    if (!result) {
        throw new ApiError(401, "REFRESH_TOKEN_EXPIRED_OR_USED");
    }

    const { accessToken, refreshToken } = result;

    return res.status(200).json(
        new ApiResponse(200, { accessToken, refreshToken }, req.t("ACCESS_TOKEN_REFRESHED"))
    );
});

const updateFCMToken = catchAsync(async (req, res) => {
    const { fcmToken } = req.body;
    if (!fcmToken) {
        throw new ApiError(400, "FCM_TOKEN_REQUIRED");
    }
    const user = req.user;
    user.fcmToken = fcmToken;
    const isUpdate = await user.save({ validateBeforeSave: false });
    if (!isUpdate) {
        throw new ApiError(500, "INTERNAL_SERVER_ERROR");
    }
    return res.status(200).json(
        new ApiResponse(200, {}, req.t("FCM_TOKEN_UPDATED"))
    );
});

const changeCurrentPassword = catchAsync(async (req, res) => {
    const { oldPassword, newPassword } = req.body;

    if (!oldPassword?.trim() || !newPassword?.trim()) {
        throw new ApiError(400, "ALL_FIELDS_REQUIRED");
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
        throw new ApiError(400, "PASSWORD_TOO_SHORT", {
            params: { min: MIN_PASSWORD_LENGTH }
        });
    }

    const user = await User.findById(req.user._id);
    const isPasswordCorrect = await user.isPasswordCorrect(oldPassword);

    if (!isPasswordCorrect) {
        throw new ApiError(400, "INCORRECT_PASSWORD");
    }

    user.password = newPassword;
    user.passwordChangedAt = new Date();
    await user.save({ validateBeforeSave: false });

    return res.status(200).json(new ApiResponse(200, {}, req.t("PASSWORD_CHANGED")));
});

const forgotPassword = catchAsync(async (req, res) => {
    const { email } = req.body;

    if (!email) {
        throw new ApiError(400, "EMAIL_REQUIRED");
    }

    const user = await User.findOne({ email, isEmailVerified: true });

    // Never reported back to the caller — same convergence as loginUser's
    // INVALID_CREDENTIALS and registerUser's REGISTRATION_OTP_SENT. No
    // verified account for this email means there is nothing to do, but a
    // distinguishable response here would let this endpoint enumerate which
    // emails have accounts, with no credential required at all.
    if (!user) {
        return res.status(200).json(
            new ApiResponse(200, {}, req.t("FORGOT_PASSWORD_OTP_SENT"))
        );
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    user.emailOtp = otp;
    user.emailOtpExpiry = Date.now() + 5 * 60 * 1000;
    await user.save();

    const mailResponse = await mailSender(email, "FORGOT_PASSWORD", otp);

    if (mailResponse) {
        return res.status(200).json(
            new ApiResponse(200, {}, req.t("FORGOT_PASSWORD_OTP_SENT"))
        );
    }

    throw new ApiError(500, "EMAIL_SEND_FAILED");
});

const verifyOtp = catchAsync(async (req, res) => {
    const { type } = req.body;

    if (!Object.values(OTP_TYPES).includes(type)) {
        throw new ApiError(400, "INVALID_OTP_TYPE");
    }

    switch (type) {
        case OTP_TYPES.EMAIL_VERIFICATION:
            return await verifyEmail(req, res);
        case OTP_TYPES.FORGOT_PASSWORD:
            return await verifyForgotPasswordOtp(req, res);
        default:
            throw new ApiError(400, "INVALID_OTP_TYPE");
    }
});

const verifyEmail = async (req, res) => {
    const { email, emailOtp } = req.body;

    if (!email || !emailOtp) {
        throw new ApiError(400, "EMAIL_OTP_REQUIRED");
    }

    const user = await User.findOne({ email, isEmailVerified: false }).select(
        "+emailOtp +emailOtpExpiry"
    );

    if (!user) {
        throw new ApiError(404, "USER_NOT_FOUND_OR_VERIFIED");
    }

    if (user.emailOtpExpiry < Date.now()) {
        user.emailOtp = null;
        user.emailOtpExpiry = null;
        await user.save();
        throw new ApiError(400, "OTP_EXPIRED");
    }

    if (!timingSafeEqualString(user.emailOtp, emailOtp)) {
        throw new ApiError(400, "INVALID_OTP");
    }

    user.isEmailVerified = true;
    user.emailOtp = null;
    user.emailOtpExpiry = null;
    user.expireDocAfterSeconds = undefined;
    await user.save();

    return res.status(200).json(
        new ApiResponse(200, {}, req.t("EMAIL_VERIFIED"))
    );
};

const verifyForgotPasswordOtp = async (req, res) => {
    const { email, emailOtp } = req.body;

    if (!email || !emailOtp) {
        throw new ApiError(400, "EMAIL_OTP_REQUIRED");
    }

    const user = await User.findOne({ email, isEmailVerified: true }).select(
        "+emailOtp +emailOtpExpiry"
    );

    if (!user) {
        throw new ApiError(404, "USER_NOT_FOUND");
    }

    if (user.emailOtpExpiry < Date.now()) {
        user.emailOtp = null;
        user.emailOtpExpiry = null;
        await user.save();
        throw new ApiError(400, "OTP_EXPIRED");
    }

    if (!timingSafeEqualString(user.emailOtp, emailOtp)) {
        throw new ApiError(400, "INVALID_OTP");
    }

    const { token, hashedToken } = generateSecureToken();
    const otpVerifyTokenExpiry = Date.now() + 5 * 60 * 1000;

    user.otpVerifyToken = hashedToken;
    user.otpVerifyTokenExpiry = otpVerifyTokenExpiry;
    user.emailOtp = null;
    user.emailOtpExpiry = null;
    await user.save({ validateBeforeSave: false });

    return res.status(200).json(
        new ApiResponse(200, { resetToken: token }, req.t("OTP_VERIFIED"))
    );
};

const setPassword = catchAsync(async (req, res) => {
    const { email, newPassword, confirmPassword, resetToken } = req.body;

    if (!email || !newPassword || !confirmPassword || !resetToken?.trim()) {
        throw new ApiError(400, "PASSWORD_RESET_FIELDS_REQUIRED");
    }

    if (newPassword !== confirmPassword) {
        throw new ApiError(400, "PASSWORDS_DO_NOT_MATCH");
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
        throw new ApiError(400, "PASSWORD_TOO_SHORT", {
            params: { min: MIN_PASSWORD_LENGTH }
        });
    }

    const user = await User.findOne({ email, isEmailVerified: true }).select(
        "+emailOtp +emailOtpExpiry +otpVerifyToken +otpVerifyTokenExpiry"
    );
    if (!user) {
        throw new ApiError(404, "INVALID_EMAIL_OR_NOT_VERIFIED");
    }

    if (user.emailOtp || user.emailOtpExpiry) {
        throw new ApiError(400, "OTP_VERIFICATION_REQUIRED");
    }

    const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

    // The token must belong to THIS user — never validate it against the collection
    // at large, or any valid token could reset any account's password.
    if (
        !user.otpVerifyToken ||
        !timingSafeEqualString(user.otpVerifyToken, hashedToken) ||
        !user.otpVerifyTokenExpiry ||
        user.otpVerifyTokenExpiry.getTime() <= Date.now()
    ) {
        throw new ApiError(400, "RESET_TOKEN_INVALID");
    }

    user.password = newPassword;
    user.otpVerifyToken = undefined;
    user.otpVerifyTokenExpiry = undefined;
    user.passwordChangedAt = new Date();
    // Reset invalidates any existing session (single-session model).
    user.refreshToken = undefined;
    await user.save({ validateBeforeSave: false });

    return res.status(200).json(new ApiResponse(200, {}, req.t("PASSWORD_RESET_SUCCESS")));
});

const updateProfile = catchAsync(async (req, res) => {
    const { userName, bio } = req.body;
    let imageUrl = null;
    const imagePath = req.file?.path || null;

    if (typeof userName !== "string" || !userName.trim()) {
        throw new ApiError(400, "FULL_NAME_REQUIRED");
    }

    if (imagePath) {
        const uploadResult = await uploadOnCloudinary(imagePath);
        imageUrl = uploadResult?.secure_url;
    }

    const updateData = { userName: userName.trim(), profileCompleted: true };
    if (typeof bio === "string" && bio.trim()) updateData.bio = bio.trim();
    if (imageUrl) updateData.photoUrl = imageUrl;

    const updatedUser = await User.findByIdAndUpdate(
        req.user._id,
        { $set: updateData },
        { returnDocument: 'after', runValidators: true }
    ).select("-password -refreshToken -emailOtp -emailOtpExpiry");

    return res.status(200).json(
        new ApiResponse(200, updatedUser, req.t("PROFILE_UPDATED"))
    );
});

const resendOtp = catchAsync(async (req, res) => {
    const { email, type } = req.body;

    if (!email?.trim()) {
        throw new ApiError(400, "EMAIL_REQUIRED");
    }

    if (!Object.values(OTP_TYPES).includes(type)) {
        throw new ApiError(400, "INVALID_OTP_TYPE");
    }

    let query;
    switch (type) {
        case OTP_TYPES.EMAIL_VERIFICATION:
            query = { email, isEmailVerified: false };
            break;
        case OTP_TYPES.FORGOT_PASSWORD:
            query = { email, isEmailVerified: true };
            break;
        default:
            throw new ApiError(400, "INVALID_OTP_TYPE");
    }

    const user = await User.findOne(query).select("+emailOtp +emailOtpExpiry");

    // Never reported back — same convergence as forgotPassword/loginUser/
    // registerUser. No account matching this email+type means there is
    // nothing to resend, but a distinguishable response would let this
    // endpoint enumerate account existence (and, via `type`, whether that
    // account is verified) with no credential at all.
    if (!user) {
        return res.status(200).json(new ApiResponse(200, {}, req.t("OTP_RESENT")));
    }

    const THIRTY_SECONDS = 30 * 1000;
    const OTP_VALIDITY = 10 * 60 * 1000;
    if (user.emailOtpExpiry) {
        const otpSentAt = user.emailOtpExpiry.getTime() - OTP_VALIDITY;
        if (Date.now() - otpSentAt < THIRTY_SECONDS) {
            throw new ApiError(429, "OTP_RATE_LIMITED");
        }
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    const otpExpiry = new Date(Date.now() + OTP_VALIDITY);

    user.emailOtp = otp;
    user.emailOtpExpiry = otpExpiry;

    if (type === OTP_TYPES.EMAIL_VERIFICATION) {
        user.expireDocAfterSeconds = new Date(Date.now() + 24 * 60 * 60 * 1000);
    }

    await user.save({ validateBeforeSave: false });

    const mailResponse = await mailSender(email, type, otp);

    if (mailResponse) {
        return res.status(200).json(new ApiResponse(200, {}, req.t("OTP_RESENT")));
    }

    throw new ApiError(500, "OTP_SEND_FAILED");
});

const getUserLanguage = catchAsync(async (req, res) => {
    return res.status(200).json(
        new ApiResponse(200, { language: req.user.language }, req.t("LANGUAGE_FETCHED"))
    );
});

const updateUserLanguage = catchAsync(async (req, res) => {
    const { language } = req.body;

    if (!language?.trim()) {
        throw new ApiError(400, "LANGUAGE_REQUIRED");
    }

    if (!Object.values(SUPPORTED_LANGUAGES).includes(language.toLowerCase())) {
        throw new ApiError(400, "UNSUPPORTED_LANGUAGE", {
            params: { languages: Object.values(SUPPORTED_LANGUAGES).join(', ') }
        });
    }

    const user = await User.findByIdAndUpdate(
        req.user._id,
        { language: language.toLowerCase().trim() },
        { returnDocument: 'after' }
    ).select('language');

    if (!user) {
        throw new ApiError(404, "USER_NOT_FOUND");
    }

    return res.status(200).json(
        new ApiResponse(200, { language: user.language }, req.t("LANGUAGE_UPDATED"))
    );
});

export {
    registerUser,
    loginUser,
    logoutUser,
    getCurrentUser,
    refreshAccessToken,
    updateFCMToken,
    changeCurrentPassword,
    forgotPassword,
    verifyOtp,
    setPassword,
    updateProfile,
    resendOtp,
    getUserLanguage, 
    updateUserLanguage,
};
