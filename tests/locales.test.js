import fs from 'fs';
import path from 'path';
import { SUPPORTED_LANGUAGES } from '../src/constants/language.constants.js';

const LOCALES_DIR = path.join(process.cwd(), 'src/locales');

const readLocale = (lang) =>
    JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, lang, 'common.json'), 'utf8'));

// Flatten so nested groups (e.g. ACCOUNT_STATUS.blocked) are compared too.
const flattenKeys = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([key, value]) => {
        const full = prefix ? `${prefix}.${key}` : key;
        return value !== null && typeof value === 'object'
            ? flattenKeys(value, full)
            : [full];
    });

const languages = Object.values(SUPPORTED_LANGUAGES);

describe('locale files', () => {
    const baseline = flattenKeys(readLocale('en')).sort();

    it.each(languages)('%s defines exactly the same keys as en', (lang) => {
        expect(flattenKeys(readLocale(lang)).sort()).toEqual(baseline);
    });

    it.each(languages)('%s has no empty values', (lang) => {
        const empty = Object.entries(readLocale(lang))
            .filter(([, v]) => typeof v === 'string' && !v.trim())
            .map(([k]) => k);
        expect(empty).toEqual([]);
    });
});
