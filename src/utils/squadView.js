/**
 * One side of a match squad as the client reads it. `players` follows the
 * stored squad order and leaves out soft-deleted players (and any XI entry that
 * points at one). `playingXI` is `null` when the scorer never set one — distinct
 * from `[]`, a deliberately empty XI.
 */
export const toSquadSideView = (match, side, players) => {
    const stored = match.squads?.[side] ?? {};
    const byId = new Map(players.map((player) => [String(player._id), player]));

    const visible = (stored.players ?? [])
        .map((id) => byId.get(String(id)))
        .filter((player) => player && !player.isDeleted);
    const visibleIds = new Set(visible.map((player) => String(player._id)));

    return {
        teamId: match[side],
        players: visible.map((player) => ({
            playerId: player._id,
            name: player.name,
            role: player.role,
            jerseyNumber: player.jerseyNumber ?? null,
        })),
        captainId: stored.captainId ?? null,
        viceCaptainId: stored.viceCaptainId ?? null,
        keeperId: stored.keeperId ?? null,
        playingXI: stored.playingXI
            ? stored.playingXI.map(String).filter((id) => visibleIds.has(id))
            : null,
        savedAt: stored.savedAt ?? null,
    };
};
