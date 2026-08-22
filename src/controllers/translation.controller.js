import catchAsync from '../utils/catchAsync.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { Localization } from '../models/translations.model.js';
import { TranslationMeta } from '../models/translationMeta.model.js';
import incrementGlobalVersion from '../utils/incrementGlobalVersion.js';

const getTranslationByLang = catchAsync(async (req, res) => {
    const { lang } = req.params;

    if (!lang?.trim()) {
        throw new ApiError(400, "LANGUAGE_REQUIRED");
    }

    const translation = await Localization.findOne({
        languageCode: lang.toLowerCase(),
    }).lean();

    if (!translation) {
        throw new ApiError(404, "LANGUAGE_NOT_FOUND");
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            translation,
            req.t("LANGUAGE_FETCHED")
        )
    );
});

const getAllTranslations = catchAsync(async (req, res) => {
    // Bounded by the languageCode enum (en/hi/mr) — no pagination needed.
    const translations = await Localization.find().lean();

    if (!translations.length) {
        throw new ApiError(404, "TRANSLATIONS_NOT_FOUND");
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            translations,
            req.t("TRANSLATIONS_FETCHED")
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
            req.t("TRANSLATIONS_VERSION_FETCHED")
        )
    );
});

const setTranslationKey = catchAsync(async (req, res) => {
    const { lang } = req.params;
    const { key, value } = req.body;

    if (!lang?.trim()) throw new ApiError(400, "LANGUAGE_REQUIRED");

    if (!key?.trim() || !value?.trim()) {
        throw new ApiError(400, "KEY_VALUE_REQUIRED");
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
            req.t("TRANSLATION_UPDATED")
        )
    );
});

const deleteTranslationKey = catchAsync(async (req, res) => {
    const { lang, key } = req.params;

    if (!lang?.trim() || !key?.trim()) {
        throw new ApiError(400, "KEY_LANG_REQUIRED");
    }

    const translation = await Localization.findOne({
        languageCode: lang.toLowerCase(),
    });

    if (!translation) {
        throw new ApiError(404, "LANGUAGE_NOT_FOUND");
    }

    if (!translation.strings.has(key)) {
        throw new ApiError(404, "TRANSLATION_KEY_NOT_FOUND");
    }

    translation.strings.delete(key);
    await translation.save();

    await incrementGlobalVersion();

    return res.status(200).json(
        new ApiResponse(
            200,
            translation,
            req.t("TRANSLATION_KEY_DELETED")
        )
    );
});

const bulkSetTranslations = catchAsync(async (req, res) => {
    const translationsList = req.body;

    if (!Array.isArray(translationsList) || translationsList.length === 0) {
        throw new ApiError(400, "TRANSLATIONS_ARRAY_REQUIRED");
    }

    // Group updates by language
    const updatesByLanguage = {};

    for (const item of translationsList) {
        const { key, translations } = item;

        if (!key?.trim()) {
            throw new ApiError(400, "TRANSLATION_KEY_REQUIRED");
        }

        if (
            !translations ||
            typeof translations !== "object" ||
            Object.keys(translations).length === 0
        ) {
            throw new ApiError(400, "TRANSLATIONS_REQUIRED_FOR_KEY", { params: { key } });
        }

        for (const [lang, value] of Object.entries(translations)) {
            const languageCode = lang.toLowerCase();

            if (typeof value !== 'string' || !value.trim()) {
                throw new ApiError(400, "INVALID_TRANSLATION_VALUE", { params: { key, lang } });
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
            req.t("TRANSLATIONS_UPDATED")
        )
    );
});

export { getTranslationByLang, getAllTranslations, getTranslationsVersion, setTranslationKey, deleteTranslationKey, bulkSetTranslations }