import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { printScript, runScript } from './generate/script';
import { evaluateDocument, serialise, deserialise, type Document } from './model/document';
import { health, massProperties, triCount, type Mesh } from './kernel/topo/mesh';
import { projectPart } from './lib/projectPart';
import { analyseDfm, estimateCost } from './lib/dfm';
import { drawingToDxf, drawingToSvg, makeDrawing } from './drafting/sheet';
import { makeDetailSheets } from './drafting/details';
import { meshToStep } from './export/step';
import { synthesise, toJsonl } from './ml/synth';
import { initManifold, manifoldReady } from './kernel/ops/manifold';
import { renderViews, REVIEW_VIEWS, type ViewName } from './render/raster';
import {
  configFromEnv, formatModelReport, MODEL_CASES, runModelBenchmark, runModelCase,
} from './eval/model';
import { encodePng } from './render/png';
import { readStep } from './ingest/step/read';
import { designBarRack, describeBarRack } from './domain/barRack';

/**
 * DATUM, headless.
 *
 * ── Why a command line ──
 *
 * Everything this application knows how to do lives behind a browser event handler. That is
 * fine for a person and useless for everything else: there is no way to check a part in CI, to
 * run a change across a folder, to synthesise a dataset, or to let an agent drive the thing
 * and *see what it built*. Every one of those is blocked on the same missing surface.
 *
 * ── The contract ──
 *
 * Each command answers with **evidence, not a verdict**. `inspect` does not say "looks fine";
 * it returns the volume, the mass, the envelope, whether the solid closed, and every feature
 * with its parameters. `dfm` does not say "manufacturable"; it names each rule that fired and
 * quotes the limit it enforces. An agent iterating on a part needs the measurement to decide
 * what to change, and so does a person.
 *
 * `--json` on any command prints the same information as a single object, so the output is a
 * data structure rather than something to scrape. The human form is the same content, laid
 * out to read.
 *
 * ── What it will not do ──
 *
 * Evaluate anything but a script or a saved document. There is no `--eval`, no plugin path and
 * no way to hand it code: the input is a program in a language whose every statement is checked
 * against the kernel's own schema, which is the property that makes running one safe.
 */

interface Options {
  json: boolean;
  out?: string;
  count?: number;
  seed?: number;
  process?: string;
  quantity?: number;
  views?: string;
  size?: number;
  delay?: number;
  family?: string;
  thicknessUm?: number;
  details?: boolean;
}

const USAGE = `
DATUM — parametric CAD, headless

  datum run      <file>            build a part and report what it made
  datum inspect  <file>            measurements, health and the feature tree
  datum dfm      <file>            manufacturability findings and cost
  datum export   <file> --out <f>  write .step .svg .dxf .stl or .json
  datum render   <file> --out <f>  PNG views of the part, for a person or a model
  datum corpus   --out <f>         synthesise training data
  datum ask      "<request>"        build a part from a request, using the model
  datum bench                      run the benchmark against a configured model
  datum rack     <file>            design the anodising rack this part hangs on
  datum print    <file>            print a saved document as a script

A <file> is a DatumScript (.datum, .txt) or a saved document (.json).
The rack command also reads a STEP file (.step, .stp), because a part to be racked is usually
somebody else's.
Add --json to any command for machine-readable output.

  --out <path>       where to write
  --count <n>        corpus size (default 100)
  --seed <n>         corpus seed, for reproducibility (default 1)
  --process <id>     mill3axis | lasercut | print_fdm (default mill3axis)
  --quantity <n>     batch size for the cost model (default 1)
  --views <list>     iso,front,right,top (default: all four)
  --size <px>        render size, square (default 512)
  --delay <ms>       pause between benchmark cases (default 4000)
  --family <list>    benchmark only these families (machined,turned,…)
  --count <n>        rack: stations across the bar, overriding what the rules choose
  --thickness <um>   rack: coating thickness in microns (default: mid-range for the process)
  --details          export: a dimensioned sheet per part, not one for the assembly
`.trim();

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, options } = parseArgs(rest);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  /*
   * The fast, robust boolean engine, before anything is built.
   *
   * `boolean()` tries Manifold and falls back to the in-house BSP engine when it is not
   * loaded. The application loads it at start-up and the test suite loads it in its setup;
   * this did not, so every part built here went through the fallback — and the fallback is
   * the one that cannot resolve two cuts touching along a wall. The headless surface was
   * measurably less capable than the product it was reporting on, which made the numbers it
   * produced worse than useless: they were pessimistic in a way nothing disclosed.
   *
   * Awaited rather than fired and forgotten, because the very next thing this does is build.
   */
  await initManifold();

  try {
    switch (command) {
      case 'run': return runCommand(positional[0], options);
      case 'inspect': return inspectCommand(positional[0], options);
      case 'dfm': return dfmCommand(positional[0], options);
      case 'export': return exportCommand(positional[0], options);
      case 'print': return printCommand(positional[0], options);
      case 'render': return renderCommand(positional[0], options);
      case 'corpus': return corpusCommand(options);
      case 'ask': return askCommand(positional.join(' '), options);
      case 'bench': return benchCommand(options);
      case 'rack': return rackCommand(positional[0], options);
      default:
        console.error(`Unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    // A stack trace is not evidence. What went wrong, in a sentence, is.
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

// ── loading ──────────────────────────────────────────────────────────────────

interface Loaded {
  doc: Document;
  name: string;
  /** The script it came from, or printed from the document it came from. */
  script: string;
}

/**
 * A file, as a document.
 *
 * Both input forms end in the same place — a feature tree — because they are the same thing
 * written two ways. A `.json` is the evaluated form and a script is the written one; neither is
 * primary, so either is accepted anywhere.
 */
function load(path: string | undefined): Loaded {
  if (!path) throw new Error('No file given. Try: datum inspect part.datum');

  const text = readFileSync(path, 'utf8');
  const name = basename(path, extname(path));

  if (extname(path).toLowerCase() === '.json') {
    const doc = deserialise(text);
    if (!doc) throw new Error(`${path} is not a DATUM document.`);
    return { doc, name, script: printScript(doc) };
  }

  const result = runScript(text);
  if (!result.ok) {
    const listed = result.errors
      .map((e) => `  line ${e.line}: ${e.message}`)
      .join('\n');
    throw new Error(`${path} did not build:\n${listed}`);
  }

  return { doc: result.doc, name, script: printScript(result.doc) };
}

/** Everything measurable about a built part, in one shape. */
function measure(doc: Document) {
  const evaluated = evaluateDocument(doc);
  const mesh = evaluated.mesh;
  const built = triCount(mesh) > 0;

  const props = built
    ? massProperties(mesh)
    : { volume: 0, centroid: [0, 0, 0] as [number, number, number] };

  const { geometry, prismatic } = projectPart(doc, evaluated);
  const h = health(mesh);

  return {
    evaluated,
    mesh,
    built,
    name: doc.name,
    material: doc.material,
    volumeMm3: props.volume,
    massG: evaluated.massGrams,
    sizeMm: [geometry.L, geometry.W, geometry.T] as [number, number, number],
    centroidMm: props.centroid,
    holes: geometry.holes.length,
    prismatic,
    triangles: triCount(mesh),
    rebuildMs: evaluated.rebuildMs,
    health: {
      closed: h.closed,
      manifold: h.manifold,
      boundaryEdges: h.boundaryEdges,
      nonManifoldEdges: h.nonManifoldEdges,
      genus: h.genus,
    },
    features: doc.features.map((f) => ({
      name: f.name,
      kind: f.kind,
      suppressed: f.suppressed,
      error: evaluated.errors.get(f.id),
      warning: evaluated.warnings.get(f.id),
    })),
  };
}

/**
 * A file, as a mesh.
 *
 * Wider than `load` on purpose. `load` wants a feature tree, because everything it feeds needs
 * one; a rack needs only the part's shape and size, and the shape of a part that needs racking
 * usually arrives as a STEP file from whoever is paying to have it coated. Refusing to design a
 * rack because the customer's file has no DATUM history in it would be refusing the ordinary
 * case.
 */
function loadMesh(path: string | undefined): { mesh: Mesh; name: string; notes: string[] } {
  if (!path) throw new Error('No file given. Try: datum rack part.step');

  const extension = extname(path).toLowerCase();
  const name = basename(path, extname(path));

  if (extension === '.step' || extension === '.stp') {
    const read = readStep(readFileSync(path, 'utf8'));
    if ('error' in read) throw new Error(`${path} could not be read: ${read.error}`);

    const notes = [...read.notes];
    // Said, not swallowed: an open solid still has a bounding box, and the box is most of what
    // a rack is sized from — but its area is a guess, and area is what sets the current.
    if (!read.closed) {
      notes.push('The solid did not close, so its wetted area is approximate and the current with it.');
    }
    return { mesh: read.mesh, name: read.name || name, notes };
  }

  const { doc } = load(path);
  return { mesh: evaluateDocument(doc).mesh, name: doc.name || name, notes: [] };
}

// ── commands ─────────────────────────────────────────────────────────────────

/**
 * The rack a part hangs on, from the part.
 *
 * This is the anodising shop's question rather than the machine shop's, and it is asked in the
 * other direction from everything else here: the input is a part somebody else designed, and
 * the output is tooling to carry it. What comes back is a DatumScript like any other, so the
 * rack can be opened, edited, measured, drawn and quoted by the same commands.
 */
function rackCommand(path: string | undefined, options: Options): number {
  const { mesh, name, notes } = loadMesh(path);

  const design = designBarRack(mesh, {
    processId: options.process,
    stations: options.count,
    thicknessUm: options.thicknessUm,
  });

  if (options.out) writeFileSync(options.out, design.script, 'utf8');

  const blockers = design.checks.filter((c) => !c.ok && c.severity === 'blocker');

  if (options.json) {
    console.log(JSON.stringify({
      ok: blockers.length === 0,
      part: { name, ...design.part },
      bar: design.bar,
      stations: design.stations,
      partsPerStation: design.partsPerStation,
      partsTotal: design.partsTotal,
      pitchMm: design.pitchMm,
      clearanceMm: design.clearanceMm,
      clip: design.clip,
      process: design.process.id,
      thicknessUm: design.thicknessUm,
      currentA: design.electrical.currentA,
      minutes: design.electrical.minutes,
      rackAreaMm2: design.rackAreaMm2,
      rackCurrentFraction: design.rackCurrentFraction,
      massG: design.massG,
      checks: design.checks.map((c) => ({
        id: c.id, ok: c.ok, severity: c.severity, title: c.title, detail: c.detail,
      })),
      notes,
      script: design.script,
    }, null, 2));
  } else {
    const [down, across, through] = design.part.sizeMm;
    console.log(`${name} — ${down.toFixed(1)} × ${across.toFixed(1)} × ${through.toFixed(1)} mm, ` +
      `${design.part.areaDm2.toFixed(2)} dm², ${design.part.massG.toFixed(1)} g`);
    console.log('');
    console.log(describeBarRack(design));
    console.log('');
    for (const note of notes) console.log(`  note: ${note}`);
    for (const c of design.checks) {
      console.log(`  ${c.ok ? '·' : `[${c.severity}]`} ${c.title}`);
      if (!c.ok) console.log(`      ${c.detail}`);
    }
    if (options.out) {
      console.log('');
      console.log(`wrote ${options.out} — open it with: datum run ${options.out}`);
    }
  }

  // A blocker means the rack would not hold the part. That has to fail a script.
  return blockers.length === 0 ? 0 : 1;
}

function runCommand(path: string | undefined, options: Options): number {
  const { doc } = load(path);
  const m = measure(doc);
  const failed = m.features.filter((f) => f.error);

  if (options.json) {
    console.log(JSON.stringify({
      ok: m.built && m.health.closed && failed.length === 0,
      ...strip(m),
    }, null, 2));
  } else {
    console.log(`${m.name} — ${m.features.length} feature${m.features.length === 1 ? '' : 's'}, ` +
      `${m.triangles.toLocaleString('en-GB')} triangles, ${m.rebuildMs} ms` +
      `${manifoldReady() ? '' : ' (BSP fallback — Manifold did not load)'}`);
    console.log(`${(m.volumeMm3 / 1000).toFixed(2)} cm³   ${m.massG.toFixed(1)} g   ` +
      `${m.sizeMm.map((v) => v.toFixed(1)).join(' × ')} mm`);
    console.log(m.health.closed ? 'solid: closed' : `solid: OPEN — ${m.health.boundaryEdges} edges`);

    /*
     * A feature that failed, named and quoted.
     *
     * The evaluator carries on when one fails — every parametric system does, and one bad
     * fillet should not make the rest of a part vanish — so a run can finish with geometry on
     * screen and a step of the recipe silently missing. Printing only the closure told a CI
     * job the solid was open without telling it which line opened it, which is the difference
     * between a failure someone can fix and one they have to bisect by hand.
     */
    for (const f of failed) {
      console.log('');
      console.log(`${f.name} (${f.kind}) failed:`);
      console.log(`  ${f.error}`);
    }
  }

  // A part that did not close has no trustworthy volume, mass or cost, so this is a failure
  // for anything downstream even though the script itself ran.
  return m.built && m.health.closed && failed.length === 0 ? 0 : 1;
}

function inspectCommand(path: string | undefined, options: Options): number {
  const { doc, script } = load(path);
  const m = measure(doc);

  if (options.json) {
    console.log(JSON.stringify({ ...strip(m), script }, null, 2));
    return m.built ? 0 : 1;
  }

  console.log(`${m.name}   ${m.material}`);
  console.log('');
  console.log(`  volume      ${(m.volumeMm3 / 1000).toFixed(3)} cm³`);
  console.log(`  mass        ${m.massG.toFixed(2)} g`);
  console.log(`  envelope    ${m.sizeMm.map((v) => v.toFixed(2)).join(' × ')} mm`);
  console.log(`  centroid    ${m.centroidMm.map((v) => v.toFixed(2)).join(', ')} mm`);
  console.log(`  holes       ${m.holes}`);
  console.log(`  section     ${m.prismatic ? 'constant along Z' : 'varies'}`);
  console.log(`  closed      ${m.health.closed}   manifold ${m.health.manifold}   genus ${m.health.genus}`);
  console.log('');

  for (const f of m.features) {
    const state = f.error ? `ERROR ${f.error}` : f.warning ? `warning: ${f.warning}` : '';
    console.log(`  ${f.suppressed ? '-' : '+'} ${f.name.padEnd(20)} ${f.kind.padEnd(16)} ${state}`);
  }

  return m.built ? 0 : 1;
}

function dfmCommand(path: string | undefined, options: Options): number {
  const { doc } = load(path);
  const evaluated = evaluateDocument(doc);
  const { doc: part, geometry, prismatic } = projectPart(doc, evaluated);

  const process = (options.process ?? 'mill3axis') as Parameters<typeof analyseDfm>[2];
  const findings = analyseDfm(part, geometry, process);
  const cost = estimateCost(part, geometry, findings, options.quantity ?? 1);

  const blockers = findings.filter((f) => f.severity === 'blocker');

  if (options.json) {
    console.log(JSON.stringify({
      process, prismatic,
      blockers: blockers.length,
      warnings: findings.length - blockers.length,
      findings: findings.map((f) => ({
        rule: f.rule, severity: f.severity, title: f.title, remedy: f.remedy,
      })),
      cost: { unit: cost.unitCost, total: cost.totalCost, cycleMinutes: cost.cycleMinutes },
    }, null, 2));
  } else {
    console.log(`${process} · ${blockers.length} blocking, ${findings.length - blockers.length} warning`);
    if (!prismatic) {
      console.log('(envelope reading — this part is not a constant section swept to a thickness)');
    }
    console.log('');
    for (const f of findings) {
      console.log(`  [${f.severity}] ${f.rule}`);
      console.log(`      ${f.title}`);
      console.log(`      → ${f.remedy}`);
    }
    console.log('');
    console.log(`  $${cost.unitCost.toFixed(2)} per part, ${cost.cycleMinutes.toFixed(1)} min cycle`);
  }

  // Blockers fail the command, so this is usable as a gate in CI.
  return blockers.length === 0 ? 0 : 1;
}

function exportCommand(path: string | undefined, options: Options): number {
  const { doc, name } = load(path);
  const out = options.out;
  if (!out) throw new Error('Nothing to write to. Add --out part.step');

  const evaluated = evaluateDocument(doc);
  if (triCount(evaluated.mesh) === 0) throw new Error('There is no solid to export.');

  const format = extname(out).toLowerCase().replace('.', '');

  /*
   * `--details` writes a drawing set: the assembly, then a dimensioned sheet per part.
   *
   * One file each, numbered and named, because that is how a drawing pack is issued and how a
   * shop knows whether it has all of it. A machinist cannot make anything from an assembly
   * view — the dimensions that matter belong to the parts — so an application that draws the
   * assembly and stops has not finished the job it started.
   */
  if (options.details) {
    if (format !== 'svg' && format !== 'dxf') {
      throw new Error('--details writes drawings. Use --out sheets.svg or sheets.dxf');
    }

    const sheets = makeDetailSheets(doc, evaluated, {
      density: doc.density,
      titleBlock: { material: doc.material },
    });

    const stem = out.slice(0, out.length - extname(out).length);
    const files = sheets.map((sheet) => {
      const slug = sheet.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const file = `${stem}-${sheet.sheet}-${slug}.${format}`;
      const text = format === 'svg' ? drawingToSvg(sheet.drawing) : drawingToDxf(sheet.drawing);

      writeFileSync(file, text, 'utf8');
      const dimensions = sheet.drawing.views.reduce((n, v) => n + v.dimensions.length, 0);
      return {
        file, name: sheet.name, sheet: sheet.sheet, of: sheet.of, dimensions,
        bytes: Buffer.byteLength(text, 'utf8'),
      };
    });

    if (options.json) console.log(JSON.stringify({ format, sheets: files }, null, 2));
    else {
      console.log(`${files.length} sheet${files.length === 1 ? '' : 's'}, ${format.toUpperCase()}`);
      for (const f of files) {
        console.log(
          `  ${f.sheet} of ${f.of}  ${f.name.padEnd(18)} ${String(f.dimensions).padStart(3)} dims  ${f.file}`,
        );
      }
    }
    return 0;
  }

  const written = write(format, out, doc, evaluated.mesh, name);

  if (options.json) console.log(JSON.stringify({ out, format, bytes: written }, null, 2));
  else console.log(`${out} — ${format.toUpperCase()}, ${written.toLocaleString('en-GB')} bytes`);

  return 0;
}

function write(format: string, out: string, doc: Document, mesh: Mesh, name: string): number {
  const drawing = () => makeDrawing(mesh, {
    density: doc.density,
    titleBlock: {
      partNumber: doc.properties?.PartNo ?? name.toUpperCase(),
      description: doc.name,
      material: doc.material,
    },
  });

  const text =
    format === 'json' ? serialise(doc)
      : format === 'datum' ? printScript(doc)
        : format === 'svg' ? drawingToSvg(drawing())
          : format === 'dxf' ? drawingToDxf(drawing())
            : format === 'stl' ? toStl(mesh, doc.name)
              : format === 'step' || format === 'stp'
                ? meshToStep(mesh, { name: doc.name, author: 'DATUM', description: doc.name }).text
                : null;

  if (text === null) {
    throw new Error(`Cannot write ".${format}". Try .step .svg .dxf .stl .json or .datum`);
  }

  writeFileSync(out, text);
  return text.length;
}

function printCommand(path: string | undefined, options: Options): number {
  const { script } = load(path);

  if (options.out) {
    writeFileSync(options.out, script);
    if (!options.json) console.log(`${options.out} — ${script.split('\n').length} lines`);
    return 0;
  }

  console.log(options.json ? JSON.stringify({ script }, null, 2) : script);
  return 0;
}


/**
 * Views of the part, as PNGs.
 *
 * The command that closes the loop. A part that has been *described* is not a part that has
 * been *looked at*: a script reads correctly while the boss it places floats half a millimetre
 * off the face, and no amount of reading the program finds that. One `--out part.png` becomes
 * `part-iso.png`, `part-front.png` and so on, because the judgement worth making needs more
 * than one view.
 */
function renderCommand(path: string | undefined, options: Options): number {
  const { doc, name } = load(path);
  const evaluated = evaluateDocument(doc);

  if (triCount(evaluated.mesh) === 0) throw new Error('There is no solid to render.');

  const requested = options.views
    ? options.views.split(',').map((v) => v.trim()) as ViewName[]
    : REVIEW_VIEWS;

  const size = options.size ?? 512;
  const rendered = renderViews(evaluated.mesh, requested, { width: size, height: size });

  const stem = (options.out ?? `${name}.png`).replace(/\.png$/i, '');
  const written: { view: string; file: string; coveredPercent: number }[] = [];

  for (const { name: view, render } of rendered) {
    const file = `${stem}-${view}.png`;
    writeFileSync(file, encodePng(render.rgba, render.width, render.height));
    written.push({
      view,
      file,
      coveredPercent: Number(((render.covered / (render.width * render.height)) * 100).toFixed(1)),
    });
  }

  if (options.json) {
    console.log(JSON.stringify({ size, views: written }, null, 2));
  } else {
    for (const w of written) console.log(`${w.file} — ${w.view}, ${w.coveredPercent}% covered`);
  }

  // Nothing visible in any view means the render is useless even though it succeeded.
  return written.some((w) => w.coveredPercent > 0.1) ? 0 : 1;
}


/**
 * The benchmark, against a real model.
 *
 * The key comes from the environment and never from an argument, because a shell records its
 * history and a key in a history file is a key that has leaked. Nothing here writes it
 * anywhere, and the report names the model but not the credential.
 */

/**
 * One request, answered the way the application answers it.
 *
 * The product, headless. It runs the same routing a user gets — catalogue first, then the
 * composer, then a model writing a script — and reports which one answered, what it wrote and
 * what it measured. That is the difference between a benchmark figure and something a reader
 * can check: the script is a few hundred bytes and it is the whole of the work.
 */
async function askCommand(request: string, options: Options): Promise<number> {
  if (!request.trim()) throw new Error('Nothing was asked. Try: datum ask "a 50 mm cube"');

  const config = configFromEnv(process.env);
  const outcome = await runModelCase({ prompt: request, family: 'machined' }, config);

  if (options.json) {
    console.log(JSON.stringify(outcome, null, 2));
  } else {
    console.log(`${outcome.ok ? 'built' : 'failed'} via the ${outcome.route} route in ${outcome.ms} ms`);
    if (outcome.script) {
      console.log('');
      console.log(outcome.script.trimEnd());
    }
    console.log('');
    console.log(outcome.message);
    if (outcome.ok) {
      console.log(`${outcome.volumeCm3} cm³   ${outcome.massG} g   ${outcome.features} features`);
    }
  }

  if (options.out && outcome.script) writeFileSync(options.out, outcome.script);
  return outcome.ok ? 0 : 1;
}

async function benchCommand(options: Options): Promise<number> {
  const config = configFromEnv(process.env);

  if (config.id === 'none' || !config.model) {
    throw new Error(
      'Set DATUM_PROVIDER, DATUM_MODEL and DATUM_API_KEY (and DATUM_BASE_URL for an ' +
      'OpenAI-compatible endpoint) before running this.',
    );
  }

  const families = options.family?.split(',').map((f) => f.trim());
  const cases = families
    ? MODEL_CASES.filter((c) => families.includes(c.family))
    : MODEL_CASES;

  const report = await runModelBenchmark(config, cases, (outcome) => {
    // Streamed, because a run against a free tier takes minutes and a silent command that
    // takes minutes is one people kill.
    if (options.json) return;
    const mark = outcome.ok ? 'ok  ' : 'fail';
    process.stderr.write(`  ${mark} ${outcome.route.padEnd(10)} ${outcome.prompt}\n`);
  });

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatModelReport(report));

  if (options.out) writeFileSync(options.out, JSON.stringify(report, null, 2));

  return report.buildRate > 0 ? 0 : 1;
}

function corpusCommand(options: Options): number {
  const count = options.count ?? 100;
  const seed = options.seed ?? 1;

  const corpus = synthesise(count, seed);
  const jsonl = toJsonl(corpus);

  if (options.out) writeFileSync(options.out, `${jsonl}\n`);

  const yield_ = ((corpus.samples.length / Math.max(1, corpus.attempted)) * 100).toFixed(1);

  if (options.json) {
    console.log(JSON.stringify({
      kept: corpus.samples.length,
      attempted: corpus.attempted,
      yieldPercent: Number(yield_),
      rejected: corpus.rejected.slice(0, 20),
      out: options.out ?? null,
    }, null, 2));
  } else {
    console.log(`${corpus.samples.length} programs kept of ${corpus.attempted} generated (${yield_}%)`);
    if (corpus.rejected.length > 0) {
      console.log(`${corpus.rejected.length} rejected — first few:`);
      for (const r of corpus.rejected.slice(0, 3)) console.log(`  ${r.reason}`);
    }
    if (options.out) console.log(`written to ${options.out}`);
  }

  return corpus.samples.length === count ? 0 : 1;
}

// ── plumbing ─────────────────────────────────────────────────────────────────

/** The measurement without the heavy objects, for printing. */
function strip(m: ReturnType<typeof measure>) {
  const { evaluated, mesh, ...rest } = m;
  void evaluated; void mesh;
  return rest;
}

function toStl(mesh: Mesh, name: string): string {
  const lines: string[] = [`solid ${name}`];

  for (let t = 0; t < triCount(mesh); t++) {
    const at = (i: number): [number, number, number] =>
      [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];

    const a = at(mesh.indices[t * 3]!), b = at(mesh.indices[t * 3 + 1]!), c = at(mesh.indices[t * 3 + 2]!);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;

    lines.push(`  facet normal ${n.map((x) => (x / l).toExponential(6)).join(' ')}`);
    lines.push('    outer loop');
    for (const p of [a, b, c]) lines.push(`      vertex ${p.map((x) => x.toExponential(6)).join(' ')}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }

  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}

export function parseArgs(argv: string[]): { positional: string[]; options: Options } {
  const positional: string[] = [];
  const options: Options = { json: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--out' || arg === '-o') { options.out = argv[++i]; continue; }
    if (arg === '--count') { options.count = Number(argv[++i]); continue; }
    if (arg === '--seed') { options.seed = Number(argv[++i]); continue; }
    if (arg === '--process') { options.process = argv[++i]; continue; }
    if (arg === '--quantity') { options.quantity = Number(argv[++i]); continue; }
    if (arg === '--views') { options.views = argv[++i]; continue; }
    if (arg === '--size') { options.size = Number(argv[++i]); continue; }
    if (arg === '--delay') { options.delay = Number(argv[++i]); continue; }
    if (arg === '--family') { options.family = argv[++i]; continue; }
    if (arg === '--thickness') { options.thicknessUm = Number(argv[++i]); continue; }
    if (arg === '--details') { options.details = true; continue; }

    if (arg.startsWith('-')) throw new Error(`Unknown option "${arg}".`);
    positional.push(arg);
  }

  return { positional, options };
}

// Run when invoked directly, and stay importable for the tests.
if (process.argv[1]?.includes('cli')) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
