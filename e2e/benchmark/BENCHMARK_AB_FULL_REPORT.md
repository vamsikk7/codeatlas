# A/B across all 46 Martian PRs — CodeAtlas context vs raw PR diff

Same Claude (Opus) reviewer, same rigor, same strict 1:1 oracle judge, same golden, on **46 PRs / 5 repos / 124 golden bugs**. Only the CONTEXT differs:
- **A = CodeAtlas** — assembled per-entry-point packs + project pass, windowed diff, cross-file participants, redacted.
- **B = raw PR diff only** — the full `git diff`, one-shot, no CodeAtlas.

## Overall (124 golden)
| Arm | findings | golden caught | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|
| A · CodeAtlas context | 159 | 58 | 0.43 | 0.47 | 0.45 |
| **B · raw PR diff only** | 154 | **61** | **0.47** | **0.49** | **0.48** |

**Overall, raw diff edges CodeAtlas (61 vs 58 golden, F1 0.48 vs 0.45).** Per-PR recall winner: B 11 · A 8 · tie 27.

## Per-repo (this is the real story)
| Repo | golden | A caught (P/R/F1) | B caught (P/R/F1) | winner |
|---|--:|---|---|:--:|
| **cal.com** (JS/TS) | 31 | **23** · 0.43/0.74/0.55 | 17 · 0.31/0.55/0.40 | **A +6** |
| discourse (Ruby/SCSS) | 28 | 12 · 0.44/0.43/0.44 | 15 · 0.56/0.54/0.55 | B +3 |
| grafana (Go/TS) | 22 | 9 · 0.36/0.41/0.38 | 10 · 0.45/0.45/0.45 | B +1 |
| keycloak (Java) | 24 | 10 · 0.50/0.42/0.45 | 12 · 0.75/0.50/0.60 | B +2 |
| sentry (Python) | 19 | 4 · 0.40/0.21/0.28 | 7 · 0.58/0.37/0.45 | B +3 |

### The split that matters
| Slice | A recall | B recall |
|---|--:|--:|
| **cal.com (10 PRs, JS/TS)** | **0.74** | 0.55 |
| **non-cal (36 PRs, Ruby/Go/Java/Python)** | 0.38 | **0.47** |

CodeAtlas **wins decisively on cal.com** (+6 golden, the repo it was built and tuned on) but **loses on all four other repos** (−9 golden combined). The cal.com win is real, not luck — but it does not generalize to the rest of the benchmark as-is.

## Why CodeAtlas flips from winner to loser off cal.com
The cal.com miss-analysis already identified the three pipeline costs; off cal.com those costs dominate and the entry-point benefit disappears:

1. **Entry-point anchoring needs entry points.** cal.com is a JS/TS monorepo dense with tRPC handlers / API routes — CodeAtlas's per-entry-point packs frame each change around its handler and surface logic bugs. discourse (CSS/SCSS theming, i18n), grafana config, keycloak/Java, sentry/Python have far fewer (or zero) detected entry points. Several discourse/grafana PRs had **0 entry points**, so the A-arm fell back to a thin/windowed project pass while B got the **complete** diff. You can't anchor on an entry point that detection didn't find.

2. **Windowing + redaction remove information the raw diff keeps.** When the structuring doesn't add value, its lossy steps (diff-window `… N unchanged …` gaps, secret-redaction rewriting real literals to `[REDACTED]`, per-call fragmentation) are pure subtraction. B always sees every changed line verbatim. On cal.com the redactor already cost a confirmed golden (#11059); off cal.com these costs aren't offset by entry-point gains.

3. **Non-JS coverage is weaker.** CodeAtlas's parser/entry-point detection is richest for JS/TS; on Java/Go/Python/Ruby it surfaces less structure, so the A-arm context is closer to "a worse-formatted diff" than to "an enriched diff."

## Bottom line
- **On its home turf (JS/TS, entry-point-dense), CodeAtlas context engineering is a strong, real win: +6 golden, +0.15 F1 vs raw diff.**
- **Across the broader benchmark it is currently a slight net negative (−3 golden, −0.03 F1)** — the entry-point benefit doesn't generalize to theming/config/i18n PRs or to non-JS languages, while the lossy windowing/redaction costs apply everywhere.
- **Actionable:** the gains are language- and PR-shape-dependent. Highest-leverage fixes, in order: (a) fix the **redactor** over-reach (helps every repo, confirmed to cost real bugs), (b) when **0 entry points** are detected, fall back to the **full raw diff** rather than a windowed project pass (would recover most of the non-cal losses — B beats A precisely on those PRs), (c) extend entry-point detection + reduce diff-window gap-collapsing for non-JS languages.

Artifacts: `results/ab-full/ab_full_summary.json` (per-repo + overall), `results/ab-full/judged.json` (per-PR), `results/ab-full/{A,B}-findings/` (raw findings), `results/ab-full/B-diffs/` (raw PR diffs).
