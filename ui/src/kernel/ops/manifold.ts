/**
 * Booleans through Manifold.
 *
 * The BSP in `boolean.ts` is honest, readable and ours, and it has a ceiling we have spent a
 * long time measuring: filleting a plain box rounds ten edges of twelve, a spoked wheel will
 * not merge into one shell at most spoke widths, a bore through a fifty-tooth gear comes back
 * with two hundred open edges. None of those are bugs left to find. They are what happens when
 * a solid is a pile of triangles and every operation has to decide, in floating point, which
 * side of a plane each of them is on.
 *
 * Manifold takes a different approach: it is *guaranteed* manifold by construction rather than
 * by hoping the epsilons work out, and it is the engine behind OpenSCAD and Blender's boolean
 * node. Apache-2.0, so it ships with no obligations at all, and 2.8 MB rather than the 67 MB a
 * full B-rep kernel costs.
 *
 * Two things this adapter has to get right beyond calling the library.
 *
 * **Face identity must survive.** Every face in this application carries a tag naming the
 * feature that made it and, for analytic surfaces, its axis and radius. Selection, filleting,
 * drawing and the bill of materials all depend on it. Manifold carries a `faceID` per triangle
 * through booleans untouched, so the tags travel with the geometry — that is the single
 * property that made this swap possible at all.
 *
 * **It must degrade rather than fail.** The WASM has to load, which is asynchronous, and in
 * some environments will not happen. So this is never the only path: `boolean()` asks whether
 * Manifold is ready and falls back to the BSP when it is not. Everything keeps working with a
 * slightly lower ceiling, which is exactly where we were before.
 */

import type { ManifoldToplevel, Manifold as ManifoldSolid } from 'manifold-3d';
import ManifoldModule from 'manifold-3d';
// The bundler resolves this to a real, hashed URL in a build and a dev URL while serving.
//
// Emscripten otherwise guesses where its .wasm lives by looking beside the script that loaded
// it, and Vite's dependency pre-bundling moves the script somewhere the file is not. The
// request then 404s, the dev server answers with index.html, and the loader reports that it
// expected the WebAssembly magic word and found "<!do" — which is a long way of saying it was
// handed a web page.
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { triCount, type FaceTag, type Mesh } from '../topo/mesh';

// ── loading ──────────────────────────────────────────────────────────────────

let toplevel: ManifoldToplevel | null = null;
let loading: Promise<ManifoldToplevel | null> | null = null;
let failure: string | null = null;

/**
 * Loads the engine, once.
 *
 * Repeated calls share the same promise, so a dozen call sites racing at startup still
 * instantiate one module. A failure is remembered as "unavailable" rather than retried on
 * every boolean, which would turn a missing file into a per-operation stall.
 */
export function initManifold(): Promise<ManifoldToplevel | null> {
  if (toplevel) return Promise.resolve(toplevel);
  if (loading) return loading;

  // Only override where the bundler's URL is one a browser can fetch.
  //
  // `?url` is a Vite transform. In a browser it becomes a real, hashed asset path, which
  // Emscripten needs because dependency pre-bundling moves its loader away from its .wasm.
  // Under Node — which is where the tests run — the same import resolves to a bare path that
  // the loader then treats as a filename, and it goes hunting in the filesystem root. There,
  // Emscripten's own resolution already works, so the best thing to do is nothing.
  const options = isNode() ? undefined : { locateFile: () => wasmUrl };

  loading = ManifoldModule(options)
    .then((wasm) => {
      wasm.setup();
      toplevel = wasm;
      failure = null;
      return wasm;
    })
    .catch((e: unknown) => {
      // Kept, not swallowed.
      //
      // Falling back silently is the right *behaviour* — the application keeps working — but
      // it made the reason invisible, and the reason was a one-word omission in this page's
      // own Content-Security-Policy: compiling WebAssembly counts as dynamic code generation,
      // so `script-src 'self'` blocked it. The .wasm downloaded, instantiation threw, every
      // boolean quietly ran on the old engine, and the only symptom was that a cup came out
      // with five times the triangles it should have. Two hours to find something that says
      // so in one line.
      failure = e instanceof Error ? e.message : String(e);
      return null;
    });

  return loading;
}

/**
 * Which engine booleans are running on, and why.
 *
 * Exposed so the diagnostics screen and the tests can both ask, rather than inferring it from
 * triangle counts.
 */
export function manifoldStatus(): { ready: boolean; reason: string | null } {
  return { ready: toplevel !== null, reason: failure };
}

/** True when running under Node rather than in a browser. */
function isNode(): boolean {
  return typeof process !== 'undefined'
    && process.versions !== undefined
    && process.versions.node !== undefined;
}

/** True when a boolean can be run through Manifold right now, without awaiting. */
export const manifoldReady = (): boolean => toplevel !== null;

/** For tests and diagnostics: forget the loaded module. */
export function resetManifold(): void {
  toplevel = null;
  loading = null;
  failure = null;
}

// ── conversion ───────────────────────────────────────────────────────────────

/**
 * Our mesh, as Manifold sees it.
 *
 * Positions go across as Float64. Manifold accepts them, and passing Float32 instead would
 * quantise a 43-metre airliner to about four microns — which is fine for that aeroplane and
 * not fine as a rule the whole kernel has to live under.
 */
function toSolid(wasm: ManifoldToplevel, mesh: Mesh, idOffset: number): ManifoldSolid {
  const faceID = new Uint32Array(mesh.faceIds.length);
  for (let i = 0; i < faceID.length; i++) faceID[i] = mesh.faceIds[i] + idOffset;

  const input = new wasm.Mesh({
    numProp: 3,
    vertProperties: mesh.positions as unknown as Float32Array,
    triVerts: mesh.indices,
    faceID,
  });

  return wasm.Manifold.ofMesh(input);
}

/**
 * Manifold's result, as one of ours.
 *
 * Output triangles carry the `faceID` of whichever input face they came from, so the tag map
 * is rebuilt by looking each one up. Manifold assigns its own ids to faces it creates, and
 * those are the genuinely new surfaces a cut exposes — they get a tag naming the operation
 * that made them, which is what the feature tree wants to show anyway.
 */
function fromSolid(
  solid: ManifoldSolid, tags: Map<number, FaceTag>, newFaceTag: FaceTag,
): Mesh {
  const out = solid.getMesh();

  const triangles = out.triVerts.length / 3;
  const faceIds = new Uint32Array(triangles);
  const rebuilt = new Map<number, FaceTag>();

  // Ids Manifold invented are renumbered above everything we know about, so they cannot
  // collide with a tag that means something else.
  let nextNew = 1;
  for (const id of tags.keys()) if (id >= nextNew) nextNew = id + 1;
  const invented = new Map<number, number>();

  const source = out.faceID;

  for (let t = 0; t < triangles; t++) {
    const raw = source ? source[t] : 0;
    const known = tags.get(raw);

    if (known) {
      faceIds[t] = raw;
      rebuilt.set(raw, known);
      continue;
    }

    let id = invented.get(raw);
    if (id === undefined) {
      id = nextNew++;
      invented.set(raw, id);
      rebuilt.set(id, { ...newFaceTag, id });
    }
    faceIds[t] = id;
  }

  return {
    positions: new Float64Array(out.vertProperties),
    indices: new Uint32Array(out.triVerts),
    faceIds,
    tags: rebuilt,
  };
}

// ── the operation ────────────────────────────────────────────────────────────

export type ManifoldOp = 'union' | 'difference' | 'intersection';

export interface ManifoldOutcome {
  mesh: Mesh;
  /** Manifold's own verdict. Anything but NoError means the result is not trustworthy. */
  status: string;
  genus: number;
  volume: number;
}

/**
 * Runs one boolean, or returns null when Manifold cannot.
 *
 * Null rather than a throw, because the caller's job on failure is to fall back to the BSP and
 * carry on — not to surface an exception from a library the user never chose.
 */
export function manifoldBoolean(a: Mesh, b: Mesh, op: ManifoldOp): ManifoldOutcome | null {
  const wasm = toplevel;
  if (!wasm) return null;
  if (triCount(a) === 0 || triCount(b) === 0) return null;

  // The two operands' face ids are numbered independently, so one is shifted clear of the
  // other before they meet. Without this, face 3 of the tool and face 3 of the body are the
  // same face as far as Manifold is concerned, and the tags come back scrambled.
  let offset = 1;
  for (const id of a.tags.keys()) if (id >= offset) offset = id + 1;

  const combined = new Map<number, FaceTag>(a.tags);
  for (const [id, tag] of b.tags) combined.set(id + offset, { ...tag, id: id + offset });

  const feature = [...b.tags.values()][0]?.feature ?? 'Boolean';
  const newFaceTag: FaceTag = { id: 0, feature, kind: 'freeform' };

  let solidA: ManifoldSolid | null = null;
  let solidB: ManifoldSolid | null = null;
  let result: ManifoldSolid | null = null;

  try {
    solidA = toSolid(wasm, a, 0);
    solidB = toSolid(wasm, b, offset);

    result = op === 'union'
      ? wasm.Manifold.union(solidA, solidB)
      : op === 'difference'
        ? wasm.Manifold.difference(solidA, solidB)
        : wasm.Manifold.intersection(solidA, solidB);

    const status = String(result.status());
    if (status !== 'NoError') return null;

    return {
      mesh: fromSolid(result, combined, newFaceTag),
      status,
      genus: result.genus(),
      volume: result.volume(),
    };
  } catch {
    return null;
  } finally {
    // WASM memory is not garbage collected. Every solid built here has to be released or a
    // long modelling session leaks until the tab dies.
    solidA?.delete();
    solidB?.delete();
    result?.delete();
  }
}
