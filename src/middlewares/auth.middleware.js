import ApiError from "../utils/ApiError.js";
import catchAsync from "../utils/catchAsync.js";
import jwt from 'jsonwebtoken';
import { User } from "../models/user.model.js";

const verifyJwt = catchAsync(async (req, _, next) => {
    const token = req.cookies?.accessToken || req.header("Authorization")?.replace("Bearer ", "");

    if (!token || token === "null" || token === "undefined") {
        throw new ApiError(401, "UNAUTHORIZED_REQUEST");
    }

    let decodedToken;
    try {
        decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            throw new ApiError(401, "ACCESS_TOKEN_EXPIRED");
        } else {
            throw new ApiError(403, "INVALID_ACCESS_TOKEN");
        }
    }
    const user = await User.findById(decodedToken?._id).select("-password -refreshToken -__v -fcmToken -isGoogleVerified -isVerified");

    if (!user) {
        throw new ApiError(401, "INVALID_ACCESS_TOKEN");
    }

    req.user = user;
    next();
})

export { verifyJwt };