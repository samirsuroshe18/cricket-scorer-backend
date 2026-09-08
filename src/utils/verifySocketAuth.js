import jwt from 'jsonwebtoken';
import { User } from '../models/user.model.js';

/**
 * Same verification `verifyJwt` performs for REST — pinned to HS256, same
 * "no user found" handling — reimplemented here because Socket.io has no
 * per-event middleware layer (see socketRateLimit.js's own comment on the
 * same gap) and match.socket.js's handlers are deliberately unauthenticated
 * by design. The auction room needs an authenticated write path
 * (`auction:bid`), so this exists to add auth scoped to ONLY the auction
 * handlers, never a global `io.use()` that would also gate the
 * intentionally anonymous match-spectator sockets.
 *
 * Returns the resolved `User` document, or null for any failure — every
 * caller treats null as "reject this event, silently," mirroring
 * `verifyJwt`'s throws but with no HTTP response to attach them to.
 */
export const verifySocketAuth = async (accessToken) => {
    if (!accessToken || typeof accessToken !== 'string') return null;

    let decoded;
    try {
        decoded = jwt.verify(accessToken, process.env.ACCESS_TOKEN_SECRET, { algorithms: ['HS256'] });
    } catch {
        return null;
    }

    const user = await User.findById(decoded?._id).select("-password -refreshToken -__v -fcmToken -isGoogleVerified -isVerified");
    return user ?? null;
};
