import { addFeature, emptyDocument, type Document, type ParamValue } from '../model/document';
import { findMeasures, headNoun, type Measure } from './parse';

/**
 * Composition: a request read as a shape and the operations performed on it.
 *
 * ── The gap this closes ──
 *
 * The catalogue matches a request to one of a few dozen archetypes and sizes it. What it
 * cannot do is read the rest of the sentence. "A hollow box 80 × 60 × 40 with 3 mm walls"
 * matched `box`, was built at 192.00 cm³ — solid, to the millimetre — and reported as
 * "Built a box." The word "hollow" and the phrase "3 mm walls" were parsed, understood as
 * belonging to no archetype parameter, and dropped. Likewise a block "with an 8 mm hole in
 * the middle" came back with no hole, and a cube "with all edges rounded 4 mm" with sharp
 * edges. Every one of them looked finished.
 *
 * That is the same failure the head-noun gate was built to stop, one level down: not the
 * wrong shape, but the right shape missing everything that was asked of it.
 *
 * ── How it works ──
 *
 * A request is a **base shape** followed by **modifier clauses**, separated by "with", "and",
 * "then" and commas. The base becomes a primitive feature; each modifier becomes a real
 * kernel feature — a hole, a pocket, a slot, a shell, a fillet, a chamfer. Every clause reads
 * its dimensions only from the measurements inside its own span, which is what keeps the 3 of
 * "3 mm walls" out of the box's height.
 *
 * Features are then ordered the way a part is actually modelled: the body, then what is cut
 * out of it, then the hollowing, then the blends. A fillet applied before a hole is drilled
 * rounds an edge that is about to be cut away.
 *
 * ── What it will not do ──
 *
 * Guess. A clause naming something it cannot build is returned in `unhandled` and the caller
 * says so out loud. Building four fifths of a part and reporting success is the behaviour
 * this module exists to remove, and reintroducing it here would be worse than never having
 * composed anything.
 */

export interface ComposedPart {
  ok: true;
  doc: Document;
  /** What each clause was read as, in the user's own terms. */
  understood: string[];
  /** Clauses naming something that cannot be built. Reported, never dropped. */
  unhandled: string[];
}

export interface ComposeFailure {
  ok: false;
  /** Why, in a sentence the user can act on. */
  reason: string;
}

export type ComposeResult = ComposedPart | ComposeFailure;

// ── the vocabulary ───────────────────────────────────────────────────────────

type BaseKind = 'box' | 'cylinder' | 'sphere' | 'tube';

/**
 * Words that name a base solid.
 *
 * Longest first so "hex bar" is not read as "bar". A `tube` is a cylinder with a concentric
 * hole rather than a primitive of its own, because that is exactly what it is and modelling
 * it as two features keeps both its diameters editable afterwards.
 */
const BASE_WORDS: { words: string[]; kind: BaseKind }[] = [
  { words: ['rectangular block', 'block', 'box', 'cube', 'billet', 'slab', 'bar', 'plate'], kind: 'box' },
  { words: ['cylinder', 'rod', 'disc', 'disk', 'puck', 'shaft', 'pin', 'peg', 'dowel'], kind: 'cylinder' },
  { words: ['tube', 'pipe', 'sleeve', 'bushing', 'bush', 'spacer', 'collar', 'ring'], kind: 'tube' },
  { words: ['sphere', 'ball'], kind: 'sphere' },
];

type ModifierKind = 'hole' | 'fillet' | 'chamfer' | 'shell' | 'pocket' | 'slot';

/**
 * Words that name an operation, and the feature they become.
 *
 * "Bore" is a hole and "wall" is a shell because that is what a machinist means by them; the
 * point of this table is to accept the trade's own vocabulary rather than the API's.
 */
const MODIFIER_WORDS: { words: string[]; kind: ModifierKind }[] = [
  { words: ['counterbore', 'countersink', 'tapped', 'hole', 'bore', 'drilling', 'drilled'], kind: 'hole' },
  { words: ['fillet', 'round', 'rounded', 'radius', 'radii'], kind: 'fillet' },
  { words: ['chamfer', 'chamfered', 'bevel', 'bevelled', 'beveled'], kind: 'chamfer' },
  { words: ['wall', 'walls', 'hollow', 'hollowed', 'shell', 'shelled'], kind: 'shell' },
  { words: ['pocket', 'recess', 'counterbore face'], kind: 'pocket' },
  { words: ['slot', 'keyway', 'groove'], kind: 'slot' },
];

/** Where one clause ends and the next begins. */
const CLAUSE_SPLIT = /\s+(?:with|and|plus|then|having|including)\s+|\s*[,;]\s*/i;

/** Numbers written as words, for "four 6 mm holes". */
const COUNT_WORDS: Record<string, number> = {
  one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, sixteen: 16,
};

// ── entry point ──────────────────────────────────────────────────────────────

export function compose(text: string): ComposeResult {
  const clauses = splitClauses(text);
  if (clauses.length === 0) return { ok: false, reason: 'There was nothing to read.' };

  const base = readBase(clauses[0]!);
  if (!base) {
    return {
      ok: false,
      reason:
        'That does not start with a shape this can compose from. It builds on a block, a ' +
        'cylinder, a tube or a sphere, and adds holes, pockets, slots, shells, fillets and ' +
        'chamfers to it.',
    };
  }

  const understood = [...base.understood];
  const unhandled: string[] = [];
  const modifiers: Modifier[] = [];

  for (const clause of clauses.slice(1)) {
    const mod = readModifier(clause);
    if (mod) {
      modifiers.push(mod);
      understood.push(mod.describe);
    } else if (clause.trim().length > 0) {
      unhandled.push(clause.trim());
    }
  }

  return { ok: true, doc: assemble(text, base, modifiers), understood, unhandled };
}

/**
 * The modifiers a request asked for, without the base.
 *
 * This is what lets an archetype keep the parts it does well — a cup's handle, a gear's
 * involute teeth — while still receiving the fillet or the shell it was asked for and would
 * otherwise have silently ignored. The caller decides which of these the archetype already
 * covered; see `applyModifiers`.
 */
export function readModifiers(text: string): { modifiers: Modifier[]; unhandled: string[] } {
  const clauses = splitClauses(text);
  const modifiers: Modifier[] = [];
  const unhandled: string[] = [];

  for (const clause of clauses.slice(1)) {
    const mod = readModifier(clause);
    if (mod) modifiers.push(mod);
    else if (clause.trim().length > 0) unhandled.push(clause.trim());
  }

  return { modifiers, unhandled };
}

/**
 * Adds modifiers to a document that already has a body, in modelling order.
 *
 * `across` is the body's smallest horizontal extent, used to place a hole pattern the request
 * gave a count for but no circle to put them on. Without it every hole in "four 6 mm holes"
 * lands on the origin, the four cuts coincide, and the part comes back with one hole — which
 * reads as a parser bug and is worse than asking.
 */
export function applyModifiers(doc: Document, modifiers: Modifier[], across?: number): Document {
  let out = doc;

  for (const mod of [...modifiers].sort((a, b) => ORDER[a.kind] - ORDER[b.kind])) {
    const params = mod.params.pattern === 'boltCircle' && mod.params.boltCircle === 0
      ? {
          ...mod.params,
          boltCircle: defaultBoltCircle(
            across, Number(mod.params.diameter ?? 8), centralBore(out),
          ),
        }
      : mod.params;

    out = addFeature(out, mod.feature, params, mod.name);
  }

  return out;
}

/** The largest hole already sitting on the axis, which a bolt circle has to clear. */
function centralBore(doc: Document): number {
  let widest = 0;

  for (const feature of doc.features) {
    if (feature.suppressed || feature.kind !== 'hole') continue;
    if (String(feature.params.pattern ?? 'single') !== 'single') continue;

    const x = Number(feature.params.x ?? 0);
    const y = Number(feature.params.y ?? 0);
    if (Math.hypot(x, y) > 1e-6) continue;

    widest = Math.max(widest, Number(feature.params.diameter ?? 0));
  }

  return widest;
}

/**
 * Where to put a bolt circle nobody specified.
 *
 * Two constraints, and both were learned the same way — by a part that did not close.
 *
 * Outward, the holes have to clear the edge by more than their own diameter, which is the
 * margin the manufacturability rules ask for; a part composed to breach its own edge-distance
 * check is not worth composing.
 *
 * Inward, they have to clear whatever is already on the axis. "A pillow block with a 25 mm
 * bore and two M8 feet holes" put the M8s on a 26 mm circle, so they cut into the 25 mm bore
 * they were meant to sit beside, and the boolean left the solid open. Two cuts that touch
 * along a wall without overlapping in volume is the one case this kernel cannot resolve, so it
 * is worth not asking it to.
 */
function defaultBoltCircle(across: number | undefined, holeDia: number, bore = 0): number {
  // Far enough out that the hole's own edge clears the bore's by half a diameter.
  const clearsTheBore = bore > 0 ? bore + holeDia * 2 : 0;

  if (!across || across <= 0) return Math.max(holeDia * 6, clearsTheBore);

  const clearsTheEdge = across - holeDia * 3;

  // When the part is too small for both, the edge wins: a hole that breaks the outside is a
  // slot the design did not ask for, and one that meets the bore is a hole in the wrong place.
  // Neither is right, and the linter reports whichever survives.
  return Math.max(holeDia * 2, Math.min(clearsTheEdge, Math.max(clearsTheEdge, clearsTheBore)));
}

export interface Modifier {
  kind: ModifierKind;
  feature: 'hole' | 'fillet' | 'chamfer' | 'shell' | 'pocket' | 'slot';
  params: Record<string, ParamValue>;
  name: string;
  /** What it was read as, for the reply. */
  describe: string;
}

/**
 * Modelling order.
 *
 * Cuts before hollowing before blends, because that is the order in which each operation has
 * something meaningful to act on: a fillet applied before a hole is drilled rounds an edge
 * that is about to be cut away, and shelling after a blend gives a wall that follows the
 * blend rather than the wall that was asked for.
 */
const ORDER: Record<ModifierKind, number> = {
  hole: 1, pocket: 1, slot: 1, shell: 2, chamfer: 3, fillet: 4,
};

// ── reading ──────────────────────────────────────────────────────────────────

/**
 * The request as a base clause followed by one clause per operation.
 *
 * Splitting on every separator is not enough, because a comma is used for both jobs: it
 * separates operations in "a block, with a hole, and a 2 mm chamfer", and it separates
 * *dimensions of one thing* in "a block 30 mm thick, 100 mm long, 50 mm wide". Read the
 * second the first way and the block loses two of its three dimensions to clauses that name
 * no operation, and comes out 60 × 60 × 30 — which is what happened.
 *
 * So a fragment that names no operation is not a clause of its own: it belongs to whatever
 * was last being described. Before any operation is named that is the base; after one, it is
 * that operation, which is what makes "with a pocket, 40 × 30, 4 mm deep" read correctly.
 */
function splitClauses(text: string): string[] {
  const parts = text
    .toLowerCase()
    .split(CLAUSE_SPLIT)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const groups: string[] = [];

  for (const part of parts) {
    // Only a fragment that is *nothing but* a dimension belongs to what came before. A
    // fragment naming something else — "an involute spline" — is a clause of its own, and
    // becomes an unhandled one, which is the whole point: swallowed into the base it would
    // have disappeared without trace.
    if (groups.length > 0 && isDimensionOnly(part)) {
      groups[groups.length - 1] += ` ${part}`;
      continue;
    }
    groups.push(part);
  }

  return groups;
}

/**
 * Words that can appear in a fragment that says nothing but a size.
 *
 * The test is deliberately closed rather than open: an unrecognised word means the fragment
 * is about something, and something is not a dimension.
 */
const DIMENSION_WORDS = new Set([
  'mm', 'cm', 'm', 'in', 'inch', 'inches', 'ft', 'thou', 'mil',
  'millimetre', 'millimeter', 'millimetres', 'millimeters',
  'centimetre', 'centimeter', 'centimetres', 'centimeters',
  'metre', 'meter', 'metres', 'meters', 'foot', 'feet',
  'long', 'length', 'wide', 'width', 'tall', 'high', 'height',
  'thick', 'thickness', 'deep', 'depth', 'across', 'diameter', 'dia',
  'radius', 'od', 'id', 'bore', 'square', 'round', 'overall',
  'a', 'an', 'the', 'of', 'by', 'x', 'and', 'at', 'is',
  // Connectives and corrections, which introduce nothing.
  'no', 'not', 'or', 'but', 'then', 'so', 'it', 'its', 'that', 'sorry', 'actually',
]);

/**
 * True when a fragment introduces nothing of its own — it is a size, or a connective.
 *
 * Not "does it contain a measurement": "200 mm long, no, 300 mm long" corrects itself through
 * a fragment that is only the word "no", and treating that as a clause of its own left the
 * correction stranded in a clause nothing read. What matters is whether the fragment names a
 * *thing*, because a thing is what deserves a clause.
 */
function isDimensionOnly(fragment: string): boolean {
  const words = fragment.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.every((w) => DIMENSION_WORDS.has(w));
}

/**
 * The part of a request that describes the part itself, with every operation clause removed.
 *
 * "A 50 mm cylinder 80 mm long with a 12 mm hole" reduces to "a 50 mm cylinder 80 mm long".
 * The 12 belongs to the hole, and anything reading it as a dimension of the *part* will size
 * the part to 12 mm — which is exactly what the requirement checker did, discarding the 80 it
 * had already read correctly because a later reading wins a tie.
 */
export function baseClause(text: string): string {
  return splitClauses(text)[0] ?? text.toLowerCase();
}

/** Which operation a clause names, or null. Longest match first: "counterbore" beats "bore". */
function modifierIn(clause: string): ModifierKind | null {
  return MODIFIER_WORDS
    .flatMap((m) => m.words.map((w) => ({ w, kind: m.kind })))
    .sort((a, b) => b.w.length - a.w.length)
    .find(({ w }) => wordAt(clause, w) >= 0)?.kind ?? null;
}

interface Base {
  kind: BaseKind;
  params: Record<string, ParamValue>;
  /** For a tube, the bore that has to be cut after the body. */
  bore?: number;
  understood: string[];
}

/** Every word that names a base solid, longest first. */
const BASE_LOOKUP = BASE_WORDS
  .flatMap((b) => b.words.map((w) => ({ w, kind: b.kind })))
  .sort((a, b) => b.w.length - a.w.length);

function readBase(clause: string): Base | null {
  /*
   * The shape has to be what the clause is *about*.
   *
   * Matching any base word anywhere would rebuild the exact defect the catalogue's head-noun
   * gate removes: "a crankshaft for a 4 cylinder engine" contains the word "cylinder", and
   * answering it with one is worse than refusing, because a plain cylinder announced as a
   * success is indistinguishable at a glance from having worked.
   */
  const known = (word: string) => BASE_LOOKUP.some(({ w }) => w === word || `${w}s` === word);
  const head = headNoun(clause, known);
  if (head.length === 0 || !known(head)) return null;

  const kind = BASE_LOOKUP.find(({ w }) => w === head || `${w}s` === head)?.kind;
  if (!kind) return null;

  const measures = findMeasures(clause);
  const understood: string[] = [];

  if (kind === 'box') return readBox(clause, measures, understood);
  if (kind === 'sphere') return readSphere(clause, measures, understood);
  return readRound(clause, measures, understood, kind);
}

function readBox(clause: string, measures: Measure[], understood: string[]): Base {
  // A dimension triple is unambiguous and beats every other reading: "80 x 60 x 40".
  const triple = clause.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/);
  if (triple) {
    const [length, width, height] = [triple[1], triple[2], triple[3]].map(Number) as [number, number, number];
    understood.push(`${length} × ${width} × ${height} mm block`);
    return { kind: 'box', params: { length, width, height }, understood };
  }

  const length = anchored(clause, measures, ['long', 'length']);
  let width = anchored(clause, measures, ['wide', 'width', 'across']);
  let height = anchored(clause, measures, ['tall', 'high', 'height', 'thick', 'thickness', 'deep']);

  // "A 100 mm long bar 20 mm square" states a section, not a width: 20 is both of the other
  // two dimensions. Read as a single width it left the height on its default and the bar came
  // out 100 × 100 × 20.
  const section = anchored(clause, measures, ['square', 'section', 'af']);
  if (section !== null && section !== length) {
    width ??= section;
    height ??= section;
  }

  const stated = [length, width, height].filter((v) => v !== null).length;

  // A cube states one edge and means all three.
  if (stated === 0) {
    const only = measures[0]?.mm;
    if (only !== undefined) {
      understood.push(`${only} mm cube`);
      return { kind: 'box', params: { length: only, width: only, height: only }, understood };
    }
  }

  const L = length ?? 60;
  const W = width ?? L;
  const H = height ?? 20;
  understood.push(`${L} × ${W} × ${H} mm block`);
  return { kind: 'box', params: { length: L, width: W, height: H }, understood };
}

function readSphere(clause: string, measures: Measure[], understood: string[]): Base {
  const radius = anchored(clause, measures, ['radius']);
  const diameter = anchored(clause, measures, ['diameter', 'dia', 'across', 'wide'])
    ?? (radius !== null ? radius * 2 : measures[0]?.mm ?? 40);

  understood.push(`${diameter} mm sphere`);
  return { kind: 'sphere', params: { diameter }, understood };
}

function readRound(
  clause: string, measures: Measure[], understood: string[], kind: BaseKind,
): Base {
  const outer = anchored(clause, measures, ['outside diameter', 'outer diameter', 'od', 'diameter', 'dia'])
    ?? measures[0]?.mm ?? 40;

  const bore = anchored(clause, measures, ['inside diameter', 'inner diameter', 'id', 'bore']);

  const height = anchored(clause, measures, ['long', 'length', 'tall', 'high', 'height', 'deep'])
    // Two bare numbers on a round part read as diameter then length, which is how a turned
    // part is written on a drawing and said out loud.
    ?? measures.filter((m) => m.mm !== outer && m.mm !== bore)[0]?.mm
    ?? outer;

  const label = kind === 'tube' ? 'tube' : 'cylinder';
  understood.push(
    bore !== null
      ? `${outer} mm × ${bore} mm bore ${label}, ${height} mm long`
      : `${outer} mm ${label}, ${height} mm long`,
  );

  return {
    kind,
    params: { diameter: outer, height },
    // A tube with no stated bore is still a tube: half the outside diameter is the wall a
    // stock tube is drawn at, and it stays editable.
    ...(kind === 'tube' ? { bore: bore ?? outer / 2 } : bore !== null ? { bore } : {}),
    understood,
  };
}

function readModifier(clause: string): Modifier | null {
  const kind = modifierIn(clause);
  if (!kind) return null;

  const measures = findMeasures(clause);

  switch (kind) {
    case 'hole': return readHole(clause, measures);
    case 'fillet': return readFillet(clause, measures);
    case 'chamfer': return readChamfer(clause, measures);
    case 'shell': return readShell(clause, measures);
    case 'pocket': return readPocket(clause, measures);
    case 'slot': return readSlot(clause, measures);
  }
}

function readHole(clause: string, measures: Measure[]): Modifier {
  const { count, at: countAt } = readCount(clause);

  // The number that gave the count is not also the size.
  const sizes = countAt >= 0 ? measures.filter((m) => m.index !== countAt) : measures;

  const diameter = anchored(clause, sizes, ['diameter', 'dia', 'bore', 'hole'])
    ?? sizes[0]?.mm ?? 8;

  const boltCircle = anchored(clause, sizes, ['bolt circle', 'pitch circle', 'pcd']);
  const depth = anchored(clause, sizes, ['deep', 'depth']);

  const holeType =
    wordAt(clause, 'counterbore') >= 0 ? 'counterbore'
      : wordAt(clause, 'countersink') >= 0 ? 'countersink'
        : wordAt(clause, 'tapped') >= 0 ? 'tapped'
          : depth !== null || wordAt(clause, 'blind') >= 0 ? 'blind'
            : 'through';

  // A count with no circle to put them on is a bolt circle by intent — that is what "four
  // 6 mm holes" on a round or square part means — so one is derived rather than stacking
  // every hole on the origin, which would cut a single hole and look like a parser bug.
  const pattern = count > 1 ? 'boltCircle' : 'single';

  const params: Record<string, ParamValue> = {
    diameter, holeType, pattern, x: 0, y: 0, cx: 0, cy: 0,
    ...(pattern === 'boltCircle' ? { count, boltCircle: boltCircle ?? 0 } : {}),
    ...(depth !== null ? { depth } : {}),
  };

  const where = pattern === 'boltCircle'
    ? `${count} × ⌀${diameter} mm holes`
    : `a ⌀${diameter} mm ${holeType} hole`;

  return {
    kind: 'hole', feature: 'hole', params,
    name: count > 1 ? 'Holes' : 'Hole',
    describe: depth !== null ? `${where}, ${depth} mm deep` : where,
  };
}

function readFillet(clause: string, measures: Measure[]): Modifier {
  const radius = anchored(clause, measures, ['radius', 'fillet', 'round', 'rounded', 'r'])
    ?? measures[0]?.mm ?? 2;

  return {
    kind: 'fillet', feature: 'fillet',
    params: { radius, minAngle: 30, faceMatch: 'bounding', convexity: 'all', faces: [] },
    name: 'Fillet',
    describe: `R${radius} mm on the edges`,
  };
}

function readChamfer(clause: string, measures: Measure[]): Modifier {
  const distance = anchored(clause, measures, ['chamfer', 'bevel']) ?? measures[0]?.mm ?? 1;

  return {
    kind: 'chamfer', feature: 'chamfer',
    params: { distance, minAngle: 30, faceMatch: 'bounding', faces: [] },
    name: 'Chamfer',
    describe: `${distance} mm chamfer on the edges`,
  };
}

function readShell(clause: string, measures: Measure[]): Modifier {
  const thickness = anchored(clause, measures, ['wall', 'walls', 'thick', 'thickness', 'shell'])
    ?? measures[0]?.mm ?? 2;

  return {
    kind: 'shell', feature: 'shell',
    params: { thickness },
    name: 'Shell',
    describe: `hollowed to a ${thickness} mm wall`,
  };
}

function readPocket(clause: string, measures: Measure[]): Modifier {
  const depth = anchored(clause, measures, ['deep', 'depth']) ?? 5;

  const pair = clause.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/);
  const length = pair ? Number(pair[1]) : anchored(clause, measures, ['long', 'length']) ?? sizeOtherThan(measures, depth) ?? 30;
  const width = pair ? Number(pair[2]) : anchored(clause, measures, ['wide', 'width']) ?? length;

  return {
    kind: 'pocket', feature: 'pocket',
    params: { length, width, depth, cornerRadius: 0, x: 0, y: 0 },
    name: 'Pocket',
    describe: `a ${length} × ${width} mm pocket ${depth} mm deep`,
  };
}

function readSlot(clause: string, measures: Measure[]): Modifier {
  const pair = clause.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/);
  const length = pair ? Number(pair[1]) : anchored(clause, measures, ['long', 'length']) ?? measures[0]?.mm ?? 30;
  const width = pair ? Number(pair[2]) : anchored(clause, measures, ['wide', 'width']) ?? sizeOtherThan(measures, length) ?? 8;

  return {
    kind: 'slot', feature: 'slot',
    params: { length, width, x: 0, y: 0, angle: 0 },
    name: 'Slot',
    describe: `a ${length} × ${width} mm slot`,
  };
}

// ── building ─────────────────────────────────────────────────────────────────

function assemble(text: string, base: Base, modifiers: Modifier[]): Document {
  const name = titleFor(base.kind);
  let doc = emptyDocument(name);

  const primitive = base.kind === 'sphere' ? 'sphere' : base.kind === 'box' ? 'box' : 'cylinder';
  doc = addFeature(doc, primitive, base.params, name);

  // A tube's bore is a hole, not a parameter of the body — so it stays editable, shows in the
  // tree, and is measured by everything downstream exactly like any other hole.
  if (base.bore !== undefined) {
    doc = addFeature(
      doc, 'hole',
      { diameter: base.bore, holeType: 'through', pattern: 'single', x: 0, y: 0 },
      'Bore',
    );
  }

  doc = applyModifiers(doc, modifiers, acrossOf(base));

  // The request itself, so the tree records what was asked for rather than only what was
  // built. Nothing downstream depends on it; a person reading the file later does.
  return { ...doc, properties: { ...(doc.properties ?? {}), Request: text.trim() } };
}

/** The base's smallest horizontal extent — what a hole pattern has to fit inside. */
function acrossOf(base: Base): number {
  if (base.kind === 'box') {
    return Math.min(Number(base.params.length ?? 0), Number(base.params.width ?? 0));
  }
  return Number(base.params.diameter ?? 0);
}

function titleFor(kind: BaseKind): string {
  return kind === 'box' ? 'Block' : kind === 'tube' ? 'Tube' : kind === 'sphere' ? 'Sphere' : 'Cylinder';
}

// ── measurement binding ──────────────────────────────────────────────────────

/** Where a whole word appears, or −1. Substrings never match: "bore" is not in "borehole". */
function wordAt(text: string, word: string): number {
  const re = new RegExp(`(?:^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s)?(?![a-z])`, 'i');
  const m = re.exec(text);
  return m ? m.index : -1;
}

/**
 * The measurement nearest to any of these words, in characters.
 *
 * Nearest rather than first, because a dimension is written on either side of its name —
 * "80 mm long" and "length of 80 mm" — and counting words gets a different answer for each.
 */
function anchored(clause: string, measures: Measure[], words: string[]): number | null {
  let best: { mm: number; distance: number } | null = null;

  for (const word of words) {
    const at = wordAt(clause, word);
    if (at < 0) continue;

    for (const m of measures) {
      const distance = m.index < at ? at - (m.index + m.raw.length) : m.index - (at + word.length);
      if (distance > 24) continue;
      if (!best || distance < best.distance) best = { mm: m.mm, distance };
    }
  }

  return best ? best.mm : null;
}

/** The first measurement that is not the one already claimed. */
function sizeOtherThan(measures: Measure[], claimed: number | null): number | null {
  const other = measures.find((m) => m.mm !== claimed);
  return other ? other.mm : null;
}

/**
 * "four 6 mm holes", "4 holes", "6 holes of 8 mm".
 *
 * `at` is where a digit count was read from, so the caller can keep that number out of the
 * running for the diameter. Without it, "6 holes of 8 mm" gave six ⌀6 holes: the 6 sits
 * closer to the word "holes" than the 8 does, so proximity picked the count as the size.
 */
function readCount(clause: string): { count: number; at: number } {
  const digits = /(\d+)\s*(?:off\s*|x\s*)?(?:hole|bore)/i.exec(clause);
  if (digits) {
    return { count: Math.max(1, Math.min(64, Number(digits[1]))), at: digits.index };
  }

  for (const [word, value] of Object.entries(COUNT_WORDS)) {
    if (word === 'a' || word === 'an') continue;
    if (new RegExp(`\\b${word}\\b[^.]{0,20}\\b(?:hole|bore)`, 'i').test(clause)) {
      return { count: value, at: -1 };
    }
  }

  return { count: 1, at: -1 };
}
