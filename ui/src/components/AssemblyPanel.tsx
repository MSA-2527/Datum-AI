import { useCallback, useState } from 'react';
import { useModel } from '../modelStore';
import { isComponent } from '../model/assembly';
import { type MateKind } from '../kernel/assembly/assembly';
import { type ClashReport } from '../model/assembly';

/**
 * Assembly relationships and clash checking.
 *
 * The two things a multi-part model needs and this app has never surfaced, despite the kernel
 * carrying both for a long time.
 *
 * **Clashes** matter most for what DATUM actually produces. A generated plan places thirty
 * components by absolute coordinate, and the failure is rarely a part a metre out of place —
 * that is obvious. It is a battery three millimetres inside a chassis wall, which looks right
 * in the viewport and cannot be built.
 *
 * **Mates** are the fix. "This shaft is concentric with that bore" survives the case moving;
 * "this shaft is at x=42" is a number somebody typed that nothing maintains.
 */

const MATES: { kind: MateKind; label: string; needsValue?: boolean; hint: string }[] = [
  { kind: 'coincident', label: 'Coincident', hint: 'Both origins occupy the same point' },
  { kind: 'concentric', label: 'Concentric', hint: 'Both Z axes share a line' },
  { kind: 'distance', label: 'Distance', needsValue: true, hint: 'Hold the origins a set distance apart' },
  { kind: 'parallel', label: 'Parallel', hint: 'Both Z axes point the same way' },
  { kind: 'perpendicular', label: 'Perpendicular', hint: 'The Z axes meet at 90°' },
  { kind: 'lock', label: 'Lock', hint: 'Fix the two rigidly together' },
];

export function AssemblyPanel() {
  const doc = useModel((s) => s.doc);
  const addMate = useModel((s) => s.addMate);
  const removeMate = useModel((s) => s.removeMate);
  const resolveMates = useModel((s) => s.resolveMates);
  const clashesOf = useModel((s) => s.clashes);
  const select = useModel((s) => s.select);

  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [value, setValue] = useState('20');
  const [report, setReport] = useState<ClashReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const components = doc.features.filter(isComponent);
  const mates = doc.mates ?? [];
  const nameOf = (id: string) => doc.features.find((f) => f.id === id)?.name ?? '(removed)';

  const check = useCallback(() => {
    setChecking(true);
    // Yield so the button shows its busy state before a boolean-heavy pass starts. A timer
    // rather than rAF: rAF does not fire in a hidden panel, so the check would never begin.
    setTimeout(() => {
      try {
        setReport(clashesOf());
      } finally {
        setChecking(false);
      }
    }, 16);
  }, [clashesOf]);

  const apply = useCallback((kind: MateKind, needsValue?: boolean) => {
    if (!a || !b) { setNotice('Choose two components first.'); return; }

    const size = needsValue ? Number(value) : undefined;
    if (needsValue && !Number.isFinite(size)) { setNotice('Give the distance a value.'); return; }

    const r = addMate(kind, a, b, size);
    setNotice(r.message);
    if (r.ok) setReport(null);      // positions moved, so any earlier clash list is stale
  }, [a, b, value, addMate]);

  if (components.length < 2) {
    return (
      <div className="asm empty-editor">
        <span>Assemblies need at least two components. Build one, or add a second shape.</span>
      </div>
    );
  }

  const real = report?.clashes.filter((c) => !c.likelyPressFit) ?? [];
  const fits = (report?.clashes.length ?? 0) - real.length;

  return (
    <div className="asm">
      <div className="st-h">Assembly</div>

      <div className="asm-pick">
        <label>
          <span>First</span>
          <select value={a} onChange={(e) => { setA(e.target.value); select(e.target.value || null); }}>
            <option value="">Choose…</option>
            {components.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label>
          <span>Second</span>
          <select value={b} onChange={(e) => { setB(e.target.value); select(e.target.value || null); }}>
            <option value="">Choose…</option>
            {components.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label className="asm-value">
          <span>Distance mm</span>
          <input type="number" value={value} step={0.5} onChange={(e) => setValue(e.target.value)} />
        </label>
      </div>

      <div className="asm-mates" role="group" aria-label="Add a mate">
        {MATES.map((m) => (
          <button key={m.kind} title={m.hint} disabled={!a || !b} onClick={() => apply(m.kind, m.needsValue)}>
            {m.label}
          </button>
        ))}
      </div>

      {notice && <p className="asm-notice">{notice}</p>}

      {mates.length > 0 && (
        <div className="asm-list">
          <div className="asm-list-head">
            <strong>{mates.length} mate{mates.length === 1 ? '' : 's'}</strong>
            <button onClick={() => setNotice(resolveMates().message)}>Re-solve</button>
          </div>
          {mates.map((m) => (
            <div className="asm-row" key={m.id}>
              <span className="asm-kind">{m.kind}</span>
              <span className="asm-pair">{nameOf(m.a.feature)} ↔ {nameOf(m.b.feature)}</span>
              {m.value !== undefined && <span className="asm-val">{m.value} mm</span>}
              <button title="Remove this mate" onClick={() => removeMate(m.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      <div className="asm-clash">
        <button onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Check for clashes'}
        </button>

        {report && (
          <>
            <p className="asm-summary" data-tone={real.length > 0 ? 'warn' : 'ok'}>
              {report.summary}
            </p>

            {real.map((c, i) => (
              <div className="asm-row" key={`${c.a}-${c.b}-${i}`}>
                <span className="asm-pair">
                  {report.nameOf.get(c.a)} ∩ {report.nameOf.get(c.b)}
                </span>
                <span className="asm-val">
                  {c.volume >= 1000 ? `${(c.volume / 1000).toFixed(1)} cm³` : `${c.volume.toFixed(0)} mm³`}
                  {' · '}{(c.fraction * 100).toFixed(0)}%
                </span>
              </div>
            ))}

            {fits > 0 && (
              <p className="asm-help">
                {fits} light overlap{fits === 1 ? '' : 's'} not listed — under 1 % of the smaller
                part, which is an interference fit rather than a mistake.
              </p>
            )}
          </>
        )}
      </div>

      <p className="asm-help">
        Mates act on each component’s own origin and Z axis. Solving moves components and
        writes the result into their placements, so the tree stays editable.
      </p>
    </div>
  );
}
