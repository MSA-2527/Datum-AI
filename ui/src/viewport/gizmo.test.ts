import { describe, expect, it } from 'vitest';
import { defaultCamera, namedView, orbit, type CameraState, type NamedView } from './camera';
import {
  MIN_SCREEN_SPAN, dragAboutAxis, dragAlongAxis, gizmoHandles, gizmoOrigin, grabHandle,
} from './gizmo';

/**
 * Moving and turning a part by dragging it.
 *
 * Every case here has an answer known before the code runs. A gizmo that is merely plausible is
 * worse than none: it puts the part somewhere the user did not ask for, in a way that looks
 * deliberate, and the mistake is only found when the assembly is measured.
 */

const HEIGHT = 800;
const ASPECT = 1.5;

function at(view: NamedView, fovMm = 200): CameraState {
  return namedView({ ...defaultCamera(), fovMm }, view);
}

describe('where the handles are', () => {
  it('puts one move and one turn handle on each axis', () => {
    const handles = gizmoHandles(at('iso'), [0, 0, 0], ASPECT);

    expect(handles).toHaveLength(6);
    expect(new Set(handles.map((h) => h.axis))).toEqual(new Set(['x', 'y', 'z']));
    expect(handles.filter((h) => h.mode === 'move')).toHaveLength(3);
  });

  it('draws them out from the part, not from the middle of the screen', () => {
    const handles = gizmoHandles(at('iso'), [50, 30, 10], ASPECT);

    for (const h of handles) {
      // Every shaft starts at the same place: the part's own origin.
      expect(h.from).toEqual(handles[0]!.from);
    }
    expect(handles[0]!.from.x).not.toBeCloseTo(0.5, 3);
  });

  it('stays the same size on screen however far the camera is', () => {
    const near = gizmoHandles(at('iso', 20), [0, 0, 0], ASPECT);
    const far = gizmoHandles(at('iso', 4000), [0, 0, 0], ASPECT);

    expect(far[0]!.at.x).toBeCloseTo(near[0]!.at.x, 9);
    expect(far[0]!.at.y).toBeCloseTo(near[0]!.at.y, 9);
  });

  it('marks an axis pointing at the viewer as no use for sliding', () => {
    // Looking down Z: the Z arrow is a dot.
    const z = gizmoHandles(at('top'), [0, 0, 0], ASPECT)
      .find((h) => h.axis === 'z' && h.mode === 'move')!;

    expect(z.span).toBeLessThan(MIN_SCREEN_SPAN);
    expect(z.usable).toBe(false);
  });

  it('marks that same axis as the best one to turn about', () => {
    // Its arc faces the viewer square on, which is exactly when a turn reads clearly.
    const z = gizmoHandles(at('top'), [0, 0, 0], ASPECT)
      .find((h) => h.axis === 'z' && h.mode === 'turn')!;

    expect(z.usable).toBe(true);
  });

  it('never puts a turn handle on the gizmo centre', () => {
    /*
     * Where a turn handle used to land for any axis pointing at the viewer — which is the one
     * orientation in which turning about that axis is easiest to see. A drag that starts on the
     * centre sweeps no angle, so the most useful handle on the gizmo was the one that did
     * nothing.
     */
    for (const view of ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'] as const) {
      for (const h of gizmoHandles(at(view), [0, 0, 0], ASPECT)) {
        if (h.mode !== 'turn') continue;

        const away = Math.hypot((h.at.x - h.from.x) * ASPECT, h.at.y - h.from.y);
        expect(away, `the ${h.axis} turn handle sits on the centre in the ${view} view`)
          .toBeGreaterThan(0.05);
      }
    }
  });

  it('keeps the three turn handles apart even when every axis is edge-on', () => {
    // Two handles at the same point is one handle the user can never reach.
    const turns = gizmoHandles(at('top'), [0, 0, 0], ASPECT).filter((h) => h.mode === 'turn');

    for (let i = 0; i < turns.length; i++) {
      for (let j = i + 1; j < turns.length; j++) {
        const apart = Math.hypot(
          (turns[i]!.at.x - turns[j]!.at.x) * ASPECT, turns[i]!.at.y - turns[j]!.at.y,
        );
        expect(apart, `${turns[i]!.axis} and ${turns[j]!.axis} turn handles overlap`)
          .toBeGreaterThan(0.02);
      }
    }
  });

  it('has all three sliding axes usable in a three-quarter view, which is why it is the default', () => {
    for (const h of gizmoHandles(at('iso'), [0, 0, 0], ASPECT)) {
      expect(h.usable, `${h.axis} ${h.mode} is unusable in the iso view`).toBe(true);
    }
  });
});

describe('sliding along an axis', () => {
  it('moves a part the distance the pointer covered', () => {
    /*
     * Front view: X runs left to right across the screen, unforeshortened. A 200 mm view over
     * 800 px is 0.25 mm per pixel, so 80 px of pointer travel is exactly 20 mm.
     */
    expect(dragAlongAxis(at('front'), 'x', 80, 0, HEIGHT)).toBeCloseTo(20, 9);
  });

  it('ignores travel across the axis', () => {
    // Dragging straight up while holding the X arrow slides nothing.
    expect(dragAlongAxis(at('front'), 'x', 0, 120, HEIGHT)).toBeCloseTo(0, 9);
  });

  it('takes only the component along the axis from a diagonal drag', () => {
    const diagonal = dragAlongAxis(at('front'), 'x', 80, 55, HEIGHT);
    expect(diagonal).toBeCloseTo(20, 9);
  });

  it('refuses an axis pointing at the viewer rather than flinging the part away', () => {
    /*
     * The failure this prevents: the projected arrow is a few pixels long, so millimetres per
     * pixel goes to infinity and one pixel of jitter throws the part out of the scene. A clamp
     * on the result would still move it somewhere wrong; the gesture itself is meaningless.
     */
    expect(dragAlongAxis(at('top'), 'z', 60, 60, HEIGHT)).toBe(0);
  });

  it('needs more pointer travel for an axis that is turned away', () => {
    // Half turned away, an axis covers less screen per millimetre, so the same travel has to
    // mean more millimetres — not fewer.
    const straight = dragAlongAxis(at('front'), 'x', 100, 0, HEIGHT);
    const turned = dragAlongAxis(orbit(at('front'), Math.PI / 4, 0), 'x', 100, 0, HEIGHT);

    expect(Math.abs(turned)).toBeGreaterThan(Math.abs(straight));
  });

  it('scales with the zoom, so the part keeps pace with the pointer', () => {
    const near = dragAlongAxis(at('front', 50), 'x', 80, 0, HEIGHT);
    const far = dragAlongAxis(at('front', 400), 'x', 80, 0, HEIGHT);

    expect(far / near).toBeCloseTo(8, 9);
  });

  it('reverses when the axis is seen from the other side', () => {
    const front = dragAlongAxis(at('front'), 'x', 80, 0, HEIGHT);
    const back = dragAlongAxis(at('back'), 'x', 80, 0, HEIGHT);

    expect(Math.sign(front)).toBe(-Math.sign(back));
  });
});

describe('turning about an axis', () => {
  /** A point at `deg` around the gizmo centre, in screen fractions. */
  const around = (deg: number, r = 0.15, aspect = ASPECT) => ({
    x: 0.5 + (Math.cos((deg * Math.PI) / 180) * r) / aspect,
    y: 0.5 + Math.sin((deg * Math.PI) / 180) * r,
  });

  it('turns by the angle the pointer swept', () => {
    const turned = dragAboutAxis(at('top'), 'z', [0, 0, 0], ASPECT, around(0), around(30));
    expect(Math.abs(turned)).toBeCloseTo(30, 6);
  });

  it('turns the way the pointer went', () => {
    const camera = at('top');
    const cw = dragAboutAxis(camera, 'z', [0, 0, 0], ASPECT, around(0), around(30));
    const acw = dragAboutAxis(camera, 'z', [0, 0, 0], ASPECT, around(0), around(-30));

    expect(Math.sign(cw)).toBe(-Math.sign(acw));
  });

  it('still turns the way the pointer went when the axis is seen from behind', () => {
    /*
     * The bug every naive implementation has. Looking at the same axis from the other side, the
     * arc appears to run the other way, so a drag that read as clockwise now reads as
     * anticlockwise — and the part turns opposite to the gesture. Which side the axis is being
     * viewed from has to enter the sign.
     */
    const fromAbove = dragAboutAxis(at('top'), 'z', [0, 0, 0], ASPECT, around(0), around(30));
    const fromBelow = dragAboutAxis(at('bottom'), 'z', [0, 0, 0], ASPECT, around(0), around(30));

    expect(Math.sign(fromAbove)).toBe(-Math.sign(fromBelow));
  });

  it('does not jump when the drag crosses the far side of the arc', () => {
    // 170° to −170° is a 20° step, not a 340° one, and a gizmo that gets this wrong spins the
    // part most of a full turn on one frame.
    const swept = dragAboutAxis(at('top'), 'z', [0, 0, 0], ASPECT, around(170), around(-170));
    expect(Math.abs(swept)).toBeCloseTo(20, 6);
  });

  it('measures the angle squarely on a wide viewport', () => {
    // Read off raw fractions, a 45° drag on a 2:1 viewport measures about 63°.
    const wide = dragAboutAxis(at('top'), 'z', [0, 0, 0], 2, around(0, 0.15, 2), around(45, 0.15, 2));
    expect(Math.abs(wide)).toBeCloseTo(45, 6);
  });

  it('has nothing to say about a drag that started on the centre', () => {
    const nowhere = dragAboutAxis(at('top'), 'z', [0, 0, 0], ASPECT, { x: 0.5, y: 0.5 }, around(30));
    expect(nowhere).toBe(0);
  });
});

describe('grabbing a handle', () => {
  it('finds the handle under the pointer', () => {
    const camera = at('iso');
    const handles = gizmoHandles(camera, [0, 0, 0], ASPECT);

    for (const h of handles) {
      expect(grabHandle(handles, h.at.x, h.at.y, ASPECT)).toEqual(h);
    }
  });

  it('grabs nothing out in open space', () => {
    const handles = gizmoHandles(at('iso'), [0, 0, 0], ASPECT);
    expect(grabHandle(handles, 0.95, 0.95, ASPECT)).toBeNull();
  });

  it('never grabs a handle it would refuse to drag', () => {
    const camera = at('top');
    const handles = gizmoHandles(camera, [0, 0, 0], ASPECT);
    const zMove = handles.find((h) => h.axis === 'z' && h.mode === 'move')!;

    expect(grabHandle(handles, zMove.at.x, zMove.at.y, ASPECT)?.mode).not.toBe('move');
  });
});

describe('where the gizmo sits', () => {
  it('is the centre of what is selected', () => {
    expect(gizmoOrigin([0, 0, 0], [60, 40, 20])).toEqual([30, 20, 10]);
  });
});
