import mongoose, {Schema} from "mongoose";

const overExtrasSchema = new Schema(
  {
    wides:   { type: Number, default: 0 },
    noBalls: { type: Number, default: 0 },
  },
  { _id: false }
);

const overSchema = new Schema(
  {
    matchId:          { type: Schema.Types.ObjectId, ref: 'Match', required: true },
    inningsId:        { type: Schema.Types.ObjectId, ref: 'Innings', required: true, index: true },
    overNumber:       { type: Number, required: true, min: 1 },
    bowlerId:         { type: Schema.Types.ObjectId, ref: 'Player', required: true },
    totalRuns:        { type: Number, default: 0, min: 0 },
    wickets:          { type: Number, default: 0, min: 0 },
    legalDeliveries:  { type: Number, default: 0, min: 0, max: 6 },
    extras:           { type: overExtrasSchema, default: () => ({}) },
    isComplete:       { type: Boolean, default: false },
  },
  { timestamps: true }
);

overSchema.index({ inningsId: 1, overNumber: 1 }, { unique: true });

export const Over = mongoose.model('Over', overSchema);