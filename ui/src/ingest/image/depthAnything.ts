/**
 * Depth Anything V2, in the browser, as a `DepthSource`.
 *
 * ── What this is ──
 *
 * The monocular depth model behind `depth.ts`, run through ONNX Runtime Web on WebAssembly. It
 * turns one photograph into a depth per pixel; `depth.ts` turns that into the height field this
 * application has always built solids from. Between the two, a photograph of a real object
 * becomes an editable parametric feature.
 *
 * Apache-2.0, and it runs on the user's own machine: the image is never uploaded, no key is
 * needed, and nothing about the part leaves the browser. That is not a nicety. The parts people
 * bring here are frequently somebody's unreleased product, and a pipeline that posts them to an
 * API is one a shop cannot use at any price.
 *
 * ── Consent, and why the download is not automatic ──
 *
 * The weights are tens of megabytes and they come from someone else's server. Fetching that the
 * moment a user drags in a picture would spend their bandwidth, on their connection, without
 * asking — so the model is loaded only when it is explicitly asked for, the size is stated before
 * it starts, and it is cached afterwards so the cost is paid once.
 *
 * ── What is tested and what is not ──
 *
 * `preprocess` and `postprocess` are exact arithmetic and are tested against known answers: a
 * known pixel becomes a known tensor value, and a known tensor becomes a known depth at a known
 * position. Get either wrong and the model is fed a blue-shifted, wrongly-scaled image and
 * returns a confident depth map of nothing — the failure would look like a bad model rather than
 * a bad adapter.
 *
 * The session itself is a thin shell over the runtime: create, run, read the one output. It
 * cannot be unit-tested without the weights, so it is kept small enough to read.
 */

import type { DepthSource } from './depth';

/**
 * What the model expects.
 *
 * Every number here is the published preprocessing for Depth Anything V2 and none of it is
 * adjustable, because it is not a setting — it is what the network was trained on. The mean and
 * standard deviation are ImageNet's; feeding raw 0-1 values instead produces an image the network
 * has never seen the like of and a depth map that is smooth, plausible and meaningless.
 */
export const MODEL_INPUT = {
  /** Multiple of 14: the vision transformer's patch size. */
  size: 518,
  mean: [0.485, 0.456, 0.406] as const,
  std: [0.229, 0.224, 0.225] as const,
} as const;

export interface DepthAnythingOptions {
  /**
   * Where the `.onnx` file is.
   *
   * Required, and deliberately not defaulted to somebody's CDN. A default would mean that
   * importing a picture quietly fetched fifty megabytes from a third party — on the user's
   * connection, without being asked, and from a host this project does not control.
   */
  modelUrl: string;
  /** Where the runtime's `.wasm` files are, if not beside the bundle. */
  wasmPath?: string;
  /** Told the download's progress, so a fifty-megabyte wait can be shown rather than endured. */
  onProgress?: (loaded: number, total: number) => void;
  /** Name to report, for the note on the feature. */
  label?: string;
  /**
   * Abandons the download.
   *
   * A fifty-megabyte fetch over a poor connection can stall, and a user watching a progress
   * figure that has not moved in two minutes has to be able to walk away. Without this the only
   * exit is to reload the page and lose the part.
   */
  signal?: AbortSignal;
}

/**
 * A depth source backed by the model.
 *
 * The session is created on first use and kept: loading is the expensive part and a user reading
 * three photographs should pay for it once.
 */
export function depthAnything(options: DepthAnythingOptions): DepthSource {
  let session: Promise<OrtSession> | null = null;

  return {
    name: options.label ?? 'Depth Anything V2 (ONNX)',

    async estimate(image) {
      session ??= loadSession(options);
      const ort = await session;

      const { size } = MODEL_INPUT;
      const input = preprocess(image, size);

      const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);
      const output = await ort.session.run({ [ort.inputName]: tensor });

      const result = output[ort.outputName];
      if (!result) {
        throw new Error(`The model produced no output named "${ort.outputName}".`);
      }

      return {
        depth: postprocess(
          result.data as Float32Array, size, size, image.width, image.height,
        ),
        width: image.width,
        height: image.height,
      };
    },
  };
}

// ── the arithmetic ───────────────────────────────────────────────────────────

/**
 * An image as the tensor the model wants: `[1, 3, size, size]`, planar, normalised.
 *
 * Planar rather than interleaved — all the reds, then all the greens, then all the blues — which
 * is what NCHW means and is the opposite of how the pixels arrive. Interleaving them the wrong
 * way produces a picture that is technically the same bytes and visually noise.
 *
 * Resampled with bilinear interpolation rather than by dropping pixels: nearest-neighbour on a
 * photograph aliases every edge, and edges are precisely what a depth model reads.
 */
export function preprocess(
  image: { width: number; height: number; data: Uint8ClampedArray },
  size: number,
): Float32Array {
  const out = new Float32Array(3 * size * size);
  const plane = size * size;

  const sx = image.width / size;
  const sy = image.height / size;

  for (let y = 0; y < size; y++) {
    // Sampled at the middle of each output pixel, which is what keeps the image centred instead
    // of drifting half a pixel towards the origin.
    const fy = (y + 0.5) * sy - 0.5;

    for (let x = 0; x < size; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const [r, g, b] = sampleBilinear(image, fx, fy);

      const at = y * size + x;
      out[at] = (r / 255 - MODEL_INPUT.mean[0]) / MODEL_INPUT.std[0];
      out[plane + at] = (g / 255 - MODEL_INPUT.mean[1]) / MODEL_INPUT.std[1];
      out[2 * plane + at] = (b / 255 - MODEL_INPUT.mean[2]) / MODEL_INPUT.std[2];
    }
  }

  return out;
}

/**
 * The model's output, back at the picture's own size.
 *
 * The network works at a fixed square and the picture is neither square nor that size, so the
 * result has to be resampled back — and it has to land on the same pixels the tracer masked, or
 * the height field and the outline describe different objects.
 */
export function postprocess(
  depth: Float32Array, fromWidth: number, fromHeight: number,
  toWidth: number, toHeight: number,
): Float32Array {
  const out = new Float32Array(toWidth * toHeight);

  const sx = fromWidth / toWidth;
  const sy = fromHeight / toHeight;

  for (let y = 0; y < toHeight; y++) {
    const fy = clamp((y + 0.5) * sy - 0.5, 0, fromHeight - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(fromHeight - 1, y0 + 1);
    const ty = fy - y0;

    for (let x = 0; x < toWidth; x++) {
      const fx = clamp((x + 0.5) * sx - 0.5, 0, fromWidth - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(fromWidth - 1, x0 + 1);
      const tx = fx - x0;

      const a = depth[y0 * fromWidth + x0]!;
      const b = depth[y0 * fromWidth + x1]!;
      const c = depth[y1 * fromWidth + x0]!;
      const d = depth[y1 * fromWidth + x1]!;

      out[y * toWidth + x] = (a * (1 - tx) + b * tx) * (1 - ty)
        + (c * (1 - tx) + d * tx) * ty;
    }
  }

  return out;
}

function sampleBilinear(
  image: { width: number; height: number; data: Uint8ClampedArray }, fx: number, fy: number,
): [number, number, number] {
  const x = clamp(fx, 0, image.width - 1);
  const y = clamp(fy, 0, image.height - 1);

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);

  const tx = x - x0;
  const ty = y - y0;

  const at = (px: number, py: number, c: number) => image.data[(py * image.width + px) * 4 + c]!;

  const mix = (c: number) => (
    (at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx) * (1 - ty)
    + (at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx) * ty
  );

  return [mix(0), mix(1), mix(2)];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ── the runtime ──────────────────────────────────────────────────────────────

interface OrtSession {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
  session: { run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>> };
  inputName: string;
  outputName: string;
}

/**
 * Loads the runtime and the weights.
 *
 * Imported dynamically, so the runtime is not in the bundle everybody downloads. Most sessions
 * never touch a depth model, and making them all carry it would be several megabytes of tax on
 * opening a CAD application.
 */
async function loadSession(options: DepthAnythingOptions): Promise<OrtSession> {
  const ort = await import('onnxruntime-web');

  if (options.wasmPath) ort.env.wasm.wasmPaths = options.wasmPath;

  const bytes = await fetchWithProgress(options.modelUrl, options.onProgress, options.signal);

  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });

  /*
   * The names are read from the model rather than assumed.
   *
   * Every export of this network names its tensors differently — `image`, `pixel_values`,
   * `input`, and the output `depth` or `predicted_depth`. Hard-coding one guess means a model
   * that is present, valid and correct fails with a message about a missing key, and the user has
   * no way to know which of the two names is wrong.
   */
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  if (!inputName || !outputName) {
    throw new Error('That ONNX file does not declare an input and an output.');
  }

  return {
    Tensor: ort.Tensor as OrtSession['Tensor'],
    session: session as unknown as OrtSession['session'],
    inputName,
    outputName,
  };
}

/**
 * Fetches with progress, because fifty megabytes is a wait somebody is watching.
 *
 * A `Content-Length` is not guaranteed — a gzipped response often has none — so the total is
 * reported as zero when it is unknown rather than invented, and a caller showing a bar can fall
 * back to showing bytes.
 */
async function fetchWithProgress(
  url: string, onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, signal ? { signal } : {});

  if (!response.ok) {
    throw new Error(`The model could not be fetched from ${url} (${response.status}).`);
  }

  const total = Number(response.headers.get('content-length') ?? 0);

  if (!response.body || !onProgress) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    if (signal?.aborted) {
      await reader.cancel();
      throw new Error('The download was stopped.');
    }

    const { done, value } = await reader.read();
    if (done) break;

    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }

  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }

  return out;
}
