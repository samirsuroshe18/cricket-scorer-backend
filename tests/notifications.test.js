import request from 'supertest';
import { buildTestApp } from './helpers/buildTestApp.js';
import { createTestUser } from './helpers/authTestUser.js';
import { connectTestDb, disconnectTestDb, clearTestDb } from './setup/testDb.js';
import { Notification } from '../src/models/notification.model.js';

describe('notification inbox endpoints', () => {
  let app;

  beforeAll(async () => {
    await connectTestDb();
    app = buildTestApp({ withNotifications: true });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await disconnectTestDb();
  });

  const list = (token, query = '') =>
    request(app).get(`/api/v1/notifications${query}`).set('Authorization', `Bearer ${token}`).send();

  const unreadCount = (token) =>
    request(app).get('/api/v1/notifications/unread-count').set('Authorization', `Bearer ${token}`).send();

  const markRead = (token, notificationId) =>
    request(app).patch(`/api/v1/notifications/${notificationId}/read`).set('Authorization', `Bearer ${token}`).send();

  const markAllRead = (token) =>
    request(app).post('/api/v1/notifications/read-all').set('Authorization', `Bearer ${token}`).send();

  it("returns only the caller's own notifications, newest first", async () => {
    const { token, user } = await createTestUser();
    const { user: other } = await createTestUser({ email: 'other-inbox@example.com' });

    await Notification.create({ recipient: other._id, type: 'match_started', title: 'Not yours', body: 'Not yours', data: {} });
    const first = await Notification.create({ recipient: user._id, type: 'match_started', title: 'First', body: 'First', data: {} });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await Notification.create({ recipient: user._id, type: 'scorer_assigned', title: 'Second', body: 'Second', data: {} });

    const res = await list(token);

    expect(res.status).toBe(200);
    expect(res.body.data.notifications).toHaveLength(2);
    expect(res.body.data.notifications[0].notificationId).toBe(String(second._id));
    expect(res.body.data.notifications[1].notificationId).toBe(String(first._id));
    expect(res.body.data.total).toBe(2);
  });

  it('paginates with ?page and ?limit', async () => {
    const { token, user } = await createTestUser();
    for (let i = 0; i < 3; i += 1) {
      await Notification.create({ recipient: user._id, type: 'match_started', title: `N${i}`, body: `N${i}`, data: {} });
    }

    const page1 = await list(token, '?page=1&limit=2');
    expect(page1.body.data.notifications).toHaveLength(2);
    expect(page1.body.data.total).toBe(3);

    const page2 = await list(token, '?page=2&limit=2');
    expect(page2.body.data.notifications).toHaveLength(1);
  });

  it('rejects an over-large limit', async () => {
    const { token } = await createTestUser();

    const res = await list(token, '?limit=10000');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAGINATION');
  });

  it('reports the unread count, excluding already-read notifications', async () => {
    const { token, user } = await createTestUser();
    await Notification.create({ recipient: user._id, type: 'match_started', title: 'Unread', body: 'Unread', data: {}, read: false });
    await Notification.create({ recipient: user._id, type: 'match_started', title: 'Read', body: 'Read', data: {}, read: true });

    const res = await unreadCount(token);

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
  });

  it('marks a single notification read, and rejects marking another user\'s notification', async () => {
    const { token, user } = await createTestUser();
    const { token: otherToken } = await createTestUser({ email: 'other-mark@example.com' });
    const notification = await Notification.create({ recipient: user._id, type: 'match_started', title: 'Mine', body: 'Mine', data: {}, read: false });

    const rejected = await markRead(otherToken, notification._id);
    expect(rejected.status).toBe(404);
    expect(rejected.body.code).toBe('NOTIFICATION_NOT_FOUND');

    const res = await markRead(token, notification._id);
    expect(res.status).toBe(200);
    expect(res.body.data.read).toBe(true);
    const updated = await Notification.findById(notification._id);
    expect(updated.read).toBe(true);
  });

  it('marks every unread notification read in one call', async () => {
    const { token, user } = await createTestUser();
    await Notification.create({ recipient: user._id, type: 'match_started', title: 'A', body: 'A', data: {}, read: false });
    await Notification.create({ recipient: user._id, type: 'match_started', title: 'B', body: 'B', data: {}, read: false });

    const res = await markAllRead(token);

    expect(res.status).toBe(200);
    const remaining = await Notification.countDocuments({ recipient: user._id, read: false });
    expect(remaining).toBe(0);
  });
});
