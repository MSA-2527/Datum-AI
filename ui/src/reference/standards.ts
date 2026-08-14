/**
 * A reference corpus of real engineering dimensions.
 *
 * This exists because of the single biggest reason generated assemblies look wrong: a language
 * model asked for a battery thickness gives a *plausible* number every time and a *different*
 * one each time. It has no way to tell you where 3.9 mm came from, and no way to be held to it.
 *
 * Everything below is a published figure with the standard it comes from named on the entry.
 * That changes what the number is: not a guess the model produced, but a fact the model was
 * handed, which a reviewer can look up and disagree with. When a plan says an M6 socket head
 * cap screw has a 10 mm head, that is ISO 4762 and it is either right or it is a typo — it is
 * never an opinion.
 *
 * Three things use it:
 *
 *   - **Retrieval.** The entries matching a request are injected into the prompt, so the model
 *     is reading dimensions rather than recalling them.
 *   - **Audit.** A returned plan is checked against the same entries, so a component that
 *     disagrees with the standard it claims to follow is reported rather than built quietly.
 *   - **The offline path.** None of this needs a network or a model. The deterministic core
 *     can size a fastener correctly with no provider configured at all.
 *
 * Scope is deliberate. These are the dimensions that recur across mechanical design and are
 * *stable* — a standard from 1980 still describes the screw in your hand. Anything that
 * changes yearly, such as a specific phone's envelope, is left to search grounding, where it
 * arrives with a citation and a date attached.
 */

export type Category =
  | 'fastener'
  | 'bearing'
  | 'battery'
  | 'material'
  | 'connector'
  | 'motor'
  | 'electronics'
  | 'cooling'
  | 'paper'
  | 'tolerance';

export interface Fact {
  /** Stable id, so an audit can point at the exact entry. */
  id: string;
  category: Category;
  /** What this describes, as a person would say it. */
  subject: string;
  /** Lower-case terms that should retrieve this entry. */
  keywords: string[];
  /** Dimensions. Millimetres unless the key says otherwise. */
  dims: Record<string, number>;
  /** The published standard or specification this comes from. */
  source: string;
  note?: string;
  /**
   * How this entry's dimensions map onto a modelled part's own parameters — and, by its
   * presence, whether such a comparison is meaningful at all.
   *
   * Most entries do not have one, and that is the point. A USB-C entry records the *plug*'s
   * mating dimensions; a phone's USB-C port is the receptacle body around it, and it is
   * larger in every direction. Comparing the two flagged three "errors" on a hand-written
   * recipe whose numbers were right — which is exactly how an audit teaches people to ignore
   * it.
   *
   * So the audit compares nothing unless an entry states, explicitly and per axis, which of
   * its figures is that part's overall size. No inference, no fallthrough between axes.
   */
  envelope?: { diameter?: string; length?: string; width?: string; height?: string };
}

// ── metric fasteners ─────────────────────────────────────────────────────────

/**
 * Metric coarse threads, per size.
 *
 * `pitch` is ISO 261. `clearance` is the medium-fit hole from ISO 273, and `tapping` is the
 * drill for a nominal 100% thread — the two numbers people most often get wrong, because a
 * hole drilled at nominal diameter will not take the screw and a hole drilled at pitch
 * diameter cannot be tapped.
 */
const THREADS: [size: string, d: number, pitch: number, clearance: number, tapping: number][] = [
  ['M1.6', 1.6, 0.35, 1.8, 1.25],
  ['M2', 2.0, 0.40, 2.4, 1.6],
  ['M2.5', 2.5, 0.45, 2.9, 2.05],
  ['M3', 3.0, 0.50, 3.4, 2.5],
  ['M4', 4.0, 0.70, 4.5, 3.3],
  ['M5', 5.0, 0.80, 5.5, 4.2],
  ['M6', 6.0, 1.00, 6.6, 5.0],
  ['M8', 8.0, 1.25, 9.0, 6.8],
  ['M10', 10.0, 1.50, 11.0, 8.5],
  ['M12', 12.0, 1.75, 14.0, 10.2],
  ['M16', 16.0, 2.00, 18.0, 14.0],
  ['M20', 20.0, 2.50, 22.0, 17.5],
  ['M24', 24.0, 3.00, 26.0, 21.0],
];

/**
 * ISO 4762 socket head cap screws: head diameter, head height, hex socket across flats.
 *
 * Head height equals the nominal thread diameter for this family, which is worth knowing —
 * a counterbore for an M6 cap screw is 10 mm across and at least 6 mm deep.
 */
const SOCKET_HEADS: Record<string, [dk: number, k: number, hex: number]> = {
  'M1.6': [3.0, 1.6, 1.5],
  M2: [3.8, 2.0, 1.5],
  'M2.5': [4.5, 2.5, 2.0],
  M3: [5.5, 3.0, 2.5],
  M4: [7.0, 4.0, 3.0],
  M5: [8.5, 5.0, 4.0],
  M6: [10.0, 6.0, 5.0],
  M8: [13.0, 8.0, 6.0],
  M10: [16.0, 10.0, 8.0],
  M12: [18.0, 12.0, 10.0],
  M16: [24.0, 16.0, 14.0],
  M20: [30.0, 20.0, 17.0],
  M24: [36.0, 24.0, 19.0],
};

/** ISO 4032 hex nuts and ISO 4014 hex bolt heads: across flats, nut height, bolt head height. */
const HEX: Record<string, [acrossFlats: number, nutHeight: number, boltHead: number]> = {
  M3: [5.5, 2.4, 2.0],
  M4: [7.0, 3.2, 2.8],
  M5: [8.0, 4.7, 3.5],
  M6: [10.0, 5.2, 4.0],
  M8: [13.0, 6.8, 5.3],
  M10: [16.0, 8.4, 6.4],
  M12: [18.0, 10.8, 7.5],
  M16: [24.0, 14.8, 10.0],
  M20: [30.0, 18.0, 12.5],
  M24: [36.0, 21.5, 15.0],
};

function fastenerFacts(): Fact[] {
  const out: Fact[] = [];

  for (const [size, d, pitch, clearance, tapping] of THREADS) {
    const lower = size.toLowerCase();

    out.push({
      id: `thread-${lower}`,
      category: 'fastener',
      subject: `${size} coarse thread`,
      keywords: [lower, 'screw', 'bolt', 'thread', 'fastener', 'hole', 'tap'],
      dims: { nominalDiameter: d, pitch, clearanceHole: clearance, tappingDrill: tapping },
      source: 'ISO 261 (pitch), ISO 273 medium fit (clearance hole)',
      note: 'A clearance hole is larger than the screw; a tapping drill is smaller.',
    });

    const head = SOCKET_HEADS[size];
    if (head) {
      out.push({
        id: `shcs-${lower}`,
        category: 'fastener',
        subject: `${size} socket head cap screw`,
        keywords: [lower, 'socket head', 'cap screw', 'shcs', 'allen', 'screw', 'fastener'],
        dims: {
          threadDiameter: d,
          headDiameter: head[0],
          headHeight: head[1],
          hexSocket: head[2],
          counterboreDiameter: head[0] + 0.5,
        },
        source: 'ISO 4762',
      });
    }

    const hex = HEX[size];
    if (hex) {
      out.push({
        id: `hexnut-${lower}`,
        category: 'fastener',
        subject: `${size} hex nut`,
        keywords: [lower, 'nut', 'hex nut', 'fastener'],
        dims: { threadDiameter: d, acrossFlats: hex[0], height: hex[1], acrossCorners: hex[0] * 1.155 },
        source: 'ISO 4032',
        note: 'Across corners is across flats divided by cos 30°, which sets the spanner clearance.',
      });

      out.push({
        id: `hexbolt-${lower}`,
        category: 'fastener',
        subject: `${size} hex head bolt`,
        keywords: [lower, 'bolt', 'hex bolt', 'hex head', 'fastener'],
        dims: { threadDiameter: d, acrossFlats: hex[0], headHeight: hex[2] },
        source: 'ISO 4014 / ISO 4017',
      });
    }
  }

  return out;
}

// ── bearings ─────────────────────────────────────────────────────────────────

/** Deep groove ball bearings: bore, outside diameter, width. */
const BEARINGS: [designation: string, bore: number, od: number, width: number][] = [
  ['608', 8, 22, 7],
  ['625', 5, 16, 5],
  ['688', 8, 16, 4],
  ['6000', 10, 26, 8],
  ['6001', 12, 28, 8],
  ['6002', 15, 32, 9],
  ['6003', 17, 35, 10],
  ['6004', 20, 42, 12],
  ['6005', 25, 47, 12],
  ['6200', 10, 30, 9],
  ['6201', 12, 32, 10],
  ['6202', 15, 35, 11],
  ['6203', 17, 40, 12],
  ['6204', 20, 47, 14],
  ['6205', 25, 52, 15],
  ['6206', 30, 62, 16],
  ['6300', 10, 35, 11],
  ['6301', 12, 37, 12],
  ['6302', 15, 42, 13],
  ['6303', 17, 47, 14],
  ['6304', 20, 52, 15],
  ['6305', 25, 62, 17],
];

function bearingFacts(): Fact[] {
  return BEARINGS.map(([designation, bore, od, width]) => ({
    envelope: { diameter: 'outsideDiameter', height: 'width' },
    id: `bearing-${designation}`,
    category: 'bearing' as const,
    subject: `${designation} deep groove ball bearing`,
    keywords: [designation, 'bearing', 'ball bearing', 'deep groove', 'shaft', 'pulley', 'wheel'],
    dims: { bore, outsideDiameter: od, width },
    source: 'ISO 15 dimension series',
    note: designation === '608'
      ? 'The skateboard and fidget-spinner bearing, and the one most 3D printers use.'
      : undefined,
  }));
}

// ── cells and batteries ──────────────────────────────────────────────────────

const BATTERIES: Fact[] = [
  {
    id: 'cell-aaa', category: 'battery', subject: 'AAA cell',
    keywords: ['aaa', 'lr03', 'r03', 'battery', 'cell', 'torch', 'remote'],
    dims: { diameter: 10.5, height: 44.5, nominalVolts: 1.5 },
    source: 'IEC 60086 size R03',
    envelope: { diameter: 'diameter', height: 'height' },
  },
  {
    id: 'cell-aa', category: 'battery', subject: 'AA cell',
    keywords: ['aa', 'lr6', 'r6', 'battery', 'cell', 'torch', 'remote'],
    dims: { diameter: 14.5, height: 50.5, nominalVolts: 1.5 },
    source: 'IEC 60086 size R6',
    envelope: { diameter: 'diameter', height: 'height' },
  },
  {
    id: 'cell-c', category: 'battery', subject: 'C cell',
    keywords: ['c cell', 'lr14', 'battery'],
    dims: { diameter: 26.2, height: 50.0, nominalVolts: 1.5 },
    source: 'IEC 60086 size R14',
    envelope: { diameter: 'diameter', height: 'height' },
  },
  {
    id: 'cell-d', category: 'battery', subject: 'D cell',
    keywords: ['d cell', 'lr20', 'battery'],
    dims: { diameter: 34.2, height: 61.5, nominalVolts: 1.5 },
    source: 'IEC 60086 size R20',
    envelope: { diameter: 'diameter', height: 'height' },
  },
  {
    id: 'cell-9v', category: 'battery', subject: '9 V battery (PP3)',
    keywords: ['9v', 'pp3', '6lr61', 'battery', 'smoke alarm'],
    dims: { length: 48.5, width: 26.5, height: 17.5, nominalVolts: 9 },
    source: 'IEC 60086 size 6LR61',
    envelope: { length: 'length', width: 'width', height: 'height' },
  },
  {
    id: 'cell-cr2032', category: 'battery', subject: 'CR2032 coin cell',
    keywords: ['cr2032', 'coin cell', 'button cell', 'battery', 'watch', 'motherboard'],
    dims: { diameter: 20.0, height: 3.2, nominalVolts: 3.0 },
    source: 'IEC 60086 (the name encodes it: 20 mm across, 3.2 mm thick)',
    envelope: { diameter: 'diameter', height: 'height' },
  },
  {
    id: 'cell-cr2450', category: 'battery', subject: 'CR2450 coin cell',
    keywords: ['cr2450', 'coin cell', 'button cell', 'battery'],
    dims: { diameter: 24.5, height: 5.0, nominalVolts: 3.0 },
    source: 'IEC 60086',
    envelope: { diameter: 'diameter', height: 'height' },
  },
  {
    id: 'cell-18650', category: 'battery', subject: '18650 lithium-ion cell',
    keywords: ['18650', 'lithium', 'li-ion', 'battery', 'cell', 'pack', 'power tool', 'laptop'],
    dims: { diameter: 18.4, height: 65.0, nominalVolts: 3.6 },
    source: 'IEC 61960 (18 mm across, 65 mm long; protected cells run longer)',
    envelope: { diameter: 'diameter', height: 'height' },
  },
  {
    id: 'cell-21700', category: 'battery', subject: '21700 lithium-ion cell',
    keywords: ['21700', 'lithium', 'li-ion', 'battery', 'cell', 'pack', 'ev'],
    dims: { diameter: 21.0, height: 70.0, nominalVolts: 3.6 },
    source: 'IEC 61960',
    envelope: { diameter: 'diameter', height: 'height' },
  },
];

// ── materials ────────────────────────────────────────────────────────────────

/**
 * Density, yield strength and stiffness.
 *
 * Density is what turns a volume into a mass, which is the number an engineer checks first and
 * the one a wrong material silently ruins — modelling an aluminium bracket at steel's density
 * overstates it by a factor of nearly three.
 */
const MATERIALS: [name: string, keywords: string[], density: number, yieldMPa: number, modulusGPa: number][] = [
  ['Aluminium 6061-T6', ['aluminium', 'aluminum', '6061', 'al'], 2.70, 276, 68.9],
  ['Aluminium 7075-T6', ['aluminium', 'aluminum', '7075'], 2.81, 503, 71.7],
  ['Steel 1018 (cold drawn)', ['steel', 'mild steel', '1018', 'carbon steel'], 7.87, 370, 200],
  ['Stainless steel 304', ['stainless', '304', 'inox'], 8.00, 215, 193],
  ['Stainless steel 316', ['stainless', '316', 'marine'], 8.00, 205, 193],
  ['Titanium Ti-6Al-4V', ['titanium', 'ti-6al-4v', 'grade 5'], 4.43, 880, 113.8],
  ['Brass C360', ['brass'], 8.50, 310, 97],
  ['Copper C110', ['copper'], 8.96, 70, 117],
  ['ABS', ['abs', 'plastic', 'injection'], 1.05, 40, 2.3],
  ['PLA', ['pla', '3d print', 'printed'], 1.24, 50, 3.5],
  ['PETG', ['petg', '3d print'], 1.27, 50, 2.1],
  ['Nylon 6', ['nylon', 'polyamide', 'pa6'], 1.14, 45, 2.5],
  ['Polycarbonate', ['polycarbonate', 'pc', 'lexan'], 1.20, 62, 2.4],
  ['Polypropylene', ['polypropylene', 'pp'], 0.90, 32, 1.5],
  ['Acetal (POM)', ['acetal', 'pom', 'delrin'], 1.41, 70, 3.1],
  ['PEEK', ['peek'], 1.32, 97, 3.6],
  ['Soda-lime glass', ['glass', 'cover glass', 'window'], 2.50, 0, 70],
  // Longer keywords than plain "glass", so a glass-reinforced composite resolves to itself
  // rather than to window glass — which was overstating a radome by a quarter.
  //
  // Deliberately not keyed on "composite" alone. That word appears in half the effective
  // densities in the recipes — a wheel assembly, a saddle, an airframe — and claiming they
  // are all 1.9 g/cm³ turned the audit into noise.
  ['Glass-reinforced plastic', ['glass-reinforced', 'grp', 'fibreglass', 'fiberglass'], 1.90, 100, 25],
  ['FR-4 laminate', ['fr4', 'fr-4', 'pcb', 'circuit board'], 1.85, 0, 24],
];

function materialFacts(): Fact[] {
  return MATERIALS.map(([name, keywords, density, yieldMPa, modulusGPa]) => ({
    id: `material-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    category: 'material' as const,
    subject: name,
    keywords: [...keywords, 'material', 'density', 'mass', 'weight'],
    // Glass and laminate have no meaningful yield point, so the key is omitted rather than
    // filled with a zero a reader would take as a measurement.
    dims: (yieldMPa > 0
      ? { densityGPerCm3: density, yieldMPa, modulusGPa }
      : { densityGPerCm3: density, modulusGPa }) as Record<string, number>,
    source: 'Published mill and datasheet values, room temperature',
  }));
}

// ── electronics, connectors, cooling ─────────────────────────────────────────

const HARDWARE: Fact[] = [
  {
    id: 'pcb-thickness', category: 'electronics', subject: 'Printed circuit board thickness',
    keywords: ['pcb', 'circuit board', 'board', 'fr4', 'mainboard', 'motherboard'],
    dims: { standard: 1.6, thin: 0.8, thinnest: 0.4, thick: 2.4, copper1oz: 0.035 },
    source: 'IPC-2221 preferred thicknesses',
    note: '1.6 mm is the default for almost everything; phones and wearables use 0.8 mm or less.',
  },
  {
    id: 'usb-c', category: 'connector', subject: 'USB Type-C plug',
    keywords: ['usb-c', 'usb c', 'type-c', 'usb', 'connector', 'port', 'charging'],
    dims: { width: 8.34, height: 2.56, receptacleDepth: 7.35 },
    source: 'USB Type-C Cable and Connector Specification',
  },
  {
    id: 'usb-a', category: 'connector', subject: 'USB Type-A receptacle',
    keywords: ['usb-a', 'usb a', 'usb', 'connector', 'port'],
    dims: { width: 14.0, height: 6.5, depth: 14.0 },
    source: 'USB 2.0 specification',
  },
  {
    id: 'jack-35', category: 'connector', subject: '3.5 mm audio jack',
    keywords: ['3.5mm', 'audio jack', 'headphone', 'aux', 'connector', 'port'],
    dims: { plugDiameter: 3.5, plugLength: 15.0, socketBodyDiameter: 6.0 },
    source: 'EIA / IEC 60603-11',
  },
  {
    id: 'rj45', category: 'connector', subject: 'RJ45 Ethernet jack',
    keywords: ['rj45', 'ethernet', 'network', 'lan', 'connector', 'port'],
    dims: { width: 14.9, height: 13.4, depth: 21.0 },
    source: 'ANSI/TIA-1096-A',
  },
  {
    id: 'hdmi-a', category: 'connector', subject: 'HDMI Type A connector',
    keywords: ['hdmi', 'display', 'video', 'connector', 'port'],
    dims: { width: 14.0, height: 4.55 },
    source: 'HDMI specification',
  },
  {
    id: 'fan-80', category: 'cooling', subject: '80 mm axial fan',
    keywords: ['fan', 'cooling', '80mm', 'axial', 'airflow'],
    dims: { size: 80, thickness: 25, mountingPitch: 71.5, screwSize: 4.0 },
    source: 'De-facto industry frame size',
    envelope: { length: 'size', width: 'size', height: 'thickness' },
  },
  {
    id: 'fan-120', category: 'cooling', subject: '120 mm axial fan',
    keywords: ['fan', 'cooling', '120mm', 'axial', 'case fan', 'radiator'],
    dims: { size: 120, thickness: 25, mountingPitch: 105, screwSize: 4.0 },
    source: 'De-facto industry frame size',
    envelope: { length: 'size', width: 'size', height: 'thickness' },
  },
  {
    id: 'fan-40', category: 'cooling', subject: '40 mm axial fan',
    keywords: ['fan', 'cooling', '40mm', 'axial', 'small fan'],
    dims: { size: 40, thickness: 10, mountingPitch: 32, screwSize: 3.0 },
    source: 'De-facto industry frame size',
    envelope: { length: 'size', width: 'size', height: 'thickness' },
  },
  {
    id: 'nema17', category: 'motor', subject: 'NEMA 17 stepper motor',
    keywords: ['nema 17', 'nema17', 'stepper', 'motor', '3d printer', 'cnc'],
    dims: { frame: 42.3, mountingPitch: 31.0, shaftDiameter: 5.0, boss: 22.0, typicalLength: 48.0 },
    source: 'NEMA ICS 16 frame size',
  },
  {
    id: 'nema23', category: 'motor', subject: 'NEMA 23 stepper motor',
    keywords: ['nema 23', 'nema23', 'stepper', 'motor', 'cnc', 'router'],
    dims: { frame: 56.4, mountingPitch: 47.14, shaftDiameter: 6.35, boss: 38.1, typicalLength: 76.0 },
    source: 'NEMA ICS 16 frame size',
  },
];

// ── universal size anchors ───────────────────────────────────────────────────

/**
 * Objects whose size is fixed by international standard.
 *
 * These are the most valuable entries in the file despite looking trivial. A model that has
 * been told a credit card is exactly 85.60 × 53.98 mm has a hard reference for "pocket sized",
 * and everything it scales against that anchor comes out closer to right.
 */
const ANCHORS: Fact[] = [
  {
    id: 'card-id1', category: 'paper', subject: 'Credit card (ID-1)',
    keywords: ['credit card', 'card', 'id-1', 'wallet', 'pocket', 'bank card'],
    dims: { length: 85.60, width: 53.98, thickness: 0.76, cornerRadius: 3.18 },
    source: 'ISO/IEC 7810 ID-1',
    envelope: { length: 'length', width: 'width', height: 'thickness' },
  },
  {
    id: 'paper-a4', category: 'paper', subject: 'A4 sheet',
    keywords: ['a4', 'paper', 'sheet', 'page', 'letter'],
    dims: { length: 297, width: 210 },
    source: 'ISO 216',
  },
  {
    id: 'paper-a3', category: 'paper', subject: 'A3 sheet',
    keywords: ['a3', 'paper', 'sheet', 'drawing'],
    dims: { length: 420, width: 297 },
    source: 'ISO 216',
  },
  {
    id: 'rack-19', category: 'electronics', subject: '19-inch rack unit',
    keywords: ['rack', '19 inch', 'rack unit', '1u', 'server', 'enclosure'],
    dims: { panelWidth: 482.6, unitHeight: 44.45, mountingPitch: 465.1 },
    source: 'EIA-310',
  },
  {
    id: 'tolerance-2768m', category: 'tolerance', subject: 'General tolerances, medium class',
    keywords: ['tolerance', 'general tolerance', 'iso 2768', 'accuracy', 'fit'],
    dims: { upTo6: 0.1, upTo30: 0.2, upTo120: 0.3, upTo400: 0.5, upTo1000: 0.8 },
    source: 'ISO 2768-m',
    note: 'Applies to dimensions with no tolerance called out on the drawing.',
  },
];

// ── the corpus ───────────────────────────────────────────────────────────────

export const FACTS: Fact[] = [
  ...fastenerFacts(),
  ...bearingFacts(),
  ...BATTERIES,
  ...materialFacts(),
  ...HARDWARE,
  ...ANCHORS,
];

/** Every fact, indexed by id. */
export const FACT_BY_ID: Map<string, Fact> = new Map(FACTS.map((f) => [f.id, f]));

/** The standards this corpus draws on, for the UI to state plainly. */
export function sources(): string[] {
  return [...new Set(FACTS.map((f) => f.source.split(' (')[0]))].sort();
}

/**
 * Density in g/cm³ for a named material, or undefined when there is no single right answer.
 *
 * Undefined is returned in two cases, and the second one matters more than it looks.
 *
 * The obvious case is a material the corpus does not hold. The other is a material
 * description naming *several* — "laminated steel and copper" is a motor rotor, and its real
 * density is neither steel's nor copper's but a stack average the author worked out. Matching
 * the longest keyword there picks copper and "corrects" a considered figure into a wrong one,
 * which is worse than not checking at all. So a composite is left alone.
 */
export function densityOf(material: string): number | undefined {
  const lower = material.toLowerCase();

  // A conjunction is the signal, not the number of entries matched. Counting matches fails
  // both ways: "aluminium 6061-T6" hits two aluminium grades and is not a composite, while
  // "stainless steel 316" hits three entries and is one material. How people write a mixture
  // is the reliable tell.
  if (/\s(and|with|over|on)\s|[/+]/.test(lower)) return undefined;

  let best: Fact | undefined;
  let bestScore = 0;

  for (const f of FACTS) {
    if (f.category !== 'material') continue;

    for (const k of f.keywords) {
      // Longest matching keyword wins, so "stainless steel 316" resolves to its own entry
      // rather than to plain steel.
      if (k.length > bestScore && lower.includes(k)) { best = f; bestScore = k.length; }
    }
  }

  return best?.dims.densityGPerCm3;
}
