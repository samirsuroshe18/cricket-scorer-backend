import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { buildUploadFilename, upload } from '../src/middlewares/multer.middleware.js';
import { errorHandler } from '../src/utils/errorHandler.js';

// multer.middleware.js used to build the on-disk filename straight from
// `file.originalname` — fully attacker-controlled multipart input — and hand
// it to multer's disk storage, which does a plain `path.join(destination,
// filename)` with no traversal guard. An originalname like
// "../../../../some/path/evil.js" therefore wrote to a path outside the
// upload directory, from any authenticated, self-registered account calling
// POST /api/v1/user/update-profile.
describe('buildUploadFilename', () => {
  it('never carries a path separator through from a traversal originalname', () => {
    const name = buildUploadFilename('../../../../etc/evil.js');

    expect(name).not.toMatch(/[\\/]/);
    expect(name).not.toContain('..');
    expect(name.endsWith('.js')).toBe(true);
  });

  it('drops an absolute-path originalname entirely, keeping only the extension', () => {
    const name = buildUploadFilename('/etc/passwd');

    // No extension on this input, and the leading "/etc/passwd" contributes
    // nothing to the result — not even as a suffix.
    expect(name).not.toMatch(/[\\/]/);
    expect(name).not.toContain('etc');
    expect(name).not.toContain('passwd');
  });

  it('discards an overlong or non-alphanumeric "extension" rather than trusting it verbatim', () => {
    const withLongExt = buildUploadFilename(`a.${'x'.repeat(50)}`);
    expect(withLongExt).not.toContain('x'.repeat(50));

    const withTraversalExt = buildUploadFilename('a..%2f..%2fevil');
    expect(withTraversalExt).not.toMatch(/[\\/]/);
    expect(withTraversalExt).not.toContain('%2f');
  });

  it('keeps a normal, safe extension for a normal upload', () => {
    expect(buildUploadFilename('profile-photo.png').endsWith('.png')).toBe(true);
    expect(buildUploadFilename('photo.JPG').endsWith('.jpg')).toBe(true);
  });

  it('produces a different name on every call, even for identical input', () => {
    const a = buildUploadFilename('photo.png');
    const b = buildUploadFilename('photo.png');
    expect(a).not.toBe(b);
  });
});

// `upload.single('file')`'s full pipeline: no size limit or type filter used
// to exist at all (JSON/urlencoded bodies are capped at 100kb in app.js, but
// multipart bypassed that entirely), and the staging directory used to sit
// under `./public`, which app.js serves unauthenticated in its entirety —
// together, a narrow but real window for an oversized upload, or a
// script-bearing HTML/SVG payload, to land somewhere publicly fetchable.
describe('upload.single (size limit, type filter, staging location)', () => {
  const buildApp = () => {
    const app = express();
    app.post('/upload', upload.single('file'), (req, res) => {
      res.status(200).json({ path: req.file.path });
    });
    app.use(errorHandler);
    return app;
  };

  it('rejects a file over the size limit with a clean 400, not a raw multer error', async () => {
    const app = buildApp();
    const oversized = Buffer.alloc(6 * 1024 * 1024, 'a'); // 6MB > 5MB limit

    const res = await request(app)
      .post('/upload')
      .attach('file', oversized, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  it('rejects a non-image content type — an HTML payload can never reach disk', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('<script>alert(1)</script>'), {
        filename: 'evil.html',
        contentType: 'text/html',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('stages an accepted upload outside the statically-served public directory', async () => {
    const app = buildApp();

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('not really a png'), {
        filename: 'photo.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(200);

    // path.resolve first: `req.file.path` can come back relative (it did,
    // before this fix, since multer.diskStorage's `destination` callback
    // was itself given the relative string './public/temp') — comparing
    // that directly against an absolute `publicDir` would silently pass
    // for the wrong reason (a relative string never "starts with" an
    // absolute one), not because the file actually landed anywhere new.
    const resolvedPath = path.resolve(res.body.path);
    const publicDir = path.resolve(process.cwd(), 'public');
    expect(resolvedPath.startsWith(publicDir)).toBe(false);

    const expectedDir = path.resolve(process.cwd(), 'uploads', 'temp');
    expect(resolvedPath.startsWith(expectedDir)).toBe(true);

    fs.unlinkSync(resolvedPath);
  });
});
