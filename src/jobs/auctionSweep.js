import mongoose from 'mongoose';
import { AuctionSession } from '../models/auctionSession.model.js';
import { AuctionLot } from '../models/auctionLot.model.js';
import { AuctionTeamOwner } from '../models/auctionTeamOwner.model.js';
import { emitLotResolved } from '../sockets/auction.socket.js';

const SWEEP_INTERVAL_MS = 1000;

/**
 * Resolves every lot whose clock has run out, across every active session,
 * in one pass. Sold/unsold is decided purely server-side here — never by a
 * bid, and never by a client's own countdown reaching zero (see the design
 * spec's "server time, not client time" requirement). Each lot is resolved
 * in its own transaction so one lot's failure can't block another's.
 *
 * A poll-based sweep rather than a per-lot `setTimeout`, specifically
 * because the backend runs under nodemon in development — nodemon restarts
 * on every file save, and an in-memory scheduled timer would be silently
 * lost on restart, stalling whatever auction was mid-run. This carries no
 * state outside the database, so a restart mid-auction just means the next
 * tick after boot picks up any overdue lot with zero recovery logic needed.
 */
export const resolveExpiredLots = async (io) => {
    const activeSessions = await AuctionSession.find({ status: 'active' });

    for (const auctionSession of activeSessions) {
        const expiredLot = await AuctionLot.findOne({
            session: auctionSession._id, status: 'active', endsAt: { $lte: new Date() },
        });
        if (!expiredLot) continue;

        const session = await mongoose.startSession();
        let outcome = null;
        try {
            await session.withTransaction(async () => {
                // The `status: 'active'` filter is what makes two overlapping
                // sweep ticks safe: whichever write lands first flips status
                // away from 'active', so the second matches nothing and
                // no-ops rather than resolving — and charging — the same lot
                // twice.
                if (expiredLot.currentBidder) {
                    const updated = await AuctionLot.findOneAndUpdate(
                        { _id: expiredLot._id, status: 'active' },
                        { $set: { status: 'sold', soldPrice: expiredLot.currentBid, soldTo: expiredLot.currentBidder, resolvedAt: new Date() } },
                        { session, new: true }
                    );
                    if (!updated) return;
                    await AuctionTeamOwner.updateOne(
                        { _id: expiredLot.currentBidder },
                        { $inc: { spent: expiredLot.currentBid } },
                        { session }
                    );
                    outcome = { outcome: 'sold', soldPrice: updated.soldPrice, soldTo: updated.soldTo };
                } else {
                    const updated = await AuctionLot.findOneAndUpdate(
                        { _id: expiredLot._id, status: 'active' },
                        { $set: { status: 'unsold', resolvedAt: new Date() } },
                        { session, new: true }
                    );
                    if (!updated) return;
                    outcome = { outcome: 'unsold' };
                }
            });
        } finally {
            await session.endSession();
        }

        if (outcome && io) {
            emitLotResolved(io, auctionSession.tournament, { lotId: expiredLot._id, ...outcome });
        }
    }
};

let sweepHandle = null;

export const startAuctionSweep = (io) => {
    if (sweepHandle) return sweepHandle;
    sweepHandle = setInterval(() => {
        resolveExpiredLots(io).catch((err) => console.error('auction sweep failed', err));
    }, SWEEP_INTERVAL_MS);
    return sweepHandle;
};

export const stopAuctionSweep = () => {
    if (sweepHandle) {
        clearInterval(sweepHandle);
        sweepHandle = null;
    }
};
