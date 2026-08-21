import {
  addFeature, defaultParams, emptyDocument, paramFields,
  type Document, type Feature, type FeatureKind, type ParamValue, type Placement,
} from '../model/document';
import { evaluateExpr, resolveParameters, type Parameter } from '../model/expr';
import { archetypeById, ARCHETYPES } from './archetypes';

/**
 * DatumScript — a part, written down.
 *
 * ── Why a language ──
 *
 * The catalogue answers a request by matching it to one of a few dozen named shapes. That is
 * the right thing when the shape is one of them — nothing beats an archetype for "M10 hex nut"
 * — and it is a ceiling everywhere else, because the cost of adding shapes is linear and the
 * world is not. A model asked to fill fields in a fixed schema can only ever produce what the
 * schema already anticipated.
 *
 * A model asked to write a *program* is bounded by the language instead. That is the decision
 * every credible system in this category arrived at independently, and it is the one change
 * that removes the ceiling rather than raising it.
 *
 * ── Why this language, and not a real one ──
 *
 * The property that has to survive is the one this application is actually differentiated by:
 * **a model cannot emit geometry the kernel would not have built.** A general-purpose scripting
 * language breaks that the moment the sandbox leaks, and sandboxes leak.
 *
 * So DatumScript is *declarative*. It has no loops, no branches, no functions and no way to
 * compute anything except an arithmetic expression over its own named parameters. Every
 * statement names a feature the kernel already implements, and every argument is checked
 * against that feature's own parameter schema — the same schema the editor draws its sliders
 * from. A statement the kernel could not build is a syntax error, found before anything runs.
 *
 * What it gains over the catalogue is that the *combinations* are unbounded: 24 feature kinds
 * in any order, at any placement, sized by expressions over shared parameters. That covers
 * parts no archetype anticipates while keeping the guarantee that made the archetypes worth
 * having.
 *
 * ── The form ──
 *
 * ```
 * # A mounting plate
 * param length = 120
 * param width  = 80
 * param thick  = 8
 * param bolts  = 4
 *
 * box    Body   length=length width=width height=thick
 * hole   Bolts  diameter=6.6 pattern=boltCircle count=bolts boltCircle=length*0.5
 * fillet Edges  radius=3
 * ```
 *
 * One statement per line. A feature is `<kind> <name> <key>=<expr> …`, and a name may be
 * omitted. Expressions may read any parameter, including ones declared later — resolution is
 * iterative, because a program written by a model does not arrive in dependency order.
 *
 * The evaluated form is a `Document`, which is to say the ordinary feature tree: everything
 * downstream — the viewport, the drawing, the manufacturability rules, the exact kernel — is
 * unchanged and unaware. A script is a way of *writing* a part, not a different kind of part.
 */

export interface ScriptError {
  /** 1-based, as an editor counts them. */
  line: number;
  message: string;
  /** The line as written, so an error can be shown in place. */
  source: string;
}

export interface ScriptResult {
  ok: boolean;
  doc: Document;
  /** Every error, not the first: a model repairing its own program needs all of them. */
  errors: ScriptError[];
  /** Parameters the script declared, in the order it declared them. */
  parameters: Parameter[];
}

/** Statement keywords that are not features. */
const DIRECTIVES = new Set(['param', 'name', 'material', 'units']);

/**
 * Every feature kind a statement may name.
 *
 * Taken from the kernel's own schema rather than listed here, so a feature added to the
 * evaluator is writable in a script the same day and nobody has to remember.
 */
export const SCRIPT_KINDS: FeatureKind[] = [
  // The catalogue, as one statement. `archetype Cup archetypeId=cup height=90` is the whole
  // of a cup — its handle, its shelling, its rim blend — in a line, and without it a document
  // built from the catalogue could not be printed as a script at all, which would make the
  // language an input rather than a format.
  'archetype',
  'box', 'cylinder', 'sphere', 'sketch', 'extrude', 'revolve', 'loft', 'sweep',
  'rib', 'draft', 'dome', 'split', 'datum', 'wrap', 'sheet',
  'hole', 'pocket', 'slot', 'fillet', 'chamfer', 'shell',
  'patternLinear', 'patternCircular', 'mirror',
];

/*
 * Kinds are matched without regard to case, and the canonical spelling is recovered here.
 *
 * Three of them — `patternLinear`, `patternCircular` and the camel-cased sheet fields — carry a
 * capital in the middle. A keyword was lowercased before it was looked up, so those three were
 * unreachable: a script that used the exact spelling the error message recommends was told the
 * feature does not exist, and the list of what does exist named it. Case is not information in
 * a keyword, so it is not consulted.
 */
const KIND_BY_LOWER = new Map<string, FeatureKind>(SCRIPT_KINDS.map((k) => [k.toLowerCase(), k]));

/** Placement keys, which every feature accepts and no feature's schema lists. */
const PLACEMENT_KEYS = new Set(['at.x', 'at.y', 'at.z', 'at.rx', 'at.ry', 'at.rz']);


/**
 * The arguments a statement may carry.
 *
 * `paramFields` answers for every feature the editor draws sliders for, and an archetype is
 * the exception: its parameters are the archetype's own, which depend on which one it is. So
 * the id is read first and the rest come from the catalogue entry it names.
 */
function fieldsFor(kind: FeatureKind, archetypeId?: string): { key: string; choice?: string[] }[] {
  if (kind !== 'archetype') {
    return paramFields(kind).map((f) => ({
      key: f.key,
      ...(f.kind === 'choice' ? { choice: (f.choices ?? []).map((c) => c.value) } : {}),
    }));
  }

  const id: { key: string; choice?: string[] }[] = [
    { key: 'archetypeId', choice: ARCHETYPES.map((a) => a.id) },
    { key: 'operation', choice: ['add', 'cut', 'intersect'] },
  ];

  const archetype = archetypeId ? archetypeById(archetypeId) : undefined;
  if (!archetype) return id;

  return [...id, ...archetype.defaults.map((d) => ({ key: d.key }))];
}

// ── parsing ──────────────────────────────────────────────────────────────────

export function runScript(source: string): ScriptResult {
  const errors: ScriptError[] = [];
  const parameters: Parameter[] = [];

  interface Pending {
    line: number;
    source: string;
    kind: FeatureKind;
    name?: string;
    args: { key: string; expr: string }[];
  }

  const pending: Pending[] = [];
  let docName = 'Part';
  let material: string | undefined;

  const lines = source.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = i + 1;

    // Comments and blank lines. `#` anywhere outside a quoted string starts a comment; there
    // are no quoted strings, so anywhere.
    const text = raw.split('#')[0]!.trim();
    if (text.length === 0) continue;

    const [head, ...rest] = text.split(/\s+/);
    const keyword = head!.toLowerCase();

    if (DIRECTIVES.has(keyword)) {
      const problem = readDirective(keyword, rest, text, parameters, (n) => { docName = n; },
        (m) => { material = m; });
      if (problem) errors.push({ line, message: problem, source: raw });
      continue;
    }

    const canonical = KIND_BY_LOWER.get(keyword);
    if (canonical === undefined) {
      errors.push({
        line,
        message:
          `"${head}" is not something this can build. ` +
          `The features are: ${SCRIPT_KINDS.join(', ')}.`,
        source: raw,
      });
      continue;
    }

    const kind = canonical;

    // An unqualified word after the kind is the feature's name; everything with an `=` is an
    // argument. A name is optional, so the two are told apart by shape rather than position.
    const named = rest.filter((t) => !t.includes('='));
    const args: { key: string; expr: string }[] = [];

    for (const token of rest) {
      if (!token.includes('=')) continue;
      const at = token.indexOf('=');
      args.push({ key: token.slice(0, at), expr: token.slice(at + 1) });
    }

    if (named.length > 1) {
      errors.push({
        line,
        message:
          `A feature takes one name, and this line has ${named.length}: ${named.join(', ')}. ` +
          `Did an argument lose its "=" — or its spaces, as in "radius = 3"?`,
        source: raw,
      });
      continue;
    }

    pending.push({ line, source: raw, kind, name: named[0], args });
  }

  // ── resolve the parameter table once, for every expression to read ──
  const resolved = resolveParameters(parameters);
  for (const [name, why] of resolved.errors) {
    const declared = parameters.findIndex((p) => p.name === name);
    errors.push({
      line: declared >= 0 ? declared + 1 : 1,
      message: `Parameter "${name}" could not be worked out: ${why}`,
      source: `param ${name}`,
    });
  }

  // ── build ──
  let doc = emptyDocument(docName);
  if (material) doc = { ...doc, material };
  doc = { ...doc, globals: parameters };

  for (const statement of pending) {
    // An archetype's arguments depend on which archetype, so its id is read before the rest.
    const declaredId = statement.args.find((a) => a.key === 'archetypeId')?.expr;
    const fields = fieldsFor(statement.kind, declaredId);
    /*
     * Argument names, matched without regard to case, exactly as the kinds are.
     *
     * Case is not information anywhere in this language, and it should not be information in
     * one half of a statement and not the other: `PatternLinear` was accepted while `flangeA`
     * written `flangea` was refused, which is a rule nobody could infer. Several field names
     * carry a capital in the middle — `flangeA`, `baseLength`, `topShape` — and every one of
     * them is a place a model or a person can lose a script to a shift key.
     */
    const allowed = new Set(fields.map((f) => f.key));
    const keyByLower = new Map(fields.map((f) => [f.key.toLowerCase(), f.key]));
    const params: Record<string, ParamValue> = {};
    const placement: Record<string, number> = {};
    let bad = false;

    for (const { key: written, expr } of statement.args) {
      const lower = written.toLowerCase();
      const key = keyByLower.get(lower) ?? (PLACEMENT_KEYS.has(lower) ? lower : written);

      if (PLACEMENT_KEYS.has(key)) {
        const value = evaluateExpr(expr, resolved.values);
        if (value.error) {
          errors.push({ line: statement.line, message: `${key}: ${value.error}`, source: statement.source });
          bad = true;
          continue;
        }
        placement[key.slice(3)] = value.value;
        continue;
      }

      if (!allowed.has(key)) {
        errors.push({
          line: statement.line,
          message:
            `${statement.kind} has no "${written}". It takes: ${[...allowed].join(', ')}` +
            (PLACEMENT_KEYS.size > 0 ? ', and at.x / at.y / at.z / at.rx / at.ry / at.rz' : '') + '.',
          source: statement.source,
        });
        bad = true;
        continue;
      }

      // A choice field takes a word, not a number — "pattern=boltCircle", "operation=cut".
      const field = fields.find((f) => f.key === key)!;
      if (field.choice) {
        const allowedValues = field.choice;
        // The same rule for the value as for the name: `pattern=BoltCircle` is the same request
        // as `pattern=boltCircle`, and refusing one of them teaches nobody anything.
        const chosen = allowedValues.find((v) => v.toLowerCase() === expr.toLowerCase());
        if (!chosen) {
          errors.push({
            line: statement.line,
            message: `${written} is "${expr}", which is not one of: ${allowedValues.join(', ')}.`,
            source: statement.source,
          });
          bad = true;
          continue;
        }
        params[key] = chosen;
        continue;
      }

      const value = evaluateExpr(expr, resolved.values);
      if (value.error) {
        errors.push({ line: statement.line, message: `${key}: ${value.error}`, source: statement.source });
        bad = true;
        continue;
      }
      /*
       * The expression is stored, not its answer.
       *
       * Evaluated here and thrown away, `height=plate` became `height=10` in the document, so
       * the parameter it named was declared and dead: printing the document back gave a script
       * whose params drove nothing, and changing `plate` moved no geometry. A parametric part
       * that stops being parametric the moment it is saved is not one.
       *
       * The evaluator resolves a string param against the document's own parameter table when
       * it reads it, so keeping the text costs nothing at build time and keeps the binding. It
       * is still evaluated here, because an expression that cannot be resolved has to be a parse
       * error found now rather than a feature that fails to build later.
       */
      params[key] = /[A-Za-z]/.test(expr) ? expr : value.value;
    }

    if (bad) continue;

    const extra = Object.keys(placement).length > 0
      ? { placement: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, ...placement } as Placement }
      : undefined;

    /*
     * A field the script left out means the same thing here as it does in the toolbar.
     *
     * It did not. A feature added from the UI carries `defaultParams`; a feature added from a
     * script carried only what was written, and every unwritten field fell back to a second,
     * different set of literals buried in the evaluator. Two default tables that disagree is a
     * language where `revolve Body` and the Revolve button build different parts.
     *
     * One of those disagreements was fatal: the evaluator's fallback section for a revolve is
     * 60 mm wide at zero offset, so it straddles the axis, and a revolve whose section crosses
     * its axis cancels itself out — `revolve Body` produced a closed, manifold, 696-triangle
     * solid of exactly zero volume. The toolbar's own default is 20 mm wide at 30 mm offset and
     * has always been fine. Merging them fixes the whole class, not just the one that showed.
     */
    const withDefaults = { ...defaultParams(statement.kind), ...params };

    doc = addFeature(doc, statement.kind, withDefaults, statement.name, extra);
  }

  return { ok: errors.length === 0, doc, errors, parameters };
}

/** A `param`, `name`, `material` or `units` line. Returns why it could not be read, or null. */
function readDirective(
  keyword: string,
  rest: string[],
  text: string,
  parameters: Parameter[],
  setName: (n: string) => void,
  setMaterial: (m: string) => void,
): string | null {
  if (keyword === 'param') {
    // `param name = expr`, with the spaces optional on either side of the `=`.
    const body = text.slice(text.toLowerCase().indexOf('param') + 5).trim();
    const at = body.indexOf('=');
    if (at < 0) return 'A parameter needs a value: param length = 120.';

    const name = body.slice(0, at).trim();
    const expr = body.slice(at + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return `"${name}" is not a usable parameter name — letters, digits and underscores, starting with a letter.`;
    }
    if (expr.length === 0) return `Parameter "${name}" has no value.`;
    if (parameters.some((p) => p.name === name)) return `Parameter "${name}" is declared twice.`;

    const literal = Number(expr);
    parameters.push({
      name,
      value: Number.isFinite(literal) ? literal : expr,
      units: 'mm',
    });
    return null;
  }

  if (keyword === 'name') {
    const value = rest.join(' ').trim();
    if (!value) return 'A name line needs a name.';
    setName(value);
    return null;
  }

  if (keyword === 'material') {
    const value = rest.join(' ').trim();
    if (!value) return 'A material line needs a material.';
    setMaterial(value);
    return null;
  }

  // `units` is accepted and ignored: everything here is millimetres, and a script that says so
  // is clearer than one that leaves it to be assumed. Refusing it would be pedantry.
  return null;
}

// ── printing ─────────────────────────────────────────────────────────────────

/**
 * A document, written back out as a script.
 *
 * The round trip is what makes the script a *format* rather than an input: a part built by
 * clicking can be read as a program, edited as text, and rebuilt — and a part written as a
 * program can be edited with the sliders. Neither is the primary form.
 */
export function printScript(doc: Document): string {
  const out: string[] = [];

  out.push(`name ${doc.name}`);
  if (doc.material) out.push(`material ${doc.material}`);

  const globals = doc.globals ?? [];
  if (globals.length > 0) {
    out.push('');
    for (const p of globals) out.push(`param ${p.name} = ${p.value}`);
  }

  if (doc.features.length > 0) out.push('');

  for (const feature of doc.features) {
    out.push(printFeature(feature));
  }

  return `${out.join('\n')}\n`;
}

function printFeature(feature: Feature): string {
  const id = typeof feature.params.archetypeId === 'string' ? feature.params.archetypeId : undefined;
  const allowed = fieldsFor(feature.kind, id).map((f) => f.key);
  const parts: string[] = [feature.kind];

  // A name only when it says something the kind does not. "Fillet1" on a fillet is noise.
  if (feature.name && !new RegExp(`^${feature.kind}\\d*$`, 'i').test(feature.name.replace(/\s+/g, ''))) {
    parts.push(feature.name.replace(/\s+/g, '_'));
  }

  for (const key of allowed) {
    const value = feature.params[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) continue;      // face selections are not expressible as text
    if (typeof value === 'boolean') continue;
    parts.push(`${key}=${typeof value === 'number' ? round(value) : value}`);
  }

  const p = feature.placement;
  if (p) {
    for (const [axis, v] of Object.entries(p)) {
      if (axis === 'mirror' || typeof v !== 'number' || v === 0) continue;
      parts.push(`at.${axis}=${round(v)}`);
    }
  }

  return parts.join(' ');
}

/** Trailing zeros make a script noisy without making it more exact. */
function round(v: number): number {
  return Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : Number(v.toFixed(4));
}

// ── the vocabulary, for a prompt ─────────────────────────────────────────────

/**
 * The language, described for a model.
 *
 * Generated from the kernel's own parameter schema rather than written out, so a model is
 * never told about a feature that does not exist or left ignorant of one that does. This is
 * the same single-source discipline the manufacturing limits use: the prompt and the validator
 * read one definition, so they cannot disagree.
 */
export function scriptVocabulary(): string {
  const lines: string[] = [];

  for (const kind of SCRIPT_KINDS) {
    if (kind === 'archetype') {
      // Named separately, because its arguments depend on which shape it names — and because
      // a model that knows the catalogue exists reaches for one line instead of twenty.
      lines.push(
        `archetype [name] archetypeId=${ARCHETYPES.map((a) => a.id).join('|')} ` +
        `operation=add|cut|intersect <and that shape's own parameters>`,
      );
      continue;
    }

    const described = fieldsFor(kind).map((f) => (
      f.choice ? `${f.key}=${f.choice.join('|')}` : `${f.key}=<number>`
    ));
    lines.push(`${kind} [name] ${described.join(' ')}`);
  }

  return lines.join('\n');
}
