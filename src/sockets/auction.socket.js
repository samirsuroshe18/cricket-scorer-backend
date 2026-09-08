import { AuctionSession } from '../models/auctionSession.model.js';
import { AuctionLot } from '../models/auctionLot.model.js';
import { AuctionBidEvent } from '../models/auctionBidEvent.model.js';
import { AuctionTeamOwner } from '../models/auctionTeamOwner.model.js';
import { Tournament } from '../models/tournament.model.js';
import { Organization } from '../models/organization.model.js';
import { isOrgMember } from '../utils/organizationAccess.js';
import { verifySocketAuth } from '../utils/verifySocketAuth.js';

const roomName = (tournamentId) => `auction:${tournamentId}`;

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
