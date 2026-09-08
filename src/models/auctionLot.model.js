import mongoose, { Schema } from "mongoose";

export const AUCTION_LOT_STATUSES = ['queued', 'active', 'sold', 'unsold'];

const auctionLotSchema = new Schema(
  {
    session: { type: Schema.Types.ObjectId, ref: 'AuctionSession', required: true },
    tournament: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true },
    poolEntry: { type: Schema.Types.ObjectId, ref: 'PlayerPoolEntry', required: true },
    player: { type: Schema.Types.ObjectId, ref: 'Player', required: true },
    basePrice: { type: Number, required: true, min: 1, max: 100000000 },
    currentBid: { type: Number, required: true, min: 1, max: 100000000 },
    currentBidder: { type: Schema.Types.ObjectId, ref: 'AuctionTeamOwner', default: null },
    status: { type: String, enum: AUCTION_LOT_STATUSES, required: true, default: 'queued' },
    endsAt: { type: Date, default: null },
    pausedRemainingMs: { type: Number, default: null },
    soldPrice: { type: Number, default: null },
    soldTo: { type: Schema.Types.ObjectId, ref: 'AuctionTeamOwner', default: null },
    sequence: { type: Number, required: true },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One lot per pool entry per session — start-auction snapshots the pool
// exactly once.
auctionLotSchema.index({ session: 1, poolEntry: 1 }, { unique: true });
// The resolution sweep's own query shape: active lots whose clock ran out.
auctionLotSchema.index({ session: 1, status: 1, endsAt: 1 });
// `next`'s own query shape: lowest-sequence queued lot in a session.
auctionLotSchema.index({ session: 1, status: 1, sequence: 1 });

export const AuctionLot = mongoose.model('AuctionLot', auctionLotSchema);
