# Per-PR: deepseek (FP-reduced) vs CodeRabbit vs Claude raw-diff

Same 40 PRs / 105 golden, one strict 1:1 oracle judge. Cells = **TP·findings** (true positives · total findings). deepseek-new = deepseek-v4-flash on CodeAtlas context WITH the #948–#953 FP reducers; deepseek-old = same model before the fixes; CodeRabbit = 3-judge avg; raw = Claude on a plain git diff.

## cal.com
| PR | golden | deepseek-new TP·F | deepseek-old TP·F | CodeRabbit TP·F | Claude raw TP·F |
|---|--:|--:|--:|--:|--:|
| #7232 | 2 | 2·10 | 2·20 | 2·13 | 2·7 |
| #8087 | 2 | 1·5 | 1·8 | 2·8 | 1·3 |
| #8330 | 2 | 2·7 | 2·12 | 2·4 | 2·5 |
| #10600 | 4 | 1·8 | 2·8 | 2·8 | 1·5 |
| #10967 | 5 | 3·7 | 4·18 | 3.7·12 | 2·6 |
| #11059 | 5 | 3·8 | 4·13 | 5·19 | 3·10 |
| #14740 | 5 | 3·18 | 4·13 | 4·10 | 3·7 |
| #14943 | 2 | 0·2 | 1·6 | 2·3 | 1·3 |
| #22345 | 2 | 1·4 | 0·3 | 1·4 | 0·3 |
| #22532 | 2 | 2·4 | 0·6 | 1·7 | 2·5 |
| **TOTAL** | **31** | **18·73** | 20·107 | 25·88 | 17·54 |

## discourse
| PR | golden | deepseek-new TP·F | deepseek-old TP·F | CodeRabbit TP·F | Claude raw TP·F |
|---|--:|--:|--:|--:|--:|
| #1 | 3 | 2·3 | 2·2 | 1.7·7 | 2·3 |
| #2 | 2 | 1·5 | 2·8 | 1.7·8 | 1·3 |
| #3 | 2 | 1·4 | 1·4 | 1·7 | 1·2 |
| #4 | 6 | 5·6 | 6·19 | 3.7·23 | 2·4 |
| #5 | 2 | 1·1 | 1·1 | 0·1 | 0·0 |
| #6 | 1 | 1·3 | 0·2 | 0.7·2 | 1·1 |
| #7 | 3 | 1·1 | 1·3 | 0·2 | 3·5 |
| #8 | 3 | 3·5 | 0·7 | 2·10 | 1·2 |
| #9 | 2 | 0·3 | 1·5 | 0·3 | 1·2 |
| #10 | 4 | 1·8 | 0·12 | 2·15 | 3·5 |
| **TOTAL** | **28** | **16·39** | 14·63 | 13·78 | 15·27 |

## grafana
| PR | golden | deepseek-new TP·F | deepseek-old TP·F | CodeRabbit TP·F | Claude raw TP·F |
|---|--:|--:|--:|--:|--:|
| #76186 | 2 | 2·7 | 1·6 | 1·2 | 0·0 |
| #79265 | 5 | 2·4 | 1·5 | 3.3·8 | 2·3 |
| #80329 | 1 | 1·1 | 1·4 | 1·4 | 1·2 |
| #90045 | 3 | 2·9 | 3·8 | 3·5 | 3·5 |
| #90939 | 2 | 1·3 | 1·4 | 1·2 | 1·1 |
| #94942 | 2 | 2·2 | 2·2 | 1·2 | 1·1 |
| #97529 | 2 | 1·1 | 1·2 | 1·4 | 1·2 |
| #103633 | 2 | 0·2 | 0·4 | 0·1 | 0·2 |
| #106778 | 2 | 0·6 | 0·3 | 1·7 | 1·4 |
| #107534 | 1 | 0·2 | 0·1 | 0·1 | 0·2 |
| **TOTAL** | **22** | **11·37** | 10·39 | 12·36 | 10·22 |

## keycloak
| PR | golden | deepseek-new TP·F | deepseek-old TP·F | CodeRabbit TP·F | Claude raw TP·F |
|---|--:|--:|--:|--:|--:|
| #32918 | 2 | 0·3 | 1·6 | 1·2 | 2·2 |
| #33832 | 2 | 2·7 | 2·5 | 1.3·5 | 2·2 |
| #36880 | 3 | 3·7 | 1·6 | 1·6 | 2·2 |
| #36882 | 1 | 0·2 | 1·5 | 0·2 | 0·1 |
| #37038 | 2 | 1·5 | 2·16 | 2·10 | 1·1 |
| #37429 | 4 | 2·3 | 2·11 | 3·9 | 0·2 |
| #37634 | 4 | 2·7 | 2·6 | 3.3·9 | 2·3 |
| #38446 | 2 | 0·4 | 2·7 | 2·4 | 1·1 |
| #40940 | 2 | 1·2 | 0·0 | 1·1 | 2·2 |
| greptile#1 | 2 | 2·4 | 2·7 | 1·4 | 0·0 |
| **TOTAL** | **24** | **13·44** | 15·69 | 16·52 | 12·16 |

## Per-repo summary (TP / F1)
| Repo | golden | deepseek-new | deepseek-old | CodeRabbit | Claude raw |
|---|--:|--:|--:|--:|--:|
| cal.com | 31 | 18 / 0.35 | 20 / 0.29 | 25 / 0.42 | 17 / 0.40 |
| discourse | 28 | 16 / 0.48 | 14 / 0.31 | 13 / 0.24 | 15 / 0.55 |
| grafana | 22 | 11 / 0.37 | 10 / 0.33 | 12 / 0.42 | 10 / 0.45 |
| keycloak | 24 | 13 / 0.38 | 15 / 0.32 | 16 / 0.41 | 12 / 0.60 |

## TOTAL (40 PRs, 105 golden)
| Reviewer | findings | TP | FP | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|--:|
| **deepseek-new (FP-reduced)** | 193 | 58 | 135 | 0.30 | 0.55 | 0.39 |
| deepseek-old (no fixes) | 278 | 59 | 219 | 0.21 | 0.56 | 0.31 |
| CodeRabbit (3-judge avg) | 254 | 65 | 189 | 0.26 | 0.62 | 0.36 |
| Claude raw diff | 119 | 54 | 65 | 0.45 | 0.51 | 0.48 |