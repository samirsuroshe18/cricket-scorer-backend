import express from "express";
import cors from 'cors';
import helmet from "helmet";
import cookieParser from "cookie-parser";
import initializeFirebaseAdmin from "./utils/firebaseAdminSdk.js";
import { errorHandler } from "./utils/errorHandler.js";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import {localeMiddleware} from "./middlewares/locale.middleware.js";
import { sanitizeMiddleware } from "./middlewares/sanitize.middleware.js";
import { globalLimiter } from "./middlewares/rateLimit.middleware.js";

const app = express();
initializeFirebaseAdmin();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const staticPath = path.join(__dirname, '../public');

app.use(helmet());
// this use for cross origin sharing
app.use(
  cors({
      origin: [process.env.CORS_ORIGIN],
      credentials: true, // Allow cookies/auth headers if needed
  })
);
// this middleware use for parsing the json data
app.use(express.json({ limit: '100kb' }));
// this is used for parsing url data extended is used for nessted object
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
// this is used for accessing public resources from server
app.use(express.static(staticPath));
// this is used to parse the cookie
app.use(cookieParser());
app.use(sanitizeMiddleware);
app.use(localeMiddleware);
app.use(globalLimiter);

// routes import
import userRouter from './routes/user.routes.js';
import translationRouter from './routes/translation.routes.js';
import matchRouter from './routes/match.routes.js';

//Routes declaration
app.use("/api/v1/user", userRouter);
app.use("/api/v1/translations", translationRouter);
app.use("/api/v1/match", matchRouter);

// Custom error handeling
app.use(errorHandler)

export default app