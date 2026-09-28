import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { PlayerInvite } from '../models/playerInvite.model.js';
import { Team } from '../models/team.model.js';
import { linkPlayerToUser } from '../utils/linkPlayerToUser.js';
import { notifyUser } from '../utils/notify.js';

// Every route here is the invitee's own. An invite that belongs to someone
// else, or whose team has since been deleted, is the same 404 — the
// existence of another person's invite is never confirmed, and a dead team's
// roster is not a place to link a player.
const findInviteForInvitee = async (inviteId, userId) => {
    const invite = await PlayerInvite.findOne({ _id: inviteId, invitedUser: userId })
        .populate('team', 'name isDeleted')
        .populate('invitedBy', '_id fullName')
        .populate('player', 'name');
    if (!invite || !invite.team || invite.team.isDeleted) {
        throw new ApiError(404, "INVITE_NOT_FOUND");
    }
    return invite;
};

// Current state rather than the notification payload, which is frozen at send
// time — the invitee may already have answered from another device.
const getPlayerInvite = catchAsync(async (req, res) => {
    const invite = await findInviteForInvitee(req.params.inviteId, req.user._id);

    return res.status(200).json(new ApiResponse(200, {
        inviteId: invite._id,
        status: invite.status,
        teamId: invite.team._id,
        teamName: invite.team.name,
        invitedByName: invite.invitedBy?.fullName ?? null,
        playerName: invite.player?.name ?? null,
    }, req.t("PLAYER_INVITE_FETCHED")));
});

// Tells the scorer who sent the invite how it was answered. The payload carries
// no `inviteId` on purpose: the client opens the invitee's Accept / Decline sheet
// for any notification that has one, and this one is for the inviter.
const notifyInviter = (invite, req, outcome) => notifyUser({
    recipientId: invite.invitedBy?._id,
    type: `player_invite_${outcome}`,
    titleKey: `NOTIFICATION_PLAYER_INVITE_${outcome.toUpperCase()}_TITLE`,
    bodyKey: `NOTIFICATION_PLAYER_INVITE_${outcome.toUpperCase()}_BODY`,
    params: { invitee: req.user.fullName, team: invite.team.name },
    data: {
        type: `player_invite_${outcome}`,
        teamId: String(invite.team._id),
        teamName: invite.team.name,
    },
});

// Accepting is the account holder's own claim, through the same compare-and-swap
// as POST /v1/player/:id/claim, and is what puts the player on the team roster.
// A lost claim race (409) leaves the invite pending and the roster untouched.
// Link, roster and status are each idempotent, so a retry after a partial
// failure converges; the inviter is told only when this call changed the status.
const acceptPlayerInvite = catchAsync(async (req, res) => {
    const invite = await findInviteForInvitee(req.params.inviteId, req.user._id);

    if (invite.status === 'declined') {
        throw new ApiError(409, "INVITE_ALREADY_DECLINED");
    }
    if (invite.status === 'cancelled') {
        throw new ApiError(409, "INVITE_CANCELLED");
    }
    if (invite.status === 'pending') {
        await linkPlayerToUser(invite.player._id, req.user._id);
        await Team.updateOne({ _id: invite.team._id }, { $addToSet: { players: invite.player._id } });
        const { modifiedCount } = await PlayerInvite.updateOne(
            { _id: invite._id, status: 'pending' },
            { $set: { status: 'accepted', respondedAt: new Date() } }
        );
        if (modifiedCount === 1) await notifyInviter(invite, req, 'accepted');
    }

    return res.status(200).json(new ApiResponse(200, {
        inviteId: invite._id,
        status: 'accepted',
        playerId: invite.player._id,
    }, req.t("PLAYER_INVITE_ACCEPTED")));
});

// Declining leaves the Player unlinked and off the roster; the scorer keeps the
// Player document (it is theirs) and is told about the decline.
const declinePlayerInvite = catchAsync(async (req, res) => {
    const invite = await findInviteForInvitee(req.params.inviteId, req.user._id);

    if (invite.status === 'accepted') {
        throw new ApiError(409, "INVITE_ALREADY_ACCEPTED");
    }
    if (invite.status === 'cancelled') {
        throw new ApiError(409, "INVITE_CANCELLED");
    }
    if (invite.status === 'pending') {
        const { modifiedCount } = await PlayerInvite.updateOne(
            { _id: invite._id, status: 'pending' },
            { $set: { status: 'declined', respondedAt: new Date() } }
        );
        if (modifiedCount === 1) await notifyInviter(invite, req, 'declined');
    }

    return res.status(200).json(new ApiResponse(200, {
        inviteId: invite._id,
        status: 'declined',
    }, req.t("PLAYER_INVITE_DECLINED")));
});

export { getPlayerInvite, acceptPlayerInvite, declinePlayerInvite };
