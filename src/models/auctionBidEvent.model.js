import mongoose, { Schema } from "mongoose";

const auctionBidEventSchema = new Schema(
  {
    lot: { type: Schema.Types.ObjectId, ref: 'AuctionLot', required: true },
    session: { type: Schema.Types.ObjectId, ref: 'AuctionSession', required: true },
    bidder: { type: Schema.Types.ObjectId, ref: 'AuctionTeamOwner', required: true },
    amount: { type: Number, required: true, min: 1, max: 100000000 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// A lot's bid history, oldest first — the exact read shape auction:join's
// ack and the live ticker both need.
auctionBidEventSchema.index({ lot: 1, createdAt: 1 });

export const AuctionBidEvent = mongoose.model('AuctionBidEvent', auctionBidEventSchema);
