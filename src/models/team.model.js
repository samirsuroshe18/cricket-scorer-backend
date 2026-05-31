import mongoose, {Schema} from "mongoose";

const teamSchema = new Schema(
  {
    name:       { type: String, required: true, trim: true, maxlength: 50 },
    shortName:  { type: String, trim: true, maxlength: 5, uppercase: true },
    players:    [{ type: Schema.Types.ObjectId, ref: 'Player' }],
    createdBy:  { type: Schema.Types.ObjectId, ref: 'User', index: true },
    isDeleted:  { type: Boolean, default: false },
  },
  { timestamps: true }
);

teamSchema.index({ name: 'text' });
teamSchema.index({ createdBy: 1, createdAt: -1 });

export const Team = mongoose.model('Team', teamSchema);