import { TranslationMeta } from "../models/translationMeta.model.js";

const incrementGlobalVersion = () =>
    TranslationMeta.findOneAndUpdate(
        {},
        { $inc: { version: 1 } },
        { upsert: true, returnDocument: 'after' }
    );

export default incrementGlobalVersion;