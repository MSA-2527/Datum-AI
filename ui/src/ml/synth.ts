import { printScript, runScript } from '../generate/script';
import { evaluateDocument } from '../model/document';
import { health, massProperties, triCount } from '../kernel/topo/mesh';
import { projectPart } from '../lib/projectPart';
import { analyseDfm } from '../lib/dfm';

/**
 * Making a corpus out of nothing.
 *
 * ── The problem this solves ──
 *
 * "Trainable on your own parts" is the requirement this project scores worst on, and the
 * reason is not the method — retrieval and a ridge-regression size prior are both sound — it
 * is that there is nothing to train on. `datum-training.jsonl` is fourteen kilobytes. A
 * fine-tune wants four to six orders of magnitude more, and the CAD data that exists is either
 * proprietary, unlabelled, or both.
 *
 * A language changes that, because a program can be **generated, executed and judged** without
 * anyone drawing anything. Sample a shape, write it as a script, run it through the same
 * kernel the product runs on, and keep it only if it built a closed solid. What survives is a
 * corpus of programs that are known to work — paired with a description of what they make,
 * which is the other half of what a fine-tune needs.
 *
 * ── Why the filter is the valuable part ──
 *
 * Anyone can generate a million programs. The reason this is worth doing here rather than
 * anywhere else is that this project can *check* them: closure, manifoldness, a positive
 * volume, a plausible mass, and a manufacturability pass that names the rule it fired. A
 * corpus filtered on "it parsed" teaches a model to write plausible-looking scripts; a corpus
 * filtered on "it produced a manufacturable solid" teaches it to write parts.
 *
 * Nothing here is a language model. It is a sampler and a judge, and the judge is the kernel.
 */

export interface Sample {
  /** What the part is, in the words someone would ask for it. */
  request: string;
  /** The program that builds it. */
  script: string;
  /** Measured off the solid it actually produced. */
  measured: {
    volumeMm3: number;
    massG: number;
    sizeMm: [number, number, number];
    features: number;
    triangles: number;
  };
  /** Manufacturability rules that fired, by id. Empty is not required — only stated. */
  findings: string[];
}

export interface Rejection {
  script: string;
  /** Why it was thrown away, in a sentence. */
  reason: string;
}

export interface Corpus {
  samples: Sample[];
  rejected: Rejection[];
  /** How many were generated to get this many keepers. */
  attempted: number;
}

/**
 * A deterministic pseudo-random source.
 *
 * Seeded so a corpus is reproducible: the same seed gives the same programs, which is what
 * makes a training run something anyone can repeat rather than a one-off. Mulberry32 — small,
 * fast, and good enough for choosing dimensions.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const between = (r: () => number, lo: number, hi: number, step = 1): number =>
  Math.round((lo + r() * (hi - lo)) / step) * step;

// ── the generators ───────────────────────────────────────────────────────────

/**
 * One family of part per generator, sampled over its own dimensions.
 *
 * Deliberately not one generator that emits random statements. A uniformly random program is
 * overwhelmingly a program that does not build — a fillet with nothing to round, a shell with
 * no body — and a corpus of near-misses teaches nothing about parts. Each of these is a shape
 * a shop actually makes, sampled across sizes and options, so what survives the filter is
 * varied in the way real work is varied.
 */
type Generator = (r: () => number) => { request: string; script: string };

const GENERATORS: { name: string; make: Generator }[] = [
  {
    name: 'plate',
    make: (r) => {
      const L = between(r, 40, 400, 5);
      const W = between(r, 30, L, 5);
      const T = between(r, 3, 25, 1);
      const d = between(r, 3, 16, 0.5);
      const n = pick(r, [1, 2, 4, 6, 8]);

      return {
        request: `a ${L} x ${W} x ${T} mm plate with ${n} ⌀${d} mm hole${n === 1 ? '' : 's'}`,
        script: [
          `param L = ${L}`, `param W = ${W}`, `param T = ${T}`,
          '',
          'box Body length=L width=W height=T',
          n === 1
            ? `hole Bore diameter=${d} holeType=through pattern=single x=0 y=0`
            : `hole Bolts diameter=${d} holeType=through pattern=boltCircle count=${n} boltCircle=${Math.round(Math.min(L, W) * 0.6)} cx=0 cy=0`,
        ].join('\n'),
      };
    },
  },
  {
    name: 'bushing',
    make: (r) => {
      const od = between(r, 12, 120, 1);
      const id = between(r, 4, od - 6, 1);
      const len = between(r, 8, 200, 2);

      return {
        request: `a bushing ${od} mm outside, ${id} mm bore, ${len} mm long`,
        script: [
          `param OD = ${od}`, `param ID = ${id}`, `param L = ${len}`,
          '',
          'cylinder Body diameter=OD height=L',
          'hole Bore diameter=ID holeType=through pattern=single x=0 y=0',
        ].join('\n'),
      };
    },
  },
  {
    name: 'housing',
    make: (r) => {
      const L = between(r, 50, 250, 5);
      const W = between(r, 40, L, 5);
      const H = between(r, 25, 120, 5);
      const wall = between(r, 2, 6, 0.5);

      return {
        request: `a ${L} x ${W} x ${H} mm housing with ${wall} mm walls`,
        script: [
          `param L = ${L}`, `param W = ${W}`, `param H = ${H}`, `param wall = ${wall}`,
          '',
          'box Body length=L width=W height=H',
          'shell Hollow thickness=wall',
        ].join('\n'),
      };
    },
  },
  {
    name: 'flanged tube',
    make: (r) => {
      const od = between(r, 20, 120, 2);
      const bore = between(r, 8, od - 8, 2);
      const len = between(r, 40, 200, 5);
      const flange = between(r, od + 20, od + 80, 5);

      return {
        request: `a ${od} mm tube ${len} mm long with a ${flange} mm flange`,
        script: [
          `param OD = ${od}`, `param bore = ${bore}`, `param L = ${len}`,
          '',
          'cylinder Barrel diameter=OD height=L',
          `cylinder Flange diameter=${flange} height=10`,
          'hole Bore diameter=bore holeType=through pattern=single x=0 y=0',
        ].join('\n'),
      };
    },
  },
  {
    name: 'bracket',
    make: (r) => {
      const L = between(r, 40, 200, 5);
      const W = between(r, 30, 120, 5);
      const T = between(r, 4, 16, 1);
      const pocket = between(r, 10, Math.max(12, W - 20), 5);
      const depth = between(r, 1, Math.max(1.5, T - 2), 0.5);

      return {
        request: `a ${L} x ${W} x ${T} mm bracket with a ${pocket} mm pocket`,
        script: [
          `param L = ${L}`, `param W = ${W}`, `param T = ${T}`,
          '',
          'box Body length=L width=W height=T',
          `pocket Relief length=${pocket} width=${pocket} depth=${depth} x=0 y=0 cornerRadius=0`,
          `chamfer Break distance=${between(r, 0.5, 2, 0.5)}`,
        ].join('\n'),
      };
    },
  },
  {
    name: 'catalogue part',
    make: (r) => {
      const id = pick(r, ['cup', 'flange', 'nut', 'washer', 'pulley', 'pipe', 'gear', 'shaft']);
      return {
        request: `a ${id}`,
        script: `archetype Part archetypeId=${id}`,
      };
    },
  },
];

// ── the judge ────────────────────────────────────────────────────────────────

/**
 * Whether a program produced something worth keeping.
 *
 * Closure first, because everything else is meaningless without it: an open surface has no
 * volume, so its mass, its centre of mass and every manufacturing figure derived from them are
 * undefined rather than wrong.
 */
export function judge(script: string, request: string): Sample | Rejection {
  const parsed = runScript(script);
  if (!parsed.ok) {
    return { script, reason: `did not parse: ${parsed.errors[0]?.message ?? 'unknown'}` };
  }

  const evaluated = evaluateDocument(parsed.doc);

  if (evaluated.errors.size > 0) {
    return { script, reason: `a feature failed: ${[...evaluated.errors.values()][0]}` };
  }
  if (triCount(evaluated.mesh) === 0) {
    return { script, reason: 'built no geometry at all' };
  }

  const h = health(evaluated.mesh);
  if (!h.closed) return { script, reason: `not closed — ${h.boundaryEdges} open edges` };
  if (!h.manifold) return { script, reason: `not manifold — ${h.nonManifoldEdges} bad edges` };

  const props = massProperties(evaluated.mesh);
  if (props.volume <= 0) return { script, reason: 'volume is zero or negative' };

  const { doc: part, geometry } = projectPart(parsed.doc, evaluated);
  const findings = analyseDfm(part, geometry).map((f) => f.rule);

  return {
    request,
    script: printScript(parsed.doc),
    measured: {
      volumeMm3: Number(props.volume.toFixed(3)),
      massG: Number(evaluated.massGrams.toFixed(3)),
      sizeMm: [
        Number(geometry.L.toFixed(3)),
        Number(geometry.W.toFixed(3)),
        Number(geometry.T.toFixed(3)),
      ],
      features: parsed.doc.features.length,
      triangles: triCount(evaluated.mesh),
    },
    findings: [...new Set(findings)],
  };
}

// ── the corpus ───────────────────────────────────────────────────────────────

export function synthesise(count: number, seed = 1): Corpus {
  const r = rng(seed);
  const samples: Sample[] = [];
  const rejected: Rejection[] = [];

  let attempted = 0;
  // A ceiling on tries, so a generator that starts producing nothing buildable cannot spin
  // forever — it reports a poor yield instead, which is the useful signal.
  const limit = count * 8;

  while (samples.length < count && attempted < limit) {
    attempted += 1;

    const generator = pick(r, GENERATORS);
    const { request, script } = generator.make(r);
    const verdict = judge(script, request);

    if ('measured' in verdict) samples.push(verdict);
    else rejected.push(verdict);
  }

  return { samples, rejected, attempted };
}

/**
 * The corpus as JSONL, one training pair per line.
 *
 * The measurements travel with the pair on purpose. A model fine-tuned on request → script
 * learns to write programs; one that has also seen what each program *measured* has seen the
 * consequence of its own numbers, which is the part a text corpus of CAD code cannot teach.
 */
export function toJsonl(corpus: Corpus): string {
  return corpus.samples
    .map((s) => JSON.stringify({
      messages: [
        { role: 'user', content: s.request },
        { role: 'assistant', content: s.script },
      ],
      measured: s.measured,
      findings: s.findings,
    }))
    .join('\n');
}
