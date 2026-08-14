import { useState } from 'react';
import { useStore } from '../store';
import type { Operation, Plan, PlanState, ValidationIssue } from '../types';
import { badgesOf, familyOf, glyphOf, isReadOnly, summarise, titleOf } from './opMeta';

interface Props {
  itemId: string;
  plan: Plan;
  issues: ValidationIssue[];
  state: PlanState;
}

const STATE_LABEL: Record<PlanState, string> = {
  streaming: 'Plan · streaming',
  resolving: 'Plan · resolving',
  ready: 'Plan · ready',
  running: 'Plan · running',
  failed: 'Plan · failed',
};

export function PlanCard({ itemId, plan, issues, state }: Props) {
  const applyPlan = useStore((s) => s.applyPlan);
  const discardPlan = useStore((s) => s.discardPlan);
  const busy = useStore((s) => s.busy);
  const [showAssumptions, setShowAssumptions] = useState(true);

  const errors = issues.filter((i) => i.severity === 'error');
  const canApply = state === 'ready' && errors.length === 0 && !busy;

  return (
    <div className="card plan rise">
      <div className={`c-strip${state === 'streaming' || state === 'resolving' ? ' pulsing' : ''}`}>
        <span aria-hidden="true">⬤</span>
        <span>{STATE_LABEL[state]}</span>
        <span className="count">
          {plan.ops.length} {plan.ops.length === 1 ? 'op' : 'ops'}
        </span>
      </div>

      <div className="c-body">
        <p className="intent">{plan.intent}</p>

        {/*
          Assumptions are a first-class element, not fine print. An AI that states what
          it inferred is auditable; one that hides it is not.
        */}
        {plan.assumptions.length > 0 && (
          <div className="assume">
            <h5>
              <button
                onClick={() => setShowAssumptions((v) => !v)}
                style={{ color: 'inherit', font: 'inherit', letterSpacing: 'inherit' }}
              >
                ⚠ Assumptions · {plan.assumptions.length} {showAssumptions ? '▾' : '▸'}
              </button>
            </h5>
            {showAssumptions && (
              <ul>
                {plan.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {errors.length > 0 && (
          <div className="assume" style={{ borderColor: 'var(--dang)', background: 'var(--dang-dim)' }}>
            <h5 style={{ color: 'var(--dang)' }}>✕ Blocked · {errors.length}</h5>
            <ul>
              {errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="ops">
          {plan.ops.map((op) => (
            <OpRow key={op.id} op={op} planState={state} />
          ))}
        </div>

        <TreeDiff plan={plan} />
      </div>

      <div className="c-foot">
        {state === 'running' ? (
          <span style={{ fontSize: 12, color: 'var(--tx1)' }}>
            Applying — graphics suspended, one undo scope…
          </span>
        ) : (
          <>
            <button className="btn ghost" disabled={!canApply}>
              Dry run ▸
            </button>
            <button className="btn ghost" disabled={!canApply}>
              ⚡ Save as Skill
            </button>
            <button className="btn ghost" onClick={() => discardPlan(itemId)}>
              Discard
            </button>
            <button className="btn primary" disabled={!canApply} onClick={() => applyPlan(plan.planId)}>
              Apply<span className="k">⏎</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function OpRow({ op, planState }: { op: Operation; planState: PlanState }) {
  const hover = useStore((s) => s.hover);
  const hotPids = useStore((s) => s.hotPids);
  const progress = useStore((s) => s.opStatus[op.id]);
  const [showRaw, setShowRaw] = useState(false);

  const pids = op.resolved?.pids ?? (op.target?.pid ? [op.target.pid] : []);
  const hot = pids.length > 0 && pids[0] !== undefined && hotPids.includes(pids[0]);
  const resolvedOk = op.resolved?.ok !== false;
  const badges = badgesOf(op.op, resolvedOk);
  const count = op.resolved?.count ?? 0;

  const pct =
    progress?.status === 'done' ? 100 : progress?.status === 'running' ? 55 : 0;

  return (
    <div
      className="op"
      data-family={familyOf(op.op)}
      data-hot={hot}
      data-ok={resolvedOk}
      data-status={progress?.status ?? ''}
      data-destructive={op.op.includes('.delete')}
      onMouseEnter={() => hover(pids)}
      onMouseLeave={() => hover(null)}
    >
      <span className="glyph" aria-hidden="true">
        {glyphOf(op.op)}
      </span>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span className="name">{titleOf(op.op)}</span>
          {isReadOnly(op.op) && (
            <span className="eyebrow" style={{ color: 'var(--ok)' }}>
              read-only
            </span>
          )}
          <button
            className="icon-btn"
            style={{ marginLeft: 'auto', width: 20, height: 20, fontSize: 11 }}
            aria-label={showRaw ? 'Hide parameters' : 'Show parameters'}
            onClick={(e) => {
              e.stopPropagation();
              setShowRaw((v) => !v);
            }}
          >
            {showRaw ? '▾' : '▸'}
          </button>
        </div>

        <div className="params">{summarise(op.op, op.params)}</div>

        {op.target && (
          <div className="target" data-ok={resolvedOk}>
            <span>⟶</span>
            <span>
              {resolvedOk
                ? op.target.kind === 'Query'
                  ? `${count} ${count === 1 ? 'entity' : 'entities'} — ${op.target.query}`
                  : (op.target.label ?? op.target.name ?? `${count} target(s)`)
                : (op.resolved?.problem ?? 'unresolved')}
            </span>
          </div>
        )}

        {badges.length > 0 && (
          <div className="badges">
            {badges.map((b) => (
              <span key={b.label} className={`badge${b.tone === 'dang' ? ' dang' : b.tone === 'viz' ? ' viz' : ''}`}>
                ● {b.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {showRaw && (
        <pre className="raw">{JSON.stringify({ op: op.op, target: op.target, params: op.params }, null, 2)}</pre>
      )}

      {(planState === 'running' || progress) && (
        <span className="bar">
          <i style={{ width: `${pct}%` }} />
        </span>
      )}
    </div>
  );
}

/**
 * Predicted tree diff. Derived from the plan rather than a real rebuild — it answers
 * "what will appear in my tree" before anything is executed.
 */
function TreeDiff({ plan }: { plan: Plan }) {
  const adds = plan.ops
    .filter((o) => {
      const f = familyOf(o.op);
      return (
        (f === 'feature' && !o.op.startsWith('feature.edit')) ||
        f === 'sketch' ||
        f === 'sheetmetal' ||
        f === 'surface'
      );
    })
    .map((o) => titleOf(o.op));

  const edits = plan.ops.filter((o) => o.op.startsWith('feature.edit.') || o.op.startsWith('param.'));
  const dels = plan.ops.filter((o) => o.op.includes('.delete'));

  if (adds.length === 0 && edits.length === 0 && dels.length === 0) return null;

  return (
    <div className="diff">
      <h5>Predicted tree diff</h5>
      {adds.map((a, i) => (
        <div key={`a${i}`} className="add">
          + {a}
        </div>
      ))}
      {edits.map((e, i) => (
        <div key={`e${i}`}>~ {e.target?.label ?? e.target?.name ?? titleOf(e.op)}</div>
      ))}
      {dels.map((d, i) => (
        <div key={`d${i}`} className="del">
          − {d.target?.label ?? d.target?.name ?? titleOf(d.op)}
        </div>
      ))}
    </div>
  );
}
