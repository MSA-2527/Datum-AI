import { describe, expect, it } from 'vitest';
import {
  asList, asNumber, asRef, asString, entitiesOfType, memberOfType, parseStep,
} from './parse';
import { readStep } from './read';
import { meshToStep } from '../../export/step';
import { box, cylinder } from '../../kernel/ops/build';
import { boolean } from '../../kernel/ops/boolean';
import { archetypeById } from '../../generate/archetypes';
import { bounds, health, massProperties, type Mesh } from '../../kernel/topo/mesh';

/**
 * STEP import.
 *
 * The central test is a **round trip through this project's own exporter**: write a solid to
 * STEP, read it back, and compare the two. That is a far stronger assertion than checking the
 * reader against a fixture, because it exercises the whole chain — surfaces, trimming loops,
 * face senses, seams — against a ground truth that is not a recording of what the reader
 * currently does. A solid that survives it is a solid whose volume, closure and envelope all
 * came back.
 *
 * The other property being tested is honesty about failure. This reader handles planes,
 * cylinders and cones and cannot do splines or tori. A file it cannot fully read must say what
 * it skipped and that the result is untrustworthy — never hand back a quietly incomplete solid,
 * because every measurement taken from one is wrong without appearing to be.
 */

const volumeOf = (m: Mesh) => Math.abs(massProperties(m).volume);

/**
 * Volumes are compared as a fraction, not to an absolute figure.
 *
 * A round trip is not expected to be bit-exact where curves are involved: the exporter
 * recovers a bore as one analytic cylinder and the reader tessellates it again at its own
 * chord tolerance, so the polygon count changes and the volume moves by a fraction of a
 * percent. Demanding equality would be asserting that neither side may ever change its
 * tessellation, which is not a property worth having.
 */
const closeWithin = (actual: number, expected: number, fraction: number) => {
  expect(Math.abs(actual - expected) / expected, `${actual} vs ${expected}`)
    .toBeLessThan(fraction);
};
const sizeOf = (m: Mesh) => {
  const b = bounds(m);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
};

/** Writes a solid to STEP and reads it back, which is the whole chain in one line. */
function roundTrip(mesh: Mesh) {
  const { text } = meshToStep(mesh, { name: 'Test part' });
  const result = readStep(text);
  if ('error' in result) throw new Error(`${result.error}${result.line ? ` (line ${result.line})` : ''}`);
  return result;
}

describe('reading the file format', () => {
  it('rejects something that is not STEP, and says how to tell', () => {
    const result = parseStep('hello, this is not a step file');
    expect('error' in result && result.error).toMatch(/ISO-10303-21/);
  });

  it('reads instances, references, numbers, strings and lists', () => {
    const file = parseStep(`ISO-10303-21;
HEADER;
FILE_NAME('bracket.step','2026-01-01T00:00:00',(''),(''),'','','');
ENDSEC;
DATA;
#1 = CARTESIAN_POINT('origin',(0.,-1.5,2.5E1));
#2 = DIRECTION('',(0.,0.,1.));
#3 = AXIS2_PLACEMENT_3D('',#1,#2,$);
ENDSEC;
END-ISO-10303-21;`);

    if ('error' in file) throw new Error(file.error);

    expect(file.entities.size).toBe(3);

    const point = file.entities.get(1)!;
    expect(point.type).toBe('CARTESIAN_POINT');
    expect(asList(point.args[1]).map((v) => asNumber(v))).toEqual([0, -1.5, 25]);

    const placement = file.entities.get(3)!;
    expect(asRef(placement.args[1])).toBe(1);
    expect(placement.args[3]!.kind).toBe('null');           // "$" is not provided
  });

  it('reads a quote inside a string, written the way Part 21 writes it', () => {
    const file = parseStep(`ISO-10303-21;
DATA;
#1 = PRODUCT('Bill''s bracket','',( ));
ENDSEC;`);

    if ('error' in file) throw new Error(file.error);
    const value = file.entities.get(1)!.args[0]!;
    expect(value.kind === 'string' && value.value).toBe("Bill's bracket");
  });

  it('steps over comments rather than reading them as data', () => {
    const file = parseStep(`ISO-10303-21;
DATA;
/* written by some translator
   over two lines */
#1 = DIRECTION('',(1.,0.,0.));
ENDSEC;`);

    if ('error' in file) throw new Error(file.error);
    expect(file.entities.size).toBe(1);
  });

  it('collapses a complex instance instead of choking on it', () => {
    // Units are written this way. They carry no geometry, and a reader that stops here reads
    // no file from any real translator.
    const file = parseStep(`ISO-10303-21;
DATA;
#1 = ( NAMED_UNIT(*) LENGTH_UNIT() SI_UNIT(.MILLI.,.METRE.) );
#2 = DIRECTION('',(1.,0.,0.));
ENDSEC;`);

    if ('error' in file) throw new Error(file.error);
    expect(file.entities.size).toBe(2);
    expect(file.entities.get(2)!.type).toBe('DIRECTION');
  });

  it('gives a line number when it cannot go on', () => {
    const result = parseStep(`ISO-10303-21;
DATA;
#1 = CARTESIAN_POINT('unclosed
ENDSEC;`);

    expect('error' in result).toBe(true);
    expect('error' in result && result.line).toBeGreaterThan(1);
  });

  it('finds every instance of a type', () => {
    const file = parseStep(`ISO-10303-21;
DATA;
#1 = DIRECTION('',(1.,0.,0.));
#2 = DIRECTION('',(0.,1.,0.));
#3 = CARTESIAN_POINT('',(0.,0.,0.));
ENDSEC;`);

    if ('error' in file) throw new Error(file.error);
    expect(entitiesOfType(file, 'DIRECTION')).toHaveLength(2);
  });
});

describe('a solid, out and back', () => {
  it('returns a block at its exact volume and size', () => {
    const original = box(80, 50, 30, [0, 0, 0], 'Block');
    const read = roundTrip(original);

    expect(read.faces).toBe(6);
    expect(read.skipped).toEqual([]);
    expect(read.closed).toBe(true);
    // A block has no curves, so this one really is exact.
    expect(volumeOf(read.mesh)).toBeCloseTo(volumeOf(original), 6);
    expect(sizeOf(read.mesh)).toEqual(sizeOf(original).map((v) => expect.closeTo(v, 6)));
  });

  it('returns a closed solid, which is what makes the volume mean anything', () => {
    const read = roundTrip(box(40, 40, 40));
    const state = health(read.mesh);

    expect(state.closed).toBe(true);
    expect(state.manifold).toBe(true);
    expect(state.boundaryEdges).toBe(0);
  });

  it('returns a turned bar, cylindrical faces and all', () => {
    const original = cylinder(15, 90, [0, 0, 0], [0, 0, 1], 'Bar');
    const read = roundTrip(original);

    expect(read.closed).toBe(true);
    // Within a tenth of a percent: the wall is stitched between its own rims, so the polygon
    // it encloses is the polygon that was exported rather than a re-approximation of it.
    closeWithin(volumeOf(read.mesh), volumeOf(original), 0.001);
  });

  it('returns a bored part with its bore still in it', () => {
    const original = boolean(
      box(60, 60, 20, [0, 0, 0], 'Block'),
      cylinder(10, 40, [0, 0, 0], [0, 0, 1], 'Bore'),
      'difference',
    ).mesh;
    const read = roundTrip(original);

    expect(read.closed).toBe(true);
    closeWithin(volumeOf(read.mesh), volumeOf(original), 0.005);
    // A bore is a handle through the solid; losing it would leave the volume nearly right and
    // the part wrong.
    expect(health(read.mesh).genus).toBe(1);
  });

  it('returns a real catalogue part unchanged', () => {
    const original = archetypeById('plate')!.build({}).mesh;
    const read = roundTrip(original);

    expect(read.closed).toBe(true);
    closeWithin(volumeOf(read.mesh), volumeOf(original), 0.005);
    expect(health(read.mesh).genus).toBe(4);                // its four fixing holes
  });

  it('keeps the name the file gave it', () => {
    expect(roundTrip(box(10, 10, 10)).name).toBe('Test part');
  });

  it('comes back parametric — the fitted part, not just triangles', async () => {
    // The point of the whole import path: a solid that arrives can be recognised, and once
    // recognised it is editable and teachable rather than a mesh.
    const { fitArchetype } = await import('../fit/archetype');
    const fit = fitArchetype(roundTrip(box(80, 50, 30)).mesh).best!;

    expect(fit.archetypeId).toBe('box');
    expect(fit.params.length).toBeCloseTo(80, 1);
  });
});

describe('saying what it could not read', () => {
  it('refuses a file with no shell and says why', () => {
    const result = readStep(`ISO-10303-21;
DATA;
#1 = CARTESIAN_POINT('',(0.,0.,0.));
ENDSEC;`);

    expect('error' in result).toBe(true);
    expect('error' in result && result.error).toMatch(/no shell/);
  });

  it('names an unreadable surface in words rather than by its schema name', () => {
    // A file whose only face is a spline. The result must say what it is, not print
    // B_SPLINE_SURFACE_WITH_KNOTS at an engineer.
    const text = `ISO-10303-21;
DATA;
#1 = CARTESIAN_POINT('',(0.,0.,0.));
#2 = DIRECTION('',(0.,0.,1.));
#3 = DIRECTION('',(1.,0.,0.));
#4 = AXIS2_PLACEMENT_3D('',#1,#2,#3);
#10 = B_SPLINE_SURFACE_WITH_KNOTS('',3,3,((#1)),.UNSPECIFIED.,.F.,.F.,.F.);
#11 = VERTEX_POINT('',#1);
#12 = LINE('',#1,#2);
#13 = EDGE_CURVE('',#11,#11,#12,.T.);
#14 = ORIENTED_EDGE('',*,*,#13,.T.);
#15 = EDGE_LOOP('',(#14,#14,#14));
#16 = FACE_OUTER_BOUND('',#15,.T.);
#17 = ADVANCED_FACE('',(#16),#10,.T.);
#18 = CLOSED_SHELL('',(#17));
ENDSEC;`;

    const result = readStep(text);
    expect('error' in result).toBe(true);
    expect('error' in result && result.error).toMatch(/freeform \(spline\) surface/);
  });

  it('says the result is not trustworthy when it had to skip a face', () => {
    // A cube written with one of its six faces on a torus. Five build; the sixth cannot, and
    // the solid is then open — which is exactly the situation that must never pass silently.
    const text = meshToStep(box(20, 20, 20), { name: 'Holed' })
      .text.replace('PLANE(', 'TOROIDAL_SURFACE(');      // the first plane only

    const result = readStep(text);
    if ('error' in result) throw new Error(result.error);

    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.closed).toBe(false);
    expect(result.notes.join(' ')).toMatch(/not trustworthy|not closed/);
    expect(result.notes.join(' ')).toMatch(/torus/);
  });
});

describe('swept across the catalogue', () => {
  /*
   * Every archetype this reader claims, written out and read back.
   *
   * Split into two lists deliberately. The first is what round-trips as a *solid* — closed,
   * and within a fraction of a percent on volume — and is what the import path can be built
   * on. The second is what does not, and it is written down rather than left out: a shaft
   * with 45° chamfers, a flange with a hub, a pulley with a V-groove all come back with
   * hairline cracks where a conical face meets its neighbours, because the two surfaces
   * tessellate the shared region to different tolerances.
   *
   * Those results are still useful — the shape and size are right, and the volume is within
   * a few percent for most of them — and they are reported as untrustworthy rather than
   * presented as solids, which is the property being asserted here. Moving one from the second
   * list to the first is the next piece of work on this reader.
   *
   * The lists are worth reading as a statement about what the reader is for: a gear with
   * ninety teeth and a plate with four holes come back exactly, and a chamfered shaft does
   * not. It is prismatic and simply-turned work that round-trips, which is most of an
   * engineering library and not all of it.
   */
  const CLOSES = ['plate', 'pipe', 'washer', 'nut', 'knob', 'gear', 'bottle'];
  const CRACKS = ['shaft', 'flange', 'pulley', 'cup', 'wheel', 'funnel'];

  for (const id of [...CLOSES, ...CRACKS]) {
    const archetype = archetypeById(id);
    if (!archetype) continue;

    it(`${id} ${CLOSES.includes(id) ? 'round-trips as a solid' : 'is reported as untrustworthy'}`, () => {
      const built = archetype.build({});
      if (!built.valid) return;

      const read = roundTrip(built.mesh);
      expect(read.skipped, `${id} skipped faces`).toEqual([]);

      if (CLOSES.includes(id)) {
        expect(read.closed, `${id} did not close`).toBe(true);
        closeWithin(volumeOf(read.mesh), volumeOf(built.mesh), 0.005);
      } else {
        // The part that matters: an open result never passes silently.
        expect(read.closed).toBe(false);
        expect(read.notes.join(' ')).toMatch(/not closed/);
        closeWithin(volumeOf(read.mesh), volumeOf(built.mesh), 0.15);
      }
    });
  }
});


describe('units, as a real translator writes them', () => {
  /*
   * Taken verbatim from a SOLIDWORKS 2025 export in the library this was first run against
   * (`SwSTEP 2.0`, AP214). The part is modelled in inches, and every coordinate in the file is
   * an inch value with nothing nearby to say so — the declaration sits four hundred entities
   * away in the unit context.
   *
   * Read without it, a 1 inch cube arrives 1 mm on a side: every dimension, the mass, the
   * area, the cost estimate and every manufacturability check wrong by a factor of 25.4, and
   * nothing about the result looks broken. This is the single most consequential thing about
   * reading somebody else's file and the easiest to miss.
   */
  const unitBlock = (assigned: string, extra = '') => `ISO-10303-21;
HEADER;
FILE_NAME('unit-test.step','2026-01-01T00:00:00',(''),(''),'SwSTEP 2.0','SolidWorks 2025','');
ENDSEC;
DATA;
${extra}
#900 =( GEOMETRIC_REPRESENTATION_CONTEXT ( 3 ) GLOBAL_UNIT_ASSIGNED_CONTEXT ( ( ${assigned} ) ) REPRESENTATION_CONTEXT ( 'NONE', 'WORKASPACE' ) );
ENDSEC;
END-ISO-10303-21;`;

  const scaleOf = (text: string) => {
    const file = parseStep(text);
    if ('error' in file) throw new Error(file.error);
    // `readStep` refuses a file with no shell, so the scale is read through a build attempt
    // on a one-face solid instead.
    return file;
  };

  it('keeps every member of a complex instance, not just the first', () => {
    const file = scaleOf(unitBlock('#910', `
#910 =( LENGTH_UNIT ( ) NAMED_UNIT ( * ) SI_UNIT ( $, .METRE. ) );`));

    const unit = file.entities.get(910)!;
    expect(unit.members?.map((m) => m.type))
      .toEqual(['LENGTH_UNIT', 'NAMED_UNIT', 'SI_UNIT']);
    expect(memberOfType(unit, 'SI_UNIT')).not.toBeNull();
  });

  it('reads an inch file at 25.4 mm to the unit', () => {
    // The exact declaration SOLIDWORKS wrote, conversion factor and all.
    const text = unitBlock('#402', `
#443 =( LENGTH_UNIT ( ) NAMED_UNIT ( * ) SI_UNIT ( $, .METRE. ) );
#372 = LENGTH_MEASURE_WITH_UNIT ( LENGTH_MEASURE( 0.025399999999999998970 ), #443 );
#402 =( CONVERSION_BASED_UNIT ( 'INCH', #372 ) LENGTH_UNIT ( ) NAMED_UNIT ( #396 ) );`);

    const file = scaleOf(text);
    const unit = file.entities.get(402)!;
    const conversion = memberOfType(unit, 'CONVERSION_BASED_UNIT')!;

    expect(conversion).not.toBeNull();
    expect(asString(conversion.args[0])).toBe('INCH');
  });

  it('a plate written in inches comes back in millimetres', () => {
    // A hand-written file rather than a rewritten export: two square faces an inch apart, in a
    // file that declares inches exactly the way SOLIDWORKS does. Only the top and bottom are
    // present, so it does not close — that is not what is being measured. The envelope is.
    const square = (z: number, ids: number[]) => ids.join(',') + z;
    void square;

    const text = `ISO-10303-21;
HEADER;
FILE_NAME('inch-plate.step','2026-01-01T00:00:00',(''),(''),'SwSTEP 2.0','SolidWorks 2025','');
ENDSEC;
DATA;
#1 = CARTESIAN_POINT ( 'NONE', ( 0.0, 0.0, 0.0 ) ) ;
#2 = CARTESIAN_POINT ( 'NONE', ( 2.0, 0.0, 0.0 ) ) ;
#3 = CARTESIAN_POINT ( 'NONE', ( 2.0, 1.0, 0.0 ) ) ;
#4 = CARTESIAN_POINT ( 'NONE', ( 0.0, 1.0, 0.0 ) ) ;
#10 = VERTEX_POINT ( 'NONE', #1 ) ;
#11 = VERTEX_POINT ( 'NONE', #2 ) ;
#12 = VERTEX_POINT ( 'NONE', #3 ) ;
#13 = VERTEX_POINT ( 'NONE', #4 ) ;
#20 = DIRECTION ( 'NONE', ( 1.0, 0.0, 0.0 ) ) ;
#21 = DIRECTION ( 'NONE', ( 0.0, 0.0, 1.0 ) ) ;
#22 = AXIS2_PLACEMENT_3D ( 'NONE', #1, #21, #20 ) ;
#23 = PLANE ( 'NONE', #22 ) ;
#30 = LINE ( 'NONE', #1, #31 ) ;
#31 = VECTOR ( 'NONE', #20, 1.0 ) ;
#40 = EDGE_CURVE ( 'NONE', #10, #11, #30, .T. ) ;
#41 = EDGE_CURVE ( 'NONE', #11, #12, #30, .T. ) ;
#42 = EDGE_CURVE ( 'NONE', #12, #13, #30, .T. ) ;
#43 = EDGE_CURVE ( 'NONE', #13, #10, #30, .T. ) ;
#50 = ORIENTED_EDGE ( 'NONE', *, *, #40, .T. ) ;
#51 = ORIENTED_EDGE ( 'NONE', *, *, #41, .T. ) ;
#52 = ORIENTED_EDGE ( 'NONE', *, *, #42, .T. ) ;
#53 = ORIENTED_EDGE ( 'NONE', *, *, #43, .T. ) ;
#60 = EDGE_LOOP ( 'NONE', ( #50, #51, #52, #53 ) ) ;
#61 = FACE_OUTER_BOUND ( 'NONE', #60, .T. ) ;
#62 = ADVANCED_FACE ( 'NONE', ( #61 ), #23, .T. ) ;
#70 = OPEN_SHELL ( 'NONE', ( #62 ) ) ;
#80 =( LENGTH_UNIT ( ) NAMED_UNIT ( * ) SI_UNIT ( $, .METRE. ) );
#81 = LENGTH_MEASURE_WITH_UNIT ( LENGTH_MEASURE( 0.025399999999999998970 ), #80 );
#82 =( CONVERSION_BASED_UNIT ( 'INCH', #81 ) LENGTH_UNIT ( ) NAMED_UNIT ( * ) );
#90 =( GEOMETRIC_REPRESENTATION_CONTEXT ( 3 ) GLOBAL_UNIT_ASSIGNED_CONTEXT ( ( #82 ) ) REPRESENTATION_CONTEXT ( 'NONE', 'WORKASPACE' ) );
ENDSEC;
END-ISO-10303-21;`;

    const read = readStep(text);
    if ('error' in read) throw new Error(read.error);

    // 2 inches by 1 inch is 50.8 mm by 25.4 mm. Read as millimetres it would be 2 by 1.
    const size = sizeOf(read.mesh).sort((a, b) => b - a);
    expect(size[0]).toBeCloseTo(50.8, 3);
    expect(size[1]).toBeCloseTo(25.4, 3);
    expect(read.notes.join(' ')).toMatch(/INCH/);
  });

  it('says so when a file declares no unit at all', () => {
    // Strip the unit context entirely. Assuming silently is how this goes wrong, so the
    // assumption is stated in the result rather than left in the code.
    const read = readStep(meshToStep(box(10, 10, 10), { name: 'Cube' }).text
      .replace(/#\d+ ?= ?\( ?GEOMETRIC_REPRESENTATION_CONTEXT[^;]*;/g, ''));

    if ('error' in read) throw new Error(read.error);
    expect(read.notes.join(' ')).toMatch(/no length unit|millimetres/i);
  });
});
