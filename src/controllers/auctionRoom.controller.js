import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { AuctionTeamOwner } from '../models/auctionTeamOwner.model.js';
import { AuctionSession } from '../models/auctionSession.model.js';
import { AuctionLot } from '../models/auctionLot.model.js';
import { PlayerPoolEntry } from '../models/playerPoolEntry.model.js';
import { findOwnedTournament } from './tournament.controller.js';
import { LOT_TIMER_MS } from '../config/auctionRules.js';
import { emitLotOnBlock, emitSessionCompleted } from '../sockets/auction.socket.js';

const startAuction = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    const existing = await AuctionSession.findOne({ tournament: tournament._id });
    if (existing) {
        throw new ApiError(409, "AUCTION_ALREADY_STARTED");
    }

    // AuctionSettings (squad-size/category-cap config) is optional and may
    // never exist — setAuctionSetup only upserts it when those specific
    // fields are sent, so its absence isn't itself a sign of incomplete
    // setup. The one real precondition is at least one configured owner:
    // with none, there's nobody to bid.
    const ownerCount = await AuctionTeamOwner.countDocuments({ tournament: tournament._id });
    if (ownerCount === 0) {
        throw new ApiError(400, "AUCTION_SETUP_INCOMPLETE");
    }

    const poolEntries = await PlayerPoolEntry.find({ tournament: tournament._id }).sort({ createdAt: 1 });

    const session = await mongoose.startSession();
    let created;
    try {
        await session.withTransaction(async () => {
            [created] = await AuctionSession.create(
                [{ tournament: tournament._id, status: 'active', createdBy: req.user._id, startedAt: new Date() }],
                { session }
            );
            if (poolEntries.length > 0) {
                await AuctionLot.insertMany(
                    poolEntries.map((entry, index) => ({
                        session: created._id, tournament: tournament._id, poolEntry: entry._id, player: entry.player,
                        basePrice: entry.basePrice, currentBid: entry.basePrice, status: 'queued', sequence: index,
                    })),
                    { session }
                );
            }
        });
    } finally {
        await session.endSession();
    }

    return res.status(201).json(new ApiResponse(201, {
        tournamentId: tournament._id, sessionId: created._id, status: created.status, lotCount: poolEntries.length,
    }, req.t("AUCTION_STARTED")));
});

const nextLot = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findOwnedTournament(tournamentId, req.user._id);

    const session = await mongoose.startSession();
    let responseData;
    try {
        await session.withTransaction(async () => {
            const auctionSession = await AuctionSession.findOne({ tournament: tournament._id }, null, { session });
            if (!auctionSession || auctionSession.status !== 'active') {
                throw new ApiError(400, "AUCTION_NOT_ACTIVE");
            }

            const alreadyActive = await AuctionLot.findOne({ session: auctionSession._id, status: 'active' }, null, { session });
            if (alreadyActive) {
                throw new ApiError(409, "LOT_ALREADY_ACTIVE");
            }

            const next = await AuctionLot.findOne({ session: auctionSession._id, status: 'queued' }, null, { session })
                .sort({ sequence: 1 });

            if (!next) {
                await AuctionSession.updateOne({ _id: auctionSession._id }, { $set: { status: 'completed', completedAt: new Date() } }, { session });
                responseData = { tournamentId: tournament._id, completed: true, lot: null };
                return;
            }

            const endsAt = new Date(Date.now() + LOT_TIMER_MS);
            await AuctionLot.updateOne(
                { _id: next._id },
                { $set: { status: 'active', currentBid: next.basePrice, endsAt } },
                { session }
            );
            responseData = {
                tournamentId: tournament._id, completed: false,
                lot: { lotId: next._id, playerId: next.player, basePrice: next.basePrice, currentBid: next.basePrice, endsAt },
            };
        });
    } finally {
        await session.endSession();
    }

    const io = req.app.get('io');
    if (io) {
        if (responseData.completed) {
            emitSessionCompleted(io, tournament._id);
        } else {
            emitLotOnBlock(io, tournament._id, responseData.lot);
        }
    }

    return res.status(200).json(new ApiResponse(200, responseData, req.t(responseData.completed ? "AUCTION_COMPLETED" : "LOT_ON_BLOCK")));
});

export { startAuction, nextLot };
