import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { AuctionTeamOwner } from '../models/auctionTeamOwner.model.js';
import { AuctionSession } from '../models/auctionSession.model.js';
import { AuctionLot } from '../models/auctionLot.model.js';
import { PlayerPoolEntry } from '../models/playerPoolEntry.model.js';
import { findOwnedTournament } from './tournament.controller.js';

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

export { startAuction };
