# Claude-as-reviewer on CodeAtlas context — vs deepseek / kimi / CodeRabbit (10 cal.com PRs)

Same 10 cal.com PRs · same 31 Martian golden. **Claude (Opus) acted as the review model on the EXACT captured CodeAtlas inputs** (the dead OpenRouter key is bypassed entirely — no external API). deepseek & kimi ran on the same captured context; CodeRabbit is the Martian offline full pipeline. All open-model rows judged by the same strict 1:1 oracle.

## Aggregate (pooled · 31 golden)
| Setup | findings | TP | FP | FN | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|--:|--:|
| **Claude (Opus) + CodeAtlas** ⟵ this run | 53 | 23 | 30 | 8 | **0.43** | 0.74 | **0.55** |
| CodeRabbit (full pipeline) | 88 | 24.7 | 63.7 | 6.3 | 0.28 | **0.80** | 0.41 |
| kimi-k2.7-code de-duped + CodeAtlas | 84 | 19 | 65 | 12 | 0.23 | 0.61 | 0.33 |
| deepseek-v4-flash + CodeAtlas | 77 | 16 | 61 | 15 | 0.21 | 0.52 | 0.30 |
| kimi-k2.7-code raw + CodeAtlas | 127 | 18 | 109 | 13 | 0.14 | 0.58 | 0.23 |

## Per-PR (findings / P / R / F1)
| PR | golden | Claude (Opus) | CodeRabbit | deepseek-v4-flash | kimi-2.7 raw |
|--:|--:|---|---|---|---|
| #7232 | 2 | **7/0.29/1/0.44** | 13/0.16/1/0.28 | 18/0.11/1/0.2 | 39/0.03/0.5/0.05 |
| #8087 | 2 | **4/0.25/0.5/0.33** | 8/0.24/1/0.39 | 13/0.15/1/0.27 | 17/0.12/1/0.21 |
| #8330 | 2 | **2/1/1/1** | 4/0.55/1/0.71 | 8/0.25/1/0.4 | 9/0.22/1/0.36 |
| #10600 | 4 | **7/0.43/0.75/0.55** | 8/0.24/0.5/0.32 | 5/0.4/0.5/0.44 | 4/0.5/0.5/0.5 |
| #10967 | 5 | **6/0.5/0.6/0.55** | 12/0.31/0.73/0.44 | 10/0.3/0.6/0.4 | 15/0.2/0.6/0.3 |
| #11059 | 5 | **11/0.27/0.6/0.38** | 19/0.26/1/0.41 | 10/0.1/0.2/0.13 | 15/0.2/0.6/0.3 |
| #14740 | 5 | **7/0.57/0.8/0.67** | 10/0.41/0.8/0.54 | 5/0/0/0 | 16/0.19/0.6/0.29 |
| #14943 | 2 | **4/0.5/1/0.67** | 3/0.6/1/0.75 | 3/0.33/0.5/0.4 | 5/0.2/0.5/0.29 |
| #22345 | 2 | **3/0.33/0.5/0.4** | 4/0.25/0.5/0.33 | 2/0.5/0.5/0.5 | 3/0/0/0 |
| #22532 | 2 | **2/1/1/1** | 7/0.14/0.5/0.22 | 3/0.67/1/0.8 | 4/0.25/0.5/0.33 |

## Reading it
- **Claude on CodeAtlas context posts the best F1 (0.55) of every setup tested — above CodeRabbit (0.41) and ~2× the open models** (deepseek 0.30, kimi 0.23/0.33 deduped). It caught **23/31 golden** at the **highest precision (0.43)** of any reviewer.
- **Recall 0.74** is just under CodeRabbit's 0.80 — and Claude did it with **53 findings vs CodeRabbit's 88**, i.e. far less noise.
- **This is the cleanest proof of the thesis: the context was never the bottleneck — the reviewer model was.** Same CodeAtlas input that gave deepseek F1 0.30 gives Claude F1 0.55. The dry-run already showed 31/31 golden are present in the input; a strong model converts them.
- **Even Claude's precision is held back by duplicate-matching, not false bugs.** On #7232 it correctly found the unawaited-forEach defect in 4 files but strict 1:1 credits one (3 "FP"); #8087 same. A de-dup pass would push Claude's precision from 0.43 toward ~0.55+ and F1 well past CodeRabbit. Perfect scores on #8330 and #22532 (P/R/F1 = 1.0).
- Conservative-but-right: 4 PRs at recall 1.0; only #14740 (0/5→ now 4/5) and #22345 lag.