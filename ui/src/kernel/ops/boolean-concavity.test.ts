/**
 * A known defect in `boolean`, pinned with its actual trigger.
 *
 * ── What breaks ──────────────────────────────────────────────────────────────
 *
 * A difference fails when the first operand already contains a **concave tessellated
 * cylinder** — a bore. The result is non-manifold, with duplicated triangles and a wrong
 * Euler characteristic.
 *
 * ── What does NOT trigger it (each of these was measured) ─────────────────────
 *
 *   - **Genus.** A square hole cut by a square tool goes genus 1 → 2 perfectly. A *blind*
 *     bore, which leaves the solid at genus 0, fails. So it is not about holes.
 *   - **Triangle count.** A cylindrical boss unioned onto the plate — 372 triangles, more
 *     than the failing case — cuts cleanly.
 *   - **The cutter.** A box cutter fails against a bored plate exactly like a cylindrical
 *     one, and a cylindrical cutter works fine against a square-holed plate. The defect is
 *     in what operand A already contains, not in what is being removed.
 *   - **Scale, and therefore the epsilon.** Shrinking the model by 1000 makes it pass, but
 *     only because `cylinder()` tessellates adaptively: the bore drops from 270 triangles
 *     to 80 and stops being finely faceted. Growing it by 1000 makes it much worse
 *     (304 duplicate triangles).
 *
 * The pattern that survives all of that is concavity plus facet density.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 *
 * `Node.clipPolygons` assumes that reaching a node with no back child means everything
 * behind that plane is interior:
 *
 *     back = this.back ? this.back.clipPolygons(back) : [];
 *
 * That is exact for a convex solid and only approximately true for a concave one, where it
 * relies on the tree being subdivided finely enough to resolve the concavity. A finely
 * faceted bore produces a fan of near-parallel tangent planes and therefore many thin cells
 * that contain no polygons, so no further subdivision happens and the assumption is applied
 * where it does not hold. This is the well-known robustness limit of csg.js-style BSP CSG,
 * not a small coding error.
 *
 * ── Impact ───────────────────────────────────────────────────────────────────
 *
 * `subtractAll` and `unionAll` already batch, so several cutters *within one feature* are
 * safe — that is why bolt patterns work. The exposure is *across* features, which a feature
 * tree applies one at a time by definition. Any part with a hole followed by another cut is
 * affected, and the corruption is quiet: the mesh still draws, but its volume, mass, section
 * properties and STEP export are all meaningless.
 *
 * `boolean()` does return `valid: false`, so callers that check are warned. Callers that
 * ignore it are not.
 *
 * ── This file ────────────────────────────────────────────────────────────────
 *
 * The `it.fails` cases assert the defect is STILL PRESENT. When the classifier is fixed they
 * will start failing, which is the signal to drop the marker and promote them.
 */

import { describe, expect, it } from 'vitest';
import { box, cylinder } from './build';
import { boolean, subtract, union } from './boolean';
import { health, type Mesh } from '../topo/mesh';

const plate = (): Mesh => box(100, 40, 10);

/** A cutter long enough to clear both faces of a 10 mm plate. */
const cutter = (x: number, r = 3) => cylinder(r, 60, [x, 0, 0], [0, 0, 1], `Tool${x}`);
const squareCutter = (x: number) => box(8, 8, 60, [x, 0, 0]);

const ok = (m: Mesh) => { const s = health(m); return s.closed && s.manifold; };

describe('difference against a solid containing a bore', () => {
  it('a single cut into a solid block is clean', () => {
    const r = subtract(plate(), cutter(-30));

    expect(r.valid, r.diagnostic).toBe(true);
    expect(health(r.mesh).genus).toBe(1);
  });

  it('a SQUARE hole then a square cut is clean — so genus is not the trigger', () => {
    const one = subtract(plate(), squareCutter(-30));
    expect(one.valid, one.diagnostic).toBe(true);
    expect(health(one.mesh).genus).toBe(1);

    const two = subtract(one.mesh, squareCutter(30));
    expect(two.valid, two.diagnostic).toBe(true);
    expect(health(two.mesh).genus).toBe(2);
  });

  it('a cylindrical BOSS in operand A is fine — so triangle count is not the trigger', () => {
    const bossy = union(plate(), cylinder(4, 30, [-30, 0, 0], [0, 0, 1], 'Boss'));
    expect(bossy.valid, bossy.diagnostic).toBe(true);

    const cut = subtract(bossy.mesh, squareCutter(30));
    expect(cut.valid, cut.diagnostic).toBe(true);
    expect(ok(cut.mesh)).toBe(true);
  });

  // These two were `it.fails` for most of this project's life. They recorded the defect that
  // shaped almost every workaround in the kernel: once operand A contained a bore, the *next*
  // cut came back with open and non-manifold edges — 4 boundary, 12 non-manifold, 10 duplicate
  // triangles on the first, and the second proved genus had nothing to do with it.
  //
  // Manifold is guaranteed manifold by construction rather than by classifying triangles
  // against planes in floating point, so both simply work. They are kept, un-skipped, because
  // a regression here would take the workarounds' reason with it.
  it('a bore in operand A no longer breaks the next cut', () => {
    const one = subtract(plate(), cutter(-30));
    const two = subtract(one.mesh, cutter(30));

    expect(two.valid, two.diagnostic).toBe(true);
    expect(ok(two.mesh)).toBe(true);
    expect(health(two.mesh).genus).toBe(2);
  });

  it('a blind bore no longer breaks it either', () => {
    const one = subtract(plate(), cylinder(3, 6, [-30, 0, 3], [0, 0, 1], 'Blind'));
    expect(one.valid, one.diagnostic).toBe(true);
    expect(health(one.mesh).genus).toBe(0);

    const two = subtract(one.mesh, squareCutter(30));
    expect(two.valid, two.diagnostic).toBe(true);
    expect(ok(two.mesh)).toBe(true);
  });

  it('WORKAROUND: union the cutters, then take one difference', () => {
    const tools = union(cutter(-30), cutter(30));
    expect(tools.valid, tools.diagnostic).toBe(true);

    const r = boolean(plate(), tools.mesh, 'difference');

    expect(r.valid, r.diagnostic).toBe(true);
    expect(health(r.mesh).duplicateTriangles).toBe(0);
    expect(health(r.mesh).genus).toBe(2);
  });

  it('WORKAROUND: still correct at four holes — this is why bolt patterns work', () => {
    let tools = cutter(-30);
    for (const x of [-10, 10, 30]) {
      const u = union(tools, cutter(x));
      expect(u.valid, u.diagnostic).toBe(true);
      tools = u.mesh;
    }

    const r = boolean(plate(), tools, 'difference');

    expect(r.valid, r.diagnostic).toBe(true);
    expect(health(r.mesh).genus).toBe(4);
  });
});
