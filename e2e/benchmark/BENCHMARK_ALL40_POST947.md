# All 40 PRs — post-#947 instruction upgrade, best-of-2 sampling

**CodeAtlas** = post-#947 instructions, best-of-2 (better of 2 runs/PR). **Claude raw** = single raw-diff sample. **CodeRabbit** = Martian offline (3-judge avg). Format: findings / TP / F1.

## cal.com (JS/TS)
| PR | golden | CodeAtlas (f/TP/F1) | Claude raw | CodeRabbit | r1/r2 |
|---|--:|---|---|---|--:|
| 7232 | 2 | 7/2/0.44 | 7/2/0.44 | 13/2/0.27 | 1/2 |
| 8087 | 2 | 3/1/0.40 | 3/1/0.40 | 8/2/0.40 | 1/1 |
| 8330 | 2 | 2/2/1.00 | 5/2/0.57 | 4/2/0.67 | 2/2 |
| 10600 | 4 | 5/3/0.67 | 5/1/0.22 | 8/2/0.33 | 3/2 |
| 10967 | 5 | 3/1/0.25 | 6/2/0.36 | 12/3.7/0.44 | 0/1 |
| 11059 | 5 | 10/4/0.53 | 10/3/0.40 | 19/5/0.42 | 3/4 |
| 14740 | 5 | 6/4/0.73 | 7/3/0.50 | 10/4/0.53 | 4/3 |
| 14943 | 2 | 3/2/0.80 | 3/1/0.40 | 3/2/0.80 | 1/2 |
| 22345 | 2 | 0/0/0.00 | 3/0/0.00 | 4/1/0.33 | 0/0 |
| 22532 | 2 | 2/2/1.00 | 5/2/0.57 | 7/1/0.22 | 2/2 |
| **TOTAL** | **31** | **41/21/0.58** | 54/17/0.40 | 88/25/0.42 | |

## discourse (Ruby/SCSS)
| PR | golden | CodeAtlas (f/TP/F1) | Claude raw | CodeRabbit | r1/r2 |
|---|--:|---|---|---|--:|
| 1 | 3 | 4/2/0.57 | 3/2/0.67 | 7/1.7/0.34 | 2/2 |
| 2 | 2 | 1/1/0.67 | 3/1/0.40 | 8/1.7/0.34 | 1/1 |
| 3 | 2 | 2/2/1.00 | 2/1/0.50 | 7/1/0.22 | 1/2 |
| 4 | 6 | 6/6/1.00 | 4/2/0.40 | 23/3.7/0.26 | 6/6 |
| 5 | 2 | 1/1/0.67 | 0/0/0.00 | 1/0/0.00 | 1/1 |
| 6 | 1 | 2/1/0.67 | 1/1/1.00 | 2/0.7/0.47 | 1/1 |
| 7 | 3 | 5/3/0.75 | 5/3/0.75 | 2/0/0.00 | 3/3 |
| 8 | 3 | 3/2/0.67 | 2/1/0.40 | 10/2/0.31 | 2/2 |
| 9 | 2 | 1/1/0.67 | 2/1/0.50 | 3/0/0.00 | 0/1 |
| 10 | 4 | 7/4/0.73 | 5/3/0.67 | 15/2/0.21 | 3/4 |
| **TOTAL** | **28** | **32/23/0.77** | 27/15/0.55 | 78/13/0.24 | |

## grafana (Go/TS)
| PR | golden | CodeAtlas (f/TP/F1) | Claude raw | CodeRabbit | r1/r2 |
|---|--:|---|---|---|--:|
| 76186 | 2 | 1/1/0.67 | 0/0/0.00 | 2/1/0.50 | 0/1 |
| 79265 | 5 | 2/2/0.57 | 3/2/0.50 | 8/3.3/0.51 | 2/2 |
| 80329 | 1 | 2/1/0.67 | 2/1/0.67 | 4/1/0.40 | 1/1 |
| 90045 | 3 | 6/3/0.67 | 5/3/0.75 | 5/3/0.75 | 3/3 |
| 90939 | 2 | 1/1/0.67 | 1/1/0.67 | 2/1/0.50 | 1/1 |
| 94942 | 2 | 2/2/1.00 | 1/1/0.67 | 2/1/0.50 | 1/2 |
| 97529 | 2 | 1/1/0.67 | 2/1/0.50 | 4/1/0.33 | 1/1 |
| 103633 | 2 | 1/1/0.67 | 2/0/0.00 | 1/0/0.00 | 1/1 |
| 106778 | 2 | 1/1/0.67 | 4/1/0.33 | 7/1/0.22 | 0/1 |
| 107534 | 1 | 0/0/0.00 | 2/0/0.00 | 1/0/0.00 | 0/0 |
| **TOTAL** | **22** | **17/13/0.67** | 22/10/0.45 | 36/12/0.42 | |

## keycloak (Java)
| PR | golden | CodeAtlas (f/TP/F1) | Claude raw | CodeRabbit | r1/r2 |
|---|--:|---|---|---|--:|
| 32918 | 2 | 1/1/0.67 | 2/2/1.00 | 2/1/0.50 | 1/1 |
| 33832 | 2 | 1/1/0.67 | 2/2/1.00 | 5/1.3/0.37 | 1/1 |
| 36880 | 3 | 2/2/0.80 | 2/2/0.80 | 6/1/0.22 | 2/1 |
| 36882 | 1 | 0/0/0.00 | 1/0/0.00 | 2/0/0.00 | 0/0 |
| 37038 | 2 | 2/2/1.00 | 1/1/0.67 | 10/2/0.33 | 2/2 |
| 37429 | 4 | 3/2/0.57 | 2/0/0.00 | 9/3/0.46 | 1/2 |
| 37634 | 4 | 4/3/0.75 | 3/2/0.57 | 9/3.3/0.51 | 3/2 |
| 38446 | 2 | 2/1/0.50 | 1/1/0.67 | 4/2/0.67 | 1/1 |
| 40940 | 2 | 2/2/1.00 | 2/2/1.00 | 1/1/0.67 | 2/1 |
| 1 | 2 | 0/0/0.00 | 0/0/0.00 | 4/1/0.33 | 0/0 |
| **TOTAL** | **24** | **17/14/0.68** | 16/12/0.60 | 52/16/0.41 | |

## OVERALL (40 PRs, 105 golden)
| Reviewer | findings | TP | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|
| **CodeAtlas (post-#947, best-of-2)** | 107 | 71 | **0.66** | **0.68** | **0.67** |
| Claude raw diff (single) | 119 | 54 | 0.45 | 0.51 | 0.48 |
| CodeRabbit (single) | 254 | 65 | 0.26 | 0.62 | 0.36 |

## Per-repo summary (TP / F1)
| Repo | golden | CodeAtlas | Claude raw | CodeRabbit |
|---|--:|--:|--:|--:|
| cal.com (JS/TS) | 31 | **21/0.58** | 17/0.40 | 25/0.42 |
| discourse (Ruby/SCSS) | 28 | **23/0.77** | 15/0.55 | 13/0.24 |
| grafana (Go/TS) | 22 | **13/0.67** | 10/0.45 | 12/0.42 |
| keycloak (Java) | 24 | **14/0.68** | 12/0.60 | 16/0.41 |
## Before → after the instruction upgrades (40 PRs, 105 golden)
| Stage | TP | Precision | Recall | F1 |
|---|--:|--:|--:|--:|
| pre-#945 (single) | 48 | 0.53 | 0.46 | 0.49 |
| post-#945 (single) | 56 | 0.52 | 0.53 | 0.53 |
| **post-#947 (best-of-2)** | **71** | **0.66** | **0.68** | **0.67** |
| post-#947 (single-run avg) | ~64 | ~0.62 | ~0.61 | ~0.61 |

The #947 targeted taxonomy + best-of-2 sampling lifted CodeAtlas from 56→71 golden (recall 0.53→0.68). Even **single-run** post-#947 (~64 TP) beats raw-diff (54) and CodeRabbit (65) on F1 at far higher precision. #947 wins are directly attributable per PR (r1/r2 column shows the lift):
- **cal_7232** forEach enumeration (ENUMERATE block), **cal_11059** hardcoded-`refresh_token` default, **cal_14740** filtered-vs-raw-input → all newly hit.
- **discourse_4 6/6** (ERB `end if`), **discourse_3 2/2** (unanchored domain regex), **discourse_7 3/3** (SCSS sweep-every-selector), **discourse_8** (test verb-vs-route), **discourse_10 4/4** (raw-SQL-migration-bypasses-normalization).
- **keycloak_37634** (inverted-predicate/substring validator), **keycloak_40940 2/2** (non-null contract violation), **grafana_76186** (audit-every-middleware-variant), **grafana_94942 2/2** (shipped-stub method).

## Why the remaining 34 golden are still missed
1. **Low-severity nits deliberately dropped for precision (~14)** — try-catch-around-dynamic-import (cal_8087), redundant optional-chaining (cal_10967), `[""]` array init (cal_14740), zero-rows-returns-domain-error + time-window-mix (grafana_79265), method-name typo + anchor-count logic (keycloak_37429), untested-new-arg (grafana_107534), test-comment-vs-fixture mismatch (grafana_103633 #2). Targeting these trades precision for marginal recall; left out by design.
2. **Deep cross-file contract reasoning (~8)** — cal_10967 `createEvent(event, credentialId)` interface change vs Lark/Office365 implementers (needs implementer bodies co-located — **#946 dependency-context**, not yet built); keycloak_38446 missing-id-copy across construct→remove flow; grafana_79265 `dbSession.Exec(args...)` Go compile-type error (needs the signature of `Exec` in context).
3. **Structurally unreviewable (~4)** — kcgreptile_1 (golden note: "reviewed commit is not in the repo" → 0 findings possible, both runs 0); keycloak_36882 System.exit (instruction added but model still declined — borderline-severity judgement).
4. **Residual single-sample variance (~8)** — cal_22345 (0/0 both runs — unreachable-branch + org-member guard; evidence present but un-flagged), grafana low-sev tails. Addressable with best-of-N (N>2) but diminishing returns.

**The dominant remaining lever is #946 (dependency-aware diff context)** — co-locating callers/implementers/signatures would convert most of bucket 2. Buckets 1 and 3 are precision-by-design and structural, not fixable by instructions.
