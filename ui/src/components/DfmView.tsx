import { useMemo, useState } from 'react';
import { useModel } from '../modelStore';
import { projectPart } from '../lib/projectPart';
import { analyseDfm, estimateCost, MATERIALS, type DfmSeverity, type Process } from '../lib/dfm';
import { analysePack, type ProcessPack } from '../lib/dfmPacks';

const QUANTITIES = [1, 10, 100, 1000];

/**
 * Process selection drives two things: the cost model and which rule pack runs. The same
 * geometry is legal for a mill and illegal for a mould, so the analysis has to follow the
 * process rather than being a single fixed checklist.
 */
const PROCESSES: { id: Process; label: string; pack?: ProcessPack }[] = [
  { id: 'mill3axis', label: '3-axis mill' },
  { id: 'lasercut', label: 'Laser / sheet', pack: 'sheet' },
  { id: 'print_fdm', label: 'FDM print', pack: 'additive' },
  { id: 'mill3axis', label: 'Injection mould', pack: 'moulding' },
];

/**
 * Manufacturability and cost.
 *
 * The competitive point of this view is that every number is traceable. Rival copilots
 * surface "real-time pricing" as a single figure from a service you cannot inspect; an
 * engineer cannot take that into a design review. Here the rules cite themselves, the
 * cost breaks into lines, and the basis is printed at the bottom so the estimate can be
 * argued with instead of believed.
 *
 * Entirely deterministic — no planner, no network, free tier.
 */
export function DfmView() {
  /*
   * Measured off the part on screen.
   *
   * This read from `store.doc` — the 2.5D sample bracket invented at boot — so every finding
   * and every cost line described a part the user had never asked for, sitting beside the one
   * they had. `projectPart` measures the real solid and reads the real feature tree, so the
   * rules now cite the part in the viewport.
   */
  const modelDoc = useModel((s) => s.doc);
  const evaluated = useModel((s) => s.evaluated);
  const build = useModel((s) => s.build);

  const projected = useMemo(
    () => projectPart(modelDoc, evaluated), [modelDoc, evaluated],
  );
  const { doc, geometry: geom, prismatic } = projected;

  const [quantity, setQuantity] = useState(1);
  // Index rather than id: two entries legitimately share a cost model (a moulded part is
  // costed as machined tooling) while running different rule packs.
  const [processIndex, setProcessIndex] = useState(0);
  const [showBasis, setShowBasis] = useState(false);

  const selected = PROCESSES[processIndex] ?? PROCESSES[0]!;
  const process: Process = selected.id;

  const findings = useMemo(() => {
    if (!doc || !geom) return [];
    const core = analyseDfm(doc, geom, process);
    // Process packs are additive: the CNC rules still apply to a moulded prototype.
    const pack = selected.pack ? analysePack(selected.pack, doc, geom) : [];
    return [...pack, ...core];
  }, [doc, geom, process, selected.pack]);
  const cost = useMemo(
    () => (doc && geom ? estimateCost(doc, geom, findings, quantity) : null),
    [doc, geom, findings, quantity],
  );

  if (geom.T <= 0 || !cost) {
    return (
      <div className="empty">
        <strong>Nothing to analyse</strong>
        Manufacturability is measured off the solid. Describe a part in the chat, or add a
        feature from the Model Explorer.
      </div>
    );
  }

  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.filter((f) => f.severity === 'warning');

  return (
    <div className="tabc">
      {/* ── quote header ── */}
      <div className="quote">
        <div className="quote-main">
          <span className="quote-value">${cost.unitCost.toFixed(2)}</span>
          <span className="quote-unit">per part</span>
        </div>
        <div className="quote-side">
          <span>
            {quantity} × <b>${cost.totalCost.toFixed(2)}</b>
          </span>
          <span>{cost.cycleMinutes.toFixed(1)} min cycle</span>
        </div>
      </div>

      <div className="chips">
        {QUANTITIES.map((q) => (
          <button key={q} className="chip" aria-pressed={quantity === q} onClick={() => setQuantity(q)}>
            {q === 1 ? 'One-off' : `×${q}`}
          </button>
        ))}
      </div>

      <div className="chips">
        {PROCESSES.map((p, i) => (
          <button
            key={p.label}
            className="chip"
            aria-pressed={processIndex === i}
            onClick={() => setProcessIndex(i)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/*
        The limit of the reading, stated where the reading is.

        These rules describe a profile swept to a thickness. A revolved, lofted or swept body
        is not one, so its envelope is measured correctly and its *outline* is not — and a
        finding about a corner radius on a part with no corners is worse than no finding.
        Saying so here costs one line and stops the numbers being over-read.
      */}
      {!prismatic && (
        <div className="note">
          <b>Envelope reading</b>
          This part is not a constant section swept to a thickness, so these rules are applied
          to its {geom.L.toFixed(0)} × {geom.W.toFixed(0)} × {geom.T.toFixed(0)} mm envelope and
          its measured volume. Mass, volume and cost follow the real solid; anything about the
          outline describes the envelope, not the shape.
        </div>
      )}

      {/* ── cost breakdown ── */}
      <div className="st-h" style={{ padding: '10px 0 4px' }}>
        Cost breakdown
      </div>
      <table className="grid">
        <tbody>
          {cost.lines.map((l) => (
            <tr key={l.label}>
              <td style={{ whiteSpace: 'normal' }}>
                <b>{l.label}</b>
                <br />
                <span style={{ color: 'var(--tx2)', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
                  {l.detail}
                </span>
              </td>
              <td className="num" style={{ verticalAlign: 'top' }}>
                ${l.amount.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button
        className="btn ghost"
        style={{ marginTop: 8, width: '100%' }}
        onClick={() => setShowBasis((v) => !v)}
      >
        {showBasis ? 'Hide basis ▾' : 'Show basis ▸'}
      </button>
      {showBasis && (
        <div className="note info" style={{ marginTop: 8 }}>
          <b>Estimate basis</b>
          {cost.basis.map((b) => (
            <div key={b} style={{ marginTop: 2 }}>
              · {b}
            </div>
          ))}
        </div>
      )}

      {/* ── manufacturability ── */}
      <div className="st-h" style={{ padding: '14px 0 4px' }}>
        Manufacturability · {blockers.length} blocking · {warnings.length} warning
      </div>

      {findings.length === 0 ? (
        <div className="empty">
          <strong>Makeable as drawn</strong>
          No rule violations for a {PROCESSES.find((p) => p.id === process)?.label.toLowerCase()}.
        </div>
      ) : (
        findings.map((f) => (
          <div className="find" key={f.id}>
            <div className="fh">
              <span className={`sev ${sevClass(f.severity)}`}>{f.severity}</span>
              <span className="rid">{f.rule}</span>
            </div>
            <p>
              {f.title}
              {(f.occurrences ?? 1) > 1 && (
                <span
                  style={{
                    marginLeft: 6,
                    padding: '1px 6px',
                    borderRadius: 3,
                    background: 'var(--input)',
                    color: 'var(--tx1)',
                    fontFamily: 'var(--mono)',
                    fontSize: 10,
                  }}
                >
                  ×{f.occurrences}
                </span>
              )}
            </p>
            <div className="why">{f.detail}</div>
            <div className="why" style={{ marginTop: 5, color: 'var(--det)' }}>
              → {f.remedy}
            </div>
            <div className="fa">
              <button className="btn determ" onClick={() => void build(fixPrompt(f.title, f.remedy))}>
                Ask DATUM to fix
              </button>
              {f.costImpact ? (
                <span
                  style={{
                    marginLeft: 'auto',
                    alignSelf: 'center',
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--warn)',
                  }}
                >
                  +${f.costImpact.toFixed(2)}
                </span>
              ) : null}
            </div>
          </div>
        ))
      )}

      <div className="note">
        <b>Deterministic · offline · free</b>
        Every rule cites itself and every cost line shows its inputs. Material{' '}
        {MATERIALS.find((m) => doc.material.toLowerCase().includes(m.id))?.name ?? doc.material}.
        Change a parameter and this recomputes on the same frame as the viewport.
      </div>
    </div>
  );
}

function sevClass(s: DfmSeverity): string {
  return s === 'blocker' ? 'err' : s === 'warning' ? 'warn' : 'adv';
}

function fixPrompt(title: string, remedy: string): string {
  return `${title}. ${remedy}`;
}
