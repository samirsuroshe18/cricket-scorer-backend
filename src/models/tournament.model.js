import mongoose, { Schema } from "mongoose";

const TOURNAMENT_FORMATS = ['knockout', 'round_robin', 'league'];
const TOURNAMENT_STATUS  = ['upcoming', 'ongoing', 'completed'];

const tournamentSchema = new Schema(
  {
    name:         { type: String, required: true, trim: true, maxlength: 100 },
    // Derived from `name` by whichever controller creates a tournament, same
    // convention as Organization.nameLower and Player.nameLower — see
    // organization.model.js's comment on why a schema hook isn't used
    // instead (findOrCreate-style upserts bypass document middleware).
    nameLower:    { type: String, required: true, trim: true },
    // Required, unlike Team.organization — tournament hosting is an
    // org-tier feature (docs/roadmap.md Phase 3), so there is no
    // standalone-tournament case to leave room for.
    organization: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    format:       { type: String, enum: TOURNAMENT_FORMATS, required: true },
    // Many-to-many: a Team persists across tournaments and can join more
    // than one. Embedded rather than a join collection — tournament scale
    // is tens of teams, not thousands, same reasoning as
    // Organization.members. `joinedAt` mirrors Organization.members'
    // `addedAt`.
    teams: [
      {
        team:     { type: Schema.Types.ObjectId, ref: 'Team', required: true },
        joinedAt: { type: Date, default: Date.now },
      },
    ],
    status:    { type: String, default: 'upcoming', enum: TOURNAMENT_STATUS },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Unique per organization, same shape as Organization's own {owner,
// nameLower} — one organization can't run two tournaments with the same
// name (case-insensitive via nameLower). Deliberately not global
// uniqueness: two different organizations naming a tournament "Summer T20"
// is expected, not a collision.
tournamentSchema.index({ organization: 1, nameLower: 1 }, { unique: true });
// Supports "which tournaments does this org run" listings.
tournamentSchema.index({ organization: 1, createdAt: -1 });
// Supports "which tournaments is this team entered in."
tournamentSchema.index({ 'teams.team': 1 });

export const Tournament = mongoose.model('Tournament', tournamentSchema);
