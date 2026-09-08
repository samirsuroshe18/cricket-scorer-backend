import mongoose from 'mongoose';
import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { AuctionSettings, CATEGORY_CAP_ROLES } from '../models/auctionSettings.model.js';
import { AuctionTeamOwner } from '../models/auctionTeamOwner.model.js';
import { AuctionSession } from '../models/auctionSession.model.js';
import { Organization } from '../models/organization.model.js';
import { isOrgMember } from '../utils/organizationAccess.js';
import { findOwnedTournament, findAccessibleTournament } from './tournament.controller.js';

const asString = (value) => (typeof value === 'string' ? value : '');

// The paid-tier half of the roadmap's settled auction-access-control
// decision — "does this auction's tournament belong to a paid
// Organization" — cannot be checked yet: Organization carries no
// tier/subscription field at all (Phase 6 is unbuilt). These seams are
// where that check attaches once it exists; today they are identical to
// findOwnedTournament/findAccessibleTournament. Not stubbed with a
// speculative field — see the design spec's §5.
const canConfigureAuction = (tournamentId, userId) => findOwnedTournament(tournamentId, userId);
const canViewAuctionSetup = (tournamentId, userId) => findAccessibleTournament(tournamentId, userId);

const validateSquadSizeField = (value) => {
    if (!Number.isInteger(value) || value < 1 || value > 100) {
        throw new ApiError(400, "INVALID_SQUAD_SIZE");
    }
};

const validateCategoryCaps = (categoryCaps) => {
    if (categoryCaps === null || typeof categoryCaps !== 'object' || Array.isArray(categoryCaps)) {
        throw new ApiError(400, "INVALID_CATEGORY_CAP");
    }
    for (const [role, cap] of Object.entries(categoryCaps)) {
        if (!CATEGORY_CAP_ROLES.includes(role)) {
            throw new ApiError(400, "INVALID_CATEGORY_CAP");
        }
        if (!Number.isInteger(cap) || cap < 1 || cap > 100) {
            throw new ApiError(400, "INVALID_CATEGORY_CAP");
        }
    }
};

const validateBudgetField = (budget) => {
    if (budget === undefined || budget === null) {
        throw new ApiError(400, "BUDGET_REQUIRED");
    }
    if (!Number.isInteger(budget) || budget < 1 || budget > 100000000) {
        throw new ApiError(400, "INVALID_BUDGET");
    }
};

// team must already be enrolled; owner must be a member of the tournament's
// own organization; no team or owner repeated within the same request —
// this is what turns a duplicate into a specific 400 instead of a generic
// 500 from a caught E11000 at the storage layer.
const validateOwners = async (owners, tournament) => {
    if (!Array.isArray(owners)) {
        throw new ApiError(400, "INVALID_OWNERS_LIST");
    }

    const enrolledTeamIds = new Set(tournament.teams.map((t) => String(t.team)));
    const seenTeams = new Set();
    const seenOwnerIds = new Set();
    const resolved = [];

    for (const entry of owners) {
        const teamId = asString(entry?.teamId).trim();
        const userId = asString(entry?.userId).trim();

        if (!mongoose.Types.ObjectId.isValid(teamId) || !enrolledTeamIds.has(teamId)) {
            throw new ApiError(400, "AUCTION_SETUP_TEAM_NOT_IN_TOURNAMENT");
        }
        if (seenTeams.has(teamId)) {
            throw new ApiError(400, "AUCTION_SETUP_DUPLICATE_TEAM");
        }
        seenTeams.add(teamId);

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            throw new ApiError(400, "AUCTION_SETUP_INVALID_OWNER");
        }
        if (seenOwnerIds.has(userId)) {
            throw new ApiError(400, "AUCTION_SETUP_DUPLICATE_OWNER");
        }
        seenOwnerIds.add(userId);

        validateBudgetField(entry?.budget);
        resolved.push({ teamId, userId, budget: entry.budget });
    }

    if (resolved.length > 0) {
        const org = await Organization.findOne({ _id: tournament.organization, isDeleted: false });
        for (const { userId } of resolved) {
            if (!isOrgMember(org, userId)) {
                throw new ApiError(400, "AUCTION_SETUP_INVALID_OWNER");
            }
        }
    }

    return resolved;
};

// Shared response shape for PATCH/GET.
const formatAuctionSetup = async (tournamentId) => {
    const [settings, owners] = await Promise.all([
        AuctionSettings.findOne({ tournament: tournamentId }),
        AuctionTeamOwner.find({ tournament: tournamentId })
            .populate('team', 'name shortName')
            .populate('owner', 'fullName'),
    ]);

    return {
        tournamentId,
        minSquadSize: settings?.minSquadSize ?? null,
        maxSquadSize: settings?.maxSquadSize ?? null,
        categoryCaps: settings?.categoryCaps ?? null,
        owners: owners.map((o) => ({
            teamId: o.team._id, teamName: o.team.name,
            userId: o.owner._id, userName: o.owner.fullName,
            budget: o.budget,
        })),
    };
};

const setAuctionSetup = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await canConfigureAuction(tournamentId, req.user._id);

    // Once the auction has started, its setup is frozen — the auction room
    // reads AuctionSettings/AuctionTeamOwner.budget as a stable baseline for
    // the whole session (squad rules aren't enforced live this phase, but
    // budget IS, and a budget that could change mid-auction would make
    // "remaining budget" meaningless).
    const activeSession = await AuctionSession.findOne({ tournament: tournament._id, status: { $ne: 'completed' } });
    if (activeSession) {
        throw new ApiError(409, "AUCTION_SETUP_LOCKED");
    }

    const settingsUpdate = {};
    if (req.body.minSquadSize !== undefined) {
        validateSquadSizeField(req.body.minSquadSize);
        settingsUpdate.minSquadSize = req.body.minSquadSize;
    }
    if (req.body.maxSquadSize !== undefined) {
        validateSquadSizeField(req.body.maxSquadSize);
        settingsUpdate.maxSquadSize = req.body.maxSquadSize;
    }
    if (req.body.categoryCaps !== undefined) {
        validateCategoryCaps(req.body.categoryCaps);
        settingsUpdate.categoryCaps = req.body.categoryCaps;
    }

    const ownersProvided = req.body.owners !== undefined;
    const resolvedOwners = ownersProvided
        ? await validateOwners(req.body.owners, tournament)
        : null;

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            if (Object.keys(settingsUpdate).length > 0) {
                // The cross-check must hold against the *effective* pair
                // after this update applies, not just the two fields
                // present in this request — otherwise a request that only
                // lowers maxSquadSize (leaving an already-stored, now-larger
                // minSquadSize untouched) would sail through and leave
                // min > max stored. Read inside the transaction (with the
                // session) rather than before it opens: two concurrent
                // PATCHes each touching only one bound could otherwise both
                // read the same pre-transaction snapshot and both pass
                // validation independently, each committing a value that's
                // individually fine but jointly invalid. Reading under the
                // transaction's snapshot isolation means a genuine conflict
                // surfaces as a write conflict that forces a retry against
                // the now-current document instead.
                if (settingsUpdate.minSquadSize !== undefined || settingsUpdate.maxSquadSize !== undefined) {
                    const existing = await AuctionSettings.findOne(
                        { tournament: tournament._id }, null, { session }
                    );
                    const effectiveMin = settingsUpdate.minSquadSize !== undefined
                        ? settingsUpdate.minSquadSize : existing?.minSquadSize;
                    const effectiveMax = settingsUpdate.maxSquadSize !== undefined
                        ? settingsUpdate.maxSquadSize : existing?.maxSquadSize;
                    if (effectiveMin != null && effectiveMax != null && effectiveMin > effectiveMax) {
                        throw new ApiError(400, "INVALID_SQUAD_SIZE");
                    }
                }
                settingsUpdate.createdBy = req.user._id;
                await AuctionSettings.findOneAndUpdate(
                    { tournament: tournament._id },
                    { $set: settingsUpdate },
                    { upsert: true, session }
                );
            }
            if (ownersProvided) {
                await AuctionTeamOwner.deleteMany({ tournament: tournament._id }, { session });
                if (resolvedOwners.length > 0) {
                    await AuctionTeamOwner.insertMany(
                        resolvedOwners.map((o) => ({
                            tournament: tournament._id, team: o.teamId, owner: o.userId,
                            budget: o.budget, createdBy: req.user._id,
                        })),
                        { session }
                    );
                }
            }
        });
    } finally {
        await session.endSession();
    }

    return res.status(200).json(
        new ApiResponse(200, await formatAuctionSetup(tournament._id), req.t("AUCTION_SETUP_SAVED"))
    );
});

const getAuctionSetup = catchAsync(async (req, res) => {
    const { tournamentId } = req.params;
    const { tournament } = await canViewAuctionSetup(tournamentId, req.user._id);

    return res.status(200).json(
        new ApiResponse(200, await formatAuctionSetup(tournament._id), req.t("AUCTION_SETUP_FETCHED"))
    );
});

export { setAuctionSetup, getAuctionSetup, formatAuctionSetup, canConfigureAuction, canViewAuctionSetup, validateSquadSizeField, validateCategoryCaps };
