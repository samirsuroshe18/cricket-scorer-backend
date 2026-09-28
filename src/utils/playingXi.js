import ApiError from './ApiError.js';
import { Player } from '../models/player.model.js';

/**
 * The Playing XI to store for one side after a squad save. Pure and DB-free.
 *
 * `requested` is `resolveSquad`'s `playingXI` (already validated against the
 * squad): an array replaces the stored XI, `null` un-sets it, and `undefined`
 * (the client never mentioned it) keeps the stored one — minus anyone the
 * save dropped from the squad. Returns ids as strings, or `undefined` when the
 * XI is unset. Unset and empty are different: only a set XI restricts scoring.
 */
export const mergePlayingXi = ({ requested, existing, savedIds }) => {
    if (requested === null) return undefined;
    if (requested !== undefined) return requested;
    if (existing === undefined) return undefined;

    const kept = new Set(savedIds.map(String));
    return existing.map(String).filter((id) => kept.has(id));
};

/**
 * Rejects `playerId` / `name` when `side`'s Playing XI is set and doesn't
 * include them. Resolves without a query while the XI is unset. Matching is by
 * id, or by the case-insensitive trimmed name of an XI player — so a brand-new
 * typed name never passes, since a new player cannot already be in the XI.
 * Called only by the online scoring endpoints; `POST /sync` deliberately does
 * not check it (see docs/api.md).
 */
export const assertInPlayingXi = async ({ match, side, playerId = null, name = '' }) => {
    const xi = match.squads?.[side]?.playingXI;
    if (!xi) return;

    if (playerId && xi.some((id) => String(id) === String(playerId))) return;

    const wanted = name.trim().toLowerCase();
    if (wanted) {
        const inXi = await Player.exists({ _id: { $in: xi }, nameLower: wanted });
        if (inXi) return;
    }
    throw new ApiError(400, 'PLAYER_NOT_IN_PLAYING_XI');
};
