# A/B — CodeAtlas context vs raw PR diff (same model, judge, golden)

Both arms: **Claude (Opus)** reviewer, same rigor instructions, same strict 1:1 oracle judge, same 31 Martian golden over 10 cal.com PRs. Only the CONTEXT differs:
- **A = CodeAtlas** — assembled per-entry-point packs + project pass (multi-pass), windowed diff, cross-file participants, redacted.
- **B = raw PR diff only** — the full `git diff` for the PR, one-shot, no CodeAtlas (the "no-context-engineering" baseline).

## Aggregate (31 golden)
| Arm | findings | TP | FP | FN | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|--:|--:|
| **A · CodeAtlas context** | 53 | 23 | 30 | 8 | **0.43** | **0.74** | **0.55** |
| B · raw PR diff only | 54 | 17 | 37 | 14 | 0.32 | 0.55 | 0.40 |
| **Δ (CodeAtlas lift)** | -1 | **+6** | -7 | -6 | **+0.12** | **+0.19** | **+0.15** |

## Per-PR (golden · TP · P/R/F1)
| PR | golden | A CodeAtlas (TP · P/R/F1) | B raw diff (TP · P/R/F1) | golden caught Δ |
|--:|--:|---|---|:--:|
| #7232 | 2 | 2 · 0.29/1/0.44 | 2 · 0.29/1/0.44 | = |
| #8087 | 2 | 1 · 0.25/0.5/0.33 | 1 · 0.33/0.5/0.4 | = |
| #8330 | 2 | 2 · 1/1/1 | 2 · 0.4/1/0.57 | = |
| #10600 | 4 | 3 · 0.43/0.75/0.55 | 1 · 0.2/0.25/0.22 | **+2** |
| #10967 | 5 | 3 · 0.5/0.6/0.55 | 2 · 0.33/0.4/0.36 | **+1** |
| #11059 | 5 | 3 · 0.27/0.6/0.37 | 3 · 0.3/0.6/0.4 | = |
| #14740 | 5 | 4 · 0.57/0.8/0.67 | 3 · 0.43/0.6/0.5 | **+1** |
| #14943 | 2 | 2 · 0.5/1/0.67 | 1 · 0.33/0.5/0.4 | **+1** |
| #22345 | 2 | 1 · 0.33/0.5/0.4 | 0 · 0/0/0 | **+1** |
| #22532 | 2 | 2 · 1/1/1 | 2 · 0.4/1/0.57 | = |

## Verdict
- **CodeAtlas context wins decisively: 23/31 golden vs 17/31 (+6), F1 0.55 vs 0.40 (+37%), at higher precision too (0.43 vs 0.32).** Same model, same diff content available — the structuring/curation is what moved the needle.
- **Where CodeAtlas pulls ahead:** #10600 (+2: caught case-sensitivity + naming the raw diff buried among 16 files), #10967, #14740, #14943, #22345 (+1 each). The per-entry-point framing surfaces logic bugs that drown in a flat diff.
- **The one place raw beats CodeAtlas confirms the redactor bug:** on #11059 the raw arm caught GOLD-1 (hardcoded `refresh_token` literal) that CodeAtlas MISSED — because CodeAtlas's secret-redactor had rewritten that literal to `[REDACTED]`. Net recall still tied (3/5 each, different goldens), but it pinpoints exactly the fix from the miss analysis: un-break the redactor and CodeAtlas would lead even on #11059.
- **Net:** context engineering adds **+6 real bugs caught** and **+15 F1 points** over handing the model the same PR as a raw diff — and the lone raw win is a self-inflicted redactor regression, not a context-design limit.