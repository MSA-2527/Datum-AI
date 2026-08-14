# DATUM — UI / UX Specification

> Design system, layouts, every screen, interaction flows, real-time affordances, and states.

---

## 1. Design principles

1. **Belong to SOLIDWORKS, don't compete with it.** The 3D viewport is sacred — DATUM never covers it with a modal. All persistent UI is docked or in a separate window.
2. **Nothing surprising ever happens.** Every mutation is previewed. Every preview shows its resolved targets highlighted in the actual model.
3. **State assumptions out loud.** The assumptions list on a plan card is a first-class UI element, not fine print.
4. **The panel is narrow — respect it.** 320–520 px. Design for 380 px and let it breathe wider. No horizontal scrolling, ever.
5. **Density over decoration.** CAD users are professionals staring at this for eight hours. Information density like a good IDE, not a consumer chat app.
6. **Deterministic actions look different from AI actions.** Skills, recipes, and direct parameter edits use a distinct visual language (solid, blue, "engineering") from AI-planned work (accented, "reasoning"). Users must always know which one they're getting.
7. **Free never feels like a trial.** No greyed-out ghosts of paid features scattered through the UI. Upgrade prompts appear contextually, once, at the moment of genuine capability limit.
8. **Keyboard-first.** Every primary action has a shortcut. CAD users live on the keyboard.

---

## 2. Design system

### 2.1 Colour

Dark is the default (SOLIDWORKS users run dark or grey UIs; the graphics area is light-grey gradient, so a dark panel creates clean separation). Light theme is fully supported.

```
Dark (default)                        Light
--bg-0    #0D1117  app background     #F6F7F9
--bg-1    #151B23  panel surface      #FFFFFF
--bg-2    #1C232D  raised card        #FFFFFF
--bg-3    #232C38  input / hover      #EEF1F5
--line-1  #2A3441  hairline border    #DDE2E9
--line-2  #384454  strong border      #C6CDD8

--txt-0   #E6EDF6  primary            #0E1621
--txt-1   #9FB0C4  secondary          #55637A
--txt-2   #63748A  tertiary / meta    #8794A8

--accent      #4C8DFF   DATUM blue — AI / plans / primary actions
--accent-dim  #1E3358
--determ      #16C79A   teal — deterministic (skills, recipes, direct edits)
--warn        #F5A524   amber — assumptions, risk, unresolved
--danger      #F2495C   red — destructive, errors, failed verify
--ok          #2FBF71   green — verified, passed
--viz         #A78BFA   violet — geometry highlight / selection linkage
```

Semantic use is strict: **teal always means "deterministic, no model involved"**, **blue always means "AI-planned"**, **amber always means "you should read this before continuing"**. Never decorative.

### 2.2 Typography

- UI: **Inter** — 13 px base in the panel, 14 px in Studio. Line-height 1.45.
- Numeric / dimensional: **JetBrains Mono**, tabular figures. All dimensions, masses, tolerances, and IDs are monospaced so columns align and digit changes don't shift layout.
- Scale: 11 / 12 / 13 / 15 / 18 / 22 / 28.
- Weight: 400 body, 500 labels, 600 headings. Nothing heavier — bold text at density reads as noise.

### 2.3 Space & shape

- 4 px base grid. Panel gutter 12 px. Card padding 12 px. Section gap 16 px.
- Radius: 6 px controls, 8 px cards, 10 px modals, 999 px chips.
- Elevation via border + subtle inner highlight, not big shadows — flat and technical.
- Minimum hit target 28 px (dense professional tooling; 32 px in Studio).

### 2.4 Motion

- 120 ms for state changes, 180 ms for entrances, `cubic-bezier(0.2, 0, 0, 1)`.
- Streaming op cards fade+rise 8 px.
- **No motion on the viewport highlight** — geometry highlighting is instant, always.
- `prefers-reduced-motion` removes all transforms, keeps opacity.

### 2.5 Iconography

Line icons, 1.5 px stroke, 16 px grid. Feature icons **mirror SOLIDWORKS's own feature iconography** (extrude, revolve, fillet, pattern…) so the tree mirror is instantly legible to an existing user. Op-type icons are consistent between the plan card, the op log, and the history timeline.

### 2.6 Accessibility

- All text ≥ 4.5:1 against its background; large text ≥ 3:1. Both themes validated.
- Never colour alone: risk badges carry an icon + label; verify checks carry ✓/⚠/✕ glyphs.
- Full keyboard traversal with a visible 2 px focus ring in `--accent`.
- Live regions announce plan state changes and batch progress.
- Respects Windows high-contrast mode and OS text scaling to 200%.

---

## 3. Surface 1 — The Task Pane panel (primary)

Docked inside SOLIDWORKS. 380 px default, resizable 320–560 px.

```
┌──────────────────────────────────────────┐
│ ▣ DATUM        ● Local · Qwen14B   ⚙ ⤢  │  32px  header
├──────────────────────────────────────────┤
│ bracket_v3.SLDPRT  ·  Default  ·  ✎ mm  │  28px  context bar
│ ✓ checked out    ⟳ rebuilt 0.4s   ⚠ 2   │        (live)
├──────────────────────────────────────────┤
│                                          │
│   ┌────────────────────────────────┐    │
│   │ You                             │    │
│   │ add mounting holes for a NEMA17 │    │  conversation
│   │ and fillet the outer corners    │    │  stream
│   │ 🔗 Face<1>                      │    │
│   └────────────────────────────────┘    │
│                                          │
│   ┌────────────────────────────────┐    │
│   │ ⬤ PLAN  ready         2 ops    │    │
│   │ ──────────────────────────────  │    │
│   │ Adds a NEMA 17 mounting pattern │    │  plan card
│   │ and R3 corner fillets.          │    │
│   │                                  │    │
│   │ ⚠ Assumptions            2  ▾   │    │
│   │ · M3 clearance, normal fit      │    │
│   │ · R3 to match Boss-Extrude1     │    │
│   │                                  │    │
│   │ ▸ ⬡ Hole Wizard  M3×4  ⟶ Face<1>│    │
│   │ ▸ ◟ Fillet  R3  ⟶ 12 edges      │    │
│   │                                  │    │
│   │ Tree diff  +2 features           │    │
│   │ ──────────────────────────────  │    │
│   │  Preview ▸      [ Apply  ⏎ ]    │    │
│   └────────────────────────────────┘    │
│                                          │
├──────────────────────────────────────────┤
│ 3 faces selected                    ✕   │  selection chip
├──────────────────────────────────────────┤
│ ┌──────────────────────────────────────┐ │
│ │ Describe the change…                 │ │  composer
│ │                                      │ │
│ │ ~ Edit ▾  🎤 📎 📷      ▲ Send      │ │
│ └──────────────────────────────────────┘ │
├──────────────────────────────────────────┤
│ 💬  ⌗ Tree  ⚙ Params  ⚡ Skills  ⚠2  ⏱ │  32px  tab rail
└──────────────────────────────────────────┘
```

### 3.1 Header

- Logo + wordmark, compact.
- **Provider chip** — the most important status in the app. Shows the active provider and model with a state dot: `● Local · Qwen14B` (teal, offline-safe) / `● BYO · Claude Sonnet 5` (blue) / `● Pro · Opus 5` (violet-gold) / `○ Disconnected` (grey). Click to switch providers inline without leaving the panel.
- `⚙` settings, `⤢` pop out to Studio.

### 3.2 Context bar (always live)

Line 1: document name · active configuration · units. Line 2: status pills, each with an instant tooltip:
- **PDM state** — `✓ checked out` (ok) / `🔒 locked by J. Diaz` (danger, mutations blocked) / `— no vault` (muted)
- **Rebuild** — `⟳ 0.4 s` with a spinner while rebuilding
- **Health** — `⚠ 2` linter findings, click to jump to the linter tab
- **Selection** appears here when non-empty on narrow widths

The context bar is the app's proof that it is actually connected and watching. It must never go stale — if the delta stream drops, it visibly greys and shows `reconnecting…` rather than lying.

### 3.3 Tab rail (bottom)

`Chat` · `Tree` (Model Explorer) · `Params` (Parameter Inspector) · `Skills` · `Health` (linter, with count badge) · `History`. Bottom placement keeps it near the thumb/cursor's resting position after using the composer, and mirrors SOLIDWORKS's own bottom-docked panes.

### 3.4 Composer

- Auto-growing textarea, 2 rows → max 8 rows.
- **Mode chip** on the left: `? Ask` / `+ Build` / `~ Edit` / `⧉ Batch`. `Tab` cycles. The chip's colour tints the composer border so mode is unmissable — Ask is grey (safe), Build/Edit are blue, Batch is teal.
- `/` command palette: skills, recipes, `/constrain`, `/explain`, `/lint`, `/measure`, `/export`, `/batch`.
- `@` reference picker: features, dimensions, components, configs, files, templates — searchable, inserts a PID-bound token rendered as a chip.
- Attachments row appears above the input when files/images are attached, each with a thumbnail and a remove button.
- Buttons: mic (push-to-talk `Ctrl+Space`), paperclip, **capture viewport** (grabs the SOLIDWORKS graphics area and opens the markup annotator).
- `Enter` sends, `Shift+Enter` newline, `Esc` clears/cancels.

### 3.5 Plan card anatomy

```
┌────────────────────────────────────────────┐
│ ⬤ PLAN · ready              2 ops   ⋯     │   status strip
├────────────────────────────────────────────┤
│ Adds a NEMA 17 mounting pattern and         │   intent (editable)
│ R3 corner fillets.                          │
│                                             │
│ ⚠ Assumptions                        2 ▾   │   amber, expandable
│   · M3 clearance holes, normal fit    ✎    │   each editable → replan
│   · R3 chosen to match Boss-Extrude1  ✎    │
│                                             │
│ ┌─────────────────────────────────────────┐ │
│ │ ⬡  Hole Wizard                     ▾   │ │   op row
│ │    M3 clearance ×4, through all         │ │
│ │    ⟶ Face<1> of Boss-Extrude1           │ │   resolved target
│ │    ● topology-change                    │ │   risk badge
│ ├─────────────────────────────────────────┤ │
│ │ ◟  Fillet                          ▾   │ │
│ │    Constant R3, propagate               │ │
│ │    ⟶ 12 edges  ⓘ show                   │ │   click = highlight in 3D
│ └─────────────────────────────────────────┘ │
│                                             │
│ Tree diff        Boss-Extrude1              │   before/after tree
│                 +M3 Clearance Hole1         │
│                 +Fillet2                    │
├────────────────────────────────────────────┤
│ Dry run ▸   Save as Skill    [ Apply ⏎ ]   │
└────────────────────────────────────────────┘
```

**Interaction details that matter:**
- Hovering an op row highlights its resolved geometry **in the SOLIDWORKS viewport** in `--viz` violet. This is the killer affordance — the user verifies the AI understood the target without reading a word of JSON.
- Clicking `▾` on an op reveals the raw parameters in an editable monospace form. Editing marks the plan `modified` and requires re-resolve (fast, local, no model call).
- Dragging an op row reorders; the DAG validator immediately flags an invalid order.
- `⋯` menu: view IR JSON, copy plan, export, replay elsewhere.
- Ops with unresolved targets render amber with a `pick target` button that puts SOLIDWORKS into a selection mode.

### 3.6 Streaming states

| State | Visual |
|---|---|
| `streaming` | Header pulses blue; op rows appear one at a time with a skeleton, filling as tokens arrive. `Cancel` is always available. |
| `resolving` | Each op row shows a small spinner where the target count will be; resolves left-to-right. |
| `ready` | Solid border, Apply enabled and focused. |
| `running` | Per-op progress: a thin determinate bar along the bottom of each row, current op has an animated left edge. Overall time elapsed in the header. |
| `done` | Collapses into the result card. |
| `failed` | Red border, failing op expanded with the COM error, rollback status stated explicitly ("Model restored to pre-plan state"). |

### 3.7 Result card

```
┌────────────────────────────────────────────┐
│ ✓ APPLIED · 1.8 s              2/2 ops     │
├────────────────────────────────────────────┤
│ Verify                                      │
│  ✓ Rebuild errors        0 → 0             │
│  ✓ Mass                  184 g → 179 g  −2.7%│
│  ✓ Interference          none               │
│  ⚠ Linter                12 → 13   +1 new  │
│    └ Hole1 not fully defined        Fix ▸  │
├────────────────────────────────────────────┤
│ ↺ Undo    ⟲ Restore snapshot    Explain     │
│ ⚡ Save as Skill                             │
└────────────────────────────────────────────┘
```

Verify rows are the heart of production trust: they turn "the AI did something" into "here is measurable evidence of what changed."

---

## 4. Surface 2 — DATUM Studio (standalone window)

For work that doesn't fit a 380 px pane. Opens with `⤢` or from the ribbon. Same React bundle, `layout=studio`.

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ ▣ DATUM Studio      bracket_v3.SLDPRT ▾    ● Pro · Opus 5     ⌕      — □ ✕       │
├────┬──────────────────────────┬────────────────────────────┬─────────────────────┤
│    │                          │                            │                     │
│ 💬 │  MODEL EXPLORER          │      VIEWPORT MIRROR       │   COPILOT           │
│ ⌗  │  ─────────────────────   │                            │   ───────────────   │
│ ⚙  │  ⌕ filter…               │    ┌──────────────────┐    │   [conversation]    │
│ ⚡ │                          │    │                  │    │                     │
│ ⧉  │  ▾ bracket_v3            │    │   live thumbnail │    │   [plan cards]      │
│ ▤  │    ⌗ Annotations         │    │   from SOLIDWORKS│    │                     │
│ ⚠  │    ◫ Material 6061-T6    │    │   2–4 fps        │    │                     │
│ ⧉  │    ▭ Front Plane         │    │                  │    │                     │
│ ⏱  │    ▭ Top Plane           │    └──────────────────┘    │                     │
│ ⚙  │    ▾ ⬢ Boss-Extrude1     │                            │                     │
│    │        ✎ Sketch1  ⚠      │    ⊞ Iso  ⊟ Front  ⊡ Fit  │                     │
│    │    ⬡ M3 Clearance Hole1  │                            │                     │
│    │    ◟ Fillet2       ⬤AI   │  ─────────────────────────  │                     │
│    │    ⬡ CutExtrude1   ⚠     │  PARAMETERS                │                     │
│    │                          │  Length   ▓▓▓▓▓░░░  62.0 mm │                     │
│    │  ── health ──            │  Width    ▓▓▓░░░░░  40.0 mm │  ─────────────────  │
│    │  14 features · 0.4 s     │  Thick    ▓▓░░░░░░   5.0 mm │  [ composer ]       │
│    │  2 warnings · 0 errors   │  mass 179 g   bbox 62×40×5 │                     │
├────┴──────────────────────────┴────────────────────────────┴─────────────────────┤
│ ⏱ OP LOG   14:22:07  ✓ Fillet2 applied (1.8s)   14:19:44  ✓ Property fill …  ▴  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

- **Left rail (56 px)**: Chat, Model Explorer, Parameters, Skills, Batch, Drawings, Health, Reuse Index, History, Settings. Icons with tooltips; active item marked with a 2 px accent bar on the left edge.
- **Centre**: viewport mirror (throttled JPEG stream, click-through to focus SOLIDWORKS) with view-preset buttons, plus the parameter strip beneath it.
- **Right (400 px, collapsible)**: the same Copilot panel as the task pane.
- **Bottom (collapsible, 28 px collapsed / 220 px expanded)**: op log console with filters and a live tail.
- Panels are resizable and the layout persists per user.

### 4.1 Studio views (left rail destinations)

| View | Layout |
|---|---|
| **Chat** | Full-width conversation with a wider plan card (raw IR side-by-side) |
| **Model Explorer** | Tree left, feature detail drawer right, dependency graph tab |
| **Parameters** | Full-width Variant Matrix grid + equation editor + goal-seek panel |
| **Skills** | Card grid (name, version, owner, last run, health) → detail with input schema editor, op template, test results, run form |
| **Batch** | 4-step wizard, then a live results grid (virtualised, thousands of rows) |
| **Drawings** | Template gallery → drawing queue → per-drawing preview with standards-check results |
| **Health** | Findings list grouped by rule, with bulk fix, suppression management, and a score trend chart |
| **Reuse Index** | Search bar + result grid with thumbnails, similarity scores, where-used counts; index status/crawl controls |
| **History** | Timeline with filters, diff viewer, snapshot restore, replay |
| **Settings** | Providers, models, egress ledger, policy, standards, templates, export profiles, account/tier |

---

## 5. Key flows

### 5.1 First run (must take under 5 minutes to first value)

1. **Welcome** — one screen: *"DATUM works offline and free. Pick how it thinks."*
2. **Provider choice** — three cards:
   - **Local model** (recommended, free) — shows detected hardware, recommends a GGUF size, downloads with progress. Honest capability note.
   - **Use my own API key** (free) — paste key, choose provider, test connection.
   - **DATUM Pro** — try free for 14 days, no card.
   Skip is allowed: *"Continue without AI"* → the deterministic core works immediately.
3. **Connect SOLIDWORKS** — detects running instance, registers the add-in, verifies with a live handshake showing the detected version and enabled capability set.
4. **Guided first win** — with a part open, DATUM suggests one high-value zero-risk action based on the actual model: *"This part has no material assigned and 3 empty properties. Fill them?"* → preview → apply → undo demo. The onboarding **teaches undo explicitly**, because that's what makes people brave.

### 5.2 Edit flow (the most common path)

Select geometry in SOLIDWORKS → panel selection chip updates live → type intent → plan streams in → hover ops to see targets highlighted in 3D → adjust a param inline → `Enter` → progress → result card with verify → done. Any regret: `Ctrl+Z`.

### 5.3 Build flow with reuse interception

Build mode → describe part → **before** the plan, a reuse card appears if the index has strong matches → user either inserts the existing part (best outcome, zero modelling) or dismisses → plan proceeds.

### 5.4 Batch flow

Targets → operation → configure → **dry run** (report grid) → run (live grid) → report. Dead-letter retry. Free tier shows the 25-target cap as a clear, non-nagging line in the target step with the count of excluded files.

### 5.5 Drawing flow

Part open → `Drawings` → template picker (with previews) → generate → live progress per stage (views → dims → balloons → BOM → title block) → standards check results → fix issues → export.

### 5.6 Capability escalation

Local model can't handle it → **capability card**, not an error:

```
┌──────────────────────────────────────────┐
│ ⚠  This is beyond your local model       │
│                                          │
│ 14 dependent steps, assembly mating.     │
│ Qwen14B completed 6 of 14 in dry run.    │
│                                          │
│ [ Run the 6 it got right ]               │
│ [ Use my API key ]                       │
│ [ Try Pro free for 14 days ]             │
│                            not now  ✕    │
└──────────────────────────────────────────┘
```

Shown at most once per session per task class. Never blocks; always offers the partial result.

---

## 6. Real-time affordances inventory

| Element | Source | Latency target |
|---|---|---|
| Selection chip | `UserSelectionPostNotify` | < 100 ms |
| Feature tree mirror | `AddItemNotify` / `DeleteItemNotify` / `RenameItemNotify` | < 150 ms, coalesced |
| Rebuild badge + timing | `RegenPostNotify2` | < 100 ms |
| Parameter values | `RegenPostNotify2` + dimension change | < 150 ms |
| Mass / bbox readout | recomputed on rebuild (async, cached) | < 400 ms |
| Linter findings | debounced 400 ms after rebuild | < 800 ms |
| PDM lock state | PDM hooks + 30 s poll fallback | < 1 s |
| Viewport mirror | throttled JPEG on view idle | 2–4 fps |
| Plan op streaming | LLM token stream | first op < 1.5 s |
| Batch item progress | per-item event | immediate |
| Connection health | pipe heartbeat 1 Hz | drop detected < 2 s |

**Degradation rule:** if the stream stalls, every live element visibly desaturates and the context bar shows `reconnecting…`. The UI must never present stale data as current — that is worse than showing nothing.

---

## 7. States catalogue

Every surface specifies these. Examples:

| Surface | Empty | Loading | Error | Offline |
|---|---|---|---|---|
| Chat | Suggested starters derived from the *actual* open document ("this part has 2 unresolved warnings — investigate?") | Skeleton plan card | Failure with the exact reason + retry | "Local model ready — you're offline and that's fine" |
| Model Explorer | "No document open — open a part or assembly" | Tree skeleton | "Lost connection to SOLIDWORKS" + reconnect | Last known tree, greyed, with a staleness timestamp |
| Parameters | "No global variables. Create one?" with a one-click add | Row shimmer | Equation error inline on the row | Read-only, greyed |
| Skills | "No skills yet — turn a plan into one, record your actions, or import a macro" (three cards) | Card skeletons | Broken-skill badge with failing test | Local skills fully usable |
| Batch | "Pick targets to begin" | Target count spinner | Dead-letter list | Queue persists; runs when reconnected |
| History | "Nothing yet — your first plan will appear here" | — | — | Fully available (local DB) |

---

## 8. Keyboard map

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+D` | Toggle DATUM panel |
| `Ctrl+Shift+K` | Focus composer from anywhere in SOLIDWORKS |
| `Tab` (in composer) | Cycle mode |
| `/` `@` | Command palette / reference picker |
| `Ctrl+Space` | Push-to-talk |
| `Enter` / `Shift+Enter` | Send / newline |
| `Ctrl+Enter` | Apply the focused plan |
| `Ctrl+Shift+Enter` | Dry run |
| `Esc` | Cancel streaming / discard plan / clear |
| `Ctrl+Z` | Undo (native SOLIDWORKS undo — DATUM plans are one step) |
| `Ctrl+F` | Search the tree mirror |
| `Ctrl+1..6` | Switch panel tabs |
| `F8` | Open Studio |
| `Alt+↑ / ↓` | Move between op rows |

---

## 9. Copy & tone

- Plain engineering English. No exclamation marks, no "Great question!", no emoji in product copy (icons only).
- Say what happened with numbers: *"Applied 2 operations in 1.8 s. Mass 184 g → 179 g."*
- Never claim certainty the system doesn't have. *"Assumed M3 clearance"* not *"Added the correct holes."*
- Errors state the cause, the consequence, and the next action, in that order: *"Face<1> no longer exists after Fillet2 was edited. The plan stopped before making changes. Pick a new face, or undo Fillet2 first."*
- Upgrade copy is factual and specific about the limit hit — never aspirational marketing inside the tool.

---

## 10. Iconography for op types (plan card / tree / log consistency)

| Namespace | Glyph family |
|---|---|
| `sketch.*` | pencil / sketch-plane |
| `feature.*` add | filled solid glyphs matching SOLIDWORKS (boss, cut, fillet, chamfer, shell, pattern) |
| `feature.edit.*` | same glyph with a small `~` overlay |
| destructive | same glyph with a red minus badge |
| `param.*` | slider / sigma |
| `config.*` | stacked layers |
| `asm.*` | linked-cubes |
| `drw.*` | sheet with view frames |
| `pdm.*` | vault/lock |
| `query.*` | magnifier (never carries a risk badge — read-only) |
| `script.macro` | terminal glyph, always amber-outlined |

---

## 11. Responsive behaviour

| Width | Layout |
|---|---|
| ≥ 1440 px (Studio) | Full four-column layout |
| 1100–1440 px | Viewport mirror collapses; explorer + copilot |
| 520–800 px (wide pane) | Two-column: stream + collapsible side tab content |
| 380–520 px (default pane) | Single column, bottom tab rail |
| 320–380 px | Compact: context bar collapses to one line, op rows lose the raw-param preview |

Below 320 px the panel shows a "widen to use DATUM" hint rather than degrading into unusability.
