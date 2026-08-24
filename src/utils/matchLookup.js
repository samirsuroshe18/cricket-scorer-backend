import mongoose from 'mongoose';
import { Match } from '../models/match.model.js';
import { looksLikeJoinCode } from './joinCode.js';

/**
 * Finds a match from either half of a share link: the 24-hex `_id` the app puts
 * in a deep link, or the six-character code a scorer reads out.
 *
 * Told apart by shape, which is unambiguous here — a join code is six
 * characters and an ObjectId is twenty-four, so no input can be both. The
 * `looksLikeJoinCode` guard rejects rubbish before a database round trip; it is
 * a filter, never authorisation.
 *
 * Soft-deleted matches resolve to null, exactly as an unknown code does. The
 * caller must not distinguish the two: doing so would tell an enumerator which
 * codes have ever existed.
 *
 * Shared by the public REST route and the socket's `match:join` so the two
 * cannot disagree about what a code means.
 */
export const findMatchByIdOrCode = async (value) => {
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    if (mongoose.Types.ObjectId.isValid(trimmed)) {
        return Match.findOne({ _id: trimmed, isDeleted: false });
    }

    if (!looksLikeJoinCode(trimmed)) return null;

    return Match.findOne({ joinCode: trimmed.toUpperCase(), isDeleted: false });
};
