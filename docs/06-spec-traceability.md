# ForgePilot spec → existing code: traceability and gap analysis

> Assessment of the MASTER BUILD PROMPT against the repository as it stands.
> Written so the gap is a build plan, not a guess. Nothing below is marked done unless
> it is code that exists and has been exercised.

---

## 1. Repository assessment

The repo already implements a large majority of this specification under the product
name **DATUM**. Concretely: 42 C# files across three projects, 21 TypeScript files, a
test project, and four design documents.

| Spec concept | Existing implementation |
|---|---|
| `ForgePilot.SolidWorksAddin` | `src/DATUM.Connector.SolidWorks` — `ISwAddin`, event tap, idle-pump dispatcher, PID resolver, undo scope, 9 handler families |
| `ForgePilot.Orchestrator` | `src/DATUM.Orchestrator` — Kestrel loopback, WebSocket fan-out, named-pipe server, provider router, validator, SQLite store |
| `ForgePilot.Contracts` | `src/DATUM.Contracts` — Operation IR, op catalogue, binary wire protocol |
| `ForgePilot.UI` | `ui/` — React + TS, one bundle serving the task pane and Studio |
| Typed CAD operation system (§4) | `OpCatalog.cs` — ~200 typed ops with traits, version gating, mode gating |
| Controlled agent execution (§1.3) | Closed vocabulary + GBNF grammar generated from the catalogue |
| Verification agent (§8.7) | `ui/src/lib/cadtests.ts` + kernel `verify[]` evaluation |
| Repair agent (§8.8) | `proposeRepair()` — bounded, deterministic, disclosed |
| Manufacturability rules (§17) | `ui/src/lib/dfm.ts` — CNC rule set + auditable cost model |
| Stable entity references (§3.3) | `PidResolver` — PID capture/resolve, halts rather than guessing |
| Transaction/undo (§10) | `UndoScope` — one `StartRecordingUndoObject` per plan |

**Recommendation: rename and restructure, do not rewrite.** The spec itself says
"Preserve working code" (§25.2). Scaffolding `apps/` + `packages/` from scratch would
discard a working execution pipeline to satisfy a directory layout.

---

## 2. The blocking constraint — now partially removed

The .NET 8 SDK was **not** present. It has since been installed user-locally
(`%LOCALAPPDATA%\Microsoft\dotnet`, SDK 8.0.423, no admin rights) via the official
`dotnet-install.ps1`. Two thirds of the C# tree now compiles and tests green:

```
dotnet build DATUM.NoSolidWorks.slnf -c Release   → Build succeeded. 0 Warning(s), 0 Error(s)
dotnet test  DATUM.NoSolidWorks.slnf -c Release   → Passed! Failed: 0, Passed: 87, Total: 87
```

`DATUM.Connector.SolidWorks` still cannot build, and this is the one thing that cannot be solved from
here: SOLIDWORKS is a licensed commercial product and its interop assemblies are
Dassault's IP, not redistributable. The `net48` toolchain itself is now proven working —
`Microsoft.NETFramework.ReferenceAssemblies` removes the Visual Studio requirement, so
the build fails on exactly one thing and says so:

```
error : SOLIDWORKS interop assemblies not found under
        'C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\api\redist'.
        Install SOLIDWORKS or pass -p:SolidWorksDir=<path>.
```

**To finish the kernel, run on a machine with a SOLIDWORKS seat:**

```bash
dotnet build src\DATUM.Connector.SolidWorks\DATUM.Connector.SolidWorks.csproj -c Release
# or, if SOLIDWORKS is not at the default path:
dotnet build src\DATUM.Connector.SolidWorks\DATUM.Connector.SolidWorks.csproj -c Release -p:SolidWorksDir="D:\SW\SOLIDWORKS"
```

Expect interop signature drift on that first compile: `HoleWizard5`, `AddMate5`,
`FeatureLinearPattern5` and `AutoBalloon5` changed arity between SOLIDWORKS 2022 and
2026. The capability probe degrades across that range at runtime; it cannot help the
compiler.

The Definition of Done items that need a live seat — installer on a clean machine, add-in
loads, real viewport updates from accepted prompts — remain unverified and are reported
as such throughout.

### What compiling actually caught

Compiling was not a formality. It surfaced four defects that review had missed:

| Defect | Consequence had it shipped |
|---|---|
| `JsonElement Params` / `Expect` / `Value` left as `Undefined` | **Showstopper.** `JsonElement` is a struct; an operation with no parameters defaults to `ValueKind.Undefined`, and `System.Text.Json` throws on serialising that. Since an op with no params is the *common* case, affected plans could be neither persisted to SQLite nor sent over the pipe. Caught by `Plan_RoundTripsThroughJsonWithParamsIntact`. |
| Missing `using System.Collections.Generic` in `KernelGateway` | Build error |
| Missing `using Microsoft.AspNetCore.Hosting` in `Program` | Build error — `ConfigureKestrel` unresolved |
| Missing `using System.Net.Http` in `Program` | Build error — `IHttpClientFactory` unresolved |

The orchestrator and test project were also retargeted from `net8.0` to `net8.0-windows`.
That is the honest fix for eight CA1416 warnings on `PipeSecurity` and `WindowsIdentity`:
this service restricts the pipe ACL to the interactive user's SID and exists to talk to
SOLIDWORKS, so it is Windows-only in substance. Suppressing the warnings would have
asserted a portability we cannot deliver.

---

## 3. Status by spec section

Legend — **Verified**: exercised and observed working. **Written**: code exists, not
compiled or run. **Partial**: some of the section. **Missing**: not started.

| § | Requirement | Status | Evidence / gap |
|---|---|---|---|
| 1.1 | Real SolidWorks viewport is source of truth | **Partial** | Kernel executes via API and reads back state (written). The UI's vector view is an explicitly-labelled *offline model*, shown only when no seat is attached — it never claims to be SolidWorks state. Under this spec the native graphics area must be primary; that holds, but the offline view should be suppressed entirely once a seat is connected. |
| 1.2 | Native parametric geometry | **Written** | 9 handler families; no mesh output path exists |
| 1.3 | Controlled agent execution | **Verified** | Closed catalogue; planner cannot emit an unknown op. Grammar generated from the catalogue. |
| 1.4 | Transparency before/after | **Verified** | Plan card shows intent, assumptions, resolved targets, risk badges, tree diff; result card shows verify evidence |
| 1.5 | Safe modification | **Partial** | Read-only + PDM gating written; **checkpoint/backup file writing is not implemented** |
| 2.1 | Add-in responsibilities | **Written** | All listed responsibilities have code |
| 2.2 | WPF/WinUI desktop app | **Missing** | No desktop shell. Studio currently runs in the browser/WebView. |
| 2.3 | Orchestration service | **Written** | Kestrel + pipe + router + validator + store |
| 2.4 | Provider abstraction | **Partial** | Local, BYO-key, managed. **Azure OpenAI and mock provider missing.** Keys via env var, **not Credential Manager**. |
| 2.5 | SQLite persistence | **Partial** | plans/ops/verify/skills tables. **No migrations. Missing: projects, workspaces, checkpoints, file fingerprints, recipes, audit events, telemetry consent.** |
| 3.2 | Model context extraction | **Partial** | Part context solid. **Assembly context thin; drawing context minimal.** |
| 3.3 | Entity reference resolver | **Partial** | PID + name + query + selection. **Missing the multi-strategy fallback ladder** (topological signature, area/centroid, adjacency, confidence scoring). |
| 3.4 | Bidirectional selection sync | **Written** | Selection → PIDs → context; op hover → viewport highlight |
| 3.5 | Real-time state sync | **Verified** | Ring buffer → 30 Hz coalescing pump → WebSocket → store. Connection badge implemented. |
| 4 | Operation schema | **Partial** | Has id, op, target, params, preconditions, resolved, verify. **Missing: `riskLevel`, `requiresApproval`, `confidence` as first-class fields** (risk is derived from traits, not declared per-op). |
| 4.1–4.8 | Operation families | **Partial** | Catalogued: ~200. Implemented handlers: sketch, feature, feature.edit, param, config, asm, drw, doc, query, meta. **Not implemented: weldments, surfaces, most sheet-metal.** |
| 5 | Four interaction modes | **Verified** | Ask / Build / Edit / Batch, with Ask provably non-mutating via trait gating |
| 6 | Designer pain points | **Partial** | Repetitive modelling, fragile references, drawings, DFM covered. **Impact analysis and dependency visualisation missing.** |
| 7 | Input methods | **Partial** | Text, selection, mode. **Voice, drag-drop, image, PDF, CSV/Excel are UI affordances with no handlers behind them.** |
| 8 | Agent architecture | **Partial** | Planner + validator + verification + repair. **No separate Intent, Context, Critic, or Safety agent.** |
| 9 | Operation tool registry | **Partial** | Handler registry with dispatch. **No per-tool `PreflightAsync`/`VerifyAsync` interface as specified.** |
| 10 | Checkpoint/undo/recovery | **Partial** | Undo scope + in-memory undo stack. **No file checkpoints, no crash recovery, no resume.** |
| 11 | UI/UX | **Verified** | Design system, both surfaces, all states. Swept at 320/380/520 and 1440 — no layout defects. |
| 11.6 | Command palette | **Missing** | Shortcuts partially bound; **no `Ctrl+K` palette** |
| 12 | Real-time communication | **Partial** | Streaming + cancellation + heartbeat + reconnect. **No idempotency keys** — a reconnect could re-dispatch. |
| 13 | Performance | **Partial** | Fast-execution scope, coalescing, lock-free ring, PID cache. **No virtualised lists; no large-assembly mode.** |
| 14 | Security | **Partial** | Loopback-only, token auth, pipe ACL, CSP, injection-resistant prompt framing. **Missing: Credential Manager, signed updates, dependency scanning.** |
| 15 | PDM | **Partial** | Lock detection and gating written. **No check-out adapter, no workflow/state reads.** |
| 16 | Recipe builder | **Missing** | Batch view runs fixed recipes; **no builder, no persistence, no dry-run/versioning model** |
| 17 | Manufacturability rules | **Partial** | CNC rules verified working. **Sheet metal, additive, injection moulding missing.** |
| 18 | Search / knowledge index | **Missing** | Reuse Index view is a static list; **no indexer** |
| 19 | Testing | **Partial** | `tests/DATUM.Tests` covers IR, wire protocol, catalogue, validator, grammar. **Unverified — cannot run.** No integration, E2E, failure or performance suites. |
| 20 | Observability | **Partial** | Structured kernel log + correlation via plan/op ids. **No diagnostics screen, no support bundle.** |
| 21 | Installer | **Missing** | No MSI, no update channel |

---

## 4. Branding configuration (§ "changeable through configuration")

Implemented and verified. `ui/src/brand.ts` resolves identity in order: host injection
(`window.FORGE_BRAND`) → `VITE_BRAND_*` build variables → defaults.

Verified by building with `VITE_BRAND_NAME=ForgePilot` and confirming the name reaches
the production bundle. The undo prefix and feature tag are branded deliberately: both are
written into the customer's document, so a rebrand that missed them would leak the old
name into real engineering files.

The C# side still hardcodes `"DATUM"` in `UndoScope`, `TaskPaneHost`, `CommandUi` and
`KernelLog`. Those need the same treatment via a `BrandOptions` record before a rename is
complete.

---

## 5. Honest completion estimate

Of the spec's 28 sections: roughly **8 verified**, **12 partial**, **8 missing**.

The largest missing pieces, in dependency order:

1. **Compile and run the C#.** Everything downstream is unverifiable until this happens.
   Requires a machine with .NET 8 SDK, .NET Framework 4.8 dev pack, and a SOLIDWORKS seat.
2. **File checkpoints and crash recovery** (§10) — the spec's safety story depends on it,
   and undo alone is not a recovery mechanism.
3. **Desktop shell** (§2.2) — currently no WPF/WinUI app exists.
4. **Recipe builder** (§16) and **workspace index** (§18) — both are currently views
   without engines.
5. **Installer** (§21).

---

## 6. What was actually done this session

Verified in-browser, not asserted:

- **Fixed a flex-shrink defect** crushing plan cards to 197 px against a 565 px natural
  height, which also made the conversation unscrollable.
- **Fixed silent message loss** — input sent while the planner was busy vanished; it now
  queues and dispatches.
- **Fixed auto-scroll** hijacking the reader's position.
- **Fixed a 4 px slider hit target** → 20 px, with the visual rail moved to
  `::-webkit-slider-runnable-track`.
- **Raised undersized controls** to the spec's minimum target (chip 24→28, pill 21→26).
- **Swept all 10 Studio views** at 1440 and all 4 panel tabs at 320/380 — no crushed
  children, no horizontal overflow, no page-level scroll.
- **Added branding configuration** and proved it with a white-label build.
