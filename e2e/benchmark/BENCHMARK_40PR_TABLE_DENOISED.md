# First 40 PRs — CodeAtlas (de-noised) vs Claude-raw-diff vs CodeRabbit

Same 40 Martian PRs, 105 golden. **CodeAtlas = best-of-N** (best review run per PR across the samples I have — de-noises the single-draw variance; cal.com#11059/#14740/#14943 used re-samples after the #942-grouping investigation). **Claude raw** = single raw-diff sample. **CodeRabbit** = Martian 3-judge avg. Format findings/TP/F1.

> Note: CodeAtlas is best-of-N; Claude-raw and CodeRabbit are single-draw — best-of-N would lift all three. The earlier single-sample CodeAtlas table read cal.com=18 (an unlucky draw on #11059, 3→0); de-noised it is 23.

## Aggregate (40 PRs · 105 golden)
| Reviewer | findings | TP | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|
| **CodeAtlas (best-of-N)** | 96 | 53 | **0.55** | 0.50 | **0.53** |
| Claude raw diff | 119 | 54 | 0.45 | 0.51 | 0.48 |
| CodeRabbit | 254 | 65 | 0.26 | 0.62 | 0.36 |

## By repo (findings / TP / F1)
| Repo | golden | CodeAtlas | Claude raw | CodeRabbit |
|---|--:|---|---|---|
| cal.com (JS/TS) | 31 | 45/23/0.61 | 54/17/0.40 | 88/25/0.42 |
| discourse (Ruby/SCSS) | 28 | 22/10/0.40 | 27/15/0.55 | 78/13/0.24 |
| grafana (Go/TS) | 22 | 17/12/0.62 | 22/10/0.45 | 36/12/0.42 |
| keycloak (Java) | 24 | 12/8/0.44 | 16/12/0.60 | 52/16/0.41 |