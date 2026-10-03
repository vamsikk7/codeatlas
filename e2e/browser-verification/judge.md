# Judge rubric — Phase 2 (evaluation)

The judge runs in a **separate session** from capture. It reads the artifacts the
capture runner dumped, **looks at every screenshot**, compares to `expected.md`,
writes a verdict, and logs issues. It never touches the browser, so it is
re-runnable and parallelizable.

## Input

```
tmp/verification-runs/<build>/<repo>/_capture-manifest.json   # covered + skipped
tmp/verification-runs/<build>/<repo>/<suite>/<case>/
    expected.md      # what to check (from the case)
    screenshot.png   # (or NN-<label>.png frames) — MUST be observed
    dom.txt          # innerText of the captured view
    console.txt      # browser console tail
    capture.json     # routes/frames/timings/toolbar values + coverage note
```

## Per-case procedure

1. Read `expected.md`.
2. **Open and OBSERVE `screenshot.png`** (every frame). This is mandatory — base the
   verdict on what you SEE, using `dom.txt` / `capture.json` only as corroboration.
3. Compare observed vs expected assertion-by-assertion.
4. Write:
   - `actual.md` — what the screenshot actually shows (be specific: counts, labels, states).
   - `analysis.md` — per-assertion PASS/FAIL + an overall verdict + a one-line rationale.
   - `result.json` — machine-readable (schema below).
5. On **FAIL**, append a ticket line to the repo `ISSUES.md` (repro + finish-line + a
   test scenario), and note the failing frame.

## Verdicts

- **pass** — every expected assertion is visible/true in the screenshot(s).
- **fail** — one or more assertions contradicted by the screenshot (a real defect).
- **blocked** — capture couldn't reach the state (no screenshot, error page, wrong
   route in `capture.json`, or the case needs interactive/tool capture that the
   mechanical runner skipped). Blocked ≠ pass. List blocked cases so they get a
   richer capture pass.
- **n/a** — the case doesn't apply to what was captured (rare; explain).

## result.json schema

```json
{
  "caseId": "L1-01", "suiteId": "L1", "repo": "polar", "build": "9.0.30-run01",
  "verdict": "pass|fail|blocked|n/a",
  "screenshots": ["screenshot.png"],
  "expectedSummary": "...", "observed": "what the screenshot shows",
  "assertionResults": [{ "assertion": "...", "result": "pass|fail", "evidence": "..." }],
  "notes": "", "ticketRefs": []
}
```

## Baseline + capability-aware judging

- `DETECT-02` etc.: compare observed counts to the repo's `baseline` (in the per-repo
  suite file). Below baseline → **fail** (detection regression).
- `ENTRY-*` / `REALTIME` / `RENDER-*`: the per-repo suite only includes cases for the
  repo's `capabilities`, so if the case is present, its kind SHOULD be visible; absent →
  fail. `ENTRY-NOHALLUCINATION` fails if a section appears that isn't in `capabilities`.
- `LABEL-*`: `capture.json.frames[].toolbarL2b` records the toolbar label — backend must
  read `⚡APIs`, frontend `⚡Entry Points`. Confirm against the screenshot too.
- `PARITY-*`: compare the vsix vs mcp screenshots of the same case (two builds).

## Parallelism

The judge is read-only on capture artifacts and writes only into each case's own
folder + appends to `summary.md`/`ISSUES.md`. So you can shard case folders across many
judge agents (e.g. one judge per repo, or per suite) with no contention. Aggregate all
`result.json` into `tmp/verification-runs/<build>/summary.md`:

```
totals: pass/fail/blocked per suite, per repo, per language/framework family
top failures (grouped), and every blocked case (with why + what capture it needs)
```

## Output roll-up

- `<build>/summary.md` — the cross-repo verdict table + issue list.
- `ISSUES.md` — one line per FAIL.
- `<build>/run-state.json` — machine tallies (already partly written by capture's
  `_capture-manifest.json`; the judge fills verdict counts).
