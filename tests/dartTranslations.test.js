import { parseKeyNames, parseLocaleMap, buildEntries } from '../src/utils/dartTranslations.js';

describe('parseKeyNames', () => {
  it('maps the Dart constant name to its snake_case key', () => {
    const source = `
      class TranslationKeys {
        static const String roleOwner = 'role_owner';
        static const String myTeamsEmptyHint = 'my_teams_empty_hint';
      }`;

    expect(parseKeyNames(source)).toEqual({
      roleOwner: 'role_owner',
      myTeamsEmptyHint: 'my_teams_empty_hint',
    });
  });
});

describe('parseLocaleMap', () => {
  it('reads single-line entries, including Devanagari', () => {
    const { values, unparsed } = parseLocaleMap(`
      const en = {
        TranslationKeys.roleOwner: 'Owner',
        TranslationKeys.roleMember: "Member",
      };
      const hi = { TranslationKeys.roleOwner: 'मालिक', };`);

    expect(values).toEqual({ roleOwner: 'मालिक', roleMember: 'Member' });
    expect(unparsed).toEqual([]);
  });

  it('reads a value that starts on the next line', () => {
    const { values } = parseLocaleMap(`
      TranslationKeys.linkHint:
          'Linking means you will get notified',
      TranslationKeys.after: 'ok',`);

    expect(values.linkHint).toBe('Linking means you will get notified');
    expect(values.after).toBe('ok');
  });

  it('joins adjacent literals into one string', () => {
    const { values } = parseLocaleMap(`
      TranslationKeys.long:
          'First part, '
          'second part.',`);

    expect(values.long).toBe('First part, second part.');
  });

  it('unescapes quotes, newlines and unicode escapes', () => {
    const { values } = parseLocaleMap(`
      TranslationKeys.a: 'We\\'ll send\\nyou a code',
      TranslationKeys.b: 'Price: \\$5',
      TranslationKeys.c: 'caf\\u00e9 \\u{1F3CF}',`);

    expect(values.a).toBe("We'll send\nyou a code");
    expect(values.b).toBe('Price: $5');
    expect(values.c).toBe('café \u{1F3CF}');
  });

  it('keeps a comma or a colon inside a value', () => {
    const { values } = parseLocaleMap(`TranslationKeys.a: 'Live: 3 wickets, 1 over',`);

    expect(values.a).toBe('Live: 3 wickets, 1 over');
  });

  it('reports an entry that is not a plain string instead of guessing', () => {
    const { values, unparsed } = parseLocaleMap(`
      TranslationKeys.computed: someFunction(),
      TranslationKeys.bad: 'unknown \\q escape',
      TranslationKeys.fine: 'fine',`);

    expect(values).toEqual({ fine: 'fine' });
    expect(unparsed).toEqual(['computed', 'bad']);
  });
});

describe('buildEntries', () => {
  const keyNames = { roleOwner: 'role_owner', roleMember: 'role_member' };

  it('builds the bulk-update payload shape', () => {
    const { entries, problems } = buildEntries(keyNames, {
      en: { roleOwner: 'Owner', roleMember: 'Member' },
      hi: { roleOwner: 'मालिक', roleMember: 'सदस्य' },
      mr: { roleOwner: 'मालक', roleMember: 'सदस्य' },
    });

    expect(problems).toEqual([]);
    expect(entries).toContainEqual({
      key: 'role_owner',
      translations: { en: 'Owner', hi: 'मालिक', mr: 'मालक' },
    });
    expect(entries).toHaveLength(2);
  });

  it('holds back a key that is missing in one language', () => {
    const { entries, problems } = buildEntries(keyNames, {
      en: { roleOwner: 'Owner' },
      hi: { roleOwner: 'मालिक' },
      mr: {},
    });

    expect(entries).toEqual([]);
    expect(problems).toEqual(['role_owner: missing in mr']);
  });

  it('holds back a locale entry that has no declared key', () => {
    const { entries, problems } = buildEntries(keyNames, {
      en: { ghost: 'Boo' },
      hi: { ghost: 'Boo' },
      mr: { ghost: 'Boo' },
    });

    expect(entries).toEqual([]);
    expect(problems).toHaveLength(1);
  });
});
