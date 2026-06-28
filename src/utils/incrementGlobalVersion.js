const incrementGlobalVersion = () =>
    TranslationMeta.findOneAndUpdate(
        {},
        { $inc: { version: 1 } },
        { upsert: true, new: true }
    );

export default incrementGlobalVersion;