# DATUM — Competitive Position

> How DATUM differs from Leo AI and MecAgent, and the one claim neither of them can make.
> Researched July 2026. Sources at the foot.

---

## 1. The field

| | **Leo AI** | **MecAgent** | **DATUM** |
|---|---|---|---|
| CAD hosts | SOLIDWORKS | SOLIDWORKS + Inventor | SOLIDWORKS |
| Core bet | "Large Mechanical Model" trained on CAD; geometry-aware part search | Fine-tuned LLM on SOLIDWORKS; conversational automation | Closed typed operation IR executed by SOLIDWORKS itself |
| Text → 3D | ✅ incl. assemblies | ✅ | ✅ (parametric only) |
| Drawings | partial | ✅ | ✅ template-driven |
| Bulk export / batch | via PDM connectors | ✅ | ✅ |
| Standards checks | — | ✅ claimed | ✅ rule packs + live linter |
| Part reuse search | ✅ text + geometry | ✅ file searcher | ✅ text + geometry fingerprint |
| PDM / PLM | ✅ SW PDM, Vault, Windchill, Teamcenter, Arena | — | ✅ SW PDM (Pro) |
| Cost / pricing | — | ✅ "real-time pricing" | ✅ auditable line-by-line estimate |
| **Free tier** | ❌ | ❌ | ✅ full deterministic core |
| **Works offline** | ❌ cloud | ❌ cloud | ✅ local model or no model at all |
| **Output verified against tests** | ❌ | ❌ | ✅ |
| **Self-repair on failed verification** | ❌ | ❌ | ✅ |
| **Rollback on failed verification** | ❌ | ❌ | ✅ |

Leo is the stronger enterprise story — the PDM/PLM connector breadth is real and hard to
match. MecAgent is the stronger breadth story — two CAD hosts and a model fine-tuned on
SOLIDWORKS specifically. Both are cloud-only subscriptions with no offline path.

---

## 2. The wedge: nobody verifies

The 2026 text-to-CAD literature converged on a single conclusion: **compilation success
and visual similarity both fail to catch a model that is subtly wrong.** The benchmarks
built that year — [Text2CAD-Bench], [CADTestBench], [BenchCAD], [HistCAD] — all moved to
test-based evaluation, asserting geometric and topological requirements against the
produced model rather than eyeballing it.

No shipping CAD copilot runs assertions against its own output. They generate, render a
preview, and hand the engineer the job of noticing.

DATUM's `verify[]` block is not a progress indicator — it is an executable test suite:

```
Every plan carries tests           →  ui/src/lib/cadtests.ts  suiteFor()
Tests run after apply              →  runSuite()
Required failure rolls back        →  store.applyPlan()
Failure is diagnosed and retried   →  proposeRepair()
```

Three invariants are asserted on **every** plan whether the planner asked for them or
not: no new rebuild errors, every hole inside the part outline, no new manufacturability
blockers. Plans that create geometry must demonstrably have created it — which catches
the failure mode where a planner emits a syntactically valid plan that resolves to
nothing.

**The claim this earns:** *DATUM is the only CAD copilot that can prove its output is
correct before you keep it.* That is a claim a chief engineer can act on, and it is not
available to any competitor without rebuilding their execution layer.

### Why self-repair is deterministic

When verification fails, DATUM diagnoses the geometry rather than re-prompting the model.
A repair derived from the failure — "holes need 3.5 mm more width to keep a
half-diameter wall" — is reproducible and explainable. Asking a model to try again
produces a *different* wrong answer at random. The planner is consulted only when the
failure is not a known shape. Attempts are bounded, disclosed in the transcript, and if
the loop cannot reach a passing state the model is restored: **a wrong answer is never
kept just because it was expensive to produce.**

---

## 3. Second wedge: cost you can argue with

MecAgent advertises real-time pricing as a figure from a service you cannot inspect. An
engineer cannot take an unexplained number into a design review.

`ui/src/lib/dfm.ts` produces a line-by-line estimate where every input is printed:

```
Material          $0.46   127.4 cm³ billet · 0.344 kg · $6.5/kg
Roughing          $0.31   18.6 cm³ at 60 cm³/min
Finishing         $0.83   604 cm² surface
Drilling          $1.00   4 holes · 5 mm deep
Tool changes      $1.25   6 tools · 20s each
Setup (amortised) $0.19   15 min over 100 parts
```

Verified behaviour: one-off $21.18 → $2.62 at quantity 100, with setup collapsing from
$18.75 to $0.19. That is the real economics of machining, and an engineer can check every
step.

The manufacturability rules are conservative by design — a false "this is fine" costs a
scrapped part; a false warning costs thirty seconds of attention. Each finding cites its
rule (`dfm.hole.edge-distance`), states the physics, and gives a remedy phrased as an
action. Identical violations across a pattern collapse into one card with a count,
because a four-hole pattern breaching edge distance is one design problem, not four.

---

## 4. Third wedge: it is free and it works offline

Neither competitor has a free tier or an offline mode. DATUM's deterministic core —
executor, Parameter Inspector, Skills, Batch, Linter, Drawing Autopilot, DFM, cost,
undo, audit log — needs no planner at all. The GBNF grammar generated from the operation
catalogue means a 7–14B local model physically cannot emit a malformed operation.

This is a distribution advantage, not a pricing gimmick. A tool that works on an
air-gapped defence workstation reaches customers a cloud subscription cannot.

---

## 5. Where DATUM is genuinely behind

Stated plainly, because pretending otherwise would make the rest of this document
untrustworthy.

| Gap | Competitor | Assessment |
|---|---|---|
| **Inventor support** | MecAgent | Real gap. The operation IR is host-agnostic by design, but no Inventor executor exists. |
| **Fine-tuned CAD model** | Both | They have trained on CAD corpora; DATUM relies on general models plus grammar constraints. Grammar closes the *validity* gap, not the *judgement* gap. |
| **PDM/PLM connector breadth** | Leo | Leo covers Vault, Windchill, Teamcenter and Arena. DATUM covers SOLIDWORKS PDM only. |
| **Company design-history knowledge** | Leo | Leo's retrieval over a firm's own engineering library is a strong moat. DATUM's reuse index is narrower. |
| **Proven at scale** | Both | They have customers. DATUM has an architecture and a test suite. |

The honest summary: DATUM wins on **trust, verifiability and reach**. It does not yet win
on breadth or on trained-model judgement, and it will not until the Inventor executor and
a CAD-tuned planner exist.

---

## 6. What to build next, in order

1. **Publish benchmark numbers.** Run the planner against [CADTestBench] and
   [Text2CAD-Bench] and publish the score. No competitor has. Being first to a number is
   worth more than being best at an unmeasured claim.
2. **Eval harness in CI.** The CADTest suite is already pure functions of the document,
   so it doubles as a scoring harness. Regressions in planner quality should fail a build.
3. **Inventor executor.** The IR is host-agnostic; only the executor is not.
4. **Design-history retrieval.** Close the Leo gap by indexing the customer's own
   released parts, not just geometry.

---

## Sources

- [Leo AI — Best AI Copilots for SOLIDWORKS](https://www.getleo.ai/blog/best-ai-copilots-for-solidworks-in-2025)
- [Leo AI can now generate full CAD assemblies — Engineering.com](https://www.engineering.com/leo-ai-can-now-generate-full-cad-assemblies/)
- [Leo AI — The Practical Guide to AI Integration with SolidWorks](https://www.getleo.ai/blog/the-practical-guide-to-ai-integration-with-solidworks)
- [MecAgent — AI copilot for mechanical CAD (Founders, Inc.)](https://f.inc/portfolio/mecagent/)
- [MecAgent — AI in CAD: How 2025 is Reshaping Mechanical Design Workflows](https://mecagent.com/blog/ai-in-cad-how-2025-is-reshaping-mechanical-design-workflows)
- [The 2026 AI Stack for Mechanical Engineers — bananaz](https://www.bananaz.ai/blog/ai-for-mechanical-engineers-2026-stack)
- [Text2CAD-Bench: A Benchmark for LLM-based Text-to-Parametric CAD Generation](https://arxiv.org/abs/2605.18430)
- [Text-to-CAD Evaluation with CADTests](https://arxiv.org/abs/2605.07807)
- [BenchCAD: A Comprehensive, Industry-Standard Benchmark for Programmatic CAD](https://arxiv.org/html/2605.10865v1)
- [HistCAD: A Constraint-Aware Parametric History-Based CAD Representation](https://arxiv.org/pdf/2602.19171)
- [CAD-Judge: Morphological Grading and Verification for Text-to-CAD](https://arxiv.org/pdf/2508.04002)
- [Why AI Must Generate Parametric CAD — Zoo](https://zoo.dev/blog/why-ai-must-generate-parametric-cad)

[Text2CAD-Bench]: https://arxiv.org/abs/2605.18430
[CADTestBench]: https://arxiv.org/abs/2605.07807
[BenchCAD]: https://arxiv.org/html/2605.10865v1
[HistCAD]: https://arxiv.org/pdf/2602.19171
