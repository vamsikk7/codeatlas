# Benchmark Comparison — CodeAtlas+deepseek-v4-flash vs CodeRabbit & others (10 cal.com PRs)

All rows are scored on the **same 10 cal.com PRs** against the **same 31 Martian golden bugs**.

> **Methodology caveat:** my run (CodeAtlas + deepseek-v4-flash) was judged by a Claude oracle; every other tool comes from the **Martian offline benchmark**, scored by the average of 3 judge models (gpt-5.2, claude-sonnet-4.5, claude-opus-4.5). Both judges match against the identical golden set, but the matching is not byte-identical — treat ±0.05 as noise. The other tools are each a **full commercial pipeline** (own model + own context + multi-pass), not a raw model.

## Aggregate (pooled over 10 PRs · 31 golden)
| Setup | judge | findings | Precision | Recall | F1 |
|---|---|--:|--:|--:|--:|
| **CodeAtlas + deepseek-v4-flash (xhigh)** ⟵ this run | oracle | 77 | 0.208 | **0.516** | **0.296** |
| Cubic v2 | Martian 3-judge | 39 | 0.49 | 0.61 | 0.54 |
| Qodo v2 | Martian 3-judge | 48 | 0.39 | 0.6 | 0.47 |
| CodeRabbit | Martian 3-judge | 88 | 0.28 | 0.8 | 0.41 |
| Greptile v4 | Martian 3-judge | 81 | 0.27 | 0.71 | 0.39 |
| GitHub Copilot | Martian 3-judge | 83 | 0.24 | 0.63 | 0.35 |
| CodeAnt v2 | Martian 3-judge | 39 | 0.32 | 0.4 | 0.36 |
| Claude Code (CLI) | Martian 3-judge | 41 | 0.29 | 0.39 | 0.33 |
| Gemini | Martian 3-judge | 47 | 0.22 | 0.33 | 0.26 |
| deepseek-v4-flash (raw diff, no CodeAtlas) | — | — | — | — | **no public data** |

## Per-PR: this run vs CodeRabbit
| PR | golden | CodeAtlas+flash findings / P / R / F1 | tok(in/comp) | calls | CodeRabbit findings / P / R / F1 |
|--:|--:|---|--:|--:|---|
| #7232 | 2 | 18 / 0.11 / 1 / 0.2 | 114k/100k | 17 | 13 / 0.16 / 1 / 0.28 |
| #8087 | 2 | 13 / 0.15 / 1 / 0.27 | 58k/52k | 8 | 8 / 0.24 / 1 / 0.39 |
| #8330 | 2 | 8 / 0.25 / 1 / 0.4 | 32k/39k | 4 | 4 / 0.55 / 1 / 0.71 |
| #10600 | 4 | 5 / 0.4 / 0.5 / 0.44 | 30k/35k | 4 | 8 / 0.24 / 0.5 / 0.32 |
| #10967 | 5 | 10 / 0.3 / 0.6 / 0.4 | 36k/35k | 5 | 12 / 0.31 / 0.73 / 0.44 |
| #11059 | 5 | 10 / 0.1 / 0.2 / 0.13 | 33k/33k | 6 | 19 / 0.26 / 1 / 0.41 |
| #14740 | 5 | 5 / 0 / 0 / 0 | 48k/56k | 9 | 10 / 0.41 / 0.8 / 0.54 |
| #14943 | 2 | 3 / 0.33 / 0.5 / 0.4 | 24k/15k | 3 | 3 / 0.6 / 1 / 0.75 |
| #22345 | 2 | 2 / 0.5 / 0.5 / 0.5 | 9k/15k | 1 | 4 / 0.25 / 0.5 / 0.33 |
| #22532 | 2 | 3 / 0.67 / 1 / 0.8 | 27k/34k | 4 | 7 / 0.14 / 0.5 / 0.22 |

## Reading the results
- **CodeRabbit beats this run on F1 (0.41 vs 0.30), driven by recall (0.80 vs 0.52).** It also emits more findings (88 vs 77) at similar precision (0.28 vs 0.21).
- **This run lands mid-pack**: above Gemini (0.26), level with Claude Code (0.33) / Copilot (0.35) / CodeAnt (0.36), below CodeRabbit (0.41), Qodo (0.47), Cubic (0.54).
- **The gap is the model, not CodeAtlas's context.** The dry-run study proved **31/31 golden are present in CodeAtlas's assembled input** — deepseek-v4-flash only converted 16/31 (52%). CodeRabbit's pipeline (stronger model + multi-pass) converts 80%. Swapping deepseek-flash for a frontier model should move recall toward the 100% findability ceiling with no pipeline change.
- **Precision is low across the board on this hard subset** (CodeRabbit 0.28, Copilot 0.24, Greptile 0.27) — cal.com PRs are FP-magnets. The leaders (Cubic 0.49, Qodo 0.39) win by being terse; this run's precision is hurt additionally by deepseek emitting duplicate findings (a de-dup pass is the clearest fix).

## What is NOT available (and why)
- **Original deepseek-v4-flash (raw diff, no CodeAtlas):** not in the Martian benchmark — deepseek isn't a tracked reviewer there (only Claude, Gemini, Copilot, and ~25 commercial tools). There is **no published per-PR data** for it. The only way to get a true same-model A/B (raw vs CodeAtlas context) is to run deepseek-v4-flash on the raw diffs myself.
- **CodeRabbit's published headline numbers** (P 0.49 / R highest / **F1 0.51** full-benchmark, ~300k PRs) are an *aggregate across the whole benchmark*, not these 10 cal.com PRs. On this hard cal.com-10 subset CodeRabbit scores F1 0.41 — the subset is harder than its global average.

Sources: Martian Code Review Bench (withmartian/code-review-benchmark, offline results) · CodeRabbit blog "tops independent AI code review benchmark" · Martian "Code Review Bench v0".