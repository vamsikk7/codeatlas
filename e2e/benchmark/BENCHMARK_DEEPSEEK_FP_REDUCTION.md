# deepseek-v4-flash — FP-reduction wave (#948–#953) re-run

Same reviewer (deepseek/deepseek-v4-flash, xhigh, via OpenRouter), same 40 PRs / 105 golden, same strict 1:1 oracle judge. The ONLY change is the FP-reduction wave: PRECISION GATES prompt block (#948 evidence-gating / #950 verify-before-absent / #952 redaction-aware + #949 diff-scoped label + #951 production-first) injected into the captured review prompts, strengthened sibling-impl dedup (#953), and the deterministic in-diff/test/dup post-filter (#949/#951/#953).

## Headline — false positives cut 38%, precision +43%, recall held

| deepseek run | findings | TP | FP | Precision | Recall | F1 |
|---|--:|--:|--:|--:|--:|--:|
| OLD (no FP fixes) | 278 | 59 | 219 | 0.21 | 0.56 | 0.31 |
| **NEW (#948–#953)** | **193** | **58** | **135** | **0.30** | **0.55** | **0.39** |
| delta | −85 (−31%) | −1 | **−84 (−38%)** | +0.09 | −0.01 | +0.08 |

- **False positives: 219 → 135 — 38% fewer.**
- **Recall held: 59 → 58 TP** (the −1 is within single-sample noise; no meaningful recall loss).
- **Precision 0.21 → 0.30 (+43% relative); F1 0.31 → 0.39 (+26%).**
- Token cost slightly lower (5.51M → 4.96M) — fewer findings emitted.

## Where the reduction came from (stacked)
- Raw findings 414 → 340, deduped 278 → 232 — the **prompt gates** alone removed 46 findings at generation (mostly speculative/wrong/redactor FPs).
- Deterministic filter 232 → 193 — dropped 33 off-diff + 2 test-nit + 1 dup (off-diff count fell vs the original's 41 because #949's prompt gate already suppressed many).
- Net 278 → 193.

## Per-repo false positives (old → new)
| Repo | FP old → new |
|---|---|
| cal.com | 87 → 55 |
| grafana | 29 → 26 |
| keycloak | 54 → 31 |
| discourse | 49 → 23 |

Every repo improved. Biggest absolute FP cuts: discourse (−26), keycloak (−23), cal.com (−32).

## Honesty notes
- Single fresh deepseek sample each side; per-PR TP wobbles with sampling (e.g. 22532 0→2, 10600 2→1) but the aggregate recall is flat and the FP drop (−84) is far beyond sampling noise.
- This beats the earlier filter-only-on-old-findings result (P0.24) — the prompt gates added real precision on top of the deterministic filter (P0.30).
