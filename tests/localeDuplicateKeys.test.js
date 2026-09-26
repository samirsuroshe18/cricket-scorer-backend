import fs from 'fs';
import path from 'path';
import { SUPPORTED_LANGUAGES } from '../src/constants/language.constants.js';

const LOCALES_DIR = path.join(process.cwd(), 'src/locales');

// JSON.parse keeps only the last of two identical keys, so locales.test.js —
// which parses the files — can never see a duplicate: a second definition
// silently overrides the first, changing the message every existing caller of
// that key returns.
describe('locale files', () => {
    it.each(Object.values(SUPPORTED_LANGUAGES))('%s defines no key twice', (lang) => {
        const text = fs.readFileSync(path.join(LOCALES_DIR, lang, 'common.json'), 'utf8');
        const seen = new Set();
        const duplicates = [];
        for (const [, key] of text.matchAll(/^ {2}"([A-Za-z0-9_]+)":/gm)) {
            if (seen.has(key)) duplicates.push(key);
            seen.add(key);
        }
        expect(duplicates).toEqual([]);
    });
});
