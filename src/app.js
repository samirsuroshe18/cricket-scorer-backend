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
import { resolveTrustProxyHops } from "./utils/trustProxy.js";

const app = express();
initializeFirebaseAdmin();

// How many reverse-proxy hops in front of this process to trust when reading
// X-Forwarded-For — this is what globalLimiter/authLimiter's IP-keyed rate
// limiting actually resolves against (see rateLimit.middleware.js). Getting
// the count wrong fails in one of two directions, not just one: too few
// (the default, unset) and every request behind a real proxy collapses onto
// the proxy's own address — one shared bucket for every user; `true` (trust
// everything) and a client can prepend whatever it likes to X-Forwarded-For
// to rotate its way past the limiter entirely. Nothing sits in front of this
// process today (see the backend CLAUDE.md — dev-only, direct LAN
// connections), so 0 (trust nothing, `req.ip` is the raw socket peer) is the
// correct default now and the safe failure mode later: deploying behind a
// single load balancer (Phase 7) without setting this still gets the
// shared-bucket failure, never the spoofable one.
app.set('trust proxy', resolveTrustProxyHops(process.env.TRUST_PROXY_HOPS));

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
import playerRouter from './routes/player.routes.js';
import teamRouter from './routes/team.routes.js';
import organizationRouter from './routes/organization.routes.js';
import tournamentRouter from './routes/tournament.routes.js';
import searchRouter from './routes/search.routes.js';

//Routes declaration
app.use("/api/v1/user", userRouter);
app.use("/api/v1/translations", translationRouter);
app.use("/api/v1/match", matchRouter);
app.use("/api/v1/player", playerRouter);
app.use("/api/v1/team", teamRouter);
app.use("/api/v1/tournament", tournamentRouter);
app.use("/api/v1/organization", organizationRouter);
app.use("/api/v1/search", searchRouter);

// Custom error handeling
app.use(errorHandler)

export default app