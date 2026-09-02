// Multer's fileFilter only ever sees `file.mimetype`, which is the
// multipart part's client-supplied Content-Type header — fully attacker-
// controlled and independent of the actual bytes sent. A request claiming
// `image/png` with an actual SVG/HTML body (carrying a <script>) passes
// that check cleanly. This reads the handful of leading bytes each real
// image format is required to start with — content, not metadata — so a
// mismatched or unrecognized payload can be caught after multer has
// already written it to disk, before it goes anywhere further (Cloudinary).
//
// Deliberately hand-rolled rather than a dependency: exactly four formats
// to recognize, each with a short, stable, well-known signature — the kind
// of check that's easier to read and trust in twenty lines here than to
// audit inside a third-party package pulled in for this alone.
export const sniffImageType = (buffer) => {
  if (!buffer || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngSignature.every((byte, i) => buffer[i] === byte)) {
    return 'image/png';
  }

  const asciiPrefix = (length) => buffer.subarray(0, length).toString('ascii');
  if (asciiPrefix(6) === 'GIF87a' || asciiPrefix(6) === 'GIF89a') {
    return 'image/gif';
  }

  // RIFF????WEBP — bytes 4-7 are the (variable) chunk size, not part of the
  // signature itself.
  if (asciiPrefix(4) === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }

  return null;
};
