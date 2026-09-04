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
    tossWinner:      { type: String, enum: TEAM_SIDE },
    tossDecision:    { type: String, enum: ['bat', 'bowl'] },
    battingFirst:    { type: String, enum: TEAM_SIDE },
    currentInnings:  { type: Number, default: 1, enum: [1, 2] },
    status:          { type: String, default: 'upcoming', enum: MATCH_STATUS },
    venue:           { type: String, trim: true, maxlength: 100 },
    matchType:       { type: String, default: 'friendly', enum: MATCH_TYPES },
    createdBy:       { type: Schema.Types.ObjectId, ref: 'User', index: true },
    // The share code a spectator types. Uppercase on write so lookups can
    // uppercase the input and compare directly — a code read out across a
    // ground comes back in whatever case the typist felt like.
    joinCode:        { type: String, uppercase: true, trim: true, minlength: 6, maxlength: 6 },
    result:          { type: matchResultSchema },
    syncStatus:      { type: String, default: 'local', enum: SYNC_STATUS },
    isDeleted:       { type: Boolean, default: false },
    completedAt:     { type: Date },
  },
  { timestamps: true }
);

// Compound index for history screen: my matches, newest first
matchSchema.index({ createdBy: 1, createdAt: -1 });
// Also serves equality queries on `status` alone — don't add a separate
// single-field index on `status`, it would be a redundant prefix of this one.
matchSchema.index({ status: 1, createdAt: -1 });
// Cloud sync queue: find all unsynced matches. Also serves equality queries
// on `syncStatus` alone — same reasoning as above, don't duplicate it.
matchSchema.index({ syncStatus: 1, updatedAt: 1 });
// Team past-results (GET /v1/team/:teamId/matches): a team can appear as
// either side, so the query is an $or across these two fields — Mongo can't
// satisfy that with one compound index, hence one per side. All statuses are
// shown (no status filter), so `status` doesn't belong in either index.
matchSchema.index({ teamA: 1, createdAt: -1 });
matchSchema.index({ teamB: 1, createdAt: -1 });
// The spectator lookup, and the constraint that makes createMatch's
// retry-on-E11000 correct rather than hopeful. SPARSE because every match
// written before share codes existed has no joinCode, and a plain unique index
// would treat all those nulls as duplicates of each other and reject them.
matchSchema.index({ joinCode: 1 }, { unique: true, sparse: true });

// Virtual: cannot have same team on both sides
matchSchema.pre('validate', function () {
  if (this.teamA && this.teamB && this.teamA.equals(this.teamB)) {
    throw new Error('Team A and Team B cannot be the same');
  }
});

export const Match = mongoose.model('Match', matchSchema);