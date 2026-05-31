import mongoose, {Schema} from "mongoose";

const EXTRA_TYPES   = ['wide', 'no_ball', 'bye', 'leg_bye'];
const WICKET_TYPES  = ['bowled', 'caught', 'lbw', 'run_out', 'stumped', 'hit_wicket', 'obstructing', 'timed_out'];

// Snapshot of innings state BEFORE this ball was applied
// Used to restore state on undo — O(1) rollback
const preEventStateSchema = new Schema(
  {
    totalRuns:          { type: Number, required: true },
    wickets:            { type: Number, required: true },
    legalBalls:         { type: Number, required: true },
    totalBalls:         { type: Number, required: true },
    oversCompleted:     { type: Number, required: true },
    currentBatterId:    { type: Schema.Types.ObjectId },
    nonStrikerId:       { type: Schema.Types.ObjectId },
    currentBowlerId:    { type: Schema.Types.ObjectId },
    overTotalRuns:      { type: Number, required: true },
    overLegalDeliveries:{ type: Number, required: true },
    extrasSnapshot:     { type: Schema.Types.Mixed },   // full extras object
  },
  { _id: false }
);

const ballEventSchema = new Schema(
  {
    matchId:          { type: Schema.Types.ObjectId, ref: 'Match',   required: true },
    inningsId:        { type: Schema.Types.ObjectId, ref: 'Innings', required: true },
    overId:           { type: Schema.Types.ObjectId, ref: 'Over',    required: true },
    overNumber:       { type: Number, required: true },   // denormalized
    ballNumber:       { type: Number, required: true },   // within over
    absoluteBallSeq:  { type: Number, required: true },   // global seq in innings for undo

    batsmanId:        { type: Schema.Types.ObjectId, ref: 'Player', required: true },
    bowlerId:         { type: Schema.Types.ObjectId, ref: 'Player', required: true },
    nonStrikerId:     { type: Schema.Types.ObjectId, ref: 'Player', required: true },

    runs:             { type: Number, required: true, min: 0, max: 6 },
    extras:           { type: Number, default: 0, min: 0 },
    extraType:        { type: String, enum: EXTRA_TYPES, default: null },

    isWicket:         { type: Boolean, default: false },
    wicketType:       { type: String, enum: WICKET_TYPES, default: null },
    dismissedPlayerId:{ type: Schema.Types.ObjectId, ref: 'Player' },

    isLegal:          { type: Boolean, required: true },  // !wide && !no_ball
    strikeRotated:    { type: Boolean, default: false },

    // State snapshot for O(1) undo
    preEventState:    { type: preEventStateSchema, required: true },
  },
  {
    timestamps: { createdAt: 'timestamp', updatedAt: false },
  }
);

// Primary undo index: latest ball in innings
ballEventSchema.index({ inningsId: 1, absoluteBallSeq: -1 });
// Over breakdown
ballEventSchema.index({ inningsId: 1, overNumber: 1, ballNumber: 1 });
// Match-level queries
ballEventSchema.index({ matchId: 1 });
// Future: player stats
ballEventSchema.index({ batsmanId: 1 });
ballEventSchema.index({ bowlerId: 1 });

// Immutability guard — ball events should never be updated, only deleted on undo
ballEventSchema.pre('updateOne', function () {
  throw new Error('BallEvent documents are immutable. Use undo (delete) instead.');
});
ballEventSchema.pre('findOneAndUpdate', function () {
  throw new Error('BallEvent documents are immutable. Use undo (delete) instead.');
});

export const BallEvent = mongoose.model('BallEvent', ballEventSchema);