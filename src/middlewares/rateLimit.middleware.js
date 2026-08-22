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
