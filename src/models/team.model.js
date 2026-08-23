import mongoose, {Schema} from "mongoose";

const teamSchema = new Schema(
  {
    name:       { type: String, required: true, trim: true, maxlength: 50 },
    shortName:  { type: String, trim: true, maxlength: 5, uppercase: true },
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
// Makes the find-or-create upsert in match.controller.js race-safe —
// without this, two concurrent create-match calls for the same new team
// name can each miss the "existing" check and insert a duplicate Team.
teamSchema.index({ createdBy: 1, name: 1 }, { unique: true });

export const Team = mongoose.model('Team', teamSchema);