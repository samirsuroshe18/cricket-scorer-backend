import mongoose, { Schema } from "mongoose";

const localizationSchema = new Schema(
    {
        languageCode: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
            enum: ['en', 'hi', 'mr'],
        },

        strings: {
            type: Map,
            of: String,
            required: true,
            default: {},
        },

        version: {
            type: Number,
            required: true,
            default: 1,
            min: 1,
        },
    },
    { timestamps: true },
);

localizationSchema.pre('save', async function () {
  if (this.isModified('strings')) {
    this.version += 1;
  }
});

export const Localization = mongoose.model("Localization", localizationSchema);