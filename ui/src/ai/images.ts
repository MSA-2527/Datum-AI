import type { RequestImage } from './providers';

/**
 * Turning what the user has into what a model can be sent.
 *
 * Every provider takes base64 and none of them takes a `blob:` or `data:` URL from a page's
 * own memory — there is no server here to host one from, and a model's fetcher cannot reach
 * into a browser tab. The bytes travel with the request or they do not travel at all.
 *
 * The size rule is the reason this file is worth having rather than inlining `btoa` at each
 * call site. Every one of these APIs rejects above roughly 3.7 MB of image, and a photograph
 * off a phone is comfortably past that; a 413 from an oversized image is also indistinguishable
 * from a rate limit, so the request layer would respond by shrinking the *text* budget, which
 * cannot help. Scaling first means the refusal never happens, and it costs nothing: detail
 * beyond a couple of megapixels does not survive the model's own resizing either.
 */

/**
 * The longest edge a picture is scaled to before sending.
 *
 * 1568 px is the size above which Anthropic resizes server-side, and the others are close
 * enough that one number serves all of them. Sending more is paying for bytes that are thrown
 * away before the model sees them.
 */
export const MAX_EDGE_PX = 1568;

/** Base64 for a byte array, without the `data:` prefix. */
export function encodeImage(
  bytes: Uint8Array, mediaType: RequestImage['mediaType'], label?: string,
): RequestImage {
  // Chunked rather than one spread: `String.fromCharCode(...bytes)` on a megabyte-scale array
  // exceeds the argument limit and throws a RangeError that reads like a corrupt file.
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  return { mediaType, base64: btoa(binary), ...(label ? { label } : {}) };
}

/** The media type for a blob, or null when it is not one any provider accepts. */
export function mediaTypeOf(type: string): RequestImage['mediaType'] | null {
  const clean = type.toLowerCase().split(';')[0]!.trim();
  if (clean === 'image/png' || clean === 'image/webp') return clean;
  if (clean === 'image/jpeg' || clean === 'image/jpg') return 'image/jpeg';
  return null;
}

/**
 * A file or blob, ready to send.
 *
 * Rejects a format no provider reads rather than sending it and letting the API answer — a
 * TIFF or an HEIC off a camera is a normal thing for someone to try, and "that format cannot
 * be sent; save it as PNG or JPEG" is a better answer than a 400 quoted back.
 */
export async function imageFromBlob(blob: Blob, label?: string): Promise<RequestImage> {
  const mediaType = mediaTypeOf(blob.type);
  if (!mediaType) {
    throw new Error(
      `${blob.type || 'That file'} cannot be sent to a model. Save it as PNG, JPEG or WebP.`,
    );
  }

  return encodeImage(new Uint8Array(await bytesOf(blob)), mediaType, label);
}

/**
 * The bytes of a blob, whichever way this runtime offers them.
 *
 * `Blob.arrayBuffer` is the direct route and is missing from older Safari and from jsdom,
 * where the tests for this file run. `FileReader` is universal and older, so it is the
 * fallback rather than the default.
 */
async function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Whatever is drawn on a canvas, scaled to a size worth sending.
 *
 * PNG rather than JPEG: these are renders and traced drawings, where a compression artefact
 * along an edge is exactly the detail being asked about.
 */
export async function imageFromCanvas(
  canvas: HTMLCanvasElement, label?: string, maxEdge = MAX_EDGE_PX,
): Promise<RequestImage> {
  const source = scaleToFit(canvas, maxEdge);

  const blob = await new Promise<Blob | null>((resolve) => source.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The browser could not encode that image.');

  return imageFromBlob(blob, label);
}

/**
 * The same canvas, or a smaller copy of it.
 *
 * Returns the original untouched when it already fits, so the common case allocates nothing.
 */
export function scaleToFit(canvas: HTMLCanvasElement, maxEdge = MAX_EDGE_PX): HTMLCanvasElement {
  const longest = Math.max(canvas.width, canvas.height);
  if (longest <= maxEdge || longest === 0) return canvas;

  const scale = maxEdge / longest;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * scale));
  out.height = Math.max(1, Math.round(canvas.height * scale));

  const ctx = out.getContext('2d');
  if (!ctx) return canvas;

  // Smoothing on: this is a downscale, and nearest-neighbour on a render produces aliasing
  // the model would read as a feature.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);

  return out;
}
