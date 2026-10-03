# CodeAtlas Code-Review Benchmark — Real LLM Run (cal.com, 10 PRs)

**Reviewer model:** `deepseek/deepseek-v4-flash` (provider openrouter, reasoning **xhigh**) · **Date:** 2026-06-28
**Pipeline:** CodeAtlas review-pr (per-entry + project pass) · **Judge:** Claude oracle (strict 1:1 finding↔golden match; FP includes out-of-golden real findings + duplicates)
**Ground truth:** Martian code-review-benchmark golden_comments (cal_dot_com.json)

## Headline
| metric | micro (pooled) | macro (avg/PR) |
|---|--:|--:|
| Precision | **0.208** | 0.281 |
| Recall | **0.516** | 0.63 |
| F1 | **0.296** | 0.354 |

Golden bugs: **31** · CodeAtlas findings: **77** · TP **16** / FP **61** / FN **15**
Tokens: **412,149** in + **414,994** completion = 827,143 · LLM calls: **61** · wall: 97 min

## Per-PR results
| repo | PR | golden | findings | TP | FP | FN | P | R | F1 | in tok | comp tok | calls | wall s |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| calcom/cal.com | #7232 | 2 | 18 | 2 | 16 | 0 | 0.11 | 1 | 0.2 | 113,551 | 99,884 | 17 | 817 |
| calcom/cal.com | #8087 | 2 | 13 | 2 | 11 | 0 | 0.15 | 1 | 0.27 | 58,266 | 51,928 | 8 | 415 |
| calcom/cal.com | #8330 | 2 | 8 | 2 | 6 | 0 | 0.25 | 1 | 0.4 | 31,531 | 39,236 | 4 | 495 |
| calcom/cal.com | #10600 | 4 | 5 | 2 | 3 | 2 | 0.4 | 0.5 | 0.44 | 30,431 | 35,354 | 4 | 640 |
| calcom/cal.com | #10967 | 5 | 10 | 3 | 7 | 2 | 0.3 | 0.6 | 0.4 | 36,425 | 34,717 | 5 | 460 |
| calcom/cal.com | #11059 | 5 | 10 | 1 | 9 | 4 | 0.1 | 0.2 | 0.13 | 32,613 | 33,390 | 6 | 603 |
| calcom/cal.com | #14740 | 5 | 5 | 0 | 5 | 5 | 0 | 0 | 0 | 48,418 | 56,352 | 9 | 1166 |
| calcom/cal.com | #14943 | 2 | 3 | 1 | 2 | 1 | 0.33 | 0.5 | 0.4 | 24,412 | 14,808 | 3 | 323 |
| calcom/cal.com | #22345 | 2 | 2 | 1 | 1 | 1 | 0.5 | 0.5 | 0.5 | 9,242 | 14,829 | 1 | 300 |
| calcom/cal.com | #22532 | 2 | 3 | 2 | 1 | 0 | 0.67 | 1 | 0.8 | 27,260 | 34,496 | 4 | 578 |

## Per-PR comments
- **#7232** (P 0.11 / R 1 / F1 0.2, 2g vs 18f): Caught BOTH golden (forEach-async + orphaned reminder rows) — perfect recall — but precision collapsed: the same 2 defects are restated 4-5× across bookings.tsx/workflows.tsx, plus extra SAML open-redirect/auth findings outside the golden set.
- **#8087** (P 0.15 / R 1 / F1 0.27, 2g vs 13f): Both golden caught; flooded with 7 duplicate reports of the same forEach defect + 4 unrelated extras (auth, leaked errors), crushing precision.
- **#8330** (P 0.25 / R 1 / F1 0.4, 2g vs 8f): Both golden caught (dayjs === identity, slotStartTime end-time); each reported ~3× plus 2 distinct extra claims (timezone, partial-overlap).
- **#10600** (P 0.4 / R 0.5 / F1 0.44, 4g vs 5f): Nailed the 2 high-sev defects (concurrent backup-code reuse, case-sensitive indexOf); missed both Low naming/wording golds; 3 FPs incl. a duplicate + unhandled-decryption.
- **#10967** (P 0.3 / R 0.6 / F1 0.4, 5g vs 10f): Caught 3/5 (null-ref, slug inversion, createEvent interface break); missed redundant optional-chaining + self-matching externalCalendarId; 7 unmatched findings.
- **#11059** (P 0.1 / R 0.2 / F1 0.13, 5g vs 10f): Only matched the safeParse-wrapper-stored-as-key bug; missed hardcoded refresh_token, invalid Zod key, and both return-shape bugs; spent most findings on unrelated webhook concerns.
- **#14740** (P 0 / R 0 / F1 0, 5g vs 5f): Total miss — found only dynamic-import error handling (4 near-identical) + a comment nit, none matching the 5 real defects (case bypass, &&/||, wrong email set, dedup, useState['']) though the dry-run showed all 5 were present in context.
- **#14943** (P 0.33 / R 0.5 / F1 0.4, 2g vs 3f): Caught the SMS deleteMany missing-method-filter bug; missed the stale-retryCount race; 2 unrelated findings (JWT expiry, @IsEnum) in other changed files.
- **#22345** (P 0.5 / R 0.5 / F1 0.5, 2g vs 2f): Caught the unreachable dead-branch; missed the org-member filtering bug; 1 unrelated JWT-expiry finding.
- **#22532** (P 0.67 / R 1 / F1 0.8, 2g vs 3f): Caught BOTH (empty {} to updateMany blocking @updatedAt; macOS sed -i '' in CI shell script — the i18n/#937-adjacent + #938 wins); 1 extra query-invalidation finding.

## Interpretation
**The context is complete; the model is the bottleneck.** The dry-run findability study (same 10 PRs) showed **31/31 golden bugs (100%) are present in the input** CodeAtlas assembles. Here, end-to-end with `deepseek-v4-flash` + xhigh, the model actually surfaced **16/31 (52% recall)** — so the ~48-point gap is the reviewer model's reasoning/extraction limit, not a CodeAtlas context gap. A stronger model should climb toward the 100% ceiling without any pipeline change.

**Precision (21%) understates quality** for two reasons the metric is strict about:
1. **Duplicate findings** — the model restates the SAME defect 3-7× across files (#7232, #8087, #8330 each report one bug many times). Under 1:1 matching every restatement is an FP. **De-duplicating findings would sharply lift precision** with no recall loss — the highest-value product fix this run surfaces.
2. **Real bugs outside the golden set** — several FPs are plausible genuine issues the golden set simply doesn't enumerate (JWT tokens without expiry, SAML open-redirect, `@IsEnum` misuse). They count against precision here but are not hallucinations.

**Worst case:** #14740 scored 0/5 — the model produced 5 findings (4 near-identical dynamic-import notes) and missed all five real defects despite every one being present in the assembled context. A clear model-side failure, not a context gap.
**Best case:** #22532 (F1 0.80) — both golden caught including the i18n/shell-script bugs that motivated #937/#938, with only one extra finding.

## Cost
827,143 total tokens over 61 calls. xhigh reasoning roughly doubles tokens (completion ≈ input) and dominates wall time (~97 min for 10 PRs). At deepseek-v4-flash rates this sweep is a few cents; on a frontier model it would be the main lever for higher recall.