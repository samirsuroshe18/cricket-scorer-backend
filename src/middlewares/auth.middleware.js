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
        // Pinned rather than left to jsonwebtoken's own inference from the
        // secret's type: inference is a property of a plain-string secret
        // (HS256 today), not a guarantee, and jwt.verify with no allowlist at
        // all accepts whatever algorithm the token's own header names —
        // including 'none' on older library versions. Every token this app
        // issues is signed with HS256 (see User.generateAccessToken), so
        // that's the only one a valid token can ever need.
        decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, { algorithms: ['HS256'] });
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            throw new ApiError(401, "ACCESS_TOKEN_EXPIRED");
        } else {
            // 401, matching every other INVALID_ACCESS_TOKEN branch (the
            // no-user-found one right below, and docs/api.md's uniformly-401
            // row for it) — a bad signature/algorithm and an unresolvable
            // user are both "your credentials don't work," not "you're not
            // allowed to do this."
            throw new ApiError(401, "INVALID_ACCESS_TOKEN");
        }
    }
    const user = await User.findById(decodedToken?._id).select("-password -refreshToken -__v -fcmToken -isGoogleVerified -isVerified");

    if (!user) {
        throw new ApiError(401, "INVALID_ACCESS_TOKEN");
    }

    req.user = user;
    next();
})

// There is no role/admin concept anywhere in User.model.js — "logged in" was
// being used as a stand-in for "authorized" on the translations CMS write
// routes, which let any self-registered account rewrite or delete the i18n
// strings every client renders. Phase 1 has exactly one real admin (whoever
// runs the CMS maintenance calls), so this is a small, ops-controlled email
// allowlist rather than a DB-backed role — no migration, no self-service path
// to become admin, and it can't be granted by anything short of editing
// `.env` and restarting. Must run AFTER verifyJwt: it reads `req.user`, which
// only verifyJwt populates.
//
// Read from `process.env` on every call rather than cached at module load —
// this is what lets a test set `process.env.ADMIN_EMAILS` per-case and see
// it take effect immediately, and the value never changes within a running
// process anyway, so there is no real cost to not caching it.
const verifyAdmin = catchAsync(async (req, _, next) => {
    const adminEmails = (process.env.ADMIN_EMAILS ?? '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);

    if (!adminEmails.includes(req.user?.email?.toLowerCase())) {
        throw new ApiError(403, "ADMIN_ACCESS_REQUIRED");
    }

    next();
});

export { verifyJwt, verifyAdmin };