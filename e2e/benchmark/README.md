# CodeAtlas vs raw-LLM code-review benchmark harness (#849)

Runs the two-arm comparison from `docs/benchmark-codeatlas-vs-raw-llm.md`
against [Martian's open code-review benchmark](https://github.com/withmartian/code-review-benchmark)
(MIT — 50 real PRs from cal.com / discourse / grafana / keycloak / sentry,
136 human-verified golden comments, LLM-judge matching).

Both arms emit the benchmark's native review shape (`{path, line, body}`),
so Martian's extract → dedup → judge → export pipeline runs **unchanged** —
making CodeAtlas's precision/recall directly comparable to the published
leaderboard (CodeRabbit, Copilot, Greptile, …).

## One-time setup

```bash
git clone --depth 1 https://github.com/withmartian/code-review-benchmark /tmp/martian-bench
export GITHUB_TOKEN=$(gh auth token)      # PR metadata + diffs (rate limits without it)
export OPENROUTER_API_KEY=…               # both arms
export BENCH_MODEL=anthropic/claude-sonnet-4.5   # one strong model for BOTH arms (#527: weak
                                                  # models lose most findings to the evidence gate)
export CODEATLAS_LLM_MODEL=$BENCH_MODEL   # keep the CodeAtlas arm on the same model
node esbuild.js                            # the CodeAtlas arm runs dist/mcp-server.js review-pr
```

## Run protocol

```bash
# 1. Resolve the 50 golden PRs to base/head SHAs (idempotent, cached)
node e2e/benchmark/fetchCorpus.mjs

# 2. Smoke: one PR per arm first — learn failure modes cheaply
node e2e/benchmark/runCodeatlasArm.mjs --limit 1
node e2e/benchmark/runRawLlmArm.mjs   --limit 1

# 3. Full runs (resumable — completed cases are cached in results/)
node e2e/benchmark/runCodeatlasArm.mjs           # clones are shallow + blob-filtered, cached in repos/
node e2e/benchmark/runRawLlmArm.mjs
#    For variance: --runs 3, then merge each repetition separately (--run N below)

# 4. Hand off to the Martian judge
node e2e/benchmark/mergeIntoBenchmarkData.mjs
cd /tmp/martian-bench/offline && uv sync
uv run python -m code_review_benchmark.step2_extract_comments
uv run python -m code_review_benchmark.step2_5_dedup_candidates
uv run python -m code_review_benchmark.step3_judge_comments
uv run python -m code_review_benchmark.summary_table
```

## What gets measured

- **Precision / recall / F1** — by the Martian judge, per severity tier.
- **Tokens per review** — both arms meter usage (`meter.tokensUsed` in the
  results JSON; the CodeAtlas arm's pipeline reports per-run totals via
  `aiReviewComplete.tokensUsed`).
- **Wall-clock per review** (`meter.wallClockMs`; the CodeAtlas arm also
  records `reviewDurationMs` excluding clone time).
- **Evidence rate** — CodeAtlas findings are evidence-gated by construction;
  the raw arm's comments can be spot-audited against the diff.

## Fairness guardrails (publish these with results)

- Same model + temperature for both arms (`BENCH_MODEL`).
- Raw arm v1 sees the full unified diff (truncated at ~90k tokens with a
  recorded `diffTruncated` flag — exclude or disclose those cases). It does
  NOT get file-read tools yet; that variant is the planned follow-up and
  must land before publishing (a no-tools strawman invites fair criticism).
- Publish both arms' raw outputs (`results/*.json`) + judge model + date.
- N≥3 repetitions (`--runs 3`) before quoting numbers; report variance.
- Known leakage caveat (Martian's own): these public PRs may be in training
  data for any model — applies equally to both arms and the leaderboard.

## Layout

```
e2e/benchmark/
  fetchCorpus.mjs            golden PRs → cases.json (base/head SHAs)
  runCodeatlasArm.mjs        arm 1: review-pr dry-run per PR
  runRawLlmArm.mjs           arm 2: same model, diff-only prompt
  mergeIntoBenchmarkData.mjs results → Martian benchmark_data.json shape
  repos/                     cached shallow clones        (gitignored)
  results/                   cases + both arms' reviews   (gitignored)
```
