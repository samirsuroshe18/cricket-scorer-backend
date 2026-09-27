import { Player } from '../models/player.model.js';

// Fills a roster player's still-unset role and jersey number from the account
// it is (or is about to be) tied to, so the scorer doesn't retype what the
// person already declared on their own profile (User.playingRole / jerseyNumber).
//
// Only ever fills: each field is written with a filter on its unset state, so a
// role or jersey the scorer chose is never overwritten, and it stays safe when
// two requests race. A profile that declares nothing ('unknown' / no number)
// writes nothing. Returns the player as stored afterwards.
export const seedPlayerFromProfile = async (player, profile) => {
    const writes = [];
    if (profile.playingRole && profile.playingRole !== 'unknown') {
        writes.push(Player.updateOne(
            { _id: player._id, role: 'unknown' },
            { $set: { role: profile.playingRole } }
        ));
    }
    if (profile.jerseyNumber != null) {
        writes.push(Player.updateOne(
            { _id: player._id, jerseyNumber: null },
            { $set: { jerseyNumber: profile.jerseyNumber } }
        ));
    }
    if (writes.length === 0) return player;

    await Promise.all(writes);
    return Player.findById(player._id);
};
