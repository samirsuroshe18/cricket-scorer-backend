import i18next from "../config/i18n.js";
import catchAsync from "../utils/catchAsync.js";

const localeMiddleware = catchAsync(async (req, _, next) => {
    const language =
        req.user?.language ||
        req.headers["accept-language"] ||
        "en";

    req.t = (key, params = {}) => {
        return i18next.t(key, {
            lng: language,
            ...params,
        });
    };

    next();
});

export { localeMiddleware };