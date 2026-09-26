import ApiError from './ApiError.js';

export const SQUAD_ROLES = ['batsman', 'bowler', 'allrounder'];

const MAX_PLAYER_NAME_LENGTH = 50;

const normalise = (name) => name.trim().toLowerCase();

/**
 * Validates and normalises the body of PUT /v1/match/:matchId/squad/:side.
 * Pure and DB-free, like resolveSync/resolveDelivery: identity resolution
 * (find-or-create) and the cross-side check need the database and live in the
 * controller. Designations are resolved to the trimmed name of the squad member
 * they name, so the controller can look each one up in the players it created.
 * Throws bare i18n keys as ApiError messages.
 */
export const resolveSquad = (body = {}) => {
    const { players = [], captain, viceCaptain, keeper } = body;

    if (!Array.isArray(players)) {
        throw new ApiError(400, 'SQUAD_PLAYER_NAME_INVALID');
    }

    const seen = new Set();
    const resolved = players.map((entry) => {
        const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
        if (!name || name.length > MAX_PLAYER_NAME_LENGTH) {
            throw new ApiError(400, 'SQUAD_PLAYER_NAME_INVALID');
        }
        // Optional: a role is only ever written when the scorer chose one. A
        // returning player's stored role (which may be `wicketkeeper` or
        // `unknown`, outside SQUAD_ROLES) is shared across every match and
        // must survive a squad save that never touched it.
        if (entry.role !== undefined && !SQUAD_ROLES.includes(entry.role)) {
            throw new ApiError(400, 'INVALID_ROLE');
        }
        const key = normalise(name);
        if (seen.has(key)) {
            throw new ApiError(400, 'SQUAD_PLAYER_NAMES_MUST_DIFFER');
        }
        seen.add(key);

        const player = { name };
        if (entry.role !== undefined) player.role = entry.role;
        if (entry.playerId) player.playerId = entry.playerId;
        return player;
    });

    const byKey = new Map(resolved.map((player) => [normalise(player.name), player.name]));

    const designate = (value) => {
        if (value === undefined || value === null || value === '') return null;
        const name = typeof value === 'string' ? byKey.get(normalise(value)) : undefined;
        if (!name) {
            throw new ApiError(400, 'SQUAD_DESIGNATION_NOT_IN_SQUAD');
        }
        return name;
    };

    const resolvedCaptain = designate(captain);
    const resolvedViceCaptain = designate(viceCaptain);
    const resolvedKeeper = designate(keeper);

    if (resolvedCaptain && resolvedCaptain === resolvedViceCaptain) {
        throw new ApiError(400, 'SQUAD_CAPTAIN_VC_MUST_DIFFER');
    }

    return {
        players: resolved,
        captain: resolvedCaptain,
        viceCaptain: resolvedViceCaptain,
        keeper: resolvedKeeper,
    };
};
