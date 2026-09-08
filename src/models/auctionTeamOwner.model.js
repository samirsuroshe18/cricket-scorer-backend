import mongoose, { Schema } from "mongoose";

const auctionTeamOwnerSchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true },
    team:       { type: Schema.Types.ObjectId, ref: 'Team', required: true },
    owner:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Play-money only, per docs/roadmap.md's settled decision — a plain
    // organizer-entered integer, never derived from career stats. Same
    // reasoning as PlayerPoolEntry.basePrice.
    budget:     { type: Number, required: true, min: 1, max: 100000000 },
    createdBy:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// One owner per team...
auctionTeamOwnerSchema.index({ tournament: 1, team: 1 }, { unique: true });
// ...and one team per owner, within a tournament.
auctionTeamOwnerSchema.index({ tournament: 1, owner: 1 }, { unique: true });

export const AuctionTeamOwner = mongoose.model('AuctionTeamOwner', auctionTeamOwnerSchema);
