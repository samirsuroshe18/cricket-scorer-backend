import mongoose, { Schema } from "mongoose";

const playerPoolEntrySchema = new Schema(
  {
    tournament: { type: Schema.Types.ObjectId, ref: 'Tournament', required: true },
    player:     { type: Schema.Types.ObjectId, ref: 'Player', required: true },
    // Play-money only, per docs/roadmap.md's settled decision — a plain
    // organizer-entered integer, never derived from career stats. See
    // docs/superpowers/specs/2026-09-07-player-pool-registration-design.md
    // §4 for why stats are never read by this feature at all.
    basePrice:  { type: Number, required: true, min: 1, max: 100000000 },
    createdBy:  { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

// One registration per player per tournament — re-registering an
// already-pooled player is a base-price edit (PATCH), not a second entry.
playerPoolEntrySchema.index({ tournament: 1, player: 1 }, { unique: true });
// Supports the pool listing's natural read order (registration order).
playerPoolEntrySchema.index({ tournament: 1, createdAt: 1 });

export const PlayerPoolEntry = mongoose.model('PlayerPoolEntry', playerPoolEntrySchema);
