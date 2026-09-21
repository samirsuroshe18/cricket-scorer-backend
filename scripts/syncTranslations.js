// Brings the translation CMS in line with the Flutter client's TranslationKeys
// and en/hi/mr maps, straight through the models — the same `$set` + `$inc`
// version bump + `incrementGlobalVersion()` that `bulkSetTranslations` does,
// so clients still see the change on their next version poll. It needs no
// login because it does not go through the API; it connects with the
// MONGODB_URI in .env.development, so it refuses to run in any other env.
//
//   npm run sync-translations                      add every key the CMS lacks
//   npm run sync-translations -- --dry-run         show what would change
//   npm run sync-translations -- --only role_owner,role_member
//   npm run sync-translations -- --force role_owner   overwrite an existing value
//   npm run sync-translations -- --client <dir>    client lib/core/translations
//
// Missing keys are added. A key whose CMS value differs from the client's is
// reported but left alone unless named in --force, since the CMS may have been
// edited on purpose. Nothing is ever deleted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

import '../src/config/env.js';
import connectDB from '../src/database/database.js';
import { Localization } from '../src/models/translations.model.js';
import incrementGlobalVersion from '../src/utils/incrementGlobalVersion.js';
import {
    buildEntries,
    parseKeyNames,
    parseLocaleMap,
} from '../src/utils/dartTranslations.js';

const LANGUAGES = ['en', 'hi', 'mr'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fail = (message) => {
    console.error(`sync-translations: ${message}`);
    process.exit(1);
};

const listArg = (name) => {
    const i = process.argv.indexOf(name);
    if (i === -1) return null;
    const value = process.argv[i + 1];
    if (!value || value.startsWith('--')) fail(`${name} needs a value`);
    return value.split(',').map((s) => s.trim()).filter(Boolean);
};

if (process.env.NODE_ENV !== 'development') {
    fail(
        `refusing to run with NODE_ENV=${process.env.NODE_ENV ?? '(unset)'}; ` +
            'this writes to the database directly and is for development only. ' +
            'Use `npm run sync-translations`.'
    );
}

const dryRun = process.argv.includes('--dry-run');
const only = listArg('--only');
const force = new Set(listArg('--force') ?? []);
const clientDir = path.resolve(
    listArg('--client')?.[0] ?? path.join(repoRoot, '../cricket-scrorer/lib/core/translations')
);

const read = (file) => {
    const target = path.join(clientDir, file);
    if (!fs.existsSync(target)) fail(`cannot find ${target} (use --client <dir>)`);
    return fs.readFileSync(target, 'utf8');
};

const keyNames = parseKeyNames(read('translation_keys.dart'));
const localeMaps = {};
const unparsed = [];
for (const lang of LANGUAGES) {
    const { values, unparsed: bad } = parseLocaleMap(read(`${lang}.dart`));
    localeMaps[lang] = values;
    unparsed.push(...bad.map((name) => `${lang}.dart: ${name}`));
}

const built = buildEntries(keyNames, localeMaps);
const problems = [...built.problems];
if (unparsed.length > 0) {
    problems.push(...unparsed.map((u) => `${u}: value is not a plain string literal`));
}

let entries = built.entries;
if (only) {
    const known = new Set(entries.map((e) => e.key));
    const unknown = only.filter((key) => !known.has(key));
    if (unknown.length > 0) {
        fail(`no complete client entry for: ${unknown.join(', ')}`);
    }
    entries = entries.filter((e) => only.includes(e.key));
}

// A problem with a key we are about to upload must stop the run; problems with
// unrelated keys are shown but do not block.
const relevant = only
    ? problems.filter((p) => only.some((key) => p.startsWith(`${key}:`)))
    : [];
if (relevant.length > 0) fail(`cannot upload:\n  ${relevant.join('\n  ')}`);

await connectDB();

try {
    const stored = {};
    for (const lang of LANGUAGES) {
        const doc = await Localization.findOne({ languageCode: lang }).lean();
        stored[lang] = doc?.strings ?? {};
    }

    const updates = Object.fromEntries(LANGUAGES.map((lang) => [lang, {}]));
    const added = [];
    const overwritten = [];
    const drifted = [];

    for (const { key, translations } of entries) {
        for (const lang of LANGUAGES) {
            const existing = stored[lang][key];
            const wanted = translations[lang];

            if (existing === undefined) {
                updates[lang][`strings.${key}`] = wanted;
                added.push(`${key} [${lang}]`);
            } else if (existing !== wanted && force.has(key)) {
                updates[lang][`strings.${key}`] = wanted;
                overwritten.push(`${key} [${lang}]`);
            } else if (existing !== wanted) {
                drifted.push(`${key} [${lang}]`);
            }
        }
    }

    const operations = LANGUAGES.filter((lang) => Object.keys(updates[lang]).length > 0).map(
        (lang) => ({
            updateOne: {
                filter: { languageCode: lang },
                update: { $set: updates[lang], $inc: { version: 1 } },
                upsert: true,
            },
        })
    );

    console.log(`client keys read : ${built.entries.length}`);
    console.log(`to add           : ${added.length}`);
    console.log(`to overwrite     : ${overwritten.length}`);
    console.log(`differ, left as is: ${drifted.length}${only ? '' : ' (pass --force <key> to overwrite)'}`);
    if (problems.length > 0 && !only) {
        console.log(`skipped (${problems.length}):\n  ${problems.join('\n  ')}`);
    }
    for (const line of added) console.log(`  + ${line}`);
    for (const line of overwritten) console.log(`  ~ ${line}`);
    if (only) for (const line of drifted) console.log(`  = ${line} differs, not touched`);

    if (operations.length === 0) {
        console.log('\nCMS already has everything; nothing written.');
    } else if (dryRun) {
        console.log('\n--dry-run: nothing written.');
    } else {
        await Localization.bulkWrite(operations);
        const meta = await incrementGlobalVersion();
        console.log(`\nWritten. globalVersion is now ${meta.version}.`);
    }
} finally {
    await mongoose.disconnect();
}
