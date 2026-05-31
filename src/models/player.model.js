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

playerSchema.index({ teamId: 1, name: 1 });

export const Player = mongoose.model('Player', playerSchema)