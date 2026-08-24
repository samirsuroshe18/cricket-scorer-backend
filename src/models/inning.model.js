import mongoose, {Schema} from "mongoose";

const extrasSchema = new Schema(
  {
    wides:   { type: Number, default: 0, min: 0 },
    noBalls: { type: Number, default: 0, min: 0 },
    byes:    { type: Number, default: 0, min: 0 },
    legByes: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const inningSchema = new Schema(
  {
    matchId:          { type: Schema.Types.ObjectId, ref: 'Match', required: true, index: true },
    inningsNumber:    { type: Number, required: true, enum: [1, 2] },
    battingTeam:      { type: String, required: true, enum: ['teamA', 'teamB'] },
    bowlingTeam:      { type: String, required: true, enum: ['teamA', 'teamB'] },
    totalRuns:        { type: Number, default: 0, min: 0 },
    wickets:          { type: Number, default: 0, min: 0, max: 10 },
    legalBalls:       { type: Number, default: 0, min: 0 },
    totalBalls:       { type: Number, default: 0, min: 0 },
    oversCompleted:   { type: Number, default: 0, min: 0 },
    target:           { type: Number },  // only set for innings 2
    extras:           { type: extrasSchema, default: () => ({}) },

    // Live state pointers — updated on every ball. The names are denormalized
    // alongside the ids so the scoring hot path can report who is on strike
    // without a Player lookup per delivery, the same way Scorecard's batting
    // lines carry playerName. Rotation swaps both pairs together.
    strikerId:        { type: Schema.Types.ObjectId, ref: 'Player' },
    strikerName:      { type: String, trim: true, maxlength: 50 },
    nonStrikerId:     { type: Schema.Types.ObjectId, ref: 'Player' },
    nonStrikerName:   { type: String, trim: true, maxlength: 50 },
    currentBowlerId:  { type: Schema.Types.ObjectId, ref: 'Player' },

    status:           { type: String, default: 'in_progress', enum: ['in_progress', 'completed'] },
    completionReason: {
      type: String,
      enum: ['overs_complete', 'all_out', 'target_achieved', 'abandoned'],
    },
  },
  { timestamps: true }
);

// Unique: only one innings 1 and one innings 2 per match
inningSchema.index({ matchId: 1, inningsNumber: 1 }, { unique: true });

export const Inning = mongoose.model('Inning', inningSchema);