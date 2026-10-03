# Benchmark — kimi-k2.7-code vs deepseek-v4-flash vs CodeRabbit (10 cal.com PRs)

Same 10 cal.com PRs · same 31 Martian golden. kimi & deepseek run on **CodeAtlas context** (deepseek live, kimi replayed from saved inputs), judged by Claude oracle; CodeRabbit from the **Martian offline benchmark** (avg of 3 judges), a full commercial pipeline. ±0.05 = judge noise.

## Aggregate (pooled, 31 golden)
| Setup | findings | TP | FP | FN | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|--:|--:|
| **kimi-k2.7-code (xhigh) + CodeAtlas** | 127 | 18 | 109 | 13 | 0.142 | **0.581** | 0.228 |
| deepseek-v4-flash (xhigh) + CodeAtlas | 77 | 16 | 61 | 15 | 0.208 | 0.516 | **0.296** |
| CodeRabbit (full pipeline) | 88 | 24.7 | 63.7 | 6.3 | **0.28** | **0.8** | **0.41** |

kimi tokens: 426k prompt + 598k completion (xhigh reasoning ≈ 140% of prompt). deepseek: 412k + 415k.

## Per-PR (findings / P / R / F1)
| PR | golden | kimi-2.7 | deepseek-v4-flash | CodeRabbit |
|--:|--:|---|---|---|
| #7232 | 2 | 39/0.03/0.5/0.05 | 18/0.11/1/0.2 | 13/0.16/1/0.28 |
| #8087 | 2 | 17/0.12/1/0.21 | 13/0.15/1/0.27 | 8/0.24/1/0.39 |
| #8330 | 2 | 9/0.22/1/0.36 | 8/0.25/1/0.4 | 4/0.55/1/0.71 |
| #10600 | 4 | 4/0.5/0.5/0.5 | 5/0.4/0.5/0.44 | 8/0.24/0.5/0.32 |
| #10967 | 5 | 15/0.2/0.6/0.3 | 10/0.3/0.6/0.4 | 12/0.31/0.73/0.44 |
| #11059 | 5 | 15/0.2/0.6/0.3 | 10/0.1/0.2/0.13 | 19/0.26/1/0.41 |
| #14740 | 5 | 16/0.19/0.6/0.29 | 5/0/0/0 | 10/0.41/0.8/0.54 |
| #14943 | 2 | 5/0.2/0.5/0.29 | 3/0.33/0.5/0.4 | 3/0.6/1/0.75 |
| #22345 | 2 | 3/0/0/0 | 2/0.5/0.5/0.5 | 4/0.25/0.5/0.33 |
| #22532 | 2 | 4/0.25/0.5/0.33 | 3/0.67/1/0.8 | 7/0.14/0.5/0.22 |

## Reading it
- **kimi has the highest recall of the two open models (0.581 vs 0.516)** — it caught 18/31 golden vs deepseek's 16/31 — but it is far noisier (127 findings vs 77), so its precision (0.142) and F1 (0.228) fall *below* deepseek (P 0.208, F1 0.296).
- **CodeRabbit still leads** (F1 0.41, recall 0.8) — higher recall *and* precision than either raw model on CodeAtlas context.
- **Duplication is the dominant precision killer for both models.** kimi #7232 emitted 39 findings (10+ restatements of the same forEach bug) → precision 0.03; deepseek did the same at lower volume. A **de-dup pass is the single highest-leverage fix** — it would lift both models' precision sharply with zero recall loss, likely closing most of the gap to CodeRabbit.
- **Context is not the limiter** (dry-run: 31/31 golden present in CodeAtlas's input). The gap is model behaviour: kimi over-generates, deepseek under-recalls; neither yet matches CodeRabbit's calibrated pipeline.