// Reads the Flutter client's translation sources so the CMS can be brought in
// line with them without retyping strings:
//
//   translation_keys.dart   static const String roleOwner = 'role_owner';
//   en.dart / hi.dart / mr.dart   TranslationKeys.roleOwner: 'Owner',
//
// Only the shapes those files actually use are understood: single- or
// double-quoted literals, adjacent literals concatenated across lines, and
// the escapes \n \t \r \\ \' \" \$ \uXXXX \u{X...}. Anything else is reported
// rather than guessed at.

const KEY_DECLARATION = /static\s+const\s+String\s+(\w+)\s*=\s*'([^']*)'\s*;/g;
const ENTRY_START = /TranslationKeys\.(\w+)\s*:\s*/g;

const SIMPLE_ESCAPES = {
    n: '\n',
    t: '\t',
    r: '\r',
    '\\': '\\',
    "'": "'",
    '"': '"',
    $: '$',
};

// { camelCaseName: 'snake_case_key' } from translation_keys.dart.
export const parseKeyNames = (source) => {
    const names = {};
    for (const match of source.matchAll(KEY_DECLARATION)) {
        names[match[1]] = match[2];
    }
    return names;
};

// Reads one quoted literal starting at `start` (which must be a quote).
// Returns { value, end } with `end` just past the closing quote, or null when
// the literal is unterminated or uses an escape we do not understand.
const readLiteral = (source, start) => {
    const quote = source[start];
    let value = '';
    let i = start + 1;

    while (i < source.length) {
        const ch = source[i];

        if (ch === quote) return { value, end: i + 1 };
        if (ch === '\n') return null;

        if (ch !== '\\') {
            value += ch;
            i += 1;
            continue;
        }

        const next = source[i + 1];
        if (next in SIMPLE_ESCAPES) {
            value += SIMPLE_ESCAPES[next];
            i += 2;
        } else if (next === 'u' && source[i + 2] === '{') {
            const close = source.indexOf('}', i + 3);
            const hex = close === -1 ? '' : source.slice(i + 3, close);
            if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return null;
            value += String.fromCodePoint(parseInt(hex, 16));
            i = close + 1;
        } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
        } else {
            return null;
        }
    }
    return null;
};

// { camelCaseName: 'value' } from one locale file, plus the entries that could
// not be read (so the caller can refuse to upload a half-parsed map).
export const parseLocaleMap = (source) => {
    const values = {};
    const unparsed = [];

    for (const match of source.matchAll(ENTRY_START)) {
        const name = match[1];
        let cursor = match.index + match[0].length;
        let value = '';
        let literals = 0;

        for (;;) {
            if (source[cursor] !== "'" && source[cursor] !== '"') break;
            const literal = readLiteral(source, cursor);
            if (!literal) {
                literals = 0;
                break;
            }
            value += literal.value;
            literals += 1;
            cursor = literal.end;
            while (/\s/.test(source[cursor] ?? '')) cursor += 1;
        }

        if (literals === 0) unparsed.push(name);
        else values[name] = value;
    }

    return { values, unparsed };
};

// Joins the key names with the three locale maps into the CMS payload shape:
// [{ key, translations: { en, hi, mr } }]. A key missing from any language, or
// a name with no declaration, goes to `problems` instead of the payload.
export const buildEntries = (keyNames, localeMaps) => {
    const languages = Object.keys(localeMaps);
    const entries = [];
    const problems = [];

    const names = new Set(Object.values(localeMaps).flatMap((m) => Object.keys(m)));

    for (const name of names) {
        const key = keyNames[name];
        if (!key) {
            problems.push(`${name}: has a locale entry but no key in translation_keys.dart`);
            continue;
        }

        const missing = languages.filter((lang) => !(name in localeMaps[lang]));
        if (missing.length > 0) {
            problems.push(`${key}: missing in ${missing.join(', ')}`);
            continue;
        }

        const translations = {};
        for (const lang of languages) translations[lang] = localeMaps[lang][name];
        entries.push({ key, translations });
    }

    // A key declared in translation_keys.dart but absent from every locale map
    // never reaches the union above, so it would be skipped silently. It also
    // renders as raw text before the first successful translation sync, so
    // name it.
    for (const [name, key] of Object.entries(keyNames)) {
        if (!names.has(name)) {
            problems.push(
                `${key}: declared in translation_keys.dart but has no entry in ${languages.join(', ')}`
            );
        }
    }

    return { entries, problems };
};
