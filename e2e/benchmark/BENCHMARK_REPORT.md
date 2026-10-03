# CodeAtlas AI-Review Context Benchmark — Final Report (2026-06-28)

## Method
For each real PR with known "golden" bugs (Martian `code-review-benchmark`), CodeAtlas's
`review-pr` was run in **dry-run** mode: it assembles the EXACT input it would send to the
review LLM and dumps it (no model call). Claude then acts as an **oracle reviewer** over
*only* that assembled input and scores each golden bug as **FINDABLE** = "is the evidence
to identify this bug present in the assembled input?". A miss is therefore a **CodeAtlas
context-assembly gap**, not a model-reasoning gap. This isolates input completeness.

## Result — 46 PRs, 5 repos, 5 languages: **120/124 findable (97%)**

| Wave | lang | PRs | golden | findable | input tokens | avg/PR |
|---|---|--:|--:|--:|--:|--:|
| cal.com | TS/JS | 10 | 31 | **31/31 (100%)** | 403,266 | 40,327 |
| discourse | Ruby | 10 | 28 | **26/28 (93%)** | 624,433 | 62,443 |
| grafana | Go/TS | 10 | 22 | **20/22 (91%)** | 415,875 | 41,588 |
| keycloak | Java | 10 | 24 | **24/24 (100%)** | 594,040 | 59,404 |
| getsentry | Python/TS | 6 | 19 | **19/19 (100%)** | 100,957 | 16,826 |
| **Total** | — | **46** | **124** | **120/124 (97%)** | **2,138,571** | **46,491** |

**Coverage: 0 reviewed-blind changed-source files across all 46 PRs** — including 30+
zero-entry-point PRs (Java SPI internals, Go services, Python/Django logic) that don't map
to HTTP routes and were near-unreviewable before this session's fixes.

### Input-token cost of the full 46-PR sweep
| Model (input rate) | cost |
|---|--:|
| Claude Opus ($15/1M) | $32.08 |
| **Claude Sonnet ($3/1M)** | **$6.42** |
| GPT-4o-mini ($0.15/1M) | $0.32 |
| local deepseek-coder | $0.00 |

(Input/assembly tokens only — the dry-run measures context, not generation; findings output is small.)

## Journey: 45% → 97%
The first cal.com wave hit a hard ceiling of **~14/31 (45%)**. Marker analysis proved the
input itself was the bottleneck, not reasoning. Nine fixes (all pure context-assembly, zero
model change) closed the gaps:

| # | Gap | Fix |
|---|---|---|
| **#930** | project pass diff-BLIND (0 `+/-` markers everywhere) | in-memory baseline fallback → real diffs |
| **#931** | presentation components mis-anchored, dropped | `.tsx/.jsx/.vue/.svelte` always to project pass |
| **#932** | redactor shredding code (`const token=res?.data`→`[REDACTED]`) | value-only redaction |
| **#933** | style/template files (`.scss/.erb`) unreviewed | added to `SOURCE_EXT` + prompt guidance |
| **#934** | cap-stranded controllers/migrations reviewed by neither pass | cap-aware `reviewedEntryPointFiles` |
| **#936** | non-parsed files had no baseline → all-`+` NEW FILE (inversions invisible) | `git show <base>` backfill |
| **#937** | i18n `.properties` translation files unreviewed | added to `SOURCE_EXT` + i18n prompt guidance |
| **#938** | large-file diff truncated past the window (buggy line dropped) | always emit changed lines; cap only context |

Verified per-fix recall jumps: cal.com 45%→100%, discourse #7 0→3/3, keycloak #37429 2→4,
keycloak #36880 2→3.

## Completeness assessment (the question: "more gaps from CodeAtlas side?")
After #930–#938, **no remaining context-assembly gaps were found.** The 4 misses are all
**inherent diff-review limits**, not CodeAtlas completeness bugs — the load-bearing evidence
is in code the PR *did not change*:

| PR | bug | why inherent |
|---|---|---|
| discourse #1 G3 | `80%` passed to gifsicle | needs the caller + the (unchanged) gifsicle impl |
| discourse #3 G1 | `should_block?` side-effects | method body is pre-existing (unchanged) code |
| grafana #90939 G2 | cache assigned on error | the assignment line is unchanged code |
| grafana #106778 G2 | silence drawer never renders | gated on an unchanged ruler-rule line |

These could only be reached by deliberately expanding context *beyond the diff* (e.g. pulling
unchanged callee bodies via the #865 participant-source channel) — a different feature than
"assemble the diff correctly," and a precision/token tradeoff. Recommend tracking as a future
**"expand-beyond-diff" lens**, not a completeness bug.

## Not completed
- **sentry-greptile** (4 PRs, 12 golden): the 453 MB / 17 k-file repo's init repeatedly
  exceeded the background-run window before a dump landed — an environment/infra limit, not a
  CodeAtlas issue. getsentry (the same Sentry codebase, 6 PRs) completed at 19/19.

## Bottom line
CodeAtlas's review-input assembly is **context-complete to the diff** across TS/JS, Ruby, Go,
Java, and Python: **97% of golden bugs are findable from the assembled input alone**, at
**~46 k tokens/PR (~$0.14/PR @ Sonnet)**, with **zero reviewed-blind files**. The residual 3%
is the fundamental boundary of diff-scoped review, not a fixable gap.
