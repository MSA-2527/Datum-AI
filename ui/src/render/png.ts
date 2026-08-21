/**
 * A PNG encoder, in about a hundred lines and with no dependencies.
 *
 * ── Why write one ──
 *
 * The renderer has to produce a picture a model can be sent, from Node as well as from a
 * browser. A browser has `canvas.toBlob`; Node does not, and `node:zlib` cannot be imported
 * into the browser bundle without a polyfill nobody wants. One encoder that runs in both is
 * smaller than the platform split it replaces.
 *
 * ── Why it does not compress ──
 *
 * DEFLATE permits **stored** blocks: uncompressed data with a five-byte header. A file made of
 * them is a completely valid PNG that every decoder reads, and writing one needs no Huffman
 * coder, no LZ77 window and no dependency — about twenty lines instead of a thousand.
 *
 * The cost is size, and it does not matter here. These images exist to be handed to a model
 * that resizes them to about 1568 px before looking at them; a 512 × 512 render is roughly a
 * megabyte stored, comfortably inside the 3.7 MB every provider accepts. Paying a thousand
 * lines of compressor to save bytes nobody transmits twice would be the wrong trade.
 */

/** A CRC-32 table, built once. PNG requires a checksum on every chunk. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32, which zlib puts at the end of its stream. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(name.length + data.length);
  body.set(name, 0);
  body.set(data, name.length);

  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 4 + body.length);
  return out;
}

/** A zlib stream of stored blocks — valid DEFLATE, no compression. */
function zlibStored(data: Uint8Array): Uint8Array {
  const MAX = 65535;
  const blocks = Math.max(1, Math.ceil(data.length / MAX));
  const out = new Uint8Array(2 + blocks * 5 + data.length + 4);

  // 0x78 0x01: deflate, 32K window, no preset dictionary, fastest.
  out[0] = 0x78;
  out[1] = 0x01;

  let at = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * MAX;
    const len = Math.min(MAX, data.length - start);
    const last = i === blocks - 1 ? 1 : 0;

    out[at++] = last;                       // BFINAL, BTYPE = 00 (stored)
    out[at++] = len & 0xff;
    out[at++] = (len >>> 8) & 0xff;
    out[at++] = ~len & 0xff;                // one's complement, as the format requires
    out[at++] = (~len >>> 8) & 0xff;

    out.set(data.subarray(start, start + len), at);
    at += len;
  }

  out.set(u32(adler32(data)), at);
  return out;
}

/**
 * RGBA pixels as a PNG.
 *
 * Filter byte zero on every scanline — "none". A filter would help a real compressor and helps
 * a stored stream not at all.
 */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`Expected ${width * height * 4} bytes for ${width} × ${height}, got ${rgba.length}.`);
  }

  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const to = y * (1 + width * 4);
    raw[to] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), to + 1);
  }

  const header = new Uint8Array(13);
  header.set(u32(width), 0);
  header.set(u32(height), 4);
  header[8] = 8;      // bit depth
  header[9] = 6;      // colour type: RGBA
  header[10] = 0;     // deflate
  header[11] = 0;     // adaptive filtering
  header[12] = 0;     // no interlace

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    chunk('IHDR', header),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);

  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  return png;
}
