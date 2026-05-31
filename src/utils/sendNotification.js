import admin from 'firebase-admin';

const sendNotification = (token, action, payload) => {

  const message = {
    token,
    data: payload,
    android: {
      priority: 'high',
    },
    apns: {
      headers: {
        'apns-priority': '5',
      },
    },
  };

  admin.messaging().send(message)
    .then((response) => {
      console.log('Successfully sent notification:', response);
    })
    .catch((error) => {
      console.log('Error sending notification:', error);
    });
};

const sendMultiNotification = (tokens, payload) => {

  const message = {
    tokens,
    data: payload,
    android: {
      priority: 'high',
    },
    apns: {
      headers: {
        'apns-priority': '5',
      },
    },
  };

  admin.messaging().sendEachForMulticast(message)
    .then((res) => console.log('Multicast sent:', res.successCount))
    .catch((err) => console.log('Multicast error:', err));
};

export { sendNotification, sendMultiNotification }