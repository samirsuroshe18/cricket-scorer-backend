import mongoose, { Schema } from "mongoose";

export const AUCTION_SESSION_STATUSES = ['active', 'paused', 'completed'];

const auctionSessionSchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true, unique: true },
    status: { type: String, enum: AUCTION_SESSION_STATUSES, required: true, default: 'active' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const AuctionSession = mongoose.model('AuctionSession', auctionSessionSchema);
