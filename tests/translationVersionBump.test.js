import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Localization } from '../src/models/translations.model.js';

// Localization's pre('save') hook bumps `version` whenever `strings` changes
// — but setTranslationKey wrote via `findOneAndUpdate`, which never runs
// document middleware at all. deleteTranslationKey (a real `.save()`) and
// bulkSetTranslations (an explicit `$inc` alongside its `$set`) both advance
// it correctly; setTranslationKey alone left this field permanently stuck,
// even though every edit went through.
describe('setTranslationKey advances Localization.version, same as delete/bulk-update', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    process.env.ADMIN_EMAILS = 'admin@example.com';
    app = buildTestApp({ withTranslations: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    delete process.env.ADMIN_EMAILS;
    await disconnectTestDb();
  });

  const setKey = (token, lang, body) =>
    request(app)
      .post(`/api/v1/translations/${lang}/set-key`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  it('increments version on every single-key edit, not just the first', async () => {
    const { token } = await createTestUser({ email: 'admin@example.com' });

    const first = await setKey(token, 'en', { key: 'greeting', value: 'Hello' });
    expect(first.status).toBe(200);
    const versionAfterFirst = first.body.data.version;

    const second = await setKey(token, 'en', { key: 'greeting', value: 'Hi there' });
    expect(second.status).toBe(200);
    expect(second.body.data.version).toBe(versionAfterFirst + 1);

    const third = await setKey(token, 'en', { key: 'farewell', value: 'Bye' });
    expect(third.status).toBe(200);
    expect(third.body.data.version).toBe(versionAfterFirst + 2);

    const stored = await Localization.findOne({ languageCode: 'en' });
    expect(stored.version).toBe(versionAfterFirst + 2);
  });
});
