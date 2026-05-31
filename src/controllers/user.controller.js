import dotenv from "dotenv";
dotenv.config()
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import mailSender from '../utils/mailSender.js';
import { User } from '../models/user.model.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { uploadOnCloudinary } from '../utils/cloudinary.js';

const generateAccessAndRefreshToken = async (userId, isRemember = false) => {
    try {
        const user = await User.findById(userId);

        if (!user) {
            throw new ApiError(404, "User not found");
        }

        const refreshExpiry = isRemember ? "30d" : undefined;
        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken(refreshExpiry);

        user.refreshToken = refreshToken;

        // when we use save() method is used then all the fields are neccesary so to avoid that we have to pass an object with property {validatBeforeSave:false}
        await user.save({ validateBeforeSave: false });

        return { accessToken, refreshToken }
    } catch (error) {
        throw new ApiError(500, error.message || "Something went wrong while generating tokens");
    }
}

const registerUser = catchAsync(async (req, res) => {
    const { userName, email, password } = req.body;
    
    if (!userName?.trim() || !email?.trim() || !password?.trim()) {
        throw new ApiError(400, "All fields are required");
    }
    
    const existedUser = await User.findOne({ email });
    
    if (existedUser) {
        throw new ApiError(409, "User with same email already exists");
    }
    
    // Generate OTP before creating user
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const user = await User.create({
        email,
        password,
        userName,
        emailOtp: otp,
        emailOtpExpiry: otpExpiry,
        expireDocAfterSeconds: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const createdUser = await User.findById(user._id);

    if (!createdUser) {
        throw new ApiError(500, "Something went wrong while registering the user");
    }

    // Pass OTP to mailSender
    const mailResponse = await mailSender(email, "VERIFY_EMAIL", otp);

    if (mailResponse) {
        return res.status(200).json(
            new ApiResponse(
                200,
                {},
                "An email sent to your account, please verify within 10 minutes"
            )
        );
    }

    throw new ApiError(500, "Something went wrong!! An email couldn't be sent to your account");
});

const loginUser = catchAsync(async (req, res) => {
    const { email, password, fcmToken, isRemember } = req.body;

    if (!email?.trim() || !password?.trim()) {
        throw new ApiError(400, "Email and password are required");
    }

    const user = await User.findOne({ email });

    if (!user) {
        throw new ApiError(401, "Invalid credentials");
    }

    if (!user.isEmailVerified) {
        throw new ApiError(403, "Please verify your email before logging in");
    }

    if (user.accountStatus !== "active") {
        throw new ApiError(403, `Your account has been ${user.accountStatus}`);
    }

    const isPasswordValid = await user.isPasswordCorrect(password);

    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid credentials");
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
            "User logged in successfully"
        )
    );
});

const logoutUser = catchAsync(async (req, res) => {
    const refreshToken = req.header("Authorization")?.replace("Bearer ", "");

    if (!refreshToken) {
        throw new ApiError(
            400,
            "Refresh token required"
        );
    }

    await User.findOneAndUpdate(
        { refreshToken: refreshToken },
        {
            $unset: {
                refreshToken: 1,
                fcmToken: 1,
            },
        },
        { new: true }
    );

    return res.status(200).json(new ApiResponse(200, {}, "User logged out successfully"));
});

const getCurrentUser = catchAsync(async (req, res) => {
    return res.status(200).json(
        new ApiResponse(200, req.user, "Current user fetched successfully")
    );
});

const refreshAccessToken = catchAsync(async (req, res) => {
    const incomingRefreshToken = req.header("x-refresh-token");

    if (!incomingRefreshToken || incomingRefreshToken === "null" || incomingRefreshToken === "undefined") {
        throw new ApiError(401, "Unauthorized request");
    }

    let decodedToken;
    try {
        decodedToken = jwt.verify(incomingRefreshToken, process.env.REFRESH_TOKEN_SECRET);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            throw new ApiError(401, "Refresh token is expired");
        }
        throw new ApiError(403, "Invalid refresh token");
    }

    const user = await User.findById(decodedToken?._id);
    if (!user || user.accountStatus !== "active") {
        throw new ApiError(401, "Invalid refresh token");
    }

    if (incomingRefreshToken !== user.refreshToken) {
        throw new ApiError(401, "Refresh token is expired or used");
    }

    const { accessToken, refreshToken } = await generateAccessAndRefreshToken(user._id);

    return res.status(200).json(new ApiResponse(200, { accessToken, refreshToken }, "Access token refreshed"));
});

const updateFCMToken = catchAsync(async (req, res) => {
    const { fcmToken } = req.body;
    if (!fcmToken) {
        throw new ApiError(400, "FCM Token is required");
    }
    const user = req.user;
    user.fcmToken = fcmToken;
    const isUpdate = await user.save({ validateBeforeSave: false });
    if (!isUpdate) {
        throw new ApiError(500, "Something went wrong");
    }
    return res.status(200).json(
        new ApiResponse(200, {}, "FCM Token updated successfully")
    );
});

const changeCurrentPassword = catchAsync(async (req, res) => {
    const { oldPassword, newPassword } = req.body;

    const user = await User.findById(req.user._id);
    const isPasswordCorrect = await user.isPasswordCorrect(oldPassword);

    if (!isPasswordCorrect) {
        throw new ApiError(400, "Password is incorrect");
    }

    user.password = newPassword;
    await user.save({ validateBeforeSave: false });

    return res.status(200).json(new ApiResponse(200, {}, "Password changed successfully"));
});

const forgotPassword = catchAsync(async (req, res) => {
    const { email } = req.body;

    if (!email) {
        throw new ApiError(400, "Email required");
    }

    const user = await User.findOne({ email, isEmailVerified: true });

    if (!user) {
        throw new ApiError(404, "Invalid email or email is not verified");
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    user.emailOtp = otp;
    user.emailOtpExpiry = Date.now() + 5 * 60 * 1000; // 5 minutes
    await user.save();

    const mailResponse = await mailSender(email, "FORGOT_PASSWORD", otp);

    if (mailResponse) {
        return res.status(200).json(
            new ApiResponse(200, {}, "An email sent to your account please reset your password in 5 minutes")
        );
    }

    throw new ApiError(500, "Something went wrong!! An email couldn't sent to your account");
});

const verifyOtp = catchAsync(async (req, res) => {
    const { email, emailOtp } = req.body;

    if (!email || !emailOtp) {
        throw new ApiError(400, "Email and OTP are required");
    }

    // Fixed: was checking isEmailVerified: true — user is NOT verified yet at this point
    // Fixed: emailOtp/emailOtpExpiry have select:false, must explicitly select them
    const user = await User.findOne({ email, isEmailVerified: false }).select(
        "+emailOtp +emailOtpExpiry"
    );

    if (!user) {
        throw new ApiError(404, "User not found or already verified");
    }

    // Fixed: OTP expiry should be checked before comparing OTP
    if (user.emailOtpExpiry < Date.now()) {
        user.emailOtp = null;
        user.emailOtpExpiry = null;
        await user.save();
        throw new ApiError(400, "OTP has expired, please request a new one");
    }

    if (user.emailOtp !== emailOtp) {
        throw new ApiError(400, "Invalid OTP");
    }

    user.isEmailVerified = true; // Fixed: was never being set to true
    user.emailOtp = null;
    user.emailOtpExpiry = null;
    user.expireDocAfterSeconds = undefined; // Remove TTL so doc is not deleted
    await user.save();

    return res.status(200).json(
        new ApiResponse(200, {}, "Email verified successfully")
    );
});

const setPassword = catchAsync(async (req, res) => {
    const { email, newPassword, confirmPassword } = req.body;

    if (!email || !newPassword || !confirmPassword) {
        throw new ApiError(400, "Email, new password and confirm password are required");
    }

    if (newPassword !== confirmPassword) {
        throw new ApiError(400, "Passwords do not match");
    }

    const user = await User.findOne({ email, isEmailVerified: true });

    if (!user) {
        throw new ApiError(404, "Invalid email or email is not verified");
    }

    if (user.emailOtp !== null || user.emailOtpExpiry !== null) {
        throw new ApiError(400, "Please verify your OTP first before resetting the password");
    }

    user.password = newPassword;
    user.passwordChangedAt = new Date();
    await user.save({ validateBeforeSave: false });

    return res.status(200).json(
        new ApiResponse(200, {}, "Password reset successfully")
    );
});

const updateProfile = catchAsync(async (req, res) => {
    const { fullName, bio } = req.body;
    let imageUrl = null;
    const imagePath = req.file?.path || null;

    if (typeof fullName !== "string" || !fullName.trim()) {
        throw new ApiError(400, "Full name is required");
    }

    if (imagePath) {
        const uploadResult = await uploadOnCloudinary(imagePath);
        imageUrl = uploadResult?.secure_url;
    }

    const updateData = {
        fullName: fullName.trim(),
        profileCompleted: true,
    };

    if (typeof bio === "string" && bio.trim()) {
        updateData.bio = bio.trim();
    }

    if (imageUrl) {
        updateData.photoUrl = imageUrl;
    }

    const updatedUser =
        await User.findByIdAndUpdate(
            req.user._id,
            {
                $set: updateData,
            },
            {
                new: true,
                runValidators: true,
            }
        ).select(
            "-password -refreshToken -emailOtp -emailOtpExpiry"
        );

    return res.status(200).json(
        new ApiResponse(200, updatedUser, "Profile updated successfully")
    );
});

const resendOtp = catchAsync(async (req, res) => {
    const { email, type } = req.body;

    if (!email?.trim()) {
        throw new ApiError(400, "Email is required");
    }

    const validTypes = ["VERIFY_EMAIL", "FORGOT_PASSWORD"];
    if (!type || !validTypes.includes(type)) {
        throw new ApiError(400, "Valid type is required: VERIFY_EMAIL or FORGOT_PASSWORD");
    }

    // Build query based on type
    const query = type === "VERIFY_EMAIL"
        ? { email, isEmailVerified: false }
        : { email, isEmailVerified: true };

    const user = await User.findOne(query).select("+emailOtp +emailOtpExpiry");

    if (!user) {
        // Intentionally vague to prevent user enumeration
        throw new ApiError(404, "No account found or action not applicable");
    }

    // Rate limit: don't resend if a valid OTP was sent less than 1 minute ago
    const ONE_MINUTE = 60 * 1000;
    if (user.emailOtpExpiry && user.emailOtpExpiry.getTime() - Date.now() > (10 * 60 * 1000 - ONE_MINUTE)) {
        throw new ApiError(429, "Please wait at least 1 minute before requesting a new OTP");
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    user.emailOtp = otp;
    user.emailOtpExpiry = otpExpiry;

    // Refresh TTL window for unverified users so doc doesn't expire mid-flow
    if (type === "VERIFY_EMAIL") {
        user.expireDocAfterSeconds = new Date(Date.now() + 24 * 60 * 60 * 1000);
    }

    await user.save();

    const mailResponse = await mailSender(email, type, otp);

    if (mailResponse) {
        return res.status(200).json(
            new ApiResponse(200, {}, "OTP resent successfully, please check your email")
        );
    }

    throw new ApiError(500, "Failed to send OTP email, please try again");
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
};
