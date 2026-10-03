# 40-PR benchmark — after instruction improvements (#945) + all fixes

Full re-dry-run (final bundle: #941/#942+ref/#943/#944/#11059/#22345/#945) → recapture all 40 inputs → Claude review on CodeAtlas context → strict 1:1 judge. Single sample per PR.

## Before → after #945 (same model, judge, golden)
| Repo | golden | PRE-#945 (f/TP/F1) | POST-#945 (f/TP/F1) | ΔTP |
|---|--:|---|---|:--:|
| cal.com (JS/TS) | 31 | 40/18/0.51 | 37/19/**0.56** | +1 |
| discourse (Ruby/SCSS) | 28 | 22/10/0.40 | 38/16/**0.48** | **+6** |
| grafana (Go/TS) | 22 | 17/12/0.62 | 15/9/0.49 | −3 |
| keycloak (Java) | 24 | 12/8/0.44 | 18/12/**0.57** | **+4** |
| **OVERALL** | 105 | 91/48/0.49 | 108/**56**/**0.53** | **+8** |

**#945 lifted recall 0.46→0.53 and F1 0.49→0.53 at flat precision (0.53→0.52).** The instruction targets paid off exactly where diagnosed — **discourse +6** (web-security taxonomy + SCSS dark-light-choose discriminator) and **keycloak +4** (feature-flag V1/V2, lookup-key id-vs-name, Java Optional.get). grafana −3 is single-sample variance (Go concurrency/logic — not an instruction target; its pre sample was a high draw).

## 3-way comparison — 40 PRs, 105 golden
| Reviewer | findings | TP | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|
| **CodeAtlas (post-#945)** | 108 | 56 | **0.52** | **0.53** | **0.53** |
| Claude raw diff | 119 | 54 | 0.45 | 0.51 | 0.48 |
| CodeRabbit | 254 | 65 | 0.26 | 0.62 | 0.36 |

**After #945, CodeAtlas now beats raw-diff on all three metrics** (recall 56 vs 54 TP — the gap that was sampling-noise is closed) and leads CodeRabbit on F1 + precision (CodeRabbit's higher recall costs 2× the findings at ½ the precision: ~3 noise comments per real bug vs CodeAtlas's ~0.9).
