// NoSQL-injection guard. express-mongo-sanitize is not used because it reassigns
// req.query, which is a getter in Express 5 and throws.
const stripOperatorKeys = (value) => {
    if (Array.isArray(value)) {
        value.forEach(stripOperatorKeys);
        return;
    }

    if (value === null || typeof value !== "object") return;

    for (const key of Object.keys(value)) {
        if (key.startsWith("$") || key.includes(".")) {
            delete value[key];
            continue;
        }
        stripOperatorKeys(value[key]);
    }
};

const sanitizeMiddleware = (req, _, next) => {
    stripOperatorKeys(req.body);
    stripOperatorKeys(req.params);
    stripOperatorKeys(req.query);
    next();
};

export { sanitizeMiddleware };
