import crypto from "crypto";
import fs from "fs";
import path from "path";
import multer from "multer";
import ApiError from "../utils/ApiError.js";
import { sniffImageType } from "../utils/sniffImageType.js";

// `file.originalname` is fully attacker-controlled multipart input — never
// safe to use in building a filesystem path. Multer's disk storage does a
// plain `path.join(destination, filename)` with no traversal guard, so an
// originalname like "../../../../some/path/evil.js" used to write straight
// to a path outside the upload directory, from any authenticated,
// self-registered account. The name written to disk is now random; the only
// thing taken from client input is a whitelisted, regex-validated extension,
// which by construction cannot contain a path separator or a ".." segment.
export const buildUploadFilename = (originalname) => {
  const ext = path.extname(originalname ?? '').toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
  return `${crypto.randomUUID()}${safeExt}`;
};

// Deliberately NOT under `./public` — app.js serves that whole tree via
// `express.static`, so anything staged under it (even briefly, before
// `uploadOnCloudinary` picks it up and deletes it) sits at a predictable,
// unauthenticated URL. Combined with an unrestricted file type, that was a
// stored-XSS delivery path: an uploaded HTML/SVG payload was reachable at
// `GET /temp/<filename>` with no auth at all while it waited. Created eagerly
// (multer does not create a missing destination itself) rather than relying
// on a committed empty directory, which git — and therefore a fresh
// checkout or a container image built from one — has no way to track.
const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'temp');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    cb(null, buildUploadFilename(file.originalname));
  }
})

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB — generous for a profile photo, not for a DoS payload

// Only real image formats are ever a legitimate profile picture. Rejecting
// everything else here — rather than accepting anything and trusting
// Cloudinary alone — is what stops an HTML/SVG payload (which can carry a
// <script>) from ever reaching disk, on top of the storage-location fix
// above.
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const multerUpload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
  },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(new ApiError(400, "UNSUPPORTED_FILE_TYPE"));
      return;
    }
    cb(null, true);
  },
});

// A thin wrapper rather than exporting `multerUpload.single('file')`
// directly: multer's own limit/size errors surface as a `MulterError`, not
// an `ApiError`, and would otherwise fall through `errorHandler`'s
// unknown-error branch as an opaque 500 instead of the specific 400s these
// actually are.
export const upload = {
  single: (fieldName) => (req, res, next) => {
    multerUpload.single(fieldName)(req, res, (err) => {
      if (!err) {
        if (!req.file) return next();

        // fileFilter above only ever saw file.mimetype — the client-supplied
        // Content-Type header, independent of the actual bytes sent. Now
        // that the upload has landed (in the staging directory only
        // app.js's own auth-gated routes can reach — see UPLOAD_DIR's own
        // comment), the real content is checked before this goes anywhere
        // further (Cloudinary): a spoofed mimetype over an SVG/HTML payload
        // is deleted here rather than trusted.
        const head = Buffer.alloc(12);
        const fd = fs.openSync(req.file.path, 'r');
        fs.readSync(fd, head, 0, 12, 0);
        fs.closeSync(fd);

        if (!sniffImageType(head)) {
          fs.unlinkSync(req.file.path);
          return next(new ApiError(400, "UNSUPPORTED_FILE_TYPE"));
        }

        return next();
      }

      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(new ApiError(400, "FILE_TOO_LARGE"));
      }

      return next(err);
    });
  },
};