/**
 * ISO 10303-21 — the STEP physical file, parsed.
 *
 * STEP is the one format every CAD, CAM and inspection package agrees on, which makes it the
 * only realistic way an existing library gets into this product: the native formats are
 * proprietary binary, and the seat that can read them can also export this.
 *
 * Part 21 is a small, regular grammar and this is a direct reader for it rather than a
 * dependency. That is a deliberate choice and worth defending: the file is untrusted input
 * arriving from someone else's CAD system, and a parser that is 300 lines of this project's
 * own code can be read, tested and reasoned about — where a library would add a supply-chain
 * dependency, a bundle cost, and its own failure modes, to save a day.
 *
 * The grammar it accepts:
 *
 *   ISO-10303-21;
 *   HEADER;  <entity>* ENDSEC;
 *   DATA;    #<id> = <entity>;  *  ENDSEC;
 *   END-ISO-10303-21;
 *
 * where an entity is `NAME(arg, arg, …)` and an argument is a reference (`#12`), a number, a
 * string (`'…'`, with `''` for a literal quote), an enumeration (`.T.`), a list (`(…)`), or
 * one of the two nulls — `$` for "not provided" and `*` for "inherited".
 *
 * **Errors are located, not thrown away.** A file that fails to parse at character 40 000 is
 * not usefully described as "invalid": the caller needs the line, so this reports one.
 */

export type Value =
  | { kind: 'ref'; id: number }
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'null' };

export interface Entity {
  id: number;
  /** Upper-case, as written. */
  type: string;
  args: Value[];
  /**
   * The other halves of a complex instance.
   *
   * Part 21 lets one instance be several entity types at once —
   * `#402 =( CONVERSION_BASED_UNIT('INCH',#372) LENGTH_UNIT() NAMED_UNIT(#396) )` — and that
   * is how every real translator writes units. Keeping only the first member was enough to
   * stop the parser choking and not enough to read anything: a metric file declares its unit
   * as `( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) )`, where the fact that matters is in
   * the *third* member.
   */
  members?: Entity[];
}

export interface StepFile {
  /** By instance id, which is how every reference in the file addresses them. */
  entities: Map<number, Entity>;
  /**
   * Millimetres per file unit, resolved from the unit context by the reader.
   *
   * Held on the file rather than in a module variable so two files can be read at once, and
   * so no geometry function can forget to ask: every coordinate goes through one place.
   */
  lengthMm: number;
  /** FILE_NAME, FILE_DESCRIPTION and friends, as written. */
  header: Entity[];
  /** Anything read but not usable, said out loud rather than dropped. */
  notes: string[];
}

export interface ParseFailure {
  error: string;
  /** 1-based, so it matches what a text editor shows. */
  line?: number;
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isNameChar = (c: string) =>
  (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || isDigit(c) || c === '_' || c === '-';

export function parseStep(text: string): StepFile | ParseFailure {
  if (!/ISO-10303-21/.test(text.slice(0, 4096))) {
    return {
      error:
        'This is not a STEP file — the ISO-10303-21 marker is missing from the header. '
        + 'A .stp or .step file saved from CAD begins with it.',
    };
  }

  const dataAt = text.search(/\bDATA\s*;/);
  if (dataAt < 0) return { error: 'The file has no DATA section, so it carries no geometry.' };

  const entities = new Map<number, Entity>();
  const header: Entity[] = [];
  const notes: string[] = [];

  let i = 0;
  let line = 1;

  const fail = (message: string): ParseFailure => ({ error: message, line });

  /** Whitespace and both comment forms. Tracks the line so an error can name one. */
  const skipTrivia = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) {
        if (text[i] === '\n') line += 1;
        i += 1;
      }
      if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) { i = text.length; return; }
        for (let j = i; j < end; j++) if (text[j] === '\n') line += 1;
        i = end + 2;
        continue;
      }
      return;
    }
  };

  const readName = (): string => {
    const start = i;
    while (i < text.length && isNameChar(text[i]!)) i += 1;
    return text.slice(start, i).toUpperCase();
  };

  const readValue = (): Value | ParseFailure => {
    skipTrivia();
    const c = text[i];

    if (c === undefined) return fail('The file ends in the middle of an entity.');

    if (c === '#') {
      i += 1;
      const start = i;
      while (i < text.length && isDigit(text[i]!)) i += 1;
      if (i === start) return fail('A "#" is not followed by an instance number.');
      return { kind: 'ref', id: Number(text.slice(start, i)) };
    }

    if (c === '$') { i += 1; return { kind: 'null' }; }
    if (c === '*') { i += 1; return { kind: 'null' }; }

    if (c === "'") {
      i += 1;
      let out = '';
      for (;;) {
        if (i >= text.length) return fail('A string is never closed.');
        if (text[i] === "'") {
          // Two quotes in a row are one literal quote, which is how Part 21 escapes them.
          if (text[i + 1] === "'") { out += "'"; i += 2; continue; }
          i += 1;
          break;
        }
        if (text[i] === '\n') line += 1;
        out += text[i];
        i += 1;
      }
      return { kind: 'string', value: out };
    }

    if (c === '.') {
      const end = text.indexOf('.', i + 1);
      if (end < 0) return fail('An enumeration is never closed.');
      const value = text.slice(i + 1, end);
      i = end + 1;
      return { kind: 'enum', value: value.toUpperCase() };
    }

    if (c === '(') {
      i += 1;
      const items: Value[] = [];
      for (;;) {
        skipTrivia();
        if (text[i] === ')') { i += 1; break; }
        if (i >= text.length) return fail('A list is never closed.');

        const item = readValue();
        if ('error' in item) return item;
        items.push(item);

        skipTrivia();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ')') { i += 1; break; }
        return fail(`Expected "," or ")" in a list, found "${text[i]}".`);
      }
      return { kind: 'list', items };
    }

    if (isDigit(c) || c === '-' || c === '+') {
      const start = i;
      i += 1;
      while (i < text.length && /[0-9.eE+-]/.test(text[i]!)) i += 1;
      const value = Number(text.slice(start, i));
      if (!Number.isFinite(value)) return fail(`"${text.slice(start, i)}" is not a number.`);
      return { kind: 'number', value };
    }

    // A bare name here is a *typed value* — `LENGTH_MEASURE(0.0254)`, `IFCREAL(1.0)` — where
    // the name states the type and the brackets hold the value. The type is not needed; the
    // value is.
    //
    // A single-argument typed value collapses to that argument rather than to a one-item
    // list, which is what it means. Returning the list instead was a real defect and a quiet
    // one: `LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(0.0254), #80)` is how every file states
    // its inch conversion, `asNumber` saw a list and returned null, the unit went unread, and
    // every inch part came in 25.4 times too small with nothing to show for it.
    if (isNameChar(c)) {
      const name = readName();
      skipTrivia();
      if (text[i] === '(') {
        const inner = readValue();
        if ('error' in inner) return inner;
        return inner.kind === 'list' && inner.items.length === 1 ? inner.items[0]! : inner;
      }
      return { kind: 'enum', value: name };
    }

    return fail(`Unexpected character "${c}".`);
  };

  /** `NAME(args)`, positioned at the name. */
  const readEntity = (id: number): Entity | ParseFailure => {
    skipTrivia();

    // A complex instance is a parenthesised run of entities sharing one id. Every member is
    // kept: the one carrying the fact a caller wants is not reliably the first.
    if (text[i] === '(') {
      i += 1;
      const members: Entity[] = [];

      for (;;) {
        skipTrivia();
        if (i >= text.length) return fail('A complex instance is never closed.');
        if (text[i] === ')') { i += 1; break; }

        const name = readName();
        if (!name) return fail('A complex instance holds something that is not an entity.');

        skipTrivia();
        if (text[i] !== '(') return fail(`"${name}" in a complex instance has no arguments.`);

        const args = readValue();
        if ('error' in args) return args;

        members.push({ id, type: name, args: args.kind === 'list' ? args.items : [args] });
      }

      if (members.length === 0) return fail('A complex instance is empty.');

      // The first member stays the entity's nominal type, so every existing caller reads it
      // unchanged; the rest are reachable through `members`.
      return { ...members[0]!, members };
    }

    const type = readName();
    if (!type) return fail('An instance has no entity name.');

    skipTrivia();
    if (text[i] !== '(') return fail(`"${type}" is not followed by its arguments.`);

    const args = readValue();
    if ('error' in args) return args;

    return { id, type, args: args.kind === 'list' ? args.items : [args] };
  };

  // ── header ──
  i = text.search(/\bHEADER\s*;/);
  if (i >= 0) {
    i += text.slice(i).indexOf(';') + 1;
    for (;;) {
      skipTrivia();
      if (i >= text.length || /^ENDSEC\s*;/i.test(text.slice(i, i + 10))) break;
      const entity = readEntity(0);
      if ('error' in entity) break;             // a malformed header is not worth failing over
      header.push(entity);
      skipTrivia();
      if (text[i] === ';') i += 1;
    }
  }

  // ── data ──
  i = dataAt + text.slice(dataAt).indexOf(';') + 1;

  for (;;) {
    skipTrivia();
    if (i >= text.length) break;
    if (/^ENDSEC\s*;/i.test(text.slice(i, i + 10))) break;

    if (text[i] !== '#') {
      // Not an instance. Step over the statement rather than failing: files from some
      // translators carry stray directives, and one of those is not a reason to lose the part.
      const end = text.indexOf(';', i);
      if (end < 0) break;
      for (let j = i; j < end; j++) if (text[j] === '\n') line += 1;
      i = end + 1;
      continue;
    }

    i += 1;
    const start = i;
    while (i < text.length && isDigit(text[i]!)) i += 1;
    const id = Number(text.slice(start, i));
    if (!Number.isFinite(id)) return fail('An instance has no number.');

    skipTrivia();
    if (text[i] !== '=') return fail(`Instance #${id} is not followed by "=".`);
    i += 1;

    const entity = readEntity(id);
    if ('error' in entity) return entity;

    entities.set(id, entity);

    skipTrivia();
    if (text[i] === ';') i += 1;
  }

  if (entities.size === 0) {
    return { error: 'The DATA section is empty — the file carries no geometry.', line };
  }

  return { entities, header, notes, lengthMm: 1 };
}

// ── reading values back ─────────────────────────────────────────────────────

export const asNumber = (v: Value | undefined): number | null =>
  (v && v.kind === 'number' ? v.value : null);

export const asRef = (v: Value | undefined): number | null =>
  (v && v.kind === 'ref' ? v.id : null);

export const asString = (v: Value | undefined): string | null =>
  (v && v.kind === 'string' ? v.value : null);

export const asList = (v: Value | undefined): Value[] =>
  (v && v.kind === 'list' ? v.items : []);

/** True for `.T.`, false for anything else — Part 21's boolean. */
export const asFlag = (v: Value | undefined): boolean =>
  !!v && v.kind === 'enum' && v.value === 'T';

/** Every instance of a type, in file order. */
export function entitiesOfType(file: StepFile, type: string): Entity[] {
  const out: Entity[] = [];
  for (const entity of file.entities.values()) if (entity.type === type) out.push(entity);
  return out;
}

/**
 * A member of a complex instance by type, or the entity itself when it is already that type.
 *
 * Reads a plain instance and a complex one the same way, so a caller does not have to know
 * which form a translator chose — and they do differ: the same unit is written as a complex
 * instance by SOLIDWORKS and as a plain one elsewhere.
 */
export function memberOfType(entity: Entity | null, type: string): Entity | null {
  if (!entity) return null;
  if (entity.type === type) return entity;
  return entity.members?.find((m) => m.type === type) ?? null;
}
