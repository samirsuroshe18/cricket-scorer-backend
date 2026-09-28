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
