import mongoose, { Schema } from "mongoose";
import { PLAYER_ROLES } from "./player.model.js";

// Category caps only apply to a real playing role — 'unknown' is excluded,
// nothing meaningful to cap when the role itself is undetermined.
export const CATEGORY_CAP_ROLES = PLAYER_ROLES.filter((role) => role !== 'unknown');

const auctionSettingsSchema = new Schema(
  {
    tournament:   { type: Schema.Types.ObjectId, ref: 'Tournament', required: true, unique: true },
    minSquadSize: { type: Number, min: 1, max: 100 },
    maxSquadSize: { type: Number, min: 1, max: 100 },
    // Plain object keyed by a CATEGORY_CAP_ROLES member -> max count for
    // that role, e.g. {"wicketkeeper": 3}. Not a Mongoose Map: small,
    // fixed-key-space, always read/written whole rather than queried
    // per-key.
    categoryCaps: { type: Schema.Types.Mixed },
    createdBy:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

export const AuctionSettings = mongoose.model('AuctionSettings', auctionSettingsSchema);
