import mongoose, { Schema } from "mongoose";

// One row per (player, match) — the flattened per-player contribution a
// completed match makes toward that player's career, sourced entirely from
// the two Scorecard documents generateScorecard already produces. See
// "Career stats computation" in docs/api.md.
//
// The unique index is what makes the career-stats increment idempotent under
// a correction: undoing and re-scoring a completed match's last ball
// re-completes it, generateScorecard reruns, and this row gets *replaced*
// (findOneAndUpdate, not inserted again) rather than double-counted. The
// delta between the old and new document here is what CareerStats.$inc
// applies — see src/utils/careerStats.js.
const battingLineSchema = new Schema(
  {
    runs:       { type: Number, required: true },
    balls:      { type: Number, required: true },
    fours:      { type: Number, required: true },
    sixes:      { type: Number, required: true },
    isNotOut:   { type: Boolean, required: true },
    // Stored as booleans on the row, not derived from `runs` at read time —
    // that's what lets a correction's delta stay a plain $inc (old flag vs
    // new flag), rather than needing a recompute of the threshold every time.
    wasFifty:   { type: Boolean, required: true },
    wasHundred: { type: Boolean, required: true },
  },
  { _id: false }
);

const bowlingLineSchema = new Schema(
  {
    legalDeliveries: { type: Number, required: true },
    runs:            { type: Number, required: true },
    wickets:         { type: Number, required: true },
    maidens:         { type: Number, required: true },
    wides:           { type: Number, required: true },
    noBalls:         { type: Number, required: true },
  },
  { _id: false }
);

const playerMatchStatsSchema = new Schema(
  {
    playerId:    { type: Schema.Types.ObjectId, ref: 'Player', required: true },
    matchId:     { type: Schema.Types.ObjectId, ref: 'Match', required: true },
    // A player bats in at most one innings and bowls in at most the other of
    // a two-innings match — never two batting or two bowling lines from one
    // match, so a single embedded line each (not an array) is the correct
    // shape, not a simplification.
    battingLine: { type: battingLineSchema, default: null },
    bowlingLine: { type: bowlingLineSchema, default: null },
    generatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

playerMatchStatsSchema.index({ playerId: 1, matchId: 1 }, { unique: true });

export const PlayerMatchStats = mongoose.model('PlayerMatchStats', playerMatchStatsSchema);
