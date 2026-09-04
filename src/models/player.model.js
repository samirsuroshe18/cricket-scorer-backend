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
    // No `teamId`. A Player used to belong to exactly one (match-scoped) Team
    // — see the player-identity rework in docs/api.md for why that made every
    // "career" span exactly one match. A Player now persists across every
    // match its scorer records; which team(s) it's rostered on, per match, is
    // Team.players, not a field here.
    createdBy:    { type: Schema.Types.ObjectId, ref: 'User' },
    isDeleted:    { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Unique so the find-or-create upsert in match.controller.js is race-safe —
// without it, two concurrent calls naming the same new player for the first
// time can each miss the "existing" check and insert a duplicate Player.
//
// Keyed on `{createdBy, nameLower}`: scorer-scoped, not team-scoped. Two
// different scorers each typing "Rahul" get two separate Players — no
// cross-scorer identity is implied or needed. The same scorer typing "Rahul"
// in two different matches gets the *same* Player, which is the entire point
// — see "Player identity — scorer-scoped rework" in docs/api.md. Keyed on
// `nameLower`, not `name`, for the same reason as before: every collision
// rule in match.controller.js compares names case-insensitively, and keying
// identity on exact case let "Rahul" and "rahul" fragment into two documents.
playerSchema.index({ createdBy: 1, nameLower: 1 }, { unique: true });

export const Player = mongoose.model('Player', playerSchema)
