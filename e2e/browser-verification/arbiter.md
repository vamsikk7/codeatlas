# Arbiter rubric — the Recon judge

The judging agent runs in a **separate session** from Scout, between
`arbiter.mjs --plan` and `arbiter.mjs --rollup`. It reads the captured artifacts,
**looks at every screenshot**, and writes a verdict per case. It never touches the
browser, so it is re-runnable and shardable.

## Flow

```
node e2e/browser-verification/scout.mjs   --smoke --build <build> --url <dashboard>   # capture
node e2e/browser-verification/arbiter.mjs --plan   --build <build>                     # -> _judge-worklist.json
#   ... AGENT session follows THIS rubric, writing result.json per case ...
node e2e/browser-verification/arbiter.mjs --rollup --build <build>                     # -> summary.md
```

`--plan` writes `tmp/verification-runs/<build>/_judge-worklist.json` — every case to
judge, with its `screenshots`, `expected` path, and `landed` flag. Shard the `items`
across judge agents (e.g. one per repo or per suite); each writes only into its own
case folder → no contention.

## Per-case procedure

For each worklist item (folder `tmp/verification-runs/<build>/<dir>/`):

1. Read `expected.md`.
2. **Open and OBSERVE every screenshot** (`screenshot.png` or `NN-*.png`). Base the
   verdict on what you SEE; use `dom.txt` / `capture.json` only to corroborate.
3. If `capture.json.landed === false` (or no screenshot), the run didn't reach the
   state → **blocked** (note that a tuning agent must re-capture with better `--actions`).
4. Compare observed vs expected assertion-by-assertion.
5. Write into the case folder:
   - `actual.md` — what the screenshot shows (specific: counts, labels, states).
   - `analysis.md` — per-assertion PASS/FAIL + overall verdict + one-line rationale.
   - `result.json` — `{caseId, suiteId, repo, build, verdict, screenshots, expectedSummary,
     observed, assertionResults[], notes, ticketRefs}`.
6. On **fail**, append a ticket line to `ISSUES.md` (repro + finish-line + test scenario).

## Verdicts

- **pass** — every expected assertion is visible/true in the screenshot(s).
- **fail** — an assertion is contradicted by the screenshot (a real defect).
- **blocked** — capture couldn't reach the state (`landed===false`, error page, no
  screenshot, or an interactive/tool case the mechanical runner skipped). Never a pass.
- **n/a** — the case doesn't apply to what was captured (explain).

## Correctness checks — NEVER pass on "renders"

A layer can render and still be wrong. The judge must verify semantics, not presence:

- **L3 participant order** — the entry-point file/router must appear **immediately after the
  actor**, BEFORE the services it calls (caller-before-callee). If a service participant sits
  left of the entry-point file (e.g. `CustomerOrderService` before `order.py`), that's a **fail**
  (BUG-CONNECT-3), even though participants + messages render. Cross-check
  `capture.json.flowWalk.chains[].participants` (recorded left-to-right) against the screenshot.
- **CONNECT hop landing** — for each endpoint in `flowWalk.chains`: `l4.landed` must be true
  (participant → `#/file/`) and `l5.landed` must be true (message → `#/flow/`). A false is a
  **fail** if the click target was correct (message/function does not open Function Flow —
  BUG-CONNECT-1), or **blocked** if the selector missed (needs a tuning re-capture).
- **L4 node interactivity** — `flowWalk.chains[].l4.nodesDraggable` must be true; false = **fail**
  (rigid nodes, BUG-CONNECT-2).
- **Picker (LABEL-05)** — category must not read `unknown`; a frontend repo's count must read
  entry points/screens, not `APIs` (BUG-CONNECT-4).
- **Message direction** — arrows point caller→callee for requests, callee→caller (dashed) for
  results.

## Baseline + capability-aware judging

- `DETECT-02`: compare observed counts to the repo `baseline` (in the per-repo suite
  file). Below baseline → **fail** (detection regression).
- `ENTRY-*` / `REALTIME` / `RENDER-*`: the per-repo suite only includes cases for the
  repo's `capabilities`; if present, the kind SHOULD be visible → absent = fail.
  `ENTRY-NOHALLUCINATION` fails if a section appears that isn't in `capabilities`.
- `LABEL-*`: `capture.json.frames[].toolbarL2b` records the toolbar label — backend must
  read `⚡APIs`, frontend `⚡Entry Points`. Confirm against the screenshot too.
- `PARITY-*`: compare the vsix vs mcp screenshots of the same case.

## Roll-up

`arbiter.mjs --rollup` aggregates every `result.json` into
`tmp/verification-runs/<build>/summary.md` (totals + per-suite + per-repo + failure list)
and prints the FAIL count to copy into `ISSUES.md`.
