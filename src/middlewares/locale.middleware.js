import i18next from "../config/i18n.js";
import catchAsync from "../utils/catchAsync.js";

// `req.user` is never set by the time this runs, for every request without
// exception: this is mounted globally in app.js ahead of every router, while
// verifyJwt is applied per-route inside them — so it always executes first,
// on protected and public routes alike. A signed-in user's own `language`
// preference therefore never reaches server-composed messages; every
// response is localized by the `accept-language` header the client sends on
// every request instead (see AuthInterceptor client-side), which is why this
// has never surfaced as a user-visible bug despite the field going unread.
const localeMiddleware = catchAsync(async (req, _, next) => {
    const language =
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