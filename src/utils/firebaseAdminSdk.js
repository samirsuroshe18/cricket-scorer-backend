import admin from 'firebase-admin';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serviceAccount = path.join(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT);

const initializeFirebaseAdmin = () => {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}

export default initializeFirebaseAdmin;