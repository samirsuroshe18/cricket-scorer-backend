import rateLimit from "express-rate-limit";

const handler = (req, res) => {
    const t = typeof req.t === "function" ? req.t : (key) => key;
    return res.status(429).json({
        statusCode: 429,
        code: "TOO_MANY_REQUESTS",
        message: t("TOO_MANY_REQUESTS"),
    });
};

export const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler,
});

// Credential and OTP endpoints are the brute-force surface — much tighter budget.
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler,
});

// Exact-email lookup is a "does this address have an account" probe, so it gets
// its own budget, keyed by the signed-in user (verifyJwt runs first) rather than
// IP: every request counts, successful or not, since a hit is the leak.
export const lookupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => String(req.user._id),
    handler,
});
