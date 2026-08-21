import { describe, expect, it } from 'vitest';
import { encodeImage, imageFromBlob, mediaTypeOf, MAX_EDGE_PX } from './images';

/**
 * Preparing an image for a provider.
 *
 * Two failures worth guarding. A megabyte-scale array spread into `String.fromCharCode`
 * throws a RangeError that reads like a corrupt file rather than like a size problem; and a
 * format no provider accepts should be refused here, with a sentence someone can act on,
 * rather than sent and answered with a 400.
 */

describe('encoding', () => {
  it('produces base64 with no data: prefix, because every adapter adds its own framing', () => {
    const img = encodeImage(new Uint8Array([0, 1, 2, 253, 254, 255]), 'image/png');

    expect(img.base64).not.toContain('data:');
    expect(img.base64).toBe(btoa('\x00\x01\x02\xfd\xfe\xff'));
    expect(img.mediaType).toBe('image/png');
  });

  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;

    const decoded = atob(encodeImage(bytes, 'image/png').base64);
    expect(decoded).toHaveLength(256);
    for (let i = 0; i < 256; i++) expect(decoded.charCodeAt(i)).toBe(i);
  });

  it('handles an image far past the argument limit of a single spread', () => {
    // 2 MB. `String.fromCharCode(...bytes)` on this throws RangeError.
    const bytes = new Uint8Array(2_000_000).fill(0x41);
    const img = encodeImage(bytes, 'image/jpeg');

    expect(img.base64.length).toBeGreaterThan(2_600_000);
    expect(atob(img.base64.slice(0, 4))).toBe('AAA');
  });

  it('carries a label through, so a multi-view request can say which view this is', () => {
    expect(encodeImage(new Uint8Array([1]), 'image/png', 'front view').label).toBe('front view');
  });

  it('omits the label rather than carrying an empty one', () => {
    expect(encodeImage(new Uint8Array([1]), 'image/png')).not.toHaveProperty('label');
  });
});

describe('formats', () => {
  it.each([
    ['image/png', 'image/png'],
    ['image/jpeg', 'image/jpeg'],
    ['image/jpg', 'image/jpeg'],
    ['image/webp', 'image/webp'],
    ['image/PNG', 'image/png'],
    ['image/jpeg; charset=binary', 'image/jpeg'],
  ])('reads %s as %s', (given, expected) => {
    expect(mediaTypeOf(given)).toBe(expected);
  });

  it.each(['image/tiff', 'image/heic', 'image/gif', 'application/pdf', ''])(
    'refuses %s, which no provider reads', (given) => {
      expect(mediaTypeOf(given)).toBeNull();
    });
});

describe('from a blob', () => {
  it('encodes the bytes it was given', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const img = await imageFromBlob(blob, 'top');

    expect(img.mediaType).toBe('image/png');
    expect(atob(img.base64)).toBe('\x01\x02\x03');
    expect(img.label).toBe('top');
  });

  it('refuses a format no provider reads, and says what to do instead', async () => {
    const blob = new Blob([new Uint8Array([1])], { type: 'image/heic' });

    await expect(imageFromBlob(blob)).rejects.toThrow(/PNG, JPEG or WebP/);
  });
});

describe('the size a picture is sent at', () => {
  it('is the size above which providers resize server-side anyway', () => {
    // Stated as a constant so the reason survives; sending more is paying for bytes that are
    // discarded before the model sees them.
    expect(MAX_EDGE_PX).toBe(1568);
  });
});
