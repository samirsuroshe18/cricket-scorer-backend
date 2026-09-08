import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Player } from '../models/player.model.js';
import { PlayerPoolEntry } from '../models/playerPoolEntry.model.js';
import { findOwnedTournament, findAccessibleTournament } from './tournament.controller.js';

const asString = (value) => (typeof value === 'string' ? value : '');

const MAX_PLAYER_NAME_LENGTH = 50;
const MIN_BASE_PRICE = 1;
const MAX_BASE_PRICE = 100000000;

// Shared response shape for POST/PATCH's single-entry response and GET's
// list — a Player's own profile fields (Phase 2) plus this entry's
// tournament-scoped basePrice. Deliberately never includes any
// CareerStats/PlayerMatchStats field — see the design spec's §4.
const formatPoolEntry = (entry, player) => ({
    playerId: player._id,
    playerName: player.name,
    role: player.role,
    jerseyNumber: player.jerseyNumber ?? null,
    battingStyle: player.battingStyle ?? null,
    bowlingStyle: player.bowlingStyle ?? null,
    bio: player.bio ?? null,
    basePrice: entry.basePrice,
    registeredAt: entry.createdAt,
});

const validateBasePrice = (basePrice) => {
    if (basePrice === undefined || basePrice === null) {
        throw new ApiError(400, "BASE_PRICE_REQUIRED");
    }
    if (!Number.isInteger(basePrice) || basePrice < MIN_BASE_PRICE || basePrice > MAX_BASE_PRICE) {
        throw new ApiError(400, "INVALID_BASE_PRICE");
    }
};

// Resolves `playerId` (must already belong to the caller's own scorer-scope)
// or find-or-creates by `playerName` under it. Mirrors match.controller.js's
// findOrCreatePlayer's identity-resolution half only — no roster or
// opposing-team side effects, which have no meaning before a player has a
// team at all (the common case: an auction runs before any match is scored).
const findOrCreatePoolPlayer = async (playerName, playerId, createdBy) => {
    if (playerId) {
        if (!mongoose.Types.ObjectId.isValid(playerId)) {
            throw new ApiError(400, "INVALID_PLAYER_ID");
        }
        const player = await Player.findOne({ _id: playerId, createdBy, isDeleted: false });
        if (!player) {
            throw new ApiError(400, "INVALID_PLAYER_ID");
        }
        return player;
    }

    const name = asString(playerName).trim();
    if (!name || name.length > MAX_PLAYER_NAME_LENGTH) {
        throw new ApiError(400, "POOL_PLAYER_NAME_REQUIRED");
    }
    const nameLower = name.toLowerCase();
    try {
        return await Player.findOneAndUpdate(
            { createdBy, nameLower },
            { $setOnInsert: { name, createdBy, nameLower } },
            { new: true, upsert: true }
        );
    } catch (err) {
        if (err.code === 11000) {
            return await Player.findOne({ createdBy, nameLower });
        }
        throw err;
    }
};

const registerPoolPlayer = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    validateBasePrice(req.body.basePrice);
    const player = await findOrCreatePoolPlayer(req.body.playerName, req.body.playerId, req.user._id);

    let entry;
    try {
        entry = await PlayerPoolEntry.create({
            tournament: tournament._id,
            player: player._id,
            basePrice: req.body.basePrice,
            createdBy: req.user._id,
        });
    } catch (err) {
        if (err.code === 11000) {
            throw new ApiError(409, "PLAYER_ALREADY_IN_POOL");
        }
        throw err;
    }

    return res.status(201).json(new ApiResponse(201, formatPoolEntry(entry, player), req.t("PLAYER_REGISTERED_IN_POOL")));
});

const listPoolEntries = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);

    const entries = await PlayerPoolEntry.find({ tournament: tournament._id })
        .sort({ createdAt: 1 })
        .populate('player', 'name role jerseyNumber battingStyle bowlingStyle bio');

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        entries: entries.map((entry) => formatPoolEntry(entry, entry.player)),
    }, req.t("POOL_FETCHED")));
});

const updatePoolEntry = catchAsync(async (req, res) => {
    const { tournamentId, playerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(playerId)) {
        throw new ApiError(400, "INVALID_ID");
    }
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    validateBasePrice(req.body.basePrice);

    const entry = await PlayerPoolEntry.findOneAndUpdate(
        { tournament: tournament._id, player: playerId },
        { $set: { basePrice: req.body.basePrice } },
        { new: true }
    ).populate('player', 'name role jerseyNumber battingStyle bowlingStyle bio');

    if (!entry) {
        throw new ApiError(404, "POOL_ENTRY_NOT_FOUND");
    }

    return res.status(200).json(new ApiResponse(200, formatPoolEntry(entry, entry.player), req.t("POOL_ENTRY_UPDATED")));
});

const removePoolEntry = catchAsync(async (req, res) => {
    const { tournamentId, playerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(playerId)) {
        throw new ApiError(400, "INVALID_ID");
    }
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    const entry = await PlayerPoolEntry.findOneAndDelete({ tournament: tournament._id, player: playerId });
    if (!entry) {
        throw new ApiError(404, "POOL_ENTRY_NOT_FOUND");
    }

    return res.status(200).json(new ApiResponse(200, { tournamentId: tournament._id, playerId }, req.t("POOL_ENTRY_REMOVED")));
});

export { registerPoolPlayer, listPoolEntries, updatePoolEntry, removePoolEntry, formatPoolEntry, validateBasePrice, MIN_BASE_PRICE, MAX_BASE_PRICE };
