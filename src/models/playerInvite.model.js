import mongoose, { Schema } from "mongoose";

export const PLAYER_INVITE_STATUSES = ['pending', 'accepted', 'declined'];

// A scorer's request that an existing app user be linked to a roster Player.
// Accepting it is what sets Player.linkedUserId (through the same
// compare-and-swap the self-claim flow uses); this row only records the ask
// and its outcome. Kept after a response rather than deleted so a decline is
// visible in history and does not block a later, fresh invite.
const playerInviteSchema = new Schema(
    {
        player:      { type: Schema.Types.ObjectId, ref: 'Player', required: true },
        team:        { type: Schema.Types.ObjectId, ref: 'Team', required: true },
        invitedUser: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        invitedBy:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
        status:      { type: String, enum: PLAYER_INVITE_STATUSES, default: 'pending', required: true },
        respondedAt: { type: Date },
    },
    { timestamps: true }
);

// At most one open invite per invitee per team. Partial, so accepted/declined
// rows never block a new invite.
playerInviteSchema.index(
    { team: 1, invitedUser: 1 },
    { unique: true, partialFilterExpression: { status: 'pending' } }
);
// The invitee's own list of invites, filtered by status.
playerInviteSchema.index({ invitedUser: 1, status: 1 });

export const PlayerInvite = mongoose.model('PlayerInvite', playerInviteSchema);
