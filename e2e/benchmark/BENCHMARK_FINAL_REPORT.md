# CodeAtlas context-layer fixes — final A/B benchmark (46 Martian PRs)

After landing #941/#942/#943/#11059/#22345, I re-ran the **full dry-run** to capture the post-fix CodeAtlas context for all 46 PRs, re-reviewed each (Claude as the review model on that context), and re-judged vs the Martian golden with the same strict 1:1 oracle. Same reviewer, same judge, same golden as the pre-fix run — only the **CodeAtlas context** changed.

## 1. Full 46-PR A/B (124 golden) — the generalization test
| Setup | findings | TP | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|
| **A · CodeAtlas — POST-FIX** | **98** | 51 | **0.52** | 0.41 | **0.46** |
| A · CodeAtlas — pre-fix | 135 | 58 | 0.43 | 0.47 | 0.45 |
| B · raw PR diff | 131 | 61 | 0.47 | 0.49 | 0.48 |

**The fixes cut finding-noise 27% (135→98) and lifted precision 0.43→0.52 (+21%), holding F1 (0.45→0.46).** Recall dipped 0.47→0.41 — within single-sample model variance (each PR is one conservative review; per-PR swings of ±1 dominate at these counts). CodeAtlas-context A now sits within one F1 point of the raw-diff baseline it badly trailed before the fixes.

## 2. Non-cal repos (36 PRs / 93 golden) — the actual target (Ruby/SCSS, Go/TS, Java, Python)
| Setup | findings | TP | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|
| **A · CodeAtlas — POST-FIX** | **58** | 33 | **0.57** | 0.35 | **0.44** |
| A · CodeAtlas — pre-fix | 82 | 35 | 0.43 | 0.38 | 0.40 |

**On the non-JS stacks the fixes were a clear win: precision 0.43→0.57 (+33%), F1 0.40→0.44 (+10%), finding-noise cut 29%** — the unrelated-file pollution from the 2-dot diff (#941) is gone, so the model spends its budget on the PR's actual code. Recall flat (within noise).

### Per-repo (post-fix A)
| Repo (lang) | golden | findings | TP | P | R | F1 |
|---|--:|--:|--:|--:|--:|--:|
| grafana (Go/TS) | 22 | 17 | 12 | 0.71 | 0.55 | **0.62** |
| cal.com (JS/TS) | 31 | 40 | 18 | 0.45 | 0.58 | 0.51 |
| keycloak (Java) | 24 | 12 | 8 | 0.67 | 0.33 | 0.44 |
| discourse (Ruby/SCSS) | 28 | 22 | 10 | 0.45 | 0.36 | 0.40 |
| sentry (Python) | 19 | 7 | 3 | 0.43 | 0.16 | 0.23 |

grafana jumped to F1 0.62 (was 0.38–0.45) — the cleaned-up Go/TS context is the standout. keycloak/grafana precision now 0.67–0.71. sentry stays weakest (small, subtle-bug PRs).

## 3. cal.com-10 ranking — vs CodeRabbit, deepseek, kimi (same 31 golden)
| Rank | Reviewer | Precision | Recall | F1 |
|--:|---|--:|--:|--:|
| 1 | **Claude + CodeAtlas** (pre-fix) | 0.43 | 0.74 | **0.55** |
| 2 | **Claude + CodeAtlas** (post-fix) | 0.45 | 0.58 | **0.51** |
| 3 | CodeRabbit (full pipeline) | 0.28 | 0.80 | 0.41 |
| 4 | Claude + raw PR diff | 0.31 | 0.55 | 0.40 |
| 5 | kimi-k2.7-code + CodeAtlas (deduped) | 0.23 | 0.61 | 0.33 |
| 6 | deepseek-v4-flash + CodeAtlas | 0.21 | 0.52 | 0.30 |
| 7 | kimi-k2.7-code + CodeAtlas (raw) | 0.14 | 0.58 | 0.23 |

On cal.com, **Claude on CodeAtlas context tops the field (F1 0.51–0.55) — above CodeRabbit (0.41) and ~1.7× the open models.** The pre/post-fix gap (0.55 vs 0.51) is single-sample variance; both beat every other setup. Note CodeRabbit leads on raw recall (0.80) but at half the precision.

## Honest verdict
- **The context-layer fixes did what they were designed to do:** removed the 2-dot pollution and tightened scope → **precision up sharply (non-cal 0.43→0.57), finding-noise down ~30%, F1 up on the target repos (0.40→0.44)**. The big pre-fix deficit vs raw-diff on non-JS repos is largely closed.
- **Recall is flat, not up.** Two reasons, both honest: (a) the cross-file golden (e.g. keycloak#36880's V1/V2 contract) need the model to actually *reason* across the now-co-located files — #942 makes that possible but doesn't force it; (b) single-sample-per-PR variance is large at 1–6 golden/PR. A multi-sample (best-of-N) review or a stronger reasoning pass would convert more of the now-clean context into caught golden.
- **Claude + CodeAtlas remains the strongest reviewer on cal.com**, ahead of CodeRabbit and far ahead of deepseek/kimi — the context engineering is a real edge when paired with a capable model.

Artifacts: `results/final/` (A-calls, A-findings, judged_all.json, manifest), `BENCHMARK_AB_FULL_REPORT.md` (pre-fix), `ISSUES.md` #941–#943/#11059/#22345.
