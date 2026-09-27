import ApiError from './ApiError.js';
import { Player } from '../models/player.model.js';

// The one place a Player gets linked to an account. Only the account holder's
// own action may reach it (POST /v1/player/:id/claim, or accepting a
// PlayerInvite) — a scorer never sets `linkedUserId` themselves, since it is
// what your-turn push notifications are sent to.
//
// Idempotent for the account that already holds the link. The write is a
// compare-and-swap on `linkedUserId: null` rather than a read-then-write, which
// closes the race where two accounts link the same still-unlinked Player at the
// same moment: exactly one wins, the other gets 409.
export const linkPlayerToUser = async (playerId, userId) => {
    const player = await Player.findOne({ _id: playerId, isDeleted: false });
    if (!player) {
        throw new ApiError(404, "PLAYER_NOT_FOUND");
    }

    if (player.linkedUserId?.equals(userId)) {
        return player;
    }

    const updated = await Player.findOneAndUpdate(
        { _id: playerId, linkedUserId: null },
        { $set: { linkedUserId: userId } },
        { new: true }
    );
    if (!updated) {
        throw new ApiError(409, "PLAYER_ALREADY_CLAIMED");
    }
    return updated;
};
