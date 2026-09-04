import mongoose, { Schema } from "mongoose";

// Max-of-all-time, not a sum — never delta-updated. See "Exact fields and
// formulas" / "The hook point" in docs/api.md for why this needs a targeted
// rescan of PlayerMatchStats on a correction, instead of a running $inc like
// every other field here.
const highScoreSchema = new Schema(
  {
    runs:     { type: Number, required: true },
    isNotOut: { type: Boolean, required: true },
    matchId:  { type: Schema.Types.ObjectId, ref: 'Match', required: true },
  },
  { _id: false }
);

const bestBowlingSchema = new Schema(
  {
    wickets: { type: Number, required: true },
    runs:    { type: Number, required: true },
    matchId: { type: Schema.Types.ObjectId, ref: 'Match', required: true },
  },
  { _id: false }
);

// One row per Player — the running career total, updated incrementally (see
// src/utils/careerStats.js) rather than aggregated on read. `average`,
// `strikeRate` and `economy` are deliberately NOT stored: they're one
// division each, computed at read time from the sums below, so a stored rate
// can never drift from the totals it's derived from.
const careerStatsSchema = new Schema(
  {
    playerId:      { type: Schema.Types.ObjectId, ref: 'Player', required: true, unique: true },

    matchesPlayed: { type: Number, default: 0 },

    // Batting
    inningsBatted: { type: Number, default: 0 },
    runs:          { type: Number, default: 0 },
    ballsFaced:    { type: Number, default: 0 },
    // The average's divisor. NEVER inningsBatted — a not-out innings adds to
    // runs and inningsBatted but not timesOut. See docs/api.md.
    timesOut:      { type: Number, default: 0 },
    notOuts:       { type: Number, default: 0 },
    fours:         { type: Number, default: 0 },
    sixes:         { type: Number, default: 0 },
    fifties:       { type: Number, default: 0 },
    hundreds:      { type: Number, default: 0 },
    highScore:     { type: highScoreSchema, default: null },

    // Bowling
    inningsBowled:   { type: Number, default: 0 },
    legalDeliveries: { type: Number, default: 0 },
    runsConceded:    { type: Number, default: 0 },
    wickets:         { type: Number, default: 0 },
    maidens:         { type: Number, default: 0 },
    bestBowling:     { type: bestBowlingSchema, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: 'updatedAt' } }
);

export const CareerStats = mongoose.model('CareerStats', careerStatsSchema);
