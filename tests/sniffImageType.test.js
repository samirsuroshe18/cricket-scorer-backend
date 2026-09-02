import { sniffImageType } from '../src/utils/sniffImageType.js';

// Multer's fileFilter only ever sees file.mimetype — the multipart part's
// client-supplied Content-Type header, fully attacker-controlled and
// independent of the actual bytes sent. sniffImageType reads content
// instead, so a spoofed-mimetype upload (e.g. an SVG-with-<script> sent as
// "image/png") can be caught after multer writes it to disk.
describe('sniffImageType', () => {
  it('recognizes a real JPEG by its leading bytes', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(sniffImageType(buffer)).toBe('image/jpeg');
  });

  it('recognizes a real PNG by its leading bytes', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    expect(sniffImageType(buffer)).toBe('image/png');
  });

  it('recognizes a real GIF (GIF89a) by its leading bytes', () => {
    const buffer = Buffer.from('GIF89a' + '\x00'.repeat(6), 'ascii');
    expect(sniffImageType(buffer)).toBe('image/gif');
  });

  it('recognizes a real GIF (GIF87a) by its leading bytes', () => {
    const buffer = Buffer.from('GIF87a' + '\x00'.repeat(6), 'ascii');
    expect(sniffImageType(buffer)).toBe('image/gif');
  });

  it('recognizes a real WebP (RIFF....WEBP) by its leading bytes', () => {
    const buffer = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]), // chunk size — irrelevant to the signature
      Buffer.from('WEBP', 'ascii'),
    ]);
    expect(sniffImageType(buffer)).toBe('image/webp');
  });

  it('rejects an SVG payload — the classic mimetype-spoofed-as-image case', () => {
    const buffer = Buffer.from('<svg onload="alert(1)"><script>alert(1)</script></svg>', 'ascii');
    expect(sniffImageType(buffer)).toBeNull();
  });

  it('rejects an HTML payload', () => {
    const buffer = Buffer.from('<html><body><script>alert(1)</script></body></html>', 'ascii');
    expect(sniffImageType(buffer)).toBeNull();
  });

  it('rejects a RIFF file that is not actually WebP (e.g. a WAV)', () => {
    const buffer = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
    ]);
    expect(sniffImageType(buffer)).toBeNull();
  });

  it('returns null for a buffer too short to carry any signature', () => {
    expect(sniffImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('returns null for an empty or missing buffer', () => {
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageType(null)).toBeNull();
    expect(sniffImageType(undefined)).toBeNull();
  });
});
