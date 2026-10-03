# Recon exploratory windtunnel — polar hardening program

Goal: make Scout+Arbiter (+ unit/e2e/verify:real) a reliable **windtunnel** — when the
full suite passes, there are NO user-visible bugs. Method: 10 rounds × 20 distinct
exploratory cases (as a developer would actually use CodeAtlas). Each round: plan 20
fresh cases on *what's left to test* → enhance Scout/Arbiter/suite → run → log bugs →
fix in logged order (TDD) → re-run Scout+Arbiter to validate. Polar first, then port
learnings to the other e2e repos.

## 10-round coverage map (what a developer does, step by step)

| Rnd | Theme (developer journey) | Focus |
|---|---|---|
| 1 | **Backend deep drill** | L2b→L3→L4→L5 landing per endpoint; participant ORDER; message direction; named-handler resolution; source-nav (file:line); anchor restore |
| 2 | **Frontend deep drill** | screen L2a(grouped by screen/page/component)→L3 render-flow→L4 component↔hook↔data; screen-content 5 sections; adaptive noun; no-hallucination |
| 3 | **Change→visualize (diff)** | edit file→resync→L1 `~` + changed APIs/sequences; add-a-feature (extra files) shows at every layer; delete; diff accuracy (only+all changed) |
| 4 | **Replay** | working-changes / PR / branch / timeline replay stepping; added-feature replay; per-layer replay |
| 5 | **Impact analysis** | blast radius per function (direct/transitive/review); cross-repo impact; visual highlight + DOM |
| 6 | **Health accuracy** | dead-code (no framework-handler false pos), god files, coupling, cycles, orphaned clusters — findings correct |
| 7 | **Search / nav / breadcrumbs / deep-links** | search API/fn/file→jump; breadcrumb up/down; `vscode://` deep-link restore; back/forward |
| 8 | **Cross-repo (multi-repo)** | picker category/noun; cross-repo edges; per-repo isolation; cross-repo impact; scoped L1-L5 |
| 9 | **Detection accuracy** | counts vs baseline; entry-point KINDS (job/mq/cli/migration/webhook/socket/subscription) real, no false pos; mount prefixes |
| 10 | **Overlays / comments / export / AI review / tours / KMap / domains** | each feature opens + accurate; overlays join anchors; export docs; tour steps; domain clustering |

## Round log

### Round 1 — Backend deep drill (planned 20 cases)
CONNECT-01 (multi-endpoint L3→L4→L5 walk) + L3-01/02, L4-01/02, L5-01/02, NAV-01/02,
ANCHOR-01..04, plus per-endpoint accuracy: participant-order, message-direction,
named-handler, source-line, sequence-return-to-actor. Run: build `9.0.37-rerun`.

Candidate bugs surfaced by the run (to confirm real-vs-selector before logging):
- CONNECT/L4: participant click did not reach `#/file/` (L4) for GET /orders, /{id}/retry, POST /benefits/slack.
- L4-01/02, L5-01/02: default drill didn't reach the layer (may be selector).
- RENDER-02: frontend screen rows on `#/features/clients` did not drill (L3 landed=false).

## Bug log (fix in this order, TDD)
_(populated as bugs are CONFIRMED real during rounds)_

- BUG-L1-SLOW-OPEN — FIXED 9.0.37 (extension.ts async serve + fallback).
- BUG-L5-WRONGFILE / BUG-L5-UNCLICKABLE — FIXED 9.0.37 (callGraphResolver resolveNonJsModulePath + edge-click feedback).
- BUG-SUBSCRIPTION-FALSEPOS — FIXED 9.0.37 (graphql.ts real-graphql gate; polar workspace APIs 946→911).
- BUG-FE-BACKEND-FILTERS — FIXED 9.0.37 (ApiListPanel adaptive tabs + Screens→L3).

## Round 1 RESULTS (judged 53 cases across 4 judge agents)
Fix-validations HELD: BUG-CONNECT-3 (participant order, all 3 endpoints), BUG-L5-WRONGFILE (correct file opens), BUG-SUBSCRIPTION-FALSEPOS (ENTRY-NOHALLUCINATION pass — no Real-Time section), L4 File Diagram (42 nodes) + L5 flow both work, HEALTH dead-code clean, ENTRY kinds all pass, TOUR spans repos.

Confirmed bugs (fix in this order, TDD):
1. **BUG-CAPTURE-L4L5-SELECTOR** (windtunnel) — capture.mjs recorded `landed` from the PRE-navigation hash → false "L4/L5 unreached" alarms on working features. FIXED: added `settleHash()` polling in captureFlowWalk (L4/L5) + captureScreenWalk (L3).
2. **BUG-FE-NO-L3L4L5-L2A** (product, P1) — frontend `#/features/clients` L2a SCREEN rows do not navigate on click (hash stays `#/features/clients`); L3 render-flow + L4 component↔hook↔data unreachable. Also blocks RENDER-01 (5-section screen-content) + MOBILE-02 (Mobile Lifecycle). Agent C fixed the workspace api-list panel; the ScreenListView (L2a) rows are a separate surface still not wired.

## Round 1 COMPLETE — fixed + validated on v9.0.38
All 3 confirmed bugs fixed TDD + live-validated:
1. BUG-CAPTURE-L4L5-SELECTOR (windtunnel stale landed-flag) — `settleHash()` polling + skip `/(group)/*` headers in screen-walk. Reduces false "unreached" alarms.
2. BUG-FE-NO-L3L4L5-L2A (product) — `App.tsx handleNodeClick` had no `type:'graph'` branch → screen rows no-op'd. FIXED (+decideNodeClick +FeatureView fallback, 898 webview tests). LIVE: screen `/(main)/auth/backup-codes` → `#/screen/...`. Scout: RENDER-02 real screens now `l3.landed=true`.
3. BUG-L1-CROSSREPO-EDGE (P0 REGRESSION — stored skeletal written before cross-repo pass → edges:[]) — extracted `buildCrossRepoEdges` + serve-time injection (extension.ts + messageHandler.ts parity, +test). LIVE: L1 draws "GET /" clients→server edge (rfEdges=1).

Windtunnel health: caught 2 real product bugs + 1 P0 regression + 1 harness self-flaw in ONE round — exactly the intent. Extension-host 5611 tests, webview 898, lint 0.

Harness follow-ups (Round-1 tail, not product bugs): L4 participant→file landing still flags for some endpoints in capture.json though Judge A confirmed L4 works via screenshot (42-node File Diagram) — a capture selector/timing item for the participant-click, to tune in a later pass.

## NEXT: Round 2 — Frontend deep-drill
screen-content 5-section L2b (Interactions/Data/Lifecycle/Nav-in/Nav-out); screen→L3 render-flow→L4 component↔hook↔data now reachable (post FE-nav fix); mobile lifecycle (PUSH/BG_TASK/LIFECYCLE); adaptive noun; no-hallucination. + Rounds 3-10 per the map above. Then port learnings to other e2e repos.

## Round 2 — Frontend deep-drill (findings)
Enhanced screen-walk: screen → screen-content L2b (5 sections) → deeper drill. Screens now drill (FE-nav fix validated: SC.landed=true).
Bugs:
1. **BUG-CAPTURE-SCREEN-SECTIONS** (windtunnel) — section regex looked for "Nav-in/out"; actual labels are "Navigation in/out". FIXED regex → sections now detected.
2. **BUG-FE-NEXTJS-SCREEN-CONTENT** (product) — Next.js App Router screens show Navigation-out (0) / Data (0) even when they navigate/fetch. Extractor handles `<Link to>` (react-router/Remix) + `router.push` but NOT: `redirect()`/`notFound()` from `next/navigation` (server-side nav-out), Next.js `<Link href>` (vs `to`), server-component data fetch. Confirmed on polar checkout page (uses `redirect`+`notFound`, shows Nav-out 0). Fix TDD in screenContentExtractor.ts.

## Round 3 — Change→visualize (diff journey) — IN PROGRESS
Live probe: added `probe_round3_added` to server/polar/kit/operator.py, watched the cascade.
Finding (candidate): **BUG-DIFF-SLOW-REFLECT** — on a large repo (polar, 3144 files) editing a file leaves the L1 "Loading…" for 30s+; extension host observed CPU-pegged (116%, 1.7GB). The diff DOES cascade (file→working differs from baseline), but the developer waits a long time to SEE the change on L1. Conflated with the fresh-init tail (LLM naming across 911 APIs + 421 screens still settling) — needs isolation on a settled index before confirming as a distinct per-edit perf bug. Related to the scoped-L1 async-serve fix (Round-1 BUG-L1-SLOW-OPEN) but this is the workspace-L1 + cascade path. Probe reverted; polar clean.

Remaining rounds 4-10 queued (replay, impact, health, search, cross-repo, detection, overlays). Each needs a settled polar index + a rebuild/reinit cycle per fix.

## Round 3 — ISOLATED (settled index, extension CPU 0% before edit)
BUG-DIFF-SLOW-REFLECT upgraded to **BUG-DIFF-MULTIREPO-NOREFLECT** (P0, confirmed, NOT init-tail):
Baseline: settled L1 opens in 868ms. Then edit ONE sub-repo file (server/polar/kit/operator.py, +1 function) →
- extension host spikes 205% → sustains ~110% for 2+ MINUTES, never settles (hung/runaway cascade);
- server store `files` row for kit/operator.py keeps the SAME hash in working AND baseline (working snapshot NEVER updated with the edit — verified in state.db);
- L1 shows "No changes", no `~modified` on the server node.
So on multi-repo polar, a sub-repo edit is (a) not reflected and (b) hangs the ext host. `addCrossFileEdges` already has the O(n²) cap (callGraphResolver.ts:425/432) — so the hang is the ROUTING: sub-repo save likely hits the monolithic `SyncOrchestrator.rebuildFile` (buildCallGraph over the 3144-file aggregate, ~L2890) instead of the owning per-repo orchestrator. Root-cause agent dispatched. Probe reverted; polar clean.

## Round 3 — FIXES SHIPPED (9.0.40) + validated (partial)
Two fixes integrated (host 5618 tests, lint 0):
1. **Durability (CONFIRMED FIXED, P0)** — persist edited file's working record BEFORE the cascade + setImmediate yield. Live-validated: body-only edit to operator.py → working snapshot hash changed dda48e8e→e5a1b90f (comment present). Before: working hash stayed == baseline (edit never reflected). So the diff journey now REFLECTS edits.
2. **Perf gate (implemented+unit-tested, live impact partial)** — computeStructuralKey gates heavy whole-repo detection (buildCallGraph/detectServices/Louvain/microservice/domain/health) for non-structural edits; skip path uses light applyDiffCascadeToLiveGraphs([file]). 197 sync tests. BUT live on operator.py (defines `attrgetter`, imported repo-wide — worst case) the cascade still pegged CPU ~110% for 60s+. Residual cost = the light diff-annotation cascade re-annotating across polar's 3588 sequence graphs (scales with the edited symbol's reference breadth). Could not isolate a leaf-file (typical) edit — extension stayed pegged from the edit+revert queue.

Follow-up (Round-3 tail): isolate a LEAF-file edit on a settled index to confirm typical edits are now fast; if the diff-annotation cascade is the residual cost, scope it to only graphs referencing the edited file (not all sequences).

## Round 3 — PERF FULLY FIXED (9.0.41), Round 3 CLOSED
Scoped `applyDiffCascadeToLiveGraphs`: (1) `buildScopedSequenceSubset` re-annotates only sequences whose graphId/meta.filePath/participant-anchors reference the edited file (not all 3588); (2) gated `buildMapGraph` + `detectDomains` behind `!affectedFiles || clusterDiffChanged` (reuse existing domains on scoped path — no Louvain re-cluster). 200 sync tests, host 5621.
LIVE VALIDATED on the worst-case file (operator.py = `attrgetter`, imported repo-wide): edit → cascade settles at **t=6s** (was 60s+/never), working snapshot updates (dda48e8e→8ce84184). **60s→6s, ~10x.** Durability + perf both fixed.

Separate finding (NOT caused by the perf fix, pre-existing): the AGGREGATE workspace L1 still shows "No changes" / no `~modified` on the server repo node after a sub-repo edit — that badge comes from `markMultiRepoL1Diff` at serve time (a different path from the scoped cascade). Logged as **BUG-L1-MULTIREPO-DIFF-BADGE** for a Round-8 (cross-repo) follow-up. The per-repo sequence/cluster diffs DO update (scoping agent's test proves participant→modified).

Round 3 bugs fixed: BUG-DIFF-MULTIREPO-NOREFLECT (durability), BUG-DIFF-CASCADE-PERF (scoping). NEXT: Round 4 (replay).

## Round 4 — Replay (findings)
Explored Timeline Replay live on polar. Flow: home → "Timeline Replay" → repo picker (categories correct — BUG-CONNECT-4 fix holds: clients "frontend · 518 entry points", server "backend · 567 APIs") → "Select Commit Range" modal (branch + commit list) → Start Replay.
Bugs/findings:
1. **BUG-REPLAY-SLOW-UPFRONT** (P1, confirmed) — Start Replay (50 commits, est "~735s") shows "Loading…" with extHost CPU pegged 133% for 44s+ and NEVER renders the first step within that window — it builds ALL selected commit diffs upfront before showing step 1. On a large-history repo the user waits minutes staring at "Loading…". Should render step 1 immediately + build ahead lazily/streamed in the background. (The ~14.7s/commit build cost itself is the commit-diff graph build — inherent, but must not block the first frame.)
2. **BUG-PICKER-ROW-MOUSE** (candidate, low confidence) — in the replay repo picker, MOUSE clicks on the repo rows (JS .click() on the <button.ca-modal-list-item> AND a coordinate click) did NOT dispatch the pick; only keyboard (filter + Enter, which selects the highlighted row) started the replay. Could be a browser-automation artifact — re-verify with a real user click before logging as a product bug.

## Round 4 — additional finding
3. **BUG-REPLAY-NO-CANCEL** (P1, confirmed) — navigating AWAY from a running Timeline Replay does NOT cancel its upfront commit-diff build; extHost stays pegged 120-270% after leaving. Starting a replay + backing out leaves the extension churning for minutes. The replay build needs an abort signal wired to route-change / replay-stop.
Round-4 fix plan (next): (a) render replay step 1 immediately + build subsequent commits lazily/streamed; (b) wire cancellation so leaving/stopping aborts the build. Both in the timeline-replay build path (commitDiffer / replay orchestrator).

## Round 4 — REPLAY FIX LANDED (9.0.42)
1. **BUG-REPLAY-SLOW-UPFRONT — FIXED** (commitTimelineReplay.ts): `play()` restructured from "build ALL commit diffs upfront (Phase 1) → then show step 1" to "build the FIRST pair → start playback → build the rest in the BACKGROUND (buildRemainingInBackground)". Playback (~stepDurationMs/step, ~dozen steps/pair) outpaces a single per-commit build, so the build stays ahead. `scheduleNextAdvance` waits at the build frontier (`_building`) instead of ending; a `whenBuildSettled()` awaitable added. UNIT-VALIDATED: new regression test proves step 1 renders after building ONLY the first pair while later pairs hang (2 buildDiff calls, not all 5). 24 replay tests pass, host 5622.
2. **BUG-REPLAY-NO-CANCEL — FIXED** (extension.ts requestRoute guard): navigating to a view the replay never steps through (health/map/domain/tour/api-testing) calls `commitTimelineReplay.stop()`, which aborts the background build via the loop's `_isPlaying` check. LIVE-VALIDATED: navigating to #/health dropped extHost CPU 100%→10% at t=4s (was pegged 120-270% before).
Residual/separate: a single commit-diff build for the CLIENTS frontend (~2000 files) is inherently slow (>45s), so even lazy the first step is slow for that repo — a per-build cost, not the upfront-build bug (which is fixed). And BUG-PICKER-ROW-MOUSE (picker rows unresponsive to mouse, keyboard works) still open — candidate.
Round 4 CLOSED (core fix). NEXT: Round 5 (impact analysis).

## Round 5 — Impact analysis (findings, confirmation blocked)
Explored Impact via home → Impact Analysis → two-step picker (repo → function). Flow exists.
Findings:
1. **BUG-IMPACT-PICKER-TITLE** (P3 polish) — the Impact picker (both the repo step AND the function step) is titled generic "Pick an item", unlike Timeline Replay's specific "Pick a repo to replay its commit timeline". Should read "Pick a repo to scope impact" / "Pick a function to analyze impact".
2. **BUG-IMPACT-NO-RESULT** (P2 candidate, UNCONFIRMED) — after picking a function (`_get_server_metadata`, confirmed matched in the picker), the picker closed to #/home with NO blast-radius overlay/panel anywhere in the DOM (no impact/blast/direct/transitive elements). Either impact renders nothing, or the pick didn't fire the analyzeImpact command. CONFOUNDED by picker flakiness — needs a real-user click or a non-picker trigger to confirm.
3. **BUG-PICKER-INTERACTION** (recurring, Rounds 4+5) — modal picker ROWS do not respond to programmatic mouse clicks (JS .click() and CDP coordinate click both no-op); only keyboard Enter (on the highlighted row) dispatches. This is now BLOCKING reliable interactive-feature testing (replay, impact). Either a real product bug (rows need a proper click handler / role=option + onKeyDown only) OR the rows rely on a synthetic-event path automation can't trigger. HIGH-VALUE to resolve — it gates the windtunnel's interactive coverage.

Windtunnel enhancement needed: the capture harness needs a reliable picker-drive primitive (filter → arrow/Enter, or a real dispatched click) so Rounds 4-10's interactive features can be captured. Until then, interactive rounds rely on fragile keyboard nudging.

## Round 5 investigation — PICKER RESOLVED + real root cause
BUG-PICKER-INTERACTION → **NOT A PRODUCT BUG (automation artifact).** ScopePicker rows are `<button onClick={()=>onPick(it)}>` with stable `data-testid="ca-scope-picker-item"` + `data-scope-item-id` (ScopePicker.tsx:127-134). Verified live: clicking the server row via `document.querySelector('[data-testid="ca-scope-picker-item"]')` for service:server → navigated #/home→#/system-design/server, picker closed. Earlier "unclickable" was fuzzy selectors (hitting nested spans) + coordinate clicks in screenshot-space≠viewport-space. Real users' clicks work.
HARNESS FIX: added `{pickerPick:'server'|0}` primitive to capture.mjs runActions — drives picker rows reliably by testid (unblocks interactive-round capture).
REAL underlying flakiness: **BUG-WS-RECONNECT-STORM** (candidate) — console flooded with 1372 `[CodeAtlas WS] WebSocket error (readyState=3)` at one timestamp when the socket dropped; the SPA retries in a tight storm instead of backing off. This (not the picker) is what caused the "Connecting…/Loading…" + messages-not-landing across Rounds 4-5, and re-confounds BUG-IMPACT-NO-RESULT (requestImpact couldn't send on a closed WS). requestImpact IS wired (messageHandler.ts:1240 + toolHandlers.ts, passing tests).
NEXT: (a) confirm/fix BUG-WS-RECONNECT-STORM (backoff on reconnect) — likely the highest-leverage robustness fix; (b) then re-confirm BUG-IMPACT-NO-RESULT on a stable WS.

## Session 2026-07-20 — WS storm FIXED + slow-nav triad FIXED + Scout stateful primitives

**Closes Round-5 NEXT(a): BUG-WS-RECONNECT-STORM → FIXED (9.0.44).** Root cause: a server restart during reconnect seeded a 2nd reconnect loop; loops cross-multiplied to ~3900 concurrent retries (2715 console msgs, dual "attempt N" counters firing same-second) → froze the tab. Fix in `webview-ui/src/wsBridge.ts`: single-timer + single-socket invariant (track `reconnectTimer`, idempotent `scheduleReconnect`; tear down old socket + detach handlers before `new WebSocket`). Validated live: clean `1s→2s→4s→8s→10s` backoff during a real outage. This was the true cause of the "Connecting…/Loading…" flakiness that confounded Rounds 4-5.

**Slow L1→L2a/L2a→L3 opening = a TRIAD, all FIXED (9.0.44–46):**
1. WS storm (above).
2. `resolvePerRepoGraph` (`src/core/sync/perRepoGraphResolver.ts`) did `Object.entries` over the server repo's 14,337 SQLite-backed lazy-proxy graphs, force-fetching every one → 685ms/nav. Fix: enumerate keys fetch-free via `getLazyGraphMap().keys()`, read only `feature:*`. → **685ms → 25ms** server round-trip. (Same trap fixed in `standalone/messageHandler.ts` bare-`#/features`.)
3. `DiagramView` ran the synchronous Dagre layout for delegated modes (feature/domain/health/api-list) that render lists, not React-Flow → 631ms wasted/nav. Fix: `DELEGATED_LAYOUT_MODES` skip. → **L2a paint 1000ms → 158ms**, zero long-tasks.
Regression tests: wsBridge (+2), perRepoGraphResolver (+1), DiagramView.layoutSkip (+4). host 5631 / webview 904 green.

**Scout harness enhancement — stateful primitives (unblocks DIFF/REPLAY/IMPACT/AIREVIEW):** added to `capture.mjs` ACTIONS DSL: `{editFile:path,find,replace|content|append,level}` (perturbs real source; save-and-restore stack, exact-byte revert, NOT git), `{revertAll}`, `{waitResync:ms}`, `{clickCommand:'Sync'}`, `{replay:'play'|'step'|'stop'}`, `{aiReview}`. Auto-revert on case-end + process exit/SIGINT so a crashed run never leaves the repo dirty. Cases with explicit ACTIONS now bypass the `shotsForCase` skip. Dry-run validated: edit → screenshot → byte-clean revert.

**NEW FINDING — BUG-DIFF-WORKSPACE-L1-NOREFLECT (P2 candidate, needs confirmation):** a working-tree edit to an indexed server handler (`server/polar/auth/endpoints.py`, +1 top-level fn) DID cascade at the per-repo level — server `state.db` shows `working` graph 108262 bytes vs `baseline` 107552 after ~30s auto-watcher (no manual Sync needed). BUT the multi-repo **workspace L1** (`#/system-design`) kept showing **"No changes"** even after Sync + fresh reload. So per-repo working diffs are NOT surfaced on the aggregated workspace L1. Either a real aggregation gap or by-design. **Test-scenario:** edit a server handler → wait 30s → assert `#/features/server` (per-repo view) shows `~modified` AND assert whether `#/system-design` workspace L1 reflects it. **Finish line:** decide expected behavior; if workspace L1 SHOULD show it, wire the aggregator to recompute per-repo diffs at read-time. Diff cases must therefore target per-repo views, not workspace L1.

## Session 2026-07-20 (cont.) — polar-scoped suite GENERATED (147 cases) + validated

New generator `generate-polar-scoped.mjs` reads polar's per-sub-repo `state.db` `apis` tables (uniform for backend HTTP/JOB/CLI + frontend SCREEN/NAV/NETWORK), groups by feature-key, and emits `polar-scoped.suite.json` (147 cases) + `polar-scoped.actions.json`:
- WALK 2 (server+clients deep L1→L5), ENTRYTYPES 23 (per type), DIFF 104 (feature×3 levels), REPLAY 2, AIREVIEW 16.
New `capture.mjs` handler: `WALK-<REPO>` → captureFlowWalk (backend) / captureScreenWalk (frontend).

**Validated live (slices):**
- WALK-SERVER (10 endpoints) → 29 screenshots. L2a→L3 ✓, L5 4/10, **L4 participant→file 0/10** (pre-existing CONNECT L4-drill gap: the `.py$` participant-click doesn't reach `#/file/`).
- ENTRYTYPES (23) → 121 screenshots. **Server 9/10 types open L3** ✓ (only NAV_ROUTE missed). **Clients 0/13** — frontend L2a is a screen list; backend-style `^GET$`/`^POST$` row selectors don't match screen rows.
- DIFF slice (server/backoffice comment) → **per-repo server L2a shows "2 modified"** (confirms per-repo diff DOES surface; workspace L1 does not — BUG-DIFF-WORKSPACE-L1-NOREFLECT). File reverts byte-clean.

**Next-run tuning backlog (windtunnel enhancement):**
1. **Clients ENTRYTYPES 0/13** — redirect frontend TYPE cases to screen-row selectors (reuse captureScreenWalk's `rowRe`), not method rows.
2. **L4 participant→file 0/N** — the sequence-view participant click needs the right target + settleHash; likely the participant label lacks a `.py` suffix or isn't the clickable element. HIGH VALUE — gates L4 coverage across the whole suite.
3. **runActions drill (ENTRYTYPES L3→L4→L5)** — add settleHash between clickText steps (fixed waits race the async nav); L4/L5 clickText landed 0.
4. **DIFF revert-settle** — server needs ≥30s (bumped); consider polling for "No changes" before the next case's baseline shot so a slow revert can't leak a stale diff into case N+1.
5. Full run (147 cases → ~600+ screenshots, ~2h incl. 104 stateful DIFF edits) must be BATCHED (no-background constraint): run WALK/ENTRYTYPES/REPLAY fast, then DIFF in chunks of ~10.

## Session 2026-07-20 (cont. 2) — selector gaps FIXED + batched capture executed

**Two high-value drill fixes (validated at scale):**
1. **L4 participant→file: 0/10 → 10/10.** SequenceView is a React Flow canvas; participants are `.react-flow__node`s whose click fires onNodeClick → File Diagram. The old `.py$` TEXT click hit the dup "API SEQUENCE order.py" header. Fix: click `.react-flow__node` with hasText `«module»` (captureFlowWalk + new `{clickNode}` ACTIONS primitive). WALK-SERVER now L4 8/8.
2. **Clients (frontend) ENTRYTYPES: 0/13 → 13/13.** The frontend L2a is a SCREEN list (route paths / `page.tsx`), not method rows; backend `^GET$` selectors matched nothing. Fix: generator emits repo-aware TYPE actions — frontend clicks screen rows → screen-content (`#/screen/…`), backend clicks method row → L3 → `{clickNode:'«module»'}` → L4.

Also added capture.mjs `--offset` for chunked runs, and `run-polar-scoped.sh` (drives the full 147-case suite in bounded chunks).

**Batched capture (build `polar-full`) executed:** WALK 2 (L4 8/8, clients 8/8), ENTRYTYPES 23 (server L4 10/10, clients 13/13), REPLAY 2, DIFF 22/104 — **202 screenshots**. Stateful DIFF confirmed at scale: per-repo view shows `~ / N modified` after `{editFile}`; polar reverts byte-clean every time, INCLUDING across 3 SIGTERM kills (the process-exit revert handler is bulletproof — polar never left dirty).

**Remaining:** DIFF 82/104 + AIREVIEW 16 — a ~90-min grind (chunks of 5 via `run-polar-scoped.sh`, needs a real batch timeout, not a 10-min-capped shell). Residual tuning: L5 message→flow lands ~3/8 (message-edge selector); DIFF revert-settle (14s) leaves a stale marker in the after-revert frame on the huge server repo — bump to ~20s or poll for "No changes".

## Session 2026-07-22 — OVERLAYNAV suite added (AI-review × navigate) + arbiter run
Closes the coverage gap behind BUG-AIREVIEW-BLOCKS-L2NAV — Scout tested AI review and navigation in ISOLATION but never their combination (AI review active on a layer → drill to the next). New scaffolding:
- **`{injectMessage}` capture.mjs primitive** — dispatches a server→webview MessageEvent straight into the page, so OVERLAY state (AI review findings, comments, impact) is activated WITHOUT a live LLM/backend. Cross-feature "overlay active × navigate" is now deterministic + fast.
- **Per-frame crash detection** — every screenshot frame records `crashed` ("Something went wrong"/error-boundary) + `blank` + `hasDiagram`. `crashedFrames` surfaces on capture.json + the manifest; the arbiter treats crashed:true as an automatic FAIL. A diagram must survive ANY overlay/data state.
- **`overlay-nav.suite.json` + `overlay-nav.actions.json`** — 4 cases: AI review active on L1 → drill L2, for WELL-FORMED and three MALFORMED payloads (no summary + items lacking top-level graphId; counts-only without byGraph; finding without bindings) — the exact shapes that crashed.

**Run (build overlaynav-9.1.50, fixed build):** capture 4/4 · `_judge-worklist` 4 · **arbiter --rollup: pass 4 · fail 0 · blocked 0**. Every case: crashedFrames=[], and the drill REACHED L2 (`#/features/…`) even with malformed AI review active — vision-confirmed (breadcrumb "System Design → Features: main", full L2 API list, no error boundary, Code Review panel contained on the right). This is the clean end-to-end confirmation the polluted manual tab couldn't give.

**Bugs discovered this run:** NONE new — the fix holds and is now regression-guarded. Minor cosmetic note (not logged as a bug): AiReviewPanel shows "NaNs" for duration when a payload lacks `meta.durationMs` — cosmetic only (AiReviewSafe contains it, no crash), surfaces only with incomplete mock data; real runs carry durationMs.

**Next-run wiring:** run alongside the scoped suite via `node capture.mjs --suite overlay-nav.suite.json --suites OVERLAYNAV --actions overlay-nav.actions.json`. Extend the matrix to comments/impact/diff overlays × every layer drill.
