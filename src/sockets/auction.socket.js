import { AuctionSession } from '../models/auctionSession.model.js';
import { AuctionLot } from '../models/auctionLot.model.js';
import { AuctionBidEvent } from '../models/auctionBidEvent.model.js';
import { AuctionTeamOwner } from '../models/auctionTeamOwner.model.js';
import { Tournament } from '../models/tournament.model.js';
import { Organization } from '../models/organization.model.js';
import { isOrgMember } from '../utils/organizationAccess.js';
import { verifySocketAuth } from '../utils/verifySocketAuth.js';
import { nextBidAmount, LOT_TIMER_MS } from '../config/auctionRules.js';
import i18next from '../config/i18n.js';

const roomName = (tournamentId) => `auction:${tournamentId}`;

// Sockets have no `accept-language` header the way REST requests do — the
// client sends its locale explicitly on `auction:join` (stored on
// `socket.data.auctionLocale`), and every rejection this connection ever
// receives is localized from that, the same `i18next.t(code, {lng})` call
// `req.t` wraps for REST (see locale.middleware.js). A bid arriving before
// any join (which the client never does in practice) falls back to 'en'.
const rejectBid = (socket, code) => {
    socket.emit('auction:bidRejected', {
        code,
        message: i18next.t(code, { lng: socket.data.auctionLocale || 'en' }),
    });
};

/**
 * The full current state of a tournament's auction room — shared by
 * `auction:join`'s ack and by a freshly-joined client's first paint. Null
 * `sessionStatus`/`lot` mean "not started yet" / "nobody on the block right
 * now," not an error — same null-for-not-yet convention as
 * match.socket.js's buildInningsState.
 */
export const buildAuctionState = async (tournamentId) => {
    const auctionSession = await AuctionSession.findOne({ tournament: tournamentId });
    const owners = await AuctionTeamOwner.find({ tournament: tournamentId }).populate('team', 'name shortName');

    const budgets = owners.map((o) => ({
        teamId: o.team._id, teamName: o.team.name, ownerId: o.owner,
        budget: o.budget, spent: o.spent, remaining: o.budget - o.spent,
    }));

    if (!auctionSession) {
        return { sessionStatus: null, lot: null, bidHistory: [], budgets };
    }

    const activeLot = await AuctionLot.findOne({ session: auctionSession._id, status: 'active' })
        .populate('player', 'name role');

    if (!activeLot) {
        return { sessionStatus: auctionSession.status, lot: null, bidHistory: [], budgets };
    }

    const events = await AuctionBidEvent.find({ lot: activeLot._id })
        .sort({ createdAt: 1 })
        .populate({ path: 'bidder', populate: { path: 'team', select: 'name' } });

    return {
        sessionStatus: auctionSession.status,
        lot: {
            lotId: activeLot._id, playerId: activeLot.player._id, playerName: activeLot.player.name,
            playerRole: activeLot.player.role, basePrice: activeLot.basePrice,
            currentBid: activeLot.currentBid, endsAt: activeLot.endsAt,
        },
        bidHistory: events.map((e) => ({
            bidderTeamId: e.bidder.team._id, bidderTeamName: e.bidder.team.name, amount: e.amount, at: e.createdAt,
        })),
        budgets,
    };
};

export const registerAuctionSocket = (io) => {
    io.on('connection', (socket) => {
        // The one authenticated write path in the whole socket layer — see
        // verifySocketAuth's own comment on why this is scoped to just this
        // handler (and auction:bid, added in a later task) rather than a
        // global io.use().
        socket.on('auction:join', async ({ tournamentId, accessToken, locale } = {}) => {
            try {
                const user = await verifySocketAuth(accessToken);
                if (!user) return;

                const tournament = await Tournament.findOne({ _id: tournamentId, isDeleted: false });
                if (!tournament) return;
                const org = await Organization.findOne({ _id: tournament.organization, isDeleted: false });
                if (!isOrgMember(org, user._id)) return;

                socket.data.auctionLocale = ['en', 'hi', 'mr'].includes(locale) ? locale : 'en';
                socket.join(roomName(tournamentId));
                socket.emit('auction:state', await buildAuctionState(tournamentId));
            } catch (err) {
                console.error('auction:join failed', err);
            }
        });

        // Read-only inverse of auction:join's socket.join — same reasoning
        // as match.socket.js's own match:leave: no DB access, no ownership
        // check, safe even if this room was never joined.
        socket.on('auction:leave', ({ tournamentId } = {}) => {
            if (typeof tournamentId === 'string' && tournamentId) {
                socket.leave(roomName(tournamentId));
            }
        });

        // The other authenticated write path — see verifySocketAuth's own
        // comment. No amount in the payload: the server computes the next
        // increment itself, which is what makes the write below a genuine
        // compare-and-swap rather than "whichever amount arrives first
        // wins" — two clients proposing different amounts would otherwise
        // need reconciliation logic this design avoids entirely.
        socket.on('auction:bid', async ({ tournamentId, lotId, accessToken } = {}) => {
            try {
                const user = await verifySocketAuth(accessToken);
                if (!user) {
                    rejectBid(socket, 'UNAUTHORIZED_REQUEST');
                    return;
                }

                const owner = await AuctionTeamOwner.findOne({ tournament: tournamentId, owner: user._id })
                    .populate('team', 'name');
                if (!owner) {
                    rejectBid(socket, 'NOT_AUCTION_OWNER');
                    return;
                }

                const lot = await AuctionLot.findOne({ _id: lotId, tournament: tournamentId });
                if (!lot || lot.status !== 'active' || !lot.endsAt || lot.endsAt.getTime() <= Date.now()) {
                    rejectBid(socket, 'LOT_NOT_ACTIVE');
                    return;
                }

                const next = nextBidAmount(lot.currentBid);
                if (owner.budget - owner.spent < next) {
                    rejectBid(socket, 'INSUFFICIENT_BUDGET');
                    return;
                }

                const newEndsAt = new Date(Date.now() + LOT_TIMER_MS);
                // Compare-and-swap on currentBid — exactly the pattern
                // `applyBowlerSelection` uses for its own near-simultaneous
                // race (see match.controller.js). Two bids reading the same
                // currentBid can both compute the same `next`; only whichever
                // write lands first still matches this filter when it runs.
                // The loser's filter no longer matches (currentBid has moved)
                // and it gets null back — a real rejection, never a silently
                // overwritten "success." No transaction needed: this is a
                // single-document write, and budget/spent aren't touched
                // here at all (only lot resolution touches those — see the
                // sweep). `endsAt` is re-checked in this same atomic filter,
                // not just in the pre-check above, so a bid whose CAS
                // executes after the deadline — even by a few milliseconds,
                // in the gap before the pre-check's read and this write —
                // can never succeed.
                const updated = await AuctionLot.findOneAndUpdate(
                    { _id: lot._id, status: 'active', currentBid: lot.currentBid, endsAt: { $gt: new Date() } },
                    { $set: { currentBid: next, currentBidder: owner._id, endsAt: newEndsAt } },
                    { new: true }
                );

                if (!updated) {
                    rejectBid(socket, 'BID_TOO_LATE');
                    return;
                }

                await AuctionBidEvent.create({ lot: lot._id, session: lot.session, bidder: owner._id, amount: next });

                emitBidAccepted(io, tournamentId, {
                    lotId: lot._id, amount: next, bidderTeamId: owner.team._id, bidderTeamName: owner.team.name, endsAt: newEndsAt,
                });
            } catch (err) {
                console.error('auction:bid failed', err);
            }
        });
    });
};

export const emitLotOnBlock = (io, tournamentId, payload) => {
    io.to(roomName(tournamentId)).emit('auction:lotOnBlock', payload);
};

export const emitSessionCompleted = (io, tournamentId) => {
    io.to(roomName(tournamentId)).emit('auction:sessionCompleted', { tournamentId });
};

export const emitPaused = (io, tournamentId, payload) => {
    io.to(roomName(tournamentId)).emit('auction:paused', payload);
};

export const emitResumed = (io, tournamentId, payload) => {
    io.to(roomName(tournamentId)).emit('auction:resumed', payload);
};

export const emitBidAccepted = (io, tournamentId, payload) => {
    io.to(roomName(tournamentId)).emit('auction:bidAccepted', payload);
};

export const emitLotResolved = (io, tournamentId, payload) => {
    io.to(roomName(tournamentId)).emit('auction:lotResolved', payload);
};
