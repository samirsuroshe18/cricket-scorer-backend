import mongoose, { Schema } from "mongoose";

const PLAYER_ROLES = ['batsman', 'bowler', 'allrounder', 'wicketkeeper', 'unknown'];

const playerSchema = new Schema(
  {
    name:         { type: String, required: true, trim: true, maxlength: 50 },
    // Derived from `name` by every writer (findOrCreatePlayer, resolveBowler)
    // rather than by a schema hook — findOrCreatePlayer's upsert bypasses
    // document middleware entirely, so a hook here would silently not run for
    // the one call site this field exists for. `name` keeps whatever case was
    // first typed, for display; this is the actual identity key.
    nameLower:    { type: String, required: true, trim: true },
    jerseyNumber: { type: Number, min: 0, max: 999 },
    role:         { type: String, enum: PLAYER_ROLES, default: 'unknown' },
    teamId:       { type: Schema.Types.ObjectId, ref: 'Team', index: true },
    createdBy:    { type: Schema.Types.ObjectId, ref: 'User' },
    isDeleted:    { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Unique so the find-or-create upsert in match.controller.js is race-safe —
// without it, two concurrent start-innings calls naming the same new opener can
// each miss the "existing" check and insert a duplicate Player. Team has no
// equivalent: see team.model.js's own comment on why a name there is
// deliberately reusable across matches, unlike a Player within one team.
//
// Keyed on `nameLower`, not `name`: every collision rule in match.controller.js
// (openers must differ, bowler can't bowl consecutive overs, incoming-batsman
// reuse) already compares names case-insensitively. Keying identity itself on
// exact case let "Rahul" and "rahul" pass all of those checks — none of them
// apply across roles/innings — and still fragment into two Player documents.
playerSchema.index({ teamId: 1, nameLower: 1 }, { unique: true });

export const Player = mongoose.model('Player', playerSchema)