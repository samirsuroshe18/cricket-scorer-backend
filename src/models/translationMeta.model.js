import mongoose, {Schema} from "mongoose";

const translationMetaSchema = new Schema(
  {
    _id: {
      type: String,
      default: "singleton",  // Always the same ID — prevents duplicates
    },
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
  },
  { timestamps: true }
);

export const TranslationMeta = mongoose.model('TranslationMeta', translationMetaSchema);