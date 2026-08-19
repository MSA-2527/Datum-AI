/**
 * Assembly plans: turning "a phone" into the parts a phone is made of.
 *
 * Everything before this produced one part. A request like "make a cup" names a single
 * object with a single shape, and the archetype catalogue answers it directly. "Make a
 * phone" does not work that way — a phone is a chassis, a display, a battery, a board, a
 * camera module, buttons and a port, each with its own size, material and position, and a
 * single lump shaped like a phone is a paperweight rather than a model of one.
 *
 * So a plan is a *bill of materials with geometry*: a list of components, each of which is
 * an archetype or a primitive with parameters, a placement, a material and a role. Building
 * one produces a document whose tree has a feature per component, which means every part can
 * be selected, measured, edited and exported separately — exactly as it would be in a real
 * assembly.
 *
 * The plan is a plain data structure on purpose. It can come from the built-in recipes, from
 * a language model, or from a person editing it, and the builder cannot tell the difference.
 * That is what keeps one code path between intent and geometry.
 */

import {
  IDENTITY_PLACEMENT, addFeature, applyFeature, defaultParams, emptyDocument, paramFields,
  type Document, type Feature, type FeatureKind, type ParamValue, type Placement,
} from '../model/document';
import { ARCHETYPES, archetypeById } from '../generate/archetypes';
import { bounds, massProperties, triCount, type Mesh } from '../kernel/topo/mesh';
import { evaluateExpr, readNumber, resolveParameters } from '../model/expr';

// ── the plan ─────────────────────────────────────────────────────────────────

export interface ComponentSpec {
  /** Stable within a plan; used for parent references. */
  id: string;
  name: string;
  /** What the part does. Shown in the tree, and what makes a BOM readable. */
  role: string;
  /** An archetype id, or a primitive kind when nothing in the catalogue fits. */
  shape: string;
  /** A number, or an expression over the plan's parameters. */
  params: Record<string, number | string>;
  placement: Placement;
  /**
   * Expressions driving placement axes, taking precedence over `placement`.
   *
   * This is where design intent lives for an assembly. A wheel at `-wheelbase / 2` follows
   * when the wheelbase changes; the same wheel at `-1167.5` does not.
   */
  placementExpr?: Partial<Record<'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz', string>>;
  material: string;
  /** g/cm³. Used for the per-component mass in the BOM. */
  density: number;
  quantity: number;
  /**
   * How the component joins the assembly.
   *
   * `add` places it as its own body, which is what a component almost always is. `fuse`
   * genuinely welds it into the running solid, for the rare case where two parts are one
   * piece of material. `cut` removes material from everything placed before it.
   */
  operation?: 'add' | 'fuse' | 'cut';
  /** Why this size, so a reviewer can check it rather than trust it. */
  note?: string;
}

export interface AssemblyPlan {
  name: string;
  description: string;
  /**
   * The design's driving dimensions.
   *
   * What turns a plan from a result into a design. Without these a plan is thirty components
   * at literal coordinates: change the wheelbase and nothing follows, because nothing in the
   * model knows a wheelbase existed. With them, a component may place itself at
   * `-wheelbase / 2` and one edit moves everything derived from it.
   */
  parameters?: { name: string; value: number | string; units: string; note?: string }[];
  /** Overall envelope, for sanity-checking the components against it. */
  envelope?: { length: number; width: number; height: number };
  components: ComponentSpec[];
  /** Assumptions made and anything the plan deliberately leaves out. */
  notes: string[];
  source: 'recipe' | 'model' | 'edited';
  /** Where any researched figures came from. */
  citations?: { title: string; uri: string }[];
}

/**
 * Shapes a plan may use that are not archetypes.
 *
 * `sketch` is here for a reason worth stating. A catalogue of named shapes covers the parts
 * somebody thought of in advance, and a real library is mostly parts nobody did: an outline
 * cut to a thickness, different every time. Admitting a profile to the vocabulary is what
 * lets those parts be described at all — and therefore imported as something editable, and
 * taught as an example.
 *
 * Its profile travels in `params.sketch` as the document's own JSON wire form, which the
 * schema already allows: a parameter may be a string.
 */
const PRIMITIVE_KINDS = new Set<FeatureKind>(['box', 'cylinder', 'sphere', 'sketch', 'loft', 'sweep']);

export const isPrimitive = (shape: string): boolean => PRIMITIVE_KINDS.has(shape as FeatureKind);
export const isArchetype = (shape: string): boolean => archetypeById(shape) !== undefined;

/** Every shape name a plan may legally use. */
export function shapeVocabulary(): string[] {
  return [...ARCHETYPES.map((a) => a.id), ...PRIMITIVE_KINDS];
}

// ── validation ───────────────────────────────────────────────────────────────

export interface ValidationResult {
  plan: AssemblyPlan;
  /** Components dropped because they could not be built at all. */
  dropped: { name: string; reason: string }[];
  /** Values corrected, with what was changed and why. */
  corrections: string[];
}

/**
 * Checks and repairs a plan.
 *
 * A plan from a language model is untrusted input in exactly the way a form submission is:
 * it will occasionally name a shape that does not exist, give a negative thickness, or
 * position a component a kilometre from the rest. None of that should reach the kernel, and
 * none of it should silently produce a wrong part.
 *
 * Every repair is recorded and shown. A quietly corrected dimension is worse than a rejected
 * one, because the user believes they got what they asked for.
 */
export function validatePlan(raw: unknown): ValidationResult | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'The plan was not an object.' };

  const input = raw as Partial<AssemblyPlan>;
  if (!Array.isArray(input.components) || input.components.length === 0) {
    return { error: 'The plan listed no components.' };
  }

  const dropped: { name: string; reason: string }[] = [];
  const corrections: string[] = [];
  const components: ComponentSpec[] = [];

  // The driving dimensions come first: everything below may be written in terms of them, so
  // they have to be resolved before a single component parameter can be checked.
  //
  // A parameter that will not resolve — circular, or naming something that does not exist —
  // is dropped rather than kept at zero. Left in, every expression depending on it would
  // quietly evaluate against a zero and produce a plausible-looking plan full of collapsed
  // geometry.
  const parameters: { name: string; value: number | string; units: string; note?: string }[] = [];
  const rawParams = (input as { parameters?: unknown }).parameters;

  if (Array.isArray(rawParams)) {
    for (const raw of rawParams) {
      const p = raw as { name?: unknown; value?: unknown; units?: unknown; note?: unknown };
      const pname = typeof p.name === 'string' ? p.name.trim() : '';
      // Names have to look like identifiers, because that is what an expression can refer to.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(pname)) continue;
      if (typeof p.value !== 'number' && typeof p.value !== 'string') continue;

      parameters.push({
        name: pname,
        value: p.value,
        units: typeof p.units === 'string' ? p.units : 'mm',
        note: typeof p.note === 'string' ? p.note : undefined,
      });
    }
  }

  const resolved = resolveParameters(parameters);
  const parameterValues = resolved.values;

  for (const [pname, why] of resolved.errors) {
    corrections.push(`Parameter ${pname} was dropped — ${why}`);
  }
  const usableParameters = parameters.filter((p) => !resolved.errors.has(p.name));

  const seen = new Set<string>();

  // How far from the origin a component may legitimately sit, measured against the plan's own
  // declared size rather than a fixed figure.
  //
  // The limit used to be a flat ten metres, on the reasoning that nothing this builds is
  // bigger than that. Then an airliner arrived: 37.6 m long, with a radome correctly placed
  // 18.8 m down the fuselage, and the validator "corrected" it to 10 m — moving a real part
  // to a wrong place and telling the user it had fixed something.
  //
  // Twice the envelope catches a component flung a kilometre away, which is the actual
  // failure mode, and never touches one that is merely far from the centre of a large object.
  const envelope = input.envelope;
  const reach = envelope
    ? Math.max(1000, Math.max(envelope.length, envelope.width, envelope.height) * 2)
    : 100_000;

  for (const [index, rawComponent] of input.components.entries()) {
    const c = rawComponent as Partial<ComponentSpec>;
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : `Component ${index + 1}`;

    const shape = typeof c.shape === 'string' ? c.shape.trim() : '';
    if (!shape || (!isArchetype(shape) && !isPrimitive(shape))) {
      dropped.push({
        name,
        reason: shape
          ? `"${shape}" is not a shape this kernel can build.`
          : 'No shape was given.',
      });
      continue;
    }

    // Parameters are clamped to the archetype's own declared range, which is the same range
    // the sliders enforce. A model asking for a 4-metre wall thickness gets the maximum, and
    // the user is told.
    const params: Record<string, number | string> = {};

    /**
     * Checks one value, keeping an expression *as an expression* wherever it is legal.
     *
     * The range check is done on what the expression evaluates to, because that is what gets
     * built — but the expression is what is stored, or the design intent is thrown away at the
     * validator and every part goes back to being a literal. An expression that lands outside
     * the range is replaced by the clamped number, since keeping intent that produces an
     * illegal part helps nobody.
     */
    const check = (
      raw: unknown, label: string, min: number, max: number, unit: string,
    ): number | string | undefined => {
      if (typeof raw === 'string' && raw.trim()) {
        const r = evaluateExpr(raw, parameterValues);
        if (r.error) {
          corrections.push(`${name}: ${label} could not be worked out — ${r.error}`);
          return undefined;
        }
        const clamped = Math.min(max, Math.max(min, r.value));
        if (Math.abs(clamped - r.value) > 1e-9) {
          corrections.push(
            `${name}: ${label} "${raw}" came to ${r.value}, outside ${min}–${max} ${unit}, ` +
            `and became ${clamped}.`,
          );
          return clamped;
        }
        return raw;
      }

      if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
      const clamped = Math.min(max, Math.max(min, raw));
      if (Math.abs(clamped - raw) > 1e-9) {
        corrections.push(`${name}: ${label} ${raw} was outside ${min}–${max} ${unit} and became ${clamped}.`);
      }
      return clamped;
    };

    // Clamp against the archetype only when the archetype is what will actually be built.
    // `buildAssembly` prefers the primitive for box, cylinder and sphere, so validating those
    // against the archetype's ranges checks something that is never used — and its 1 mm floor
    // silently thickened a 0.8 mm cover glass, which is a real and correct dimension.
    const archetype = isPrimitive(shape) ? undefined : archetypeById(shape);

    if (archetype) {
      for (const spec of archetype.defaults) {
        const v = check((c.params ?? {})[spec.key], spec.label, spec.min, spec.max, spec.unit);
        params[spec.key] = v ?? spec.value;
      }
    } else {
      // Some parameters are choices, not quantities: a loft names the plane it is built on and
      // the shape of each end. Running those through the expression evaluator reported "there
      // is no parameter called rect" and dropped them, which left the loft to fall back on its
      // defaults — a wing that quietly rebuilt itself as the stock 60 mm transition.
      //
      // Which keys are choices is asked of the feature rather than listed here, so a new
      // choice parameter cannot be forgotten in this one place.
      const choices = new Set(
        paramFields(shape as FeatureKind, c.params as Record<string, ParamValue> | undefined)
          .filter((f) => f.kind === 'choice')
          .map((f) => f.key),
      );

      for (const [key, value] of Object.entries(c.params ?? {})) {
        if (choices.has(key) && typeof value === 'string') { params[key] = value; continue; }

        // Primitives have no declared ranges, so only obvious nonsense is caught.
        const v = check(value, key, -100_000, 100_000, 'mm');
        if (v !== undefined) params[key] = v;
      }
    }

    const placement = sanePlacement(c.placement, name, corrections, reach);

    // Driven axes, kept only when they actually resolve. A placement expression that names a
    // parameter the plan never declared would put the part at the origin without saying why.
    let placementExpr: ComponentSpec['placementExpr'];
    const rawExpr = (c as { placementExpr?: Record<string, unknown> }).placementExpr;
    if (rawExpr && typeof rawExpr === 'object') {
      for (const axis of ['x', 'y', 'z', 'rx', 'ry', 'rz'] as const) {
        const src = rawExpr[axis];
        if (typeof src !== 'string' || !src.trim()) continue;

        const r = evaluateExpr(src, parameterValues);
        if (r.error) {
          corrections.push(`${name}: the ${axis} expression was dropped — ${r.error}`);
          continue;
        }
        placementExpr = { ...placementExpr, [axis]: src };
        placement[axis] = r.value;
      }
    }

    let id = typeof c.id === 'string' && c.id.trim() ? c.id.trim() : `c${index + 1}`;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);

    components.push({
      id,
      name,
      role: typeof c.role === 'string' ? c.role : '',
      shape,
      params,
      placement,
      placementExpr,
      material: typeof c.material === 'string' && c.material.trim() ? c.material.trim() : 'Unspecified',
      density: typeof c.density === 'number' && c.density > 0 && c.density < 30 ? c.density : 1.2,
      quantity: Number.isFinite(c.quantity) ? Math.max(1, Math.min(64, Math.round(c.quantity as number))) : 1,
      operation: c.operation === 'cut' ? 'cut' : c.operation === 'fuse' ? 'fuse' : 'add',
      note: typeof c.note === 'string' ? c.note : undefined,
    });
  }

  if (components.length === 0) {
    return { error: `None of the ${input.components.length} components could be built.` };
  }

  return {
    plan: {
      parameters: usableParameters,
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Assembly',
      description: typeof input.description === 'string' ? input.description : '',
      envelope: input.envelope,
      components,
      notes: Array.isArray(input.notes) ? input.notes.filter((n) => typeof n === 'string') : [],
      source: input.source === 'recipe' ? 'recipe' : 'model',
      citations: Array.isArray(input.citations) ? input.citations : undefined,
    },
    dropped,
    corrections,
  };
}

function sanePlacement(
  raw: unknown, name: string, corrections: string[], reach: number,
): Placement {
  const p = (raw ?? {}) as Partial<Placement>;
  const axis = (v: unknown, key: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
    const clamped = Math.min(reach, Math.max(-reach, v));
    if (clamped !== v) corrections.push(`${name}: position ${key} ${v} was implausible and became ${clamped}.`);
    return clamped;
  };

  return {
    x: axis(p.x, 'x'), y: axis(p.y, 'y'), z: axis(p.z, 'z'),
    rx: wrapDeg(p.rx), ry: wrapDeg(p.ry), rz: wrapDeg(p.rz),
  };
}

const wrapDeg = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return ((v % 360) + 360) % 360;
};

// ── building ─────────────────────────────────────────────────────────────────

/**
 * Turns a plan into a document.
 *
 * One feature per component, **in the order the plan lists them**, because in an assembly
 * that order carries meaning: a cut removes material from everything placed before it and
 * nothing after. Putting a chassis cavity immediately after the chassis hollows the chassis;
 * putting it at the end would bore a hole through the battery and the board as well.
 *
 * An earlier version sorted all the cuts to the end so that a cut listed first would still
 * work. That helped exactly one case and broke every assembly, so instead a cut that appears
 * before anything to cut is moved just past the first additive component — the narrow repair
 * for the narrow problem, leaving deliberate ordering alone.
 */
export function buildAssembly(plan: AssemblyPlan): Document {
  let doc = emptyDocument(plan.name);

  // A document carries one density, but an assembly is made of many materials, and weighing
  // the merged solid at any single one of them is wrong. Taking the heaviest — which is what
  // this did — made a 250 g phone weigh 831 g, because a stainless SIM tray set the density
  // for 104 cm³ of aluminium, glass and battery.
  //
  // So the mass is summed from the bill of materials, where each part is weighed at its own
  // density, and carried on the document as a known figure. The density field keeps a real
  // material's value for anything that still wants one; it is no longer what determines mass.
  const bulk = plan.components.reduce<ComponentSpec | null>(
    (best, c) => (!best || c.density > best.density ? c : best), null,
  );

  doc = {
    ...doc,
    material: plan.components.length > 1
      ? 'Mixed — see the bill of materials'
      : bulk?.material ?? doc.material,
    density: bulk?.density ?? doc.density,
    knownMassGrams: assemblyMass(plan),
    globals: (plan.parameters ?? []).filter((p) => p.name),
  };

  const ordered = reorderLeadingCuts(plan.components);

  for (const component of ordered) {
    for (let i = 0; i < component.quantity; i++) {
      const suffix = component.quantity > 1 ? ` ${i + 1}` : '';
      const placement = component.quantity > 1
        ? mirrorForInstance(component.placement, i)
        : component.placement;

      const params: Record<string, ParamValue> = { ...component.params };

      // The component's material travels onto the feature so the viewport can colour a brass
      // bush like brass. It does not set the mass: an assembly is weighed from the bill of
      // materials, each line at its own density, and that number is already on the document.
      if (component.material && component.material !== 'Unspecified') {
        params.material = component.material;
      }
      // The operation applies whichever route builds the shape. Setting it only on the
      // primitive branch meant an archetype marked as a cut was quietly unioned instead.
      params.operation =
        component.operation === 'cut' ? 'cut'
        : component.operation === 'fuse' ? 'add'
        : 'place';

      let kind: FeatureKind;

      // A few names exist as both a primitive and a catalogue archetype. The primitive is
      // preferred: it is the same shape by a shorter path, with no archetype parameter
      // clamping in between.
      if (isPrimitive(component.shape)) {
        kind = component.shape as FeatureKind;
      } else {
        kind = 'archetype';
        params.archetypeId = component.shape;
      }

      doc = addFeature(doc, kind, params, `${component.name}${suffix}`, {
        placement,
        role: component.role,
        // Driven axes are dropped for the mirrored copies of a repeated component: the
        // expression describes where the *first* one goes, and applying it unchanged would
        // stack every instance in the same place.
        placementExpr: i === 0 ? component.placementExpr : undefined,
      });
    }
  }

  return doc;
}

/**
 * The inverse: a document read back as the plan that would produce it.
 *
 * Needed because a worked example has to be in *exactly* the form the planner is asked to
 * emit. Showing a model a feature tree and then asking it for an assembly plan teaches it
 * the wrong shape — the example has to be the answer, not a paraphrase of it.
 *
 * Not every document can be one. A plan's vocabulary is archetypes and primitives placed in
 * space; a document may also hold sketches, extrudes, fillets, holes and traced imports,
 * none of which a plan can express. Those features are **reported, not dropped**: an example
 * silently missing the pocket that gives the part its purpose is worse than no example, and
 * the caller needs to be able to say so.
 *
 * Quantities are not re-collapsed. `buildAssembly` expands a component of quantity 4 into
 * four features and mirrors their placements; guessing which four features were once one
 * component would be inference dressed as a round trip, and it would be wrong the first time
 * someone moved one of them.
 */
export interface DocumentAsPlan {
  plan: AssemblyPlan;
  /** Features a plan cannot express, with the reason, in tree order. */
  excluded: { name: string; reason: string }[];
}

export function planFromDocument(doc: Document): DocumentAsPlan {
  const components: ComponentSpec[] = [];
  const excluded: { name: string; reason: string }[] = [];

  for (const feature of doc.features) {
    if (feature.suppressed) {
      excluded.push({ name: feature.name, reason: 'suppressed' });
      continue;
    }

    let shape: string | null = null;
    if (isPrimitive(feature.kind)) {
      shape = feature.kind;
    } else if (feature.kind === 'archetype') {
      const id = feature.params.archetypeId;
      shape = typeof id === 'string' && archetypeById(id) ? id : null;
    }

    if (!shape) {
      excluded.push({
        name: feature.name,
        reason: `a "${feature.kind}" feature has no equivalent in a plan`,
      });
      continue;
    }

    // `operation` and `archetypeId` are how a document records what a plan says in its own
    // fields. Carrying them through as parameters would put them in the example twice, in a
    // form the schema does not have.
    const params: Record<string, number | string> = {};
    for (const [key, value] of Object.entries(feature.params)) {
      if (key === 'operation' || key === 'archetypeId') continue;
      if (typeof value === 'number' || typeof value === 'string') params[key] = value;
    }

    components.push({
      id: feature.id,
      name: feature.name,
      role: feature.role ?? '',
      shape,
      params,
      placement: feature.placement ?? IDENTITY_PLACEMENT,
      ...(feature.placementExpr ? { placementExpr: feature.placementExpr } : {}),
      material: doc.material,
      density: doc.density,
      quantity: 1,
      operation: feature.params.operation === 'cut' ? 'cut' : 'add',
    });
  }

  const plan: AssemblyPlan = {
    name: doc.name,
    description: '',
    parameters: doc.globals.map((g) => ({ ...g })),
    components,
    notes: [],
    source: 'edited',
  };

  return { plan, excluded };
}

/** Moves any cut that precedes every additive component to just after the first one. */
function reorderLeadingCuts(components: ComponentSpec[]): ComponentSpec[] {
  const firstAdditive = components.findIndex((c) => c.operation !== 'cut');
  if (firstAdditive <= 0) return components;

  const leadingCuts = components.slice(0, firstAdditive);
  const rest = components.slice(firstAdditive);
  return [rest[0], ...leadingCuts, ...rest.slice(1)];
}

/**
 * Spreads repeated instances instead of stacking them.
 *
 * A quantity of two almost always means a symmetric pair — two hinges, two brackets, two
 * headlights — and placing both at the same coordinates hides one entirely inside the other.
 * Mirroring across the Y axis is the common case; larger counts are spread along X, which is
 * at least visible and obviously wrong if it was not what was meant.
 */
export function mirrorForInstance(base: Placement, index: number): Placement {
  if (index === 0) return base;

  // Mirror across whichever axis the part is actually offset along.
  //
  // Only Y was handled, so a component placed off-centre in X — a rocket's second pair of
  // fins, anything arranged fore and aft — put both copies in the same place instead of
  // opposite each other. The result was a cruciform with two fins.
  //
  // Reflected, not just moved. Negating the position alone is right for a symmetric component
  // and wrong for a handed one: a lofted wing grows outboard from its root, so the copy at
  // -y grew back through the fuselage and the aircraft finished with both wings on one side.
  // A mirror is what a pair of components actually is.
  if (index === 1) {
    if (Math.abs(base.y) > 1e-6) return { ...base, y: -base.y, mirror: 'y' };
    if (Math.abs(base.x) > 1e-6) return { ...base, x: -base.x, mirror: 'x' };
  }

  // Beyond a mirrored pair there is no general rule for where copies go, so they are nudged
  // apart rather than stacked exactly, which would give the boolean coincident faces.
  return { ...base, x: base.x + index * 0.001 };
}

// ── bill of materials ────────────────────────────────────────────────────────

export interface BomLine {
  item: number;
  name: string;
  role: string;
  shape: string;
  quantity: number;
  material: string;
  /** cm³ for one piece. */
  volumeCm3: number;
  /** Grams for the whole line, so quantity is already applied. Negative for a cut. */
  massGrams: number;
  density: number;
  note?: string;
}

/** What measuring a shape tells us: how much it displaces, and how far it reaches. */
export interface ShapeMeasure {
  /** mm³. */
  volume: number;
  /** Half-size in each axis, before placement. */
  half: [number, number, number];
  /**
   * Where the shape's own bounding box sits relative to its origin.
   *
   * Primitives are centred, so this is zero for them. Archetypes are not: a funnel builds
   * upward from its spout, a table from the floor. Assuming everything is centred put the
   * rocket's nose cone 420 mm off its tube and had the inspection report it as floating in
   * space — a check disagreeing with the geometry it was checking.
   */
  centre: [number, number, number];
}

/**
 * Measurements of built archetypes, keyed by shape and parameters.
 *
 * Archetypes have no closed-form volume, so measuring one means building it — and a gear or a
 * spoked wheel is expensive to build. Both the bill of materials and the geometry inspection
 * want the same numbers for the same components, and without a cache each of them paid the
 * cost separately, on every pass. Inspecting a bicycle took forty-eight seconds.
 *
 * Keyed on the parameters as well as the id, because two gears with different tooth counts are
 * different solids. Unbounded, which is safe here: the key space is the set of distinct
 * components a session actually builds, in the low hundreds at most.
 */
const measured = new Map<string, ShapeMeasure>();

const ZERO: ShapeMeasure = { volume: 0, half: [0, 0, 0], centre: [0, 0, 0] };

/**
 * Volume and extent for one component's shape, before placement.
 *
 * Primitives are computed in closed form because they have one, and because doing so avoids
 * tessellation error entirely — a cylinder's mesh volume is short by the inscribed-polygon
 * deficit, which at the default segment count is about a tenth of a percent and is a silly
 * thing to accept when πr²h is exact.
 */
/** A component's parameters with every expression worked out. */
export function resolveComponentParams(
  c: ComponentSpec, values: Record<string, number> = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(c.params)) {
    out[key] = readNumber(raw, values, 0).value;
  }
  return out;
}

/** Bounding half-extents, centre and volume of a mesh, in the form the inspector wants. */
function measureOf(mesh: Mesh): ShapeMeasure {
  const b = bounds(mesh);
  return {
    volume: Math.abs(massProperties(mesh).volume),
    half: [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2],
    centre: [(b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2],
  };
}

export function measureShape(c: ComponentSpec, values: Record<string, number> = {}): ShapeMeasure {
  // A parameter may now be an expression over the plan's own driving dimensions, so the whole
  // set is resolved up front. Passing no values resolves literals only, which is what every
  // caller that predates parameters wants.
  //
  // Resolved eagerly rather than through a Proxy: a Proxy that implements only `get` and `has`
  // reports no keys at all to `Object.keys`, so the archetype branch below — which enumerates
  // the parameters it was given — silently saw an empty object and fell back to defaults. A
  // bicycle's tubes came out 3.2 metres long.
  const p = resolveComponentParams(c, values);

  switch (c.shape) {
    case 'box': {
      const [l, w, h] = [p.length ?? 0, p.width ?? 0, p.height ?? 0];
      return { volume: l * w * h, half: [l / 2, w / 2, h / 2], centre: [0, 0, 0] };
    }
    case 'cylinder': {
      const r = (p.diameter ?? 0) / 2;
      const h = p.height ?? 0;
      return { volume: Math.PI * r * r * h, half: [r, r, h / 2], centre: [0, 0, 0] };
    }
    case 'sphere': {
      const r = (p.diameter ?? 0) / 2;
      return { volume: (4 / 3) * Math.PI * r ** 3, half: [r, r, r], centre: [0, 0, 0] };
    }
    /*
     * Lofts and sweeps are measured by building them.
     *
     * Every other primitive here has a closed-form volume, and a loft does not — its volume
     * depends on how its two sections correspond, which is the loft's own business. Writing a
     * formula for the common cases would be a second geometry model that agrees with the
     * kernel until the day it does not; a wing that the inspector believed had no volume at
     * all is exactly that failure, and it is the reason this branch exists rather than a
     * length x width x height guess.
     */
    case 'loft':
    case 'sweep': {
      const key = `${c.shape}|${JSON.stringify(p)}`;
      const hit = measured.get(key);
      if (hit) return hit;

      const doc = emptyDocument();
      const feature: Feature = {
        id: 'measure', name: c.name, kind: c.shape as FeatureKind,
        params: { ...defaultParams(c.shape as FeatureKind), ...c.params },
        suppressed: false,
      };

      const built = applyFeature(
        { positions: new Float64Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0), tags: new Map() },
        feature, doc,
      );

      const value = built.mesh && triCount(built.mesh) > 0
        ? measureOf(built.mesh)
        : ZERO;
      measured.set(key, value);
      return value;
    }

    default: {
      const archetype = archetypeById(c.shape);
      if (!archetype) return ZERO;

      const key = `${c.shape}|${JSON.stringify(p)}`;
      const hit = measured.get(key);
      if (hit) return hit;

      try {
        const mesh = archetype.build(p).mesh;
        const b = bounds(mesh);
        const value: ShapeMeasure = {
          volume: Math.abs(massProperties(mesh).volume),
          half: [
            (b.max[0] - b.min[0]) / 2,
            (b.max[1] - b.min[1]) / 2,
            (b.max[2] - b.min[2]) / 2,
          ],
          centre: [
            (b.max[0] + b.min[0]) / 2,
            (b.max[1] + b.min[1]) / 2,
            (b.max[2] + b.min[2]) / 2,
          ],
        };
        measured.set(key, value);
        return value;
      } catch {
        // A parameter set the archetype cannot build is already reported by the validator;
        // there is no second useful thing to say about it here.
        measured.set(key, ZERO);
        return ZERO;
      }
    }
  }
}

/** The volume of one component, in mm³. */
export function componentVolume(c: ComponentSpec): number {
  return measureShape(c).volume;
}

/**
 * The bill of materials, with a real mass against every line.
 *
 * Mass is the first number an engineer checks and the one that exposes a model as fake. It
 * needs each part's *own* volume against its *own* density, which is what this does.
 *
 * Cuts are subtracted, at the density of the material they are cutting into — taken as the
 * nearest preceding component that adds material, which is what a cavity in a frame or a port
 * through a wall actually removes. That is an approximation: a cut spanning two materials is
 * charged entirely to the first. It is a far smaller error than ignoring cuts, which would
 * weigh a phone's mid-frame as a solid aluminium billet.
 */
export function billOfMaterials(plan: AssemblyPlan): BomLine[] {
  let lastAddedDensity = 0;

  return plan.components.map((c, i) => {
    const volumeMm3 = componentVolume(c);
    const volumeCm3 = volumeMm3 / 1000;
    const cut = c.operation === 'cut';

    if (!cut) lastAddedDensity = c.density;
    const density = cut ? lastAddedDensity : c.density;

    return {
      item: i + 1,
      name: c.name,
      role: c.role,
      shape: c.shape,
      quantity: c.quantity,
      material: c.material,
      volumeCm3,
      density,
      massGrams: volumeCm3 * density * c.quantity * (cut ? -1 : 1),
      note: c.note,
    };
  });
}

/** What the assembly weighs, in grams, summed over the bill of materials. */
export function assemblyMass(plan: AssemblyPlan): number {
  return Math.max(0, billOfMaterials(plan).reduce((sum, line) => sum + line.massGrams, 0));
}

/** A short human summary of the plan, for the conversation. */
export function describePlan(plan: AssemblyPlan): string {
  const total = plan.components.reduce((n, c) => n + c.quantity, 0);
  const kinds = new Set(plan.components.map((c) => c.shape)).size;
  return (
    `${plan.name}: ${total} part${total === 1 ? '' : 's'} across ${plan.components.length} ` +
    `component type${plan.components.length === 1 ? '' : 's'} (${kinds} distinct shape${kinds === 1 ? '' : 's'}).`
  );
}

export { IDENTITY_PLACEMENT };
