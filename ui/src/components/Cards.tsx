import { useStore } from '../store';
import type { CapabilityMiss, VerifyReport } from '../types';

/**
 * The result card. Its job is to turn "the AI did something" into measurable evidence:
 * rebuild errors before and after, mass delta, interference count. This block is what
 * makes the product defensible in a production engineering environment.
 */
export function ResultCard({ report }: { report: VerifyReport }) {
  const undoLast = useStore((s) => s.undoLast);
  const massDelta =
    Math.abs(report.massBeforeG) < 1e-9
      ? 0
      : ((report.massAfterG - report.massBeforeG) / report.massBeforeG) * 100;

  const lintWorse = report.lintAfter > report.lintBefore;

  return (
    <div className="card result rise" data-passed={report.passed}>
      <div className="c-strip">
        <span aria-hidden="true">{report.passed ? '✓' : '✕'}</span>
        <span>
          {report.rolledBack ? 'Rolled back' : report.passed ? 'Applied' : 'Failed'} ·{' '}
          {(report.elapsedMs / 1000).toFixed(1)} s
        </span>
        <span className="count">{report.checks.length} checks</span>
      </div>

      <div className="c-body">
        <div className="verify">
          <VRow
            tone={report.errorsAfter <= report.errorsBefore ? 'ok' : 'bad'}
            label="Rebuild errors"
            value={`${report.errorsBefore} → ${report.errorsAfter}`}
          />
          <VRow
            tone="ok"
            label="Mass"
            value={`${report.massBeforeG.toFixed(1)} → ${report.massAfterG.toFixed(1)} g · ${massDelta >= 0 ? '+' : ''}${massDelta.toFixed(1)}%`}
          />
          <VRow
            tone={report.interferences === 0 ? 'ok' : 'bad'}
            label="Interference"
            value={report.interferences === 0 ? 'none' : `${report.interferences} found`}
          />
          <VRow
            tone={lintWorse ? 'warn' : 'ok'}
            label="Linter"
            value={`${report.lintBefore} → ${report.lintAfter}${lintWorse ? ` · +${report.lintAfter - report.lintBefore} new` : ''}`}
          />
          {report.checks
            .filter((c) => !c.ok)
            .map((c) => (
              <VRow key={c.check} tone="bad" label={c.check} value={c.detail ?? 'failed'} />
            ))}
        </div>
      </div>

      <div className="c-foot">
        <button className="btn" onClick={() => void undoLast()}>
          ↺ Undo
        </button>
        <button className="btn ghost">⟲ Restore snapshot</button>
        <button className="btn ghost">Explain</button>
        <button className="btn ghost">⚡ Save as Skill</button>
      </div>
    </div>
  );
}

function VRow({ tone, label, value }: { tone: 'ok' | 'warn' | 'bad'; label: string; value: string }) {
  return (
    <div className="vrow" data-tone={tone}>
      <span className="g" aria-hidden="true">
        {tone === 'ok' ? '✓' : tone === 'warn' ? '⚠' : '✕'}
      </span>
      <span>{label}</span>
      <span className="v">{value}</span>
    </div>
  );
}

/**
 * Capability escalation. Deliberately NOT a blocked state and NOT a nag: it reports what
 * the local model actually managed, and always offers to run the part it got right.
 * Attempted-and-honest beats blocked-and-upsold.
 */
export function CapabilityCard({ miss }: { miss: CapabilityMiss }) {
  const setProvider = useStore((s) => s.setProvider);

  return (
    <div className="card capability rise">
      <div className="c-strip">
        <span aria-hidden="true">⚠</span>
        <span>Beyond your local model</span>
      </div>

      <div className="c-body" style={{ fontSize: 12.5, color: 'var(--tx1)', lineHeight: 1.5 }}>
        <p style={{ margin: '0 0 7px', color: 'var(--tx0)' }}>{miss.error}</p>
        {miss.totalOps > 0 && (
          <p style={{ margin: 0 }}>
            Completed {miss.partialOps} of {miss.totalOps} steps in the dry run. Nothing has been changed.
          </p>
        )}
      </div>

      <div className="c-foot">
        {miss.partialOps > 0 && (
          <button className="btn">Run the {miss.partialOps} it got right</button>
        )}
        {miss.alternatives.map((a) => (
          <button
            key={a.id}
            className={a.kind === 'Managed' ? 'btn viz' : 'btn'}
            onClick={() => setProvider(a.id)}
          >
            {a.kind === 'Managed' ? 'Run on Pro' : `Use ${a.modelId}`}
          </button>
        ))}
      </div>
    </div>
  );
}

export function NoticeCard({
  tone,
  title,
  text,
}: {
  tone: 'info' | 'warn' | 'error';
  title?: string;
  text: string;
}) {
  const colour = tone === 'error' ? 'var(--dang)' : tone === 'warn' ? 'var(--warn)' : 'var(--tx0)';
  return (
    <div className="card rise">
      <div className="c-body" style={{ fontSize: 12.5, color: 'var(--tx1)' }}>
        {title && (
          <strong style={{ display: 'block', marginBottom: 5, fontSize: 13, color: colour }}>{title}</strong>
        )}
        {text}
      </div>
    </div>
  );
}
