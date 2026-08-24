import mongoose, { Schema } from "mongoose";

const PLAYER_ROLES = ['batsman', 'bowler', 'allrounder', 'wicketkeeper', 'unknown'];

const playerSchema = new Schema(
  {
    name:         { type: String, required: true, trim: true, maxlength: 50 },
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
// each miss the "existing" check and insert a duplicate Player. Mirrors the
// {createdBy, name} unique index on Team.
playerSchema.index({ teamId: 1, name: 1 }, { unique: true });

export const Player = mongoose.model('Player', playerSchema)