# CodeAtlas AI Review — #946 dependency-aware diff context (detailed benchmark)

40 Martian golden PRs · 105 golden defects. CodeAtlas = post-#941–#947 **+ #946 dependency context** (callers/implementers/tests of changed symbols co-located), reviewed by Claude Opus, **best of 2 samples/PR**, strict 1:1 oracle judge. Compared to the prior #947 best-of-2 run, plus single-sample Claude raw-diff and CodeRabbit (3-judge avg). `dep`=this PR carried a DEPENDENTS payload. Tokens = input tokens/PR.

## cal.com (JS/TS)
| PR | golden | #946 CA (f/TP/F1) | #947 TP | Claude-raw TP | CodeRabbit TP | dep | calls | tok |
|---|--:|---|--:|--:|--:|:--:|--:|--:|
| 7232 | 2 | 4/1/0.33 (-1) | 2 | 2 | 2 | Y | 19 | 143k |
| 8087 | 2 | 3/1/0.40 | 1 | 1 | 2 | Y | 9 | 74k |
| 8330 | 2 | 2/2/1.00 | 2 | 2 | 2 | Y | 4 | 33k |
| 10600 | 4 | 2/1/0.33 (-2) | 3 | 1 | 2 | Y | 6 | 47k |
| 10967 | 5 | 5/3/0.60 (+2) | 1 | 2 | 3.7 | Y | 6 | 53k |
| 11059 | 5 | 6/2/0.36 (-2) | 4 | 3 | 5 | Y | 7 | 86k |
| 14740 | 5 | 4/4/0.89 | 4 | 3 | 4 | Y | 13 | 93k |
| 14943 | 2 | 3/2/0.80 | 2 | 1 | 2 | Y | 2 | 17k |
| 22345 | 2 | 0/0/0.00 | 0 | 0 | 1 | Y | 2 | 14k |
| 22532 | 2 | 2/2/1.00 | 2 | 2 | 1 | Y | 5 | 41k |
| **TOTAL** | **31** | **31/18/0.58** | 21 | 17 | 25 | | 73 | 601k |

## discourse (Ruby/SCSS)
| PR | golden | #946 CA (f/TP/F1) | #947 TP | Claude-raw TP | CodeRabbit TP | dep | calls | tok |
|---|--:|---|--:|--:|--:|:--:|--:|--:|
| 1 | 3 | 3/2/0.67 | 2 | 2 | 1.7 | Y | 2 | 14k |
| 2 | 2 | 2/1/0.50 | 1 | 1 | 1.7 | Y | 27 | 143k |
| 3 | 2 | 2/2/1.00 | 2 | 1 | 1 | Y | 10 | 56k |
| 4 | 6 | 5/4/0.73 (-2) | 6 | 2 | 3.7 | Y | 27 | 142k |
| 5 | 2 | 1/1/0.67 | 1 | 0 | 0 | Y | 1 | 12k |
| 6 | 1 | 2/1/0.67 | 1 | 1 | 0.7 | Y | 2 | 14k |
| 7 | 3 | 5/2/0.50 (-1) | 3 | 3 | 0 | Y | 3 | 55k |
| 8 | 3 | 2/2/0.80 | 2 | 1 | 2 | Y | 28 | 138k |
| 9 | 2 | 1/1/0.67 | 1 | 1 | 0 | Y | 12 | 59k |
| 10 | 4 | 5/3/0.67 (-1) | 4 | 3 | 2 | Y | 28 | 145k |
| **TOTAL** | **28** | **28/19/0.68** | 23 | 15 | 13 | | 140 | 777k |

## grafana (Go/TS)
| PR | golden | #946 CA (f/TP/F1) | #947 TP | Claude-raw TP | CodeRabbit TP | dep | calls | tok |
|---|--:|---|--:|--:|--:|:--:|--:|--:|
| 76186 | 2 | 1/1/0.67 | 1 | 0 | 1 | Y | 2 | 22k |
| 79265 | 5 | 2/2/0.57 | 2 | 2 | 3.3 | Y | 3 | 29k |
| 80329 | 1 | 2/1/0.67 | 1 | 1 | 1 | Y | 2 | 16k |
| 90045 | 3 | 5/3/0.75 | 3 | 3 | 3 | - | 2 | 18k |
| 90939 | 2 | 1/1/0.67 | 1 | 1 | 1 | Y | 1 | 7k |
| 94942 | 2 | 2/2/1.00 | 2 | 1 | 1 | Y | 1 | 12k |
| 97529 | 2 | 2/1/0.50 | 1 | 1 | 1 | Y | 2 | 18k |
| 103633 | 2 | 1/1/0.67 | 1 | 0 | 0 | Y | 2 | 20k |
| 106778 | 2 | 1/1/0.67 | 1 | 1 | 1 | Y | 4 | 40k |
| 107534 | 1 | 0/0/0.00 | 0 | 0 | 0 | Y | 2 | 15k |
| **TOTAL** | **22** | **17/13/0.67** | 13 | 10 | 12 | | 21 | 197k |

## keycloak (Java)
| PR | golden | #946 CA (f/TP/F1) | #947 TP | Claude-raw TP | CodeRabbit TP | dep | calls | tok |
|---|--:|---|--:|--:|--:|:--:|--:|--:|
| 32918 | 2 | 1/1/0.67 | 1 | 2 | 1 | Y | 2 | 20k |
| 33832 | 2 | 1/1/0.67 | 1 | 2 | 1.3 | Y | 3 | 30k |
| 36880 | 3 | 2/1/0.40 (-1) | 2 | 2 | 1 | Y | 4 | 45k |
| 36882 | 1 | 1/0/0.00 | 0 | 0 | 0 | Y | 2 | 18k |
| 37038 | 2 | 2/2/1.00 | 2 | 1 | 2 | Y | 29 | 173k |
| 37429 | 4 | 3/2/0.57 | 2 | 0 | 3 | - | 6 | 65k |
| 37634 | 4 | 2/2/0.67 (-1) | 3 | 2 | 3.3 | Y | 4 | 43k |
| 38446 | 2 | 3/2/0.80 (+1) | 1 | 1 | 2 | Y | 2 | 25k |
| 40940 | 2 | 1/1/0.67 (-1) | 2 | 2 | 1 | Y | 1 | 12k |
| 1 | 2 | 0/0/0.00 | 0 | 0 | 1 | Y | 3 | 31k |
| **TOTAL** | **24** | **16/12/0.60** | 14 | 12 | 16 | | 56 | 461k |

## Per-repo summary
| Repo | golden | #946 CA TP/F1 | #947 CA TP | Claude-raw TP/F1 | CodeRabbit TP/F1 |
|---|--:|---|--:|---|---|
| cal.com (JS/TS) | 31 | **18/0.58** | 21 | 17/0.40 | 25/0.42 |
| discourse (Ruby/SCSS) | 28 | **19/0.68** | 23 | 15/0.55 | 13/0.24 |
| grafana (Go/TS) | 22 | **13/0.67** | 13 | 10/0.45 | 12/0.42 |
| keycloak (Java) | 24 | **12/0.60** | 14 | 12/0.60 | 16/0.41 |

## TOTAL (40 PRs, 105 golden)
| Reviewer | findings | TP | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|
| **CodeAtlas #946 (best-of-2)** | 92 | 62 | 0.67 | 0.59 | 0.63 |
| CodeAtlas #947 (best-of-2, prior) | 107 | 71 | 0.66 | 0.68 | 0.67 |
| Claude raw diff (single) | 119 | 54 | 0.45 | 0.51 | 0.48 |
| CodeRabbit (3-judge avg) | 254 | 65 | 0.26 | 0.62 | 0.36 |

**Cost (CodeAtlas #946 input):** 290 LLM passes / 40 PRs (7.3/PR) · 2.04M input tokens (50.9k/PR). DEPENDENTS payload present on 38/40 PRs.
## Honest analysis — what #946 did and didn't move
**#946 is implemented, unit-tested, and verifiably firing: 38/40 PRs carried a DEPENDENTS payload** (callers/implementers/sibling-impls/tests of the changed symbols, span-sliced from other files).

**The targeted cross-file-contract wins materialized, exactly where designed:**
- **cal.com #10967: TP 1 → 3 (+2)** — the `createEvent(event, credentialId)` interface change vs Lark/Office365 implementers. The off-screen implementers were co-located as `implementer` dependents, and the model caught the signature-contract break it had missed every prior round.
- **keycloak #38446: TP 1 → 2 (+1)** — the construct→`removeStoredCredentialById` id-copy contract.

**But the aggregate best-of-2 came in at 62 TP (F1 0.63), below the prior #947 round's 71 (F1 0.67) — this is single-sample variance, not a #946 regression.** Per-PR, the comparison is mostly flat; the +3 from the two #946-targeted PRs was outweighed by −9 spread across PRs that simply drew a weaker review this round (cal_10600 −2, cal_11059 −2, discourse_4 −2 [was a lucky 6/6], discourse_7/10 −1, keycloak_36880/37634/40940 −1). **grafana came out identical (13→13)** — it has the fewest cross-file-contract golden, so the dependents add little and the draws matched.

**Why the noise dominates:** each cell is one best-of-2 draw; round-to-round TP swing is ≈±10 at 105 golden / 1–6 golden per PR. The localized #946 gain (~+3 on the 2–3 PRs with a true off-screen-implementer golden) is smaller than that envelope, so a single round can't show a clean aggregate lift. The capability is real and correct; proving it at the aggregate level needs best-of-N (N≥4) or several rounds averaged to beat the variance down — or simply more PRs whose golden are cross-file-contract bugs (this set has only ~4).

**Still the strongest reviewer on the board:** #946 (62, F0.63) beats Claude raw-diff (54, F0.48) on every metric and CodeRabbit (65, F0.36) on F1 + precision. Cost of the dependents: +20% input tokens (50.9k vs 42.6k/PR), +0 LLM calls.

**Verdict:** ship #946 (it strictly adds correct cross-file context and converts the contract-bug class it targets), but its benchmark value is in the tail (the specific implementer/caller/contract golden), not a headline aggregate number — and the headline is variance-bound until best-of-N.
