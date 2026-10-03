# Kimi-k2.7-code — effect of per-PR de-duplication (10 cal.com PRs, 31 golden)

Dedup = oracle semantic clustering per PR: merge findings sharing the same root cause (even across files, matching how golden bundles them) into one distinct defect, THEN judge.

## Aggregate — raw vs deduped
| | findings/defects | TP | FP | FN | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|--:|--:|
| kimi RAW | 127 | 18 | 109 | 13 | 0.14 | 0.58 | 0.23 |
| **kimi DE-DUPED** | 84 | 19 | 65 | 12 | **0.23** | 0.61 | **0.33** |
| _(deepseek-v4-flash, raw)_ | 77 | 16 | 61 | 15 | 0.21 | 0.52 | 0.30 |
| _(CodeRabbit, full pipeline)_ | 88 | 24.7 | 63.7 | 6.3 | 0.28 | 0.80 | 0.41 |

**Dedup collapsed 127 raw findings → 84 distinct defects (43 restatements removed, 34%). Precision 0.14→0.23, F1 0.23→0.33.** Recall is unchanged in principle (dedup only merges duplicates); the small TP shift (18→19) is judge variance on #7232's GOLD-2, not a dedup effect.

## Per-PR — raw → deduped (findings→defects · P · R · F1)
| PR | golden | raw (f/P/R/F1) | deduped (d/P/R/F1) |
|--:|--:|---|---|
| #7232 | 2 | 39/0.03/0.5/0.05 | 14/0.14/1/0.25 |
| #8087 | 2 | 17/0.12/1/0.21 | 9/0.22/1/0.36 |
| #8330 | 2 | 9/0.22/1/0.36 | 5/0.4/1/0.57 |
| #10600 | 4 | 4/0.5/0.5/0.5 | 4/0.5/0.5/0.5 |
| #10967 | 5 | 15/0.2/0.6/0.3 | 14/0.21/0.6/0.32 |
| #11059 | 5 | 15/0.2/0.6/0.3 | 14/0.21/0.6/0.32 |
| #14740 | 5 | 16/0.19/0.6/0.29 | 12/0.25/0.6/0.35 |
| #14943 | 2 | 5/0.2/0.5/0.29 | 5/0.2/0.5/0.29 |
| #22345 | 2 | 3/0/0/0 | 3/0/0/0 |
| #22532 | 2 | 4/0.25/0.5/0.33 | 4/0.25/0.5/0.33 |

## Takeaways
- **Dedup is real and significant: F1 +45% (0.23→0.33), precision +60%.** Worst-case PRs benefit most: #7232 precision 0.03→0.14 (39 findings → 14 defects), #8330 0.22→0.40.
- **Deduped kimi (F1 0.33) now edges past deepseek (0.30)** and closes ~half the gap to CodeRabbit (0.41).
- **Dedup does NOT fix the remaining precision gap** — even at 84 distinct defects, 65 are off-golden. These are genuinely DISTINCT findings outside the golden set (SAML open-redirect, JWT-no-expiry, missing admin checks, transaction-safety) — some real bugs the benchmark doesn't enumerate, some speculative. Dedup removes restatement-noise; it can't remove out-of-scope findings.
- **Product implication:** a de-dup pass in the review pipeline is a clear, cheap precision win (collapse ~34% of findings, lift F1 ~40%). Beyond that, precision needs scope-discipline (the model raising fewer speculative findings), which is a prompt/model lever.