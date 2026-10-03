# Recon — CodeAtlas browser + tool verification

A comprehensive, screenshot-driven verification catalog for the CodeAtlas browser
dashboard **and** the MCP tool-call surface, run across **every repo** in the catalog.
Two runners: **Scout** (capture) and **Arbiter** (judge).

## Quick start

```bash
# 1) SCOUT — capture (mechanical + tuning-agent). Pick a scope:
node e2e/browser-verification/scout.mjs --smoke  --url http://localhost:7742 --build 9.0.30-smoke   # P0, fast suites, all repos
node e2e/browser-verification/scout.mjs --all    --urls polar=http://localhost:7742 --build 9.0.30  # every repo (needs a url per repo)
node e2e/browser-verification/scout.mjs --repos polar,go-gin --suites L1,L2A,LABEL --url ... --build X   # limited

# 2) ARBITER — judge (separate session)
node e2e/browser-verification/arbiter.mjs --plan   --build 9.0.30-smoke   # -> _judge-worklist.json
#    ... an agent follows arbiter.md: opens each screenshot, writes result.json ...
node e2e/browser-verification/arbiter.mjs --rollup --build 9.0.30-smoke   # -> summary.md
```

## Layout

| Path | What it is |
|---|---|
| `../browser-verification-suite.json` | **Canonical master** — all suites, cases, conventions, repoCatalog (46 repos), capabilityMatrix, toolCatalog (55 MCP tools), evidence protocol, perf budgets, execution phases. Edit this. |
| `generate-per-repo.mjs` | Splits the master into one self-contained JSON per repo. |
| `repos/<repo>.suite.json` · `repos/_index.json` | **Generated** per-repo suites (repo meta + applicable cases + baseline + capabilities) + index. |
| **`scout.mjs`** | **Capture runner** — selection (`--all`/`--smoke`/`--repos`) + roll-up; spawns the engine per repo. |
| `capture.mjs` | Per-repo capture engine (Playwright + ACTIONS DSL + landing self-report). Scout calls it. |
| **`arbiter.mjs`** | **Judge runner** — `--plan` (worklist) / `--rollup` (verdicts → summary.md). |
| `arbiter.md` | Judge rubric the vision agent follows between plan and rollup. |

Regenerate the per-repo files after editing the master:

```bash
node e2e/browser-verification/generate-per-repo.mjs
```

This is distinct from `e2e/tests/*.spec.ts` (Playwright, mock handlers). These cases
run against a **real initialized workspace** on the live dashboard (VSIX :7742 and/or
MCP :7842).

## Non-negotiable rules (from the master `meta.mandates`)

1. **ALL REPOS** — every applicable case runs against every repo in `repoCatalog`
   (43 framework repos + `polar` multi-repo + single-repo dogfood). Applicability is
   derived from `scope` + `tags` + repo `category/kind` (see `applicabilityRules`).
2. **SCREENSHOT EVERY TEST** — each case captures a screenshot and records an explicit
   **actual-vs-expected** observation. DOM / db / log / network / perf checks are
   *additional* evidence, never a substitute for the screenshot.
3. **TOOL CALLS INCLUDED** — the `TOOLS` suite exercises the MCP tools over JSON-RPC on
   the standalone daemon; each call saves request+response + a screenshot of any view it
   drives.
4. **PRE-RUN RESET** — before every repo run: `git checkout -- . && git clean -fd` to
   restore the original committed state, then **re-init → resync → capture the perf
   baseline** (`SETUP-04`). No run starts from a dirty tree; probe/feature files are
   cleaned up afterward.
5. **BUILD-NUMBERED OUTPUT** — all evidence is written under
   `tmp/verification-runs/<build>/...` inside the repo. `tmp/` is git-ignored
   (`.gitignore`), publish-ignored (`.vscodeignore` `tmp/**`), and VS Code-hidden
   (`.vscode/settings.json`).

## Output layout (per run)

```
tmp/verification-runs/<build>/                         # e.g. 9.0.30-run01
  run-state.json                                       # started/finished, builds up, per-suite tallies, skips (with reasons)
  summary.md                                           # roll-up + cross-repo analysis + tickets
  <repo>/<suiteId>/<caseId>/
    screenshot.png            (MANDATORY; multi-step -> NN-<label>.png)
    expected.md
    actual.md                 (observed FROM the screenshot + evidence)
    analysis.md               (PASS/FAIL/BLOCKED verdict; bug write-up on FAIL)
    result.json               (machine-readable; see evidenceRecordSchema)
    evidence/                 (dom.txt, db.txt, log.txt, network.json, perf.json)
```

## Two phases: capture (parallel) + judge (separate session)

Capture and evaluation are **decoupled** so you can run many parallel browser-capture
sessions and a **separate judge session** that goes over the results and logs issues.

### Phase 1 — capture (mechanical, ~0 LLM, parallel)

`capture.mjs` (Playwright) drives the live dashboard for ONE repo and dumps artifacts
per case. No evaluation, no vision. One process per repo → runs in parallel:

```bash
# one per repo, in parallel (MCP daemons parallelize; VSIX serializes on one editor)
node e2e/browser-verification/capture.mjs \
  --suite e2e/browser-verification/repos/polar.suite.json \
  --url http://localhost:7742 --build 9.0.30-run01 \
  --out tmp/verification-runs/9.0.30-run01/polar \
  [--suites SETUP,L1,L2A,L2B,LABEL,HEALTH,DETECT,CLUSTER,ENTRYPOINTS,RENDERFLOW,TOUR] [--limit N]
```

Per case it writes `screenshot.png` (+ `NN-<label>.png` frames), `expected.md`,
`dom.txt`, `console.txt`, `capture.json` (routes/timings/toolbar values), and a
run-level `_capture-manifest.json` (covered vs skipped-with-reason).

The mechanical runner covers the **route-navigable + drill** suites (SETUP, L1, L2a/L2b,
LABEL, HEALTH, DETECT, CLUSTER, ENTRYPOINTS, REALTIME, RENDERFLOW, MOBILE, TOUR, and
L3/L4/L5/NAV/ANCHOR via a best-effort first-row drill). Stateful/interactive suites
(DIFF, FEATURE, REPLAY, IMPACT, OVERLAYS, COMMENTS, SEARCH, EXPORT, MULTIREPO) and the
bash-companion ones (PERF, LIFECYCLE timings, TOOLS JSON-RPC) are recorded in
`_capture-manifest.json.skipped` for a richer capture pass — never silently dropped.

### Phase 2 — judge (vision, re-runnable, in a different session)

`arbiter.mjs --plan` builds `_judge-worklist.json`; a separate session follows
`arbiter.md`: for each covered case it **looks at the screenshot**, compares to
`expected.md`, and writes `actual.md` + `analysis.md` + `result.json` (pass/fail/blocked),
logging every FAIL to `ISSUES.md`. It never touches the browser, so it re-runs cheaply
and shards across many judge agents (one per repo or per suite). `arbiter.mjs --rollup`
aggregates verdicts into `tmp/verification-runs/<build>/summary.md`.

### Pre-run reset (still required, per repo, before capture)

`git -C <repoPath> checkout -- . && git -C <repoPath> clean -fd`, then re-init + resync +
capture the perf baseline (`SETUP-04`, bash companion). Clean up probe files afterward.

A run is **complete** only when every applicable `(repo × case)` pair has a screenshot
and a verdict; partial runs list uncovered pairs (no silent caps).

## What's covered

Layers `L1..L5`, navigation/breadcrumbs, adaptive **Entry Points vs APIs** labeling,
**comprehensive diff** (including **add-a-feature with extra files** and delete),
**replay** (working changes incl. added-feature sets, PR, branch), **click-through
tours**, overlays, health, **visual impact highlighting** (screenshot + DOM, not just the
panel), search, export, AI review, comments, multi-repo isolation/cross-repo,
**re-init/resync stability + performance**, VSIX↔MCP parity, and the **MCP tool-call
surface**.

### Language + framework coverage (the cross-stack backbone)

Two mechanisms make the suite prove detection depth per language/framework rather than
just "does it render":

- **Baseline-asserted detection** — each per-repo file carries a `baseline` injected from
  `e2e/real-projects/expectations.json` (min api/route/cluster/service/graph counts). The
  `DETECT` suite asserts the live browser/tool counts meet the known-good baseline, so a
  detection *regression* in any framework fails the run. Refresh with
  `npm run verify:real:update`.
- **Capability-gated entry-point kinds** — each repo carries `capabilities` (from the
  master `capabilityMatrix`), and a `capability`-tagged case runs **only** when the repo
  has it. So each repo verifies *its* framework's entry-point kinds — and the
  `ENTRY-NOHALLUCINATION` case verifies kinds the framework does *not* emit are absent:

  | Suite | Verifies | Example repos |
  |---|---|---|
  | `DETECT` | framework/language id, parse health, counts ≥ baseline | all |
  | `ENTRYPOINTS` | HTTP methods+mount prefixes; GraphQL; tRPC/RPC; JOB+Worker node; MQ consumer+broker edge; CLI; Rails FILTER; migrations; no-hallucination | Kafka→MQ, Celery/Sidekiq→JOB, Symfony/Laravel→CLI, Apollo→GraphQL, tRPC→RPC, Rails→FILTER+migration |
  | `REALTIME` | GraphQL subscription / WS / SSE / socket.io | ts-apollo (`graphql`); tRPC covered by `ENTRY-TRPC` |
  | `RENDERFLOW` | FE/mobile drill: screen-content 5-section L2b, render-flow L3, component↔hook↔data L4, mobile lifecycle | js-nextjs, ts-remix/nuxt/sveltekit, dart-flutter, kotlin-android, swift-ios, ts-react-native |
  | `ANCHOR` | source nav (file:line), route→controller anchor, deep-link restore, re-anchoring | all backend |
  | `CLUSTER` | Louvain clustering, sub-clusters, semantic naming, Business Domains, Jaccard stability | all backend |

Non-API entry points (jobs, MQ, CLI, migrations, seeds, socket events, subscriptions,
health, model hooks, filters) and mobile categories (push, background task, lifecycle,
deep link, widget, content provider) are exercised where the framework emits them.
