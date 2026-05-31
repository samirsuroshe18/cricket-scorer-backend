import mongoose, {Schema} from "mongoose";

const TEAM_SIDE = ['teamA', 'teamB'];
const MATCH_STATUS = ['upcoming', 'live', 'innings_break', 'completed', 'abandoned'];
const MATCH_TYPES  = ['friendly', 'turf', 'tournament', 'practice'];
const SYNC_STATUS  = ['local', 'syncing', 'synced', 'conflict'];

const matchResultSchema = new Schema(
  {
    winner:      { type: String, enum: [...TEAM_SIDE, 'tie', 'no_result'] },
    margin:      { type: Number, min: 0 },
    marginType:  { type: String, enum: ['runs', 'wickets'] },
    description: { type: String, maxlength: 200 },
  },
  { _id: false }
);

const matchSchema = new Schema(
  {
    title:           { type: String, trim: true, maxlength: 80 },
    teamA:           { type: Schema.Types.ObjectId, ref: 'Team', required: true },
    teamB:           { type: Schema.Types.ObjectId, ref: 'Team', required: true },
    totalOvers:      { type: Number, required: true, min: 1, max: 50 },
    tossWinner:      { type: String, required: true, enum: TEAM_SIDE },
    tossDecision:    { type: String, required: true, enum: ['bat', 'bowl'] },
    battingFirst:    { type: String, required: true, enum: TEAM_SIDE },
    currentInnings:  { type: Number, default: 1, enum: [1, 2] },
    status:          { type: String, default: 'upcoming', enum: MATCH_STATUS, index: true },
    venue:           { type: String, trim: true, maxlength: 100 },
    matchType:       { type: String, default: 'friendly', enum: MATCH_TYPES },
    createdBy:       { type: Schema.Types.ObjectId, ref: 'User', index: true },
    result:          { type: matchResultSchema },
    syncStatus:      { type: String, default: 'local', enum: SYNC_STATUS, index: true },
    isDeleted:       { type: Boolean, default: false },
    completedAt:     { type: Date },
  },
  { timestamps: true }
);

// Compound index for history screen: my matches, newest first
matchSchema.index({ createdBy: 1, createdAt: -1 });
matchSchema.index({ status: 1, createdAt: -1 });
// Cloud sync queue: find all unsynced matches
matchSchema.index({ syncStatus: 1, updatedAt: 1 });

// Virtual: cannot have same team on both sides
matchSchema.pre('validate', function (next) {
  if (this.teamA && this.teamB && this.teamA.equals(this.teamB)) {
    return next(new Error('Team A and Team B cannot be the same'));
  }
  next();
});

export const Match = mongoose.model('Match', matchSchema);