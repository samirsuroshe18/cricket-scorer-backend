import dotenv from "dotenv";
dotenv.config()
import express from "express";
import cors from 'cors';
import cookieParser from "cookie-parser";
import initializeFirebaseAdmin from "./utils/firebaseAdminSdk.js";
import { errorHandler } from "./utils/errorHandler.js";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';

const app = express();
initializeFirebaseAdmin();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const staticPath = path.join(__dirname, '../public');

// this use for cross origin sharing 
app.use(
  cors({
      origin: [process.env.CORS_ORIGIN],
      credentials: true, // Allow cookies/auth headers if needed
  })
);
// this middleware use for parsing the json data
app.use(express.json());
// this is used for parsing url data extended is used for nessted object
app.use(express.urlencoded({ extended: true }));
// this is used for accessing public resources from server
app.use(express.static(staticPath));
// this is used to parse the cookie
app.use(cookieParser());

// routes import
import userRouter from './routes/user.routes.js';

//Routes declaration
app.use("/api/v1/user", userRouter);

// Custom error handeling
app.use(errorHandler)

export default app