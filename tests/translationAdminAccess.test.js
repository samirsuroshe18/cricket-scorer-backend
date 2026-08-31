import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';

// The translations CMS write routes used to be guarded by `verifyJwt` alone —
// there is no role/admin concept anywhere in User.model.js, so "logged in"
// was standing in for "authorized" and any self-registered account could
// rewrite or delete the i18n strings every client renders. `verifyAdmin`
// (an ADMIN_EMAILS allowlist, since Phase 1 has no DB-backed role to check)
// is the actual authorization check now.
describe('translations CMS write routes require admin access', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withTranslations: true });
  });

  afterEach(async () => {
    delete process.env.ADMIN_EMAILS;
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const bulkUpdateBody = [
    { key: 'greeting', translations: { en: 'Hello', hi: 'नमस्ते', mr: 'नमस्कार' } },
  ];

  it('rejects a bulk-update from an ordinary, freshly self-registered account', async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const { token } = await createTestUser({ email: 'ordinary-user@example.com' });

    const res = await request(app)
      .post('/api/v1/translations/bulk-update')
      .set('Authorization', `Bearer ${token}`)
      .send(bulkUpdateBody);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_ACCESS_REQUIRED');
  });

  it('rejects set-key and delete-key from an ordinary account the same way', async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const { token } = await createTestUser({ email: 'ordinary-user-2@example.com' });

    const setRes = await request(app)
      .post('/api/v1/translations/en/set-key')
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'greeting', value: 'Hello' });
    expect(setRes.status).toBe(403);
    expect(setRes.body.code).toBe('ADMIN_ACCESS_REQUIRED');

    const deleteRes = await request(app)
      .delete('/api/v1/translations/en/key/greeting')
      .set('Authorization', `Bearer ${token}`);
    expect(deleteRes.status).toBe(403);
    expect(deleteRes.body.code).toBe('ADMIN_ACCESS_REQUIRED');
  });

  it('allows a bulk-update from an account whose email is on the ADMIN_EMAILS allowlist', async () => {
    process.env.ADMIN_EMAILS = 'Admin@Example.com, other-admin@example.com';
    const { token } = await createTestUser({ email: 'admin@example.com' });

    const res = await request(app)
      .post('/api/v1/translations/bulk-update')
      .set('Authorization', `Bearer ${token}`)
      .send(bulkUpdateBody);

    expect(res.status).toBe(200);
  });

  it('leaves the read-only routes public — no admin, no login, needed', async () => {
    const res = await request(app).get('/api/v1/translations/version');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
