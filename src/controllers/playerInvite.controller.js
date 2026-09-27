import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { PlayerInvite } from '../models/playerInvite.model.js';
import { linkPlayerToUser } from '../utils/linkPlayerToUser.js';

// Every route here is the invitee's own. An invite that belongs to someone
// else, or whose team has since been deleted, is the same 404 — the
// existence of another person's invite is never confirmed, and a dead team's
// roster is not a place to link a player.
const findInviteForInvitee = async (inviteId, userId) => {
    const invite = await PlayerInvite.findOne({ _id: inviteId, invitedUser: userId })
        .populate('team', 'name isDeleted')
        .populate('invitedBy', 'fullName')
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

// Accepting is the account holder's own claim, through the same compare-and-swap
// as POST /v1/player/:id/claim. A lost claim race (409) leaves the invite
// pending: the ask is still open even though this player can no longer satisfy it.
const acceptPlayerInvite = catchAsync(async (req, res) => {
    const invite = await findInviteForInvitee(req.params.inviteId, req.user._id);

    if (invite.status === 'declined') {
        throw new ApiError(409, "INVITE_ALREADY_DECLINED");
    }
    if (invite.status === 'pending') {
        await linkPlayerToUser(invite.player._id, req.user._id);
        await PlayerInvite.updateOne(
            { _id: invite._id, status: 'pending' },
            { $set: { status: 'accepted', respondedAt: new Date() } }
        );
    }

    return res.status(200).json(new ApiResponse(200, {
        inviteId: invite._id,
        status: 'accepted',
        playerId: invite.player._id,
    }, req.t("PLAYER_INVITE_ACCEPTED")));
});

// Declining leaves the Player on the roster, unlinked — the scorer still has a
// named player, exactly as if they had typed it.
const declinePlayerInvite = catchAsync(async (req, res) => {
    const invite = await findInviteForInvitee(req.params.inviteId, req.user._id);

    if (invite.status === 'accepted') {
        throw new ApiError(409, "INVITE_ALREADY_ACCEPTED");
    }
    if (invite.status === 'pending') {
        await PlayerInvite.updateOne(
            { _id: invite._id, status: 'pending' },
            { $set: { status: 'declined', respondedAt: new Date() } }
        );
    }

    return res.status(200).json(new ApiResponse(200, {
        inviteId: invite._id,
        status: 'declined',
    }, req.t("PLAYER_INVITE_DECLINED")));
});

export { getPlayerInvite, acceptPlayerInvite, declinePlayerInvite };
