import { describe, expect, it } from 'vitest';
import { classifySubject } from './subject';
import { foregroundMask, traceImage, type RasterImage } from './trace';
import { renderViews } from '../../render/raster';
import { runScript } from '../../generate/script';
import { evaluateDocument } from '../../model/document';

/**
 * Telling a picture of a part from a picture of a machine.
 *
 * The failure being guarded against is specific and was reported from use: a perspective render
 * of a rotary kiln — long cylinder on concrete piers, stack, preheater, half a building in
 * frame — was imported, traced as though it were a flat gasket, and extruded into a slab shaped
 * like the outline of the whole scene. Closed, manifold, dimensioned, and nothing to do with a
 * kiln. Nothing downstream could catch it, because every downstream check asks whether the
 * solid is sound and it was.
 *
 * ── Why the hard case is a real render, not a drawing of one ──
 *
 * A hand-built proxy would be a test of my idea of what such an image looks like. DATUM has its
 * own software rasteriser, so the scene case here is an actual shaded render of an actual
 * assembly, with real interior edges, real shading falloff and a real background — the same
 * class of image as the one that was misread. If the classifier cannot tell that DATUM's own
 * render of an assembly is a picture of a machine, it cannot tell anything.
 */

/** Newline, kept as a constant because these scripts are assembled from arrays. */
const LF = String.fromCharCode(10);

/** A raster of one flat colour, to draw on. */
function blank(width: number, height: number, level = 245): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = level;
    data[i * 4 + 1] = level;
    data[i * 4 + 2] = level;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function fill(
  img: RasterImage, x0: number, y0: number, x1: number, y1: number, level: number,
): void {
  for (let y = Math.max(0, y0); y <= Math.min(img.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(img.width - 1, x1); x++) {
      const i = (y * img.width + x) * 4;
      img.data[i] = level;
      img.data[i + 1] = level;
      img.data[i + 2] = level;
    }
  }
}

function classify(img: RasterImage) {
  return classifySubject(img, foregroundMask(img));
}

/** A shaded render of a built assembly, as RGBA. */
function renderOf(script: string): RasterImage {
  const result = runScript(script);
  expect(result.errors.map((e) => e.message)).toEqual([]);

  const evaluated = evaluateDocument(result.doc);
  const [first] = renderViews(evaluated.mesh, ['iso'], { width: 320, height: 320 });
  const render = first!.render;

  expect(render.covered).toBeGreaterThan(0);
  return {
    width: render.width,
    height: render.height,
    data: new Uint8ClampedArray(render.rgba),
  };
}

describe('a flat part photographed square on', () => {
  it('is recognised as something an outline can be built from', () => {
    const img = blank(200, 200);
    fill(img, 40, 60, 160, 140, 40);          // a plain rectangular blank

    const verdict = classify(img);
    expect(verdict.subject).toBe('flat-part');
  });

  it('is still a flat part when it has holes in it', () => {
    const img = blank(200, 200);
    fill(img, 30, 30, 170, 170, 40);
    fill(img, 60, 60, 80, 80, 245);            // two bores
    fill(img, 120, 120, 140, 140, 245);

    expect(classify(img).subject).toBe('flat-part');
  });

  it('is still a flat part when it is a long thin bracket', () => {
    // Fills little of its bounding box only because it is L-shaped, which is not evidence of
    // anything three-dimensional.
    const img = blank(240, 240);
    fill(img, 20, 20, 60, 210, 40);
    fill(img, 20, 175, 210, 210, 40);

    expect(classify(img).subject).toBe('flat-part');
  });

  it('is still a flat part when it carries an engraved mark', () => {
    // Interior detail, but a small amount of it: one signal is never enough on its own.
    const img = blank(200, 200);
    fill(img, 30, 30, 170, 170, 40);
    fill(img, 80, 90, 120, 96, 150);
    fill(img, 80, 110, 120, 116, 150);

    expect(classify(img).subject).toBe('flat-part');
  });

  it('is not fooled by an antialiased edge', () => {
    /*
     * The case the synthetic tests could not see, found by importing a real picture. Every image
     * a browser produces is antialiased: the silhouette is not a step but a band a pixel or two
     * wide where the subject fades into the background, and that band is nothing but steep
     * gradient. Measured right up to the outline, a plain grey disc on white scored 3% hard
     * interior steps and was refused as a picture of a machine.
     *
     * A rectangle filled by hand has no soft edge, so no test written from imagination has one.
     */
    const size = 160;
    const img = blank(size, size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
        const cover = Math.max(0, Math.min(1, 55.5 - d));
        const level = Math.round(245 * (1 - cover) + 85 * cover);
        const i = (y * size + x) * 4;
        img.data[i] = level;
        img.data[i + 1] = level;
        img.data[i + 2] = level;
      }
    }

    const verdict = classify(img);

    expect(verdict.evidence.interiorDetail).toBeLessThan(0.005);
    expect(verdict.subject).toBe('flat-part');
  });

  it('says nothing about an empty frame rather than guessing', () => {
    const verdict = classify(blank(64, 64));
    expect(verdict.confidence).toBe(0);
  });
});

/** A wireframe-style machine on a light ground: long diagonal shell, piers, stack, building. */
function kiln(w=640,h=360):RasterImage{
  const d=new Uint8ClampedArray(w*h*4).fill(240);
  const set=(x:number,y:number,v:number)=>{if(x<0||y<0||x>=w||y>=h)return;const i=(y*w+x)*4;d[i]=v;d[i+1]=v;d[i+2]=v;};
  // building block, separate
  for(let y=90;y<250;y++)for(let x=20;x<130;x++)set(x,y,205);
  // shell: diagonal band with ribs
  for(let t=0;t<420;t++){const x=180+t, y=250-Math.round(t*0.32);
    for(let k=-16;k<=16;k++)set(x,y+k,200+Math.round(k*0.8));
    if(t%7===0)for(let k=-16;k<=16;k++)set(x,y+k,60);}
  // piers
  for(const px of [250,420,560])for(let y=0;y<70;y++)for(let x=0;x<46;x++)set(px+x,300-Math.round((px-180)*0.32)+y,210);
  // stack
  for(let y=40;y<150;y++)for(let x=580;x<620;x++)set(x,y,215);
  return {width:w,height:h,data:d};
}


/** A four-view technical drawing: thin black line work on white, arranged in panels. */
function blueprint(w = 640, h = 480): RasterImage {
  const img = blank(w, h, 250);
  const ink = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    img.data[i] = 25; img.data[i + 1] = 25; img.data[i + 2] = 25;
  };

  // Four view panels, each an outline with some detail inside it, all in 1-2 px strokes.
  const panel = (x0: number, y0: number, x1: number, y1: number) => {
    for (let x = x0; x <= x1; x++) { ink(x, y0); ink(x, y1); }
    for (let y = y0; y <= y1; y++) { ink(x0, y); ink(x1, y); }

    // A rounded body outline and a couple of wheels, as a car drawing has.
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const rx = (x1 - x0) * 0.38, ry = (y1 - y0) * 0.3;
    for (let t = 0; t < 720; t++) {
      const a = (t / 720) * Math.PI * 2;
      ink(Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a)));
    }
    for (const wx of [cx - rx * 0.55, cx + rx * 0.55]) {
      for (let t = 0; t < 360; t++) {
        const a = (t / 360) * Math.PI * 2;
        ink(Math.round(wx + 12 * Math.cos(a)), Math.round(cy + ry * 0.8 + 12 * Math.sin(a)));
      }
    }
  };

  panel(20, 20, 300, 220);
  panel(330, 20, 620, 220);
  panel(20, 250, 300, 460);
  panel(330, 250, 620, 460);
  return img;
}

describe('a technical drawing', () => {
  it('is recognised as a drawing, not traced as a part', () => {
    /*
     * The worst output this importer has ever produced, reported from use: a four-view blueprint
     * of a car, traced as one shape and extruded — a flat slab in the outline of the whole
     * *sheet*, every view and every leader line, 7 mm thick. Confident, closed, dimensioned, and
     * not a car.
     *
     * It slipped past the earlier tests because they all ask about the *inside* of a silhouette,
     * and a drawing has no inside.
     */
    const verdict = classify(blueprint());

    expect(verdict.subject).toBe('drawing');
    expect(verdict.reason).toContain('line drawing');
  });

  it('recognises it by ink that does not survive thinning', () => {
    // The measurement, and the reason it is decisive: strokes vanish, objects do not.
    const drawing = classify(blueprint()).evidence;
    const solid = classify((() => {
      const img = blank(200, 200);
      fill(img, 40, 40, 160, 160, 40);
      return img;
    })()).evidence;

    expect(drawing.strokeSurvival).toBeLessThan(0.2);
    expect(solid.strokeSurvival).toBeGreaterThan(0.8);
  });

  it('does not call a solid part a drawing however dark it is', () => {
    const img = blank(200, 200);
    fill(img, 20, 20, 180, 180, 15);

    expect(classify(img).subject).not.toBe('drawing');
  });

  it('does not call a render a drawing', () => {
    expect(classify(renderOf('cylinder Body diameter=60 height=90')).subject).not.toBe('drawing');
  });
});

describe('a picture of a three-dimensional thing', () => {
  it('refuses the reported case: a wireframe machine on piers', () => {
    /*
     * The closest reproduction of the image that was misread. Every signal fires, and each for
     * its own reason: the building stands apart from the machine, the wireframe fills the
     * interior with hard lines, and a kiln running diagonally across the frame on piers leaves
     * three-quarters of its own bounding box empty.
     *
     * What this used to produce was a slab shaped like the outline of the whole photograph.
     */
    const img = kiln();
    const verdict = classifySubject(img, foregroundMask(img));

    expect(verdict.subject).toBe('scene');
    expect(verdict.evidence.regions).toBeGreaterThan(2);
    expect(verdict.evidence.interiorDetail).toBeGreaterThan(0.02);
    expect(verdict.evidence.fillRatio).toBeLessThan(0.35);

    // And says all three, so the user is told why rather than simply refused.
    expect(verdict.reason).toContain('separate objects');
    expect(verdict.reason).toContain('hard edges');
    expect(verdict.reason).toContain('bounding box');
  });

  it('recognises a render of an assembly as a scene', () => {
    /*
     * The reported case, reproduced as closely as this repository can reproduce it: several
     * components, seen in perspective, with the interior structure that a real photograph of a
     * machine has and a silhouette does not.
     */
    const kilnish = renderOf([
      'cylinder Shell diameter=40 height=220 at.rx=90',
      'cylinder Tyre1 diameter=52 height=14 at.rx=90 at.y=-60',
      'cylinder Tyre2 diameter=52 height=14 at.rx=90 at.y=60',
      'box Pier1 length=40 width=30 height=60 at.y=-60 at.z=-55',
      'box Pier2 length=40 width=30 height=60 at.y=60 at.z=-55',
      'cylinder Stack diameter=26 height=90 at.y=130 at.z=45',
    ].join('\n'));

    const verdict = classify(kilnish);

    expect(verdict.subject).toBe('scene');
    expect(verdict.reason).toContain('scene rather than of one part');
  });

  it('recognises a render of a single machined part as a scene too', () => {
    // And it should. A photograph of a part is not a flat drawing of one: the outline is a
    // silhouette from one angle, and extruding it invents the depth it cannot see.
    const bracket = renderOf([
      'box Body length=80 width=50 height=30',
      'hole Bolts diameter=8 pattern=grid cols=2 rows=2 spacingX=50 spacingY=28',
      'fillet Edges radius=4',
    ].join('\n'));

    expect(classify(bracket).subject).toBe('scene');
  });

  it('measures why, so the decision can be argued with rather than believed', () => {
    const verdict = classify(renderOf([
      'cylinder Shell diameter=40 height=220 at.rx=90',
      'box Pier1 length=40 width=30 height=60 at.y=-60 at.z=-55',
      'box Pier2 length=40 width=30 height=60 at.y=60 at.z=-55',
      'cylinder Stack diameter=26 height=90 at.y=130 at.z=45',
    ].join(LF)));

    expect(verdict.evidence.regions).toBeGreaterThan(0);
    expect(verdict.reason.length).toBeGreaterThan(40);
    expect(verdict.reason).toMatch(/\d/);
  });

  it('separates smooth shading from hard interior edges, which is the whole distinction', () => {
    /*
     * Both a curved part and a machine are solid, and both spread their tones widely. What
     * tells them apart is the *hardness* of what is inside the outline: a dome's gradient is
     * gentle everywhere, and a machine steps at every join between one component and the next.
     */
    const curved = classify(renderOf('cylinder Body diameter=60 height=90')).evidence;
    const machine = classify(renderOf([
      'cylinder Shell diameter=40 height=220 at.rx=90',
      'box Pier1 length=40 width=30 height=60 at.y=-60 at.z=-55',
      'box Pier2 length=40 width=30 height=60 at.y=60 at.z=-55',
      'cylinder Stack diameter=26 height=90 at.y=130 at.z=45',
    ].join(LF))).evidence;

    expect(machine.interiorDetail).toBeGreaterThan(curved.interiorDetail * 3);
  });

  it('is not fooled by a single blown highlight on a flat part', () => {
    // One specular pixel at full white would swing a full-range measurement by two hundred
    // levels. Percentiles are why it does not.
    const img = blank(200, 200);
    fill(img, 40, 40, 160, 160, 40);
    fill(img, 99, 99, 101, 101, 255);

    expect(classify(img).subject).toBe('flat-part');
  });

  it('separates the two cases by a wide margin, not a fine one', () => {
    /*
     * A threshold in a narrow gap is a coin toss on the next image. This asserts the gap
     * itself: the interior of a render is many times busier than the interior of a silhouette,
     * which is what makes the rule worth trusting on images neither case anticipated.
     */
    const flat = blank(200, 200);
    fill(flat, 40, 40, 160, 160, 40);

    const shaded = classify(renderOf('cylinder Body diameter=60 height=90')).evidence;
    const silhouette = classify(flat).evidence;

    // Reported, and deliberately not decisive: tonal spread says a surface is curved, which is
    // a question for the shading solver rather than grounds for refusing the picture.
    expect(shaded.tonalSpread).toBeGreaterThan(100);
    expect(silhouette.tonalSpread).toBeLessThan(30);
  });
});

describe('the numbers the thresholds sit between', () => {
  /*
   * A threshold is only worth what the gap around it is worth. These assert the gap itself, so
   * a change that narrows it fails here rather than silently making the classifier a coin toss
   * on the next image.
   */
  it('separates one object from several by a wide margin of hard interior steps', () => {
    const one = classify(renderOf('cylinder Body diameter=60 height=90')).evidence;
    const several = classify(renderOf([
      'cylinder Shell diameter=40 height=220 at.rx=90',
      'box Pier1 length=40 width=30 height=60 at.y=-60 at.z=-55',
      'box Pier2 length=40 width=30 height=60 at.y=60 at.z=-55',
      'cylinder Stack diameter=26 height=90 at.y=130 at.z=45',
    ].join(LF))).evidence;

    expect(several.interiorDetail).toBeGreaterThan(one.interiorDetail * 3);
  });

  it('scores a strongly curved surface as smoother than a flat-faced one', () => {
    /*
     * The consequence of measuring steps rather than slopes, and the reason the shaded dome
     * survives. A dome's shading changes fast but never abruptly; a box's faces meet at a line.
     * Measured by gradient magnitude the dome scored 0.13 and the four-part machine 0.06, so
     * the dome was refused and the machine was not — the classifier was exactly inverted.
     */
    const dome = blank(160, 160);
    for (let y = 0; y < 160; y++) {
      for (let x = 0; x < 160; x++) {
        const dx = x - 80, dy = y - 80;
        const d2 = dx * dx + dy * dy;
        if (d2 > 60 * 60) continue;
        const level = Math.round(Math.sqrt(1 - d2 / 3600) * 190);
        const i = (y * 160 + x) * 4;
        dome.data[i] = level;
        dome.data[i + 1] = level;
        dome.data[i + 2] = level;
      }
    }

    const curved = classify(dome).evidence;
    const faceted = classify(renderOf('box Body length=80 width=50 height=30')).evidence;

    expect(curved.interiorDetail).toBeLessThan(faceted.interiorDetail);
    expect(classify(dome).subject).toBe('flat-part');
  });
});

describe('what the classification is for', () => {
  it('lets the tracer keep doing the job it is good at', () => {
    // The point is not that tracing is unreliable. Handed what it is for, it works, and the
    // classifier is what makes sure it is handed that.
    const img = blank(200, 200);
    fill(img, 40, 60, 160, 140, 40);

    const traced = traceImage(img, { mmPerPixel: 0.5 });
    expect('error' in traced).toBe(false);
    expect(classify(img).subject).toBe('flat-part');
  });
});
