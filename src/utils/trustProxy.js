// Parses TRUST_PROXY_HOPS into the numeric hop count Express's own
// `trust proxy` setting expects — see the comment in app.js for why this
// must be a specific number of hops, never `true`/`false`. Anything that
// doesn't parse to a whole number (unset, empty, garbage) falls back to 0:
// trust nothing, the safe default for today's no-proxy topology.
export const resolveTrustProxyHops = (rawValue) => {
    const hops = Number.parseInt(rawValue ?? "0", 10);
    return Number.isInteger(hops) ? hops : 0;
};
