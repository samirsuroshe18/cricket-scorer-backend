import mongoose, {Schema} from "mongoose";

const battingLineSchema = new Schema(
  {
    playerId:      { type: Schema.Types.ObjectId, ref: 'Player' },
    playerName:    { type: String, required: true },  // denormalized
    runs:          { type: Number, default: 0 },
    balls:         { type: Number, default: 0 },
    fours:         { type: Number, default: 0 },
    sixes:         { type: Number, default: 0 },
    strikeRate:    { type: Number, default: 0 },
    dismissalType: { type: String },
    isNotOut:      { type: Boolean, default: false },
  },
  { _id: false }
);

const bowlingLineSchema = new Schema(
  {
    playerId:   { type: Schema.Types.ObjectId, ref: 'Player'},
    playerName: { type: String, required: true },  // denormalized
    overs:      { type: String },     // "4.2" format
    maidens:    { type: Number, default: 0 },
    runs:       { type: Number, default: 0 },
    wickets:    { type: Number, default: 0 },
    economy:    { type: Number, default: 0 },
    wides:      { type: Number, default: 0 },
    noBalls:    { type: Number, default: 0 },
  },
  { _id: false }
);

const scorecardSchema = new Schema(
  {
    matchId:        { type: Schema.Types.ObjectId, ref: 'Match',   required: true, index: true },
    inningsId:      { type: Schema.Types.ObjectId, ref: 'Inning', required: true },
    inningsNumber:  { type: Number, required: true },
    battingTeam:    { type: String, required: true },
    battingScores:  [battingLineSchema],
    bowlingScores:  [bowlingLineSchema],
    totalRuns:      { type: Number, required: true },
    totalWickets:   { type: Number, required: true },
    totalOvers:     { type: String, required: true },  // "12.3"
    extras: {
      total:   { type: Number, default: 0 },
      wides:   { type: Number, default: 0 },
      noBalls: { type: Number, default: 0 },
      byes:    { type: Number, default: 0 },
      legByes: { type: Number, default: 0 },
    },
    generatedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

scorecardSchema.index({ matchId: 1, inningsNumber: 1 }, { unique: true });

export const Scorecard = mongoose.model('Scorecard', scorecardSchema);