/**
 * What a part looks like.
 *
 * An assembly rendered in one grey is a silhouette. A car came back as thirty components and
 * read as a single lump, because nothing on screen distinguished the glass from the tyres
 * from the body — and an engineer checking a model checks it by *seeing* it, so a model that
 * cannot be seen cannot be checked.
 *
 * Colour here is derived from **material**, not decoration. That choice does two things at
 * once: an assembly is legible without anyone assigning colours by hand, and the colour
 * carries information — a part that looks like brass is specified as brass, and one that
 * looks wrong is wrong. Every CAD package does this, and it is why their assemblies are
 * readable at a glance and this one was not.
 *
 * An explicit override is still allowed, because sometimes two steel parts need telling
 * apart and no material distinction exists to do it.
 */

export interface Appearance {
  /** sRGB, 0–1, as the renderer wants it. */
  rgb: [number, number, number];
  /** What matched, for the UI to show. */
  label: string;
}

/**
 * Materials and the colour each is recognised by.
 *
 * Matched on substrings of the document's material name, longest first, so "304 stainless"
 * finds stainless before it finds steel. The colours are the ones these materials actually
 * are — anodised aluminium is not the same grey as cast iron — because the point is
 * recognition rather than variety.
 */
const MATERIALS: { match: string[]; rgb: [number, number, number]; label: string }[] = [
  { match: ['stainless', '304', '316'], rgb: [0.72, 0.74, 0.76], label: 'Stainless' },
  { match: ['titanium', 'ti-6al'], rgb: [0.60, 0.60, 0.63], label: 'Titanium' },
  { match: ['aluminium', 'aluminum', '6061', '7075', '5052'], rgb: [0.79, 0.81, 0.84], label: 'Aluminium' },
  { match: ['brass', 'c360'], rgb: [0.83, 0.69, 0.31], label: 'Brass' },
  { match: ['bronze'], rgb: [0.72, 0.52, 0.29], label: 'Bronze' },
  { match: ['copper'], rgb: [0.80, 0.47, 0.29], label: 'Copper' },
  { match: ['cast iron', 'iron'], rgb: [0.42, 0.42, 0.45], label: 'Cast iron' },
  { match: ['steel', '1018', '4140', 'mild'], rgb: [0.58, 0.60, 0.64], label: 'Steel' },
  { match: ['glass', 'acrylic', 'perspex', 'polycarb'], rgb: [0.62, 0.78, 0.85], label: 'Glass' },
  { match: ['rubber', 'epdm', 'nitrile', 'tyre', 'tire'], rgb: [0.18, 0.18, 0.20], label: 'Rubber' },
  { match: ['abs', 'nylon', 'pla', 'petg', 'polypropylene', 'polyethylene', 'plastic'], rgb: [0.85, 0.85, 0.87], label: 'Plastic' },
  { match: ['delrin', 'acetal', 'ptfe', 'teflon'], rgb: [0.93, 0.93, 0.90], label: 'Acetal' },
  { match: ['oak', 'pine', 'wood', 'plywood', 'birch'], rgb: [0.76, 0.58, 0.35], label: 'Wood' },
  { match: ['stoneware', 'ceramic', 'porcelain'], rgb: [0.88, 0.85, 0.79], label: 'Ceramic' },
  { match: ['carbon', 'cfrp'], rgb: [0.20, 0.21, 0.23], label: 'Carbon fibre' },
  { match: ['battery', 'lithium'], rgb: [0.35, 0.55, 0.42], label: 'Cell' },
  { match: ['pcb', 'board', 'fr4'], rgb: [0.20, 0.45, 0.32], label: 'Board' },
];

/** The neutral a part takes when its material says nothing. */
const DEFAULT: [number, number, number] = [0.74, 0.76, 0.80];

export function appearanceFor(material: string): Appearance {
  const name = (material ?? '').toLowerCase();

  // Longest match wins, so "cast iron" is not read as "iron" and "304 stainless" is not
  // read as "steel".
  let best: { rgb: [number, number, number]; label: string; length: number } | null = null;
  for (const entry of MATERIALS) {
    for (const token of entry.match) {
      if (!name.includes(token)) continue;
      if (!best || token.length > best.length) {
        best = { rgb: entry.rgb, label: entry.label, length: token.length };
      }
    }
  }

  return best ? { rgb: best.rgb, label: best.label } : { rgb: DEFAULT, label: 'Unspecified' };
}

/**
 * A colour for a part that has no material to distinguish it.
 *
 * Two steel brackets in an assembly are the same colour and should be, but a model made
 * entirely of unspecified parts is back to being one grey lump. Where nothing else separates
 * them, the feature's own position in the tree does — spread around the hue circle by the
 * golden angle, which keeps successive components far apart in hue however many there are.
 *
 * Saturation is kept low — these are engineering parts, not a chart — but not so low that
 * neighbouring hues wash into the same grey under shading, which was the first attempt and
 * left an assembly looking exactly as uniform as before. Lightness alternates as well, so
 * two adjacent bodies differ in value and not only in hue: a shaded face reads its value long
 * before its hue, and on a curved surface the hue difference alone disappears entirely.
 */
export function fallbackColour(index: number): [number, number, number] {
  const hue = (index * 137.508) % 360;
  const lightness = index % 2 === 0 ? 0.68 : 0.56;
  return hslToRgb(hue / 360, 0.34, lightness);
}

/**
 * The materials the appearance table knows, for a picker.
 *
 * The first alias of each is the one offered, because it is the word an engineer would write
 * — "stainless", not "316". Everything else in the table still matches on typed input, so a
 * document that says "316L" is coloured the same as one that says "stainless".
 */
export function materialChoices(): { value: string; label: string }[] {
  return MATERIALS.map((m) => ({ value: m.match[0]!, label: m.label }));
}

/** `#rrggbb` as the UI stores it. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function toHex(rgb: [number, number, number]): string {
  const part = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255)
    .toString(16).padStart(2, '0');
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}
