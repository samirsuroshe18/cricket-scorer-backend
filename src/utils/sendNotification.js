import admin from 'firebase-admin';

// FCM `data` values must all be strings — unlike `notification`, the SDK
// does not stringify for you, and passing e.g. a boolean or an ObjectId
// throws at send time rather than silently coercing.
const stringifyData = (data) => Object.fromEntries(
  Object.entries(data ?? {}).map(([key, value]) => [key, String(value)])
);

// A `notification` block (not just `data`) is what makes the OS actually
// show something in the tray when the app is backgrounded or killed — a
// data-only message is silently dropped by the platform unless the app is
// in the foreground to render it itself. `data` still carries the
// deep-link payload (type/matchId/etc.) for the client's tap handler.
//
// Never throws: a push failure (invalid/expired token, no connectivity to
// FCM, whatever) must never be the reason the match/auction write it's
// attached to fails. Callers that want to observe the outcome can await
// the returned promise; callers that don't can fire-and-forget it.
const sendNotification = async (token, { title, body }, data) => {
  try {
    const response = await admin.messaging().send({
      token,
      notification: { title, body },
      data: stringifyData(data),
      android: { priority: 'high' },
      apns: {
        headers: { 'apns-priority': '5' },
        payload: { aps: { sound: 'default' } },
      },
    });
    return { ok: true, response };
  } catch (error) {
    console.log('Error sending notification:', error);
    return { ok: false, error };
  }
};

const sendMultiNotification = async (tokens, { title, body }, data) => {
  if (tokens.length === 0) return { ok: true, successCount: 0, failureCount: 0 };
  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: stringifyData(data),
      android: { priority: 'high' },
      apns: {
        headers: { 'apns-priority': '5' },
        payload: { aps: { sound: 'default' } },
      },
    });
    return { ok: true, successCount: response.successCount, failureCount: response.failureCount };
  } catch (error) {
    console.log('Multicast error:', error);
    return { ok: false, error };
  }
};

export { sendNotification, sendMultiNotification }
