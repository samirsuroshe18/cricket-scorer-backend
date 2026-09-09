import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { AuctionSession } from '../models/auctionSession.model.js';
import { AuctionLot } from '../models/auctionLot.model.js';
import { AuctionTeamOwner } from '../models/auctionTeamOwner.model.js';
import { findAccessibleTournament } from './tournament.controller.js';

// `AuctionSession.tournament` carries a unique index and `startAuction`
// unconditionally 409s on any existing session regardless of status — a
// tournament has at most one AuctionSession, ever. So neither report
// endpoint takes a sessionId; each looks up that one session itself.
const findTournamentAuctionSession = async (tournamentId) => {
    const session = await AuctionSession.findOne({ tournament: tournamentId });
    if (!session) {
        throw new ApiError(404, "AUCTION_NOT_FOUND");
    }
    return session;
};

const getAuctionSquad = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);
    const session = await findTournamentAuctionSession(tournament._id);

    const owners = await AuctionTeamOwner.find({ tournament: tournament._id })
        .populate('team', 'name')
        .populate('owner', 'fullName');

    const soldLots = await AuctionLot.find({ session: session._id, status: 'sold' })
        .populate('player', 'name role')
        .sort({ resolvedAt: 1 });

    const soldByOwner = new Map();
    for (const lot of soldLots) {
        const key = String(lot.soldTo);
        const players = soldByOwner.get(key) ?? [];
        players.push({ playerId: lot.player._id, playerName: lot.player.name, role: lot.player.role, soldPrice: lot.soldPrice });
        soldByOwner.set(key, players);
    }

    const teams = owners.map((owner) => ({
        teamId: owner.team._id,
        teamName: owner.team.name,
        ownerId: owner.owner._id,
        ownerName: owner.owner.fullName,
        budget: owner.budget,
        spent: owner.spent,
        remaining: owner.budget - owner.spent,
        players: soldByOwner.get(String(owner._id)) ?? [],
    }));

    const unsoldLots = await AuctionLot.find({ session: session._id, status: 'unsold' })
        .populate('player', 'name role')
        .sort({ resolvedAt: 1 });

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        teams,
        unsold: unsoldLots.map((lot) => ({
            playerId: lot.player._id, playerName: lot.player.name, role: lot.player.role, basePrice: lot.basePrice,
        })),
    }, req.t("AUCTION_SQUAD_FETCHED")));
});

const getAuctionHistory = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await findAccessibleTournament(tournamentId, req.user._id);
    const session = await findTournamentAuctionSession(tournament._id);

    const resolvedLots = await AuctionLot.find({ session: session._id, status: { $in: ['sold', 'unsold'] } })
        .populate('player', 'name role')
        .populate({ path: 'soldTo', populate: { path: 'team', select: 'name' } })
        .sort({ resolvedAt: 1 });

    return res.status(200).json(new ApiResponse(200, {
        tournamentId: tournament._id,
        entries: resolvedLots.map((lot) => ({
            lotId: lot._id,
            playerId: lot.player._id,
            playerName: lot.player.name,
            role: lot.player.role,
            basePrice: lot.basePrice,
            outcome: lot.status,
            soldPrice: lot.status === 'sold' ? lot.soldPrice : null,
            teamId: lot.status === 'sold' ? lot.soldTo.team._id : null,
            teamName: lot.status === 'sold' ? lot.soldTo.team.name : null,
            resolvedAt: lot.resolvedAt,
        })),
    }, req.t("AUCTION_HISTORY_FETCHED")));
});

export { getAuctionSquad, getAuctionHistory };
