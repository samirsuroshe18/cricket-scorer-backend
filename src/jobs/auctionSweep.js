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
        const session = await mongoose.startSession();
        let outcome = null;
        try {
            await session.withTransaction(async () => {
                // The lot is read fresh HERE — inside the transaction's own
                // snapshot, via the same `endsAt: {$lte: now}` filter that
                // decides eligibility — never from a value captured before
                // this transaction opened. A bid accepted between sweep
                // ticks always pushes `endsAt` into the future (see
                // auction.socket.js), so if one landed in the gap, this
                // query simply finds nothing this tick and defers to the
                // next one. Resolving from a stale, pre-transaction read
                // was a real bug: a bid landing in that gap got silently
                // overwritten with the stale bidder/price (see
                // tests/auctionSweepBidRace.test.js for the exact
                // scenario this closes).
                const lot = await AuctionLot.findOne(
                    { session: auctionSession._id, status: 'active', endsAt: { $lte: new Date() } },
                    null,
                    { session }
                );
                if (!lot) return;

                // The `status: 'active'` filter on each write below is what
                // makes two overlapping sweep ticks safe: whichever write
                // lands first flips status away from 'active', so the
                // second matches nothing and no-ops rather than resolving —
                // and charging — the same lot twice.
                if (lot.currentBidder) {
                    const updated = await AuctionLot.findOneAndUpdate(
                        { _id: lot._id, status: 'active', currentBid: lot.currentBid },
                        { $set: { status: 'sold', soldPrice: lot.currentBid, soldTo: lot.currentBidder, resolvedAt: new Date() } },
                        { session, new: true }
                    );
                    if (!updated) return;
                    // {new: true} so the emitted payload carries the
                    // post-charge spent/remaining — the design's own wire
                    // contract requires the winning team's updated budget
                    // travel with this event, so the client applies the
                    // server's authoritative number rather than computing
                    // it itself from a possibly-stale local cache.
                    const updatedOwner = await AuctionTeamOwner.findOneAndUpdate(
                        { _id: lot.currentBidder },
                        { $inc: { spent: lot.currentBid } },
                        { session, new: true }
                    );
                    outcome = {
                        lotId: lot._id, outcome: 'sold', soldPrice: updated.soldPrice, soldTo: updated.soldTo,
                        spent: updatedOwner.spent, remaining: updatedOwner.budget - updatedOwner.spent,
                    };
                } else {
                    const updated = await AuctionLot.findOneAndUpdate(
                        { _id: lot._id, status: 'active' },
                        { $set: { status: 'unsold', resolvedAt: new Date() } },
                        { session, new: true }
                    );
                    if (!updated) return;
                    outcome = { lotId: lot._id, outcome: 'unsold' };
                }
            });
        } finally {
            await session.endSession();
        }

        if (outcome && io) {
            emitLotResolved(io, auctionSession.tournament, outcome);
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
