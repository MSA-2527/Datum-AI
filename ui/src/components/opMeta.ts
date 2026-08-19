/**
 * Operation presentation: glyph, human sentence, risk badges.
 *
 * The visual language is load-bearing per docs/04-ux-spec.md §1.6 — teal families are
 * deterministic (no model involved), blue is AI-planned geometry, green is read-only,
 * amber is the generated-code escape hatch. A user must always be able to tell which
 * kind of operation they are about to run.
 */

export type OpFamily =
  | 'sketch'
  | 'feature'
  | 'sheetmetal'
  | 'weldment'
  | 'surface'
  | 'param'
  | 'config'
  | 'asm'
  | 'doc'
  | 'drw'
  | 'pdm'
  | 'query'
  | 'meta'
  | 'script';

export function familyOf(op: string): OpFamily {
  const head = op.split('.')[0] ?? 'meta';
  return head as OpFamily;
}

const GLYPHS: Record<string, string> = {
  'feature.fillet': '◟',
  'feature.chamfer': '◺',
  'feature.extrude': '⬢',
  'feature.extrude_cut': '⬡',
  'feature.revolve': '◍',
  'feature.loft': '⧨',
  'feature.sweep': '➰',
  'feature.shell': '◧',
  'feature.hole_wizard': '⬡',
  'feature.simple_hole': '○',
  'feature.pattern_linear': '⬚',
  'feature.pattern_circular': '❋',
  'feature.mirror': '◫',
  'feature.reference_plane': '▭',
  'sketch.create': '✎',
  'sketch.circle': '○',
  'sketch.rectangle': '▭',
  'sketch.line': '╱',
  'sketch.dimension': '↔',
  'sketch.add_relation': '⊥',
  'sketch.fully_define': '⊞',
  'param.set_global': 'Σ',
  'param.set_dimension': '↔',
  'param.goal_seek': '◎',
  'config.create': '▤',
  'asm.insert_component': '⧉',
  'asm.mate': '⚭',
  'asm.fasten': '⊕',
  'doc.export': '⤓',
  'doc.set_property': '⌗',
  'doc.set_material': '◫',
  'doc.rebuild': '⟳',
  'drw.create_from_model': '▤',
  'drw.auto_balloon': '◉',
  'drw.add_bom': '▦',
  'pdm.check_out': '🔓',
  'script.macro': '>_',
};

const FAMILY_GLYPHS: Record<OpFamily, string> = {
  sketch: '✎',
  feature: '⬢',
  sheetmetal: '⌐',
  weldment: '⊨',
  surface: '◠',
  param: 'Σ',
  config: '▤',
  asm: '⧉',
  doc: '⌗',
  drw: '▤',
  pdm: '🔒',
  query: '⌕',
  meta: '⋯',
  script: '>_',
};

export function glyphOf(op: string): string {
  return GLYPHS[op] ?? FAMILY_GLYPHS[familyOf(op)] ?? '·';
}

/** Human-readable operation name, e.g. feature.hole_wizard → "Hole Wizard". */
export function titleOf(op: string): string {
  const tail = op.split('.').slice(1).join(' ');
  const special: Record<string, string> = {
    hole_wizard: 'Hole Wizard',
    pattern_linear: 'Linear Pattern',
    pattern_circular: 'Circular Pattern',
    set_global: 'Set Global Variable',
    set_dimension: 'Set Dimension',
    goal_seek: 'Goal Seek',
    set_params: 'Edit Feature',
    mass_properties: 'Mass Properties',
    create_from_model: 'Create Drawing',
    auto_balloon: 'Auto Balloon',
    add_bom: 'Insert BOM',
    macro: 'Generated Macro',
  };
  const key = op.split('.').slice(1).join('_');
  if (special[key]) return special[key]!;
  return tail
    .split(/[_.]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * One-line parameter summary. Deliberately shows units and counts rather than raw JSON:
 * the raw form is one click away for anyone who wants it.
 */
export function summarise(op: string, params?: Record<string, unknown>): string {
  if (!params) return '';
  const p = params as Record<string, string | number | boolean | number[] | undefined>;
  const u = (p.units as string) ?? 'mm';
  const bits: string[] = [];

  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined);

  switch (op) {
    case 'feature.fillet':
      if (num('radius') !== undefined) bits.push(`Constant R${num('radius')} ${u}`);
      if (p.propagate) bits.push('propagate to tangent faces');
      break;
    case 'feature.chamfer':
      if (num('distance') !== undefined) bits.push(`${num('distance')} ${u}`);
      if (num('angle') !== undefined) bits.push(`${num('angle')}°`);
      break;
    case 'feature.hole_wizard': {
      const pos = Array.isArray(p.positions) ? (p.positions as number[]).length / 2 : 0;
      bits.push(`${p.standard ?? 'ISO'} ${p.fastener ?? ''} ${p.fit ?? ''} fit`.replace(/\s+/g, ' ').trim());
      if (pos) bits.push(`×${pos}`);
      if (p.endCondition) bits.push(String(p.endCondition).replace(/_/g, ' '));
      break;
    }
    case 'feature.shell':
      if (num('thickness') !== undefined) bits.push(`${num('thickness')} ${u} wall`);
      break;
    case 'feature.extrude':
    case 'feature.extrude_cut':
      if (num('depth') !== undefined) bits.push(`${num('depth')} ${u}`);
      if (p.endCondition) bits.push(String(p.endCondition).replace(/_/g, ' '));
      break;
    case 'feature.pattern_linear':
      bits.push(`${num('count') ?? 2}× at ${num('spacing') ?? 0} ${u}`);
      break;
    case 'feature.pattern_circular':
      bits.push(`${num('count') ?? 4}× over ${num('angle') ?? 360}°`);
      break;
    case 'param.set_global':
    case 'param.set_dimension':
      bits.push(`${p.name ?? '?'} = ${num('value') ?? '?'} ${u}`);
      break;
    case 'doc.set_property':
      bits.push(`${p.name ?? '?'} = "${p.value ?? ''}"`);
      break;
    case 'doc.set_material':
      bits.push(String(p.material ?? ''));
      break;
    case 'doc.export':
      bits.push(String(p.format ?? 'STEP'));
      break;
    case 'asm.mate':
      bits.push(String(p.type ?? 'coincident'));
      break;
    default: {
      // Generic fallback: the two or three most informative keys.
      const keys = Object.keys(p).filter((k) => k !== 'units').slice(0, 3);
      for (const k of keys) {
        const v = p[k];
        if (v === undefined || v === null) continue;
        bits.push(`${k} ${Array.isArray(v) ? `[${v.length}]` : String(v)}`);
      }
    }
  }

  return bits.join(' · ');
}

export interface Badge {
  label: string;
  tone: 'warn' | 'dang' | 'viz';
}

/** Risk badges. Mirrors OpTraits in the contracts assembly. */
export function badgesOf(op: string, resolvedOk: boolean): Badge[] {
  const out: Badge[] = [];
  const family = familyOf(op);

  if (!resolvedOk) out.push({ label: 'unresolved reference', tone: 'warn' });

  if (op.includes('.delete') || op === 'asm.delete_component' || op === 'config.delete') {
    out.push({ label: 'destructive', tone: 'dang' });
  }

  if (family === 'script') out.push({ label: 'generated code', tone: 'warn' });

  if (
    family === 'feature' ||
    family === 'sheetmetal' ||
    family === 'surface' ||
    op.startsWith('feature.edit')
  ) {
    if (!op.startsWith('feature.reference') && !op.includes('rename')) {
      out.push({ label: 'topology change', tone: 'warn' });
    }
  }

  if (family === 'config' || op.includes('configurations')) {
    out.push({ label: 'crosses configs', tone: 'viz' });
  }

  return out;
}

export function isReadOnly(op: string): boolean {
  return op.startsWith('query.') || op === 'meta.assert' || op === 'meta.note';
}
