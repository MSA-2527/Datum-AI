import { decompose } from '../ai/decompose';
import { evaluateDocument } from '../model/document';
import { health, massProperties, triCount } from '../kernel/topo/mesh';
import { defaultConfig, type ProviderConfig, type ProviderId } from '../ai/providers';

/**
 * The benchmark, with a model configured.
 *
 * ── Why this is separate from `eval/` ──
 *
 * The deterministic benchmark answers "what does every user get, offline, for nothing", and it
 * has to be reproducible to the digit or it cannot gate a build. This answers a different
 * question — "how good is the model path" — and it cannot be reproducible, because a model is
 * not. Mixing them would either make the gate flaky or make this dishonest.
 *
 * ── What it measures, and why those ──
 *
 * The number that matters for a language-based CAD system is **first-attempt validity**: how
 * often a model writes a program that parses and builds without being told anything. Published
 * results across frontier models put that well below half on non-trivial parts. The second
 * number is what the repair loop recovers, because that is the entire argument for having one.
 *
 * Both are reported per prompt as well as in aggregate, because an average over a mixed set
 * hides the shape of the failure: a model that is perfect on plates and hopeless on anything
 * turned scores the same as one that is mediocre at both, and only one of those is fixable.
 */

export interface ModelCase {
  prompt: string;
  /** What kind of thing this is, so the aggregate can be read by family rather than as one number. */
  family: 'primitive' | 'machined' | 'turned' | 'catalogue' | 'assembly' | 'unbuildable';
}

/**
 * The prompts.
 *
 * Chosen to span what the routes actually do rather than to flatter any of them: things the
 * catalogue answers without a model, things only a script can express, an assembly that must
 * route away from the script path, and one request that nothing should build — because a
 * benchmark with no refusals in it cannot tell a capable system from a compliant one.
 */
export const MODEL_CASES: ModelCase[] = [
  { prompt: 'a 120 x 80 x 10 mm mounting plate with four M6 clearance holes', family: 'machined' },
  { prompt: 'a bronze bushing 25 mm outside diameter, 15 mm bore, 40 mm long', family: 'turned' },
  { prompt: 'a spacer 20 mm across and 12 mm long with an 8 mm bore', family: 'turned' },
  { prompt: 'an aluminium enclosure 150 x 100 x 60 mm with 3 mm walls', family: 'machined' },
  { prompt: 'a stepped shaft, 30 mm diameter for 60 mm then 20 mm for 40 mm', family: 'turned' },
  { prompt: 'a 200 mm long channel section, 60 mm wide, 40 mm tall, 5 mm thick', family: 'machined' },
  { prompt: 'a crankshaft journal with an oil gallery through it', family: 'machined' },

  /*
   * Parts the offline routes refuse.
   *
   * The first run of this benchmark answered ten of thirteen prompts from the catalogue in
   * under a second, which is excellent for a user and useless as a measurement: the number it
   * produced described the parser, not the model. Every prompt below names something no
   * archetype has and no base-plus-modifier reading covers, so the script route is the only
   * thing that can answer it and the figure means what it says.
   */
  { prompt: 'a dovetail slide 120 mm long, 40 mm wide, 20 mm tall', family: 'machined' },
  { prompt: 'a stepped bore adapter: a 60 mm flange 10 mm thick with a 30 mm spigot 25 mm long, bored 18 mm through', family: 'machined' },
  { prompt: 'a heat sink base 100 x 100 x 8 mm with a 40 mm raised boss 6 mm proud in the centre', family: 'machined' },
  { prompt: 'a wedge clamp 60 mm long tapering from 20 mm to 8 mm thick', family: 'machined' },
  { prompt: 'a two-tier standoff: 20 mm across for 15 mm, then 12 mm across for 10 mm, tapped M6 through', family: 'turned' },
  { prompt: 'a pillow block 80 x 50 x 45 mm with a 25 mm bore on the centreline and two M8 feet holes', family: 'machined' },
  { prompt: 'a 50 mm cube with a 20 mm square pocket 10 mm deep in the top', family: 'primitive' },
  { prompt: 'a flange 150 mm across with 8 bolt holes on a 120 mm circle', family: 'machined' },
  { prompt: 'make a cup', family: 'catalogue' },
  { prompt: 'M10 hex nut', family: 'catalogue' },
  { prompt: 'a gearbox', family: 'assembly' },
  { prompt: 'a hydroformed titanium turbine volute with variable-section runners', family: 'unbuildable' },
];

export interface CaseOutcome {
  prompt: string;
  family: ModelCase['family'];
  ok: boolean;
  /** Which route answered. `model` is the script route; `plan` is the decomposition. */
  route: string;
  /** Repairs the script route needed. Absent when it did not run. */
  repairs?: number;
  /** What the model said when shown the result. */
  review?: string;
  /**
   * The program the model wrote, when it wrote one.
   *
   * A benchmark that reports a rate and not the work is one nobody can check. The script is
   * the whole of what was produced, it is a few hundred bytes, and it is the only way a reader
   * can tell a part that is right from a part that merely closed.
   */
  script?: string;
  closed?: boolean;
  volumeCm3?: number;
  massG?: number;
  features?: number;
  ms: number;
  /** Why it failed, when it did. */
  message: string;
  /**
   * True when the run was throttled rather than beaten.
   *
   * Kept apart from a capability failure in every figure below. A free tier refusing a fourth
   * call in a minute says nothing about whether the model could have written the part, and
   * counting it as a failure would make the benchmark a measure of the tier.
   */
  rateLimited?: boolean;
}

export interface ModelReport {
  provider: string;
  model: string;
  outcomes: CaseOutcome[];
  /** Cases that produced a closed solid, over cases that should have. */
  buildRate: number;
  /** Of the cases the script route answered, how many needed no repair. */
  firstAttemptRate: number;
  scripted: number;
  meanRepairs: number;
  /** Requests that should be refused and were. */
  refusedCorrectly: number;
  refusable: number;
  /** Cases the provider throttled, excluded from every rate above. */
  rateLimited: number;
  ms: number;
}

/** Where a key comes from. Never a command-line argument, which shells record. */
export function configFromEnv(env: Record<string, string | undefined>): ProviderConfig {
  const id = (env.DATUM_PROVIDER ?? 'none') as ProviderId;
  return {
    ...defaultConfig(),
    id,
    model: env.DATUM_MODEL ?? '',
    apiKey: env.DATUM_API_KEY ?? '',
    ...(env.DATUM_BASE_URL ? { baseUrl: env.DATUM_BASE_URL } : {}),
  };
}

/** A rate limit reads the same from every provider: the words differ, the meaning does not. */
const THROTTLED = /rate limit|too many requests|quota|429|try again/i;

const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function runModelCase(
  testCase: ModelCase, config: ProviderConfig, retries = 2,
): Promise<CaseOutcome> {
  const started = Date.now();

  try {
    let result = await decompose(testCase.prompt, { config, preferModel: false });

    /*
     * A throttled call is not a failed one.
     *
     * A free tier refusing a fourth request in a minute says nothing about whether the model
     * could have written the part. Waiting and asking again is what a person would do, and
     * counting the refusal instead would turn a benchmark of the system into a benchmark of
     * the plan someone is paying for.
     */
    for (let attempt = 0; attempt < retries && !result.ok && THROTTLED.test(result.message); attempt++) {
      await wait(20_000 * (attempt + 1));
      result = await decompose(testCase.prompt, { config, preferModel: false });
    }

    if (!result.ok) {
      const throttled = THROTTLED.test(result.message);
      return {
        prompt: testCase.prompt, family: testCase.family, ok: false, route: 'refused',
        ms: Date.now() - started, message: result.message.slice(0, 160),
        ...(throttled ? { rateLimited: true } : {}),
      };
    }

    const evaluated = evaluateDocument(result.doc);
    const built = triCount(evaluated.mesh) > 0;
    const h = health(evaluated.mesh);

    return {
      prompt: testCase.prompt,
      family: testCase.family,
      ok: built && h.closed,
      route: result.route,
      ...(result.script !== undefined
        ? { repairs: countRepairs(result.message), script: result.script }
        : {}),
      ...(result.message.includes('by eye') ? { review: 'matches' } : {}),
      closed: h.closed,
      volumeCm3: built ? Number((massProperties(evaluated.mesh).volume / 1000).toFixed(2)) : 0,
      massG: Number(evaluated.massGrams.toFixed(1)),
      features: result.doc.features.length,
      ms: Date.now() - started,
      message: result.message.slice(0, 160),
    };
  } catch (e) {
    return {
      prompt: testCase.prompt, family: testCase.family, ok: false, route: 'error',
      ms: Date.now() - started,
      message: e instanceof Error ? e.message.slice(0, 160) : String(e),
    };
  }
}

/** The route reports its own repair count in words; this reads it back. */
function countRepairs(message: string): number {
  const m = /\((\d+) repairs?\)/.exec(message);
  return m ? Number(m[1]) : 0;
}

export async function runModelBenchmark(
  config: ProviderConfig, cases: ModelCase[] = MODEL_CASES,
  onCase?: (outcome: CaseOutcome) => void,
  spacingMs = 0,
  // How many times a throttled case is retried. Zero makes a run fast and unforgiving, which
  // is what a test wants and what a measurement does not.
  retries = 2,
): Promise<ModelReport> {
  const started = Date.now();
  const outcomes: CaseOutcome[] = [];

  // Sequential. A free tier's per-minute limit is the binding constraint, and eight at once
  // simply converts the benchmark into a rate-limit test.
  for (const [i, testCase] of cases.entries()) {
    // Paced, not parallel. A free tier's per-minute limit is the binding constraint, and eight
    // at once converts the benchmark into a rate-limit test.
    if (i > 0 && spacingMs > 0) await wait(spacingMs);

    const outcome = await runModelCase(testCase, config, retries);
    outcomes.push(outcome);
    onCase?.(outcome);
  }

  // Throttled cases are excluded from every rate: they measure the tier, not the system.
  const measured = outcomes.filter((o) => !o.rateLimited);
  const buildable = measured.filter((o) => o.family !== 'unbuildable');
  const refusable = measured.filter((o) => o.family === 'unbuildable');
  const scripted = measured.filter((o) => o.repairs !== undefined);

  return {
    provider: config.id,
    model: config.model,
    outcomes,
    buildRate: buildable.length === 0 ? 0 : buildable.filter((o) => o.ok).length / buildable.length,
    firstAttemptRate: scripted.length === 0
      ? 0
      : scripted.filter((o) => o.repairs === 0).length / scripted.length,
    scripted: scripted.length,
    meanRepairs: scripted.length === 0
      ? 0
      : scripted.reduce((n, o) => n + (o.repairs ?? 0), 0) / scripted.length,
    refusedCorrectly: refusable.filter((o) => !o.ok).length,
    refusable: refusable.length,
    rateLimited: outcomes.filter((o) => o.rateLimited).length,
    ms: Date.now() - started,
  };
}

/** The report as a table someone can read, or paste. */
export function formatModelReport(report: ModelReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const lines: string[] = [];

  lines.push(`${report.provider} · ${report.model}`);
  lines.push('─'.repeat(96));

  for (const o of report.outcomes) {
    const mark = o.family === 'unbuildable' ? (o.ok ? 'WRONG' : 'refused') : (o.ok ? 'built' : 'FAILED');
    const detail = o.ok && o.volumeCm3
      ? `${o.volumeCm3} cm³, ${o.features} feat`
      : o.message.split('\n')[0]!.slice(0, 44);

    lines.push(
      `${mark.padEnd(8)} ${o.route.padEnd(10)} ` +
      `${(o.repairs === undefined ? '' : `${o.repairs}r`).padEnd(4)} ` +
      `${String(o.ms).padStart(6)}ms  ${o.prompt.slice(0, 40).padEnd(42)} ${detail}`,
    );
  }

  lines.push('─'.repeat(96));
  lines.push(`built ${pct(report.buildRate)} of buildable requests`);
  if (report.scripted > 0) {
    lines.push(
      `script route answered ${report.scripted}: ${pct(report.firstAttemptRate)} first attempt, ` +
      `${report.meanRepairs.toFixed(1)} repairs on average`,
    );
  }
  lines.push(`refused ${report.refusedCorrectly} of ${report.refusable} unbuildable requests`);
  if (report.rateLimited > 0) {
    lines.push(`${report.rateLimited} throttled by the provider and excluded from every figure`);
  }
  lines.push(`${(report.ms / 1000).toFixed(1)} s total`);

  return lines.join('\n');
}
