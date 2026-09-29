import ApiError from './ApiError.js';
import { Player } from '../models/player.model.js';

/** The hard floor `minPlayingXi` can never go below, regardless of who sets it. */
export const MIN_PLAYING_XI_FLOOR = 2;

/**
 * True when `{ minPlayingXi, maxPlayingXi }` is a legal range: both integers,
 * min at least [[MIN_PLAYING_XI_FLOOR]], max at least min. No ceiling on max.
 */
export const isValidPlayingXiRange = (minPlayingXi, maxPlayingXi) =>
    Number.isInteger(minPlayingXi) && Number.isInteger(maxPlayingXi) &&
    minPlayingXi >= MIN_PLAYING_XI_FLOOR && maxPlayingXi >= minPlayingXi;

/**
 * Throws when `count` (a side's about-to-be-saved Playing XI size) falls
 * outside `match`'s stored range. Callers only invoke this once they've
 * already decided the XI is being set (not left unset) — an unset XI carries
 * no size restriction.
 */
export const assertPlayingXiSize = (match, count) => {
    if (count < match.minPlayingXi) throw new ApiError(400, 'PLAYING_XI_TOO_SMALL');
    if (count > match.maxPlayingXi) throw new ApiError(400, 'PLAYING_XI_TOO_LARGE');
};

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
