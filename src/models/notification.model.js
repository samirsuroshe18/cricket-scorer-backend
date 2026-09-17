import mongoose, { Schema } from "mongoose";

// One row per delivered (or attempted) push — the in-app inbox's source of
// truth. `title`/`body` are the already-localized strings sent to FCM, not
// a key + params: a push notification's OS-tray text is fixed at send
// time, and the inbox is meant to show exactly what the recipient's device
// showed, not a fresher re-render in whatever language they're on now.
export const NOTIFICATION_TYPES = [
    'match_started',
    'scorer_assigned',
    'your_turn_to_bat',
    'your_turn_to_bowl',
    'auction_started',
    'lot_sold',
];

const notificationSchema = new Schema(
    {
        recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        type:      { type: String, enum: NOTIFICATION_TYPES, required: true },
        title:     { type: String, required: true, trim: true },
        body:      { type: String, required: true, trim: true },
        // Deep-link payload — e.g. { matchId } or { tournamentId } — same
        // shape sent to the client as the FCM message's `data` block, kept
        // here too so the in-app inbox can navigate on tap without waiting
        // for a fresh push.
        data:      { type: Schema.Types.Mixed, default: {} },
        read:      { type: Boolean, default: false },
    },
    { timestamps: true }
);

// The inbox list query: newest-first for one recipient.
notificationSchema.index({ recipient: 1, createdAt: -1 });
// The unread-count query.
notificationSchema.index({ recipient: 1, read: 1 });

export const Notification = mongoose.model('Notification', notificationSchema);
