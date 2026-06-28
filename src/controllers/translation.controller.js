import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Localization } from '../models/translations.model.js';
import { TranslationMeta } from '../models/translationMeta.model.js';
import incrementGlobalVersion from '../utils/incrementGlobalVersion.js';

const getTranslationByLang = catchAsync(async (req, res) => {
    const { lang } = req.params;

    if (!lang?.trim()) {
        throw new ApiError(400, "Language is required");
    }

    const translation = await Localization.findOne({
        languageCode: lang.toLowerCase(),
    });

    if (!translation) {
        throw new ApiError(404, "Language not found");
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            translation,
            "Language fetched successfully"
        )
    );
});

const getAllTranslations = catchAsync(async (req, res) => {
    const translations = await Localization.find();

    if (!translations.length) {
        throw new ApiError(404, "Translations not found");
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            translations,
            "Translations fetched successfully"
        )
    );
});

const getTranslationsVersion = catchAsync(async (req, res) => {
    const [meta, translations] = await Promise.all([
        TranslationMeta.findOne().lean(),
        Localization.find(
            {},
            {
                languageCode: 1,
                version: 1,
                _id: 0,
            }
        ).lean(),
    ]);

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                globalVersion: meta?.version ?? 1,
                languages: translations,
            },
            "Translations version fetched successfully"
        )
    );
});

const setTranslationKey = catchAsync(async (req, res) => {
    const { lang } = req.params;
    const { key, value } = req.body;

    if (!lang?.trim()) throw new ApiError(400, "Language is required");

    if (!key?.trim() || !value?.trim()) {
        throw new ApiError(400, "key and value are required");
    }

    const translation = await Localization.findOneAndUpdate(
        { languageCode: lang.toLowerCase() },
        { $set: { [`strings.${key}`]: value } },
        { upsert: true, new: true }
    );

    await incrementGlobalVersion();

    return res.status(200).json(
        new ApiResponse(
            200,
            translation,
            "Translation updated"
        )
    );
});

const deleteTranslationKey = catchAsync(async (req, res) => {
    const { lang, key } = req.params;

    if (!lang?.trim() || !key?.trim()) {
        throw new ApiError(400, "key and lang are required");
    }

    const translation = await Localization.findOne({
        languageCode: lang.toLowerCase(),
    });

    if (!translation) {
        throw new ApiError(404, "Language not found");
    }

    if (!translation.strings.has(key)) {
        throw new ApiError(404, "Key not found");
    }

    translation.strings.delete(key);
    await translation.save();

    await incrementGlobalVersion();

    return res.status(200).json(
        new ApiResponse(
            200,
            translation,
            "Key deleted"
        )
    );
});

const bulkSetTranslations = catchAsync(async (req, res) => {
    const translationsList = req.body;

    if (!Array.isArray(translationsList) || translationsList.length === 0) {
        throw new ApiError(
            400,
            "Request body must be a non-empty array"
        );
    }

    // Group updates by language
    const updatesByLanguage = {};

    for (const item of translationsList) {
        const { key, translations } = item;

        if (!key?.trim()) {
            throw new ApiError(400, "Key is required");
        }

        if (
            !translations ||
            typeof translations !== "object" ||
            Object.keys(translations).length === 0
        ) {
            throw new ApiError(
                400,
                `Translations are required for key '${key}'`
            );
        }

        for (const [lang, value] of Object.entries(translations)) {
            const languageCode = lang.toLowerCase();

            if (typeof value !== 'string' || !value.trim()) {
                throw new ApiError(400, `Invalid value for key '${key}' in lang '${lang}'`);
            }

            if (!updatesByLanguage[languageCode]) {
                updatesByLanguage[languageCode] = {};
            }

            updatesByLanguage[languageCode][`strings.${key}`] = value;
        }
    }

    const operations = Object.entries(updatesByLanguage).map(
        ([languageCode, updates]) => ({
            updateOne: {
                filter: { languageCode },
                update: {
                    $set: updates,
                    $inc: { version: 1 },
                },
                upsert: true,
            },
        })
    );

    await Localization.bulkWrite(operations);

    const updatedTranslations = await Localization.find({
        languageCode: {
            $in: Object.keys(updatesByLanguage),
        },
    });

    await incrementGlobalVersion();

    return res.status(200).json(
        new ApiResponse(
            200,
            updatedTranslations,
            "Translations updated successfully"
        )
    );
});

export { getTranslationByLang, getAllTranslations, getTranslationsVersion, setTranslationKey, deleteTranslationKey, bulkSetTranslations }