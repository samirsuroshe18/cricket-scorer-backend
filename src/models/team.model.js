import mongoose, {Schema} from "mongoose";

const teamSchema = new Schema(
  {
    name:       { type: String, required: true, trim: true, maxlength: 50 },
    shortName:  { type: String, trim: true, maxlength: 5, uppercase: true },
    // The roster for THIS match's side — who a name resolves against for the
    // opposing-team collision check, since Player itself is scorer-scoped,
    // not team-scoped (see player.model.js). Maintained via $addToSet by
    // findOrCreatePlayer/resolveBowler, never read/written directly here.
    players:    [{ type: Schema.Types.ObjectId, ref: 'Player' }],
    createdBy:  { type: Schema.Types.ObjectId, ref: 'User' },
    isDeleted:  { type: Boolean, default: false },
  },
  { timestamps: true }
);

teamSchema.index({ name: 'text' });
// Also serves equality queries on `createdBy` alone — don't add a separate
// single-field index on `createdBy`, it would be a redundant prefix.
teamSchema.index({ createdBy: 1, createdAt: -1 });
// No unique index on {createdBy, name}: teams are match-scoped, and the same
// scorer legitimately creates a fresh "Team A" for every new match — see
// createTeam in match.controller.js.

export const Team = mongoose.model('Team', teamSchema);