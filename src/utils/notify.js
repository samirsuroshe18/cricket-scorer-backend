import { User } from '../models/user.model.js';
import { Notification } from '../models/notification.model.js';
import { sendNotification, sendMultiNotification } from './sendNotification.js';
import i18next from '../config/i18n.js';

// Every call site (a controller inside `catchAsync`, a background sweep job
// with no `req` at all) shares one contract: never throw. A failed or
// missing FCM token, a `User` that's since been deleted, an i18next lookup
// miss — none of it should be the reason the match/auction write this is
// attached to fails, since by the time this runs that write has already
// committed. Localizes off the recipient's own `User.language`, not `req`,
// so the same code path works whether or not a request is in flight —
// i18next is preloaded with all locales at boot (see config/i18n.js), so a
// direct `.t(key, {lng})` call needs no Express middleware.

/**
 * Notify a single recipient. Always writes the in-app inbox row; also sends
 * a push if the recipient has a registered `fcmToken`. `data` is the
 * deep-link payload (e.g. `{ matchId }`), sent as the FCM message's `data`
 * block and stored alongside the inbox row so a tap works the same way
 * whether it came from a fresh push or from browsing the inbox later.
 */
export const notifyUser = async ({ recipientId, type, titleKey, bodyKey, params = {}, data = {} }) => {
  if (!recipientId) return;
  try {
    const recipient = await User.findById(recipientId, 'fcmToken language');
    if (!recipient) return;

    const lng = recipient.language || 'en';
    const title = i18next.t(titleKey, { lng, ...params });
    const body = i18next.t(bodyKey, { lng, ...params });

    await Notification.create({ recipient: recipientId, type, title, body, data });

    if (recipient.fcmToken) {
      await sendNotification(recipient.fcmToken, { title, body }, data);
    }
  } catch (error) {
    console.log(`[notify] notifyUser failed for recipient ${recipientId}, type ${type}:`, error);
  }
};

/**
 * Notify many recipients at once (e.g. every team owner when an auction
 * starts). Grouped by language rather than one `sendMultiNotification` call
 * for everyone: recipients can be on different languages, and a push's
 * title/body has to be finalized text, not a key — so each language group
 * gets its own rendered copy and its own multicast send. The inbox row is
 * still one per recipient either way.
 */
export const notifyUsers = async ({ recipientIds, type, titleKey, bodyKey, params = {}, data = {} }) => {
  const ids = [...new Set(recipientIds.filter(Boolean).map(String))];
  if (ids.length === 0) return;

  try {
    const recipients = await User.find({ _id: { $in: ids } }, 'fcmToken language');
    if (recipients.length === 0) return;

    const byLanguage = new Map();
    for (const recipient of recipients) {
      const lng = recipient.language || 'en';
      if (!byLanguage.has(lng)) byLanguage.set(lng, []);
      byLanguage.get(lng).push(recipient);
    }

    const notificationDocs = [];
    for (const [lng, group] of byLanguage) {
      const title = i18next.t(titleKey, { lng, ...params });
      const body = i18next.t(bodyKey, { lng, ...params });

      for (const recipient of group) {
        notificationDocs.push({ recipient: recipient._id, type, title, body, data });
      }

      const tokens = group.map((r) => r.fcmToken).filter(Boolean);
      if (tokens.length > 0) {
        await sendMultiNotification(tokens, { title, body }, data);
      }
    }

    await Notification.insertMany(notificationDocs);
  } catch (error) {
    console.log(`[notify] notifyUsers failed for type ${type}:`, error);
  }
};
