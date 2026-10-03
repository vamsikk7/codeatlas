# Why Claude-on-CodeAtlas missed 8/31 golden — input root-cause analysis

For each miss we inspected the EXACT captured input the reviewer saw (`results/claude-review/calls/pr-<n>.calls.json`) and classified the cause.

| # | PR | Golden missed | Evidence in input? | Cause | Fix owner |
|---|--:|---|---|---|---|
| 1 | #8087 | GOLD-1 try/catch around awaited dynamic import | **Yes** — added line `+967 const paymentApp = await appStore[...]`, shown as changed | LOW_SEV_SKIP | reviewer (severity policy) |
| 2 | #10600 | GOLD-2 "backup code login" msg in a *disable* endpoint | **Yes** — added line `+50 console.error("…backup code login.")`, model was reviewing adjacent lines | **MODEL_MISS** | reviewer |
| 3 | #10967 | GOLD-2 redundant `?.` on `mainHostDestinationCalendar?.integration` | **Yes** — added line in BrokenIntegrationEmail.tsx | LOW_SEV_SKIP | reviewer (severity policy) |
| 4 | #10967 | GOLD-5 `createEvent` interface contract break (Lark/Office365 not updated) | **Fragmented** — interface change in call 3; stale Lark/Office365 impls in call 2 *as unchanged context*; never co-located | **CONTEXT_GAP** | **CodeAtlas** |
| 5 | #11059 | GOLD-1 hardcoded `refresh_token = "refresh_token"` literal | **Destroyed** — secret redactor rewrote the literal to `"[REDACTED]"`, so it reads like deliberate redaction logic | **CONTEXT_GAP (redactor)** | **CodeAtlas** |
| 6 | #11059 | GOLD-5 `res?.data` undefined → TypeError | **Yes, but split** — model *did* flag the mechanism (FIND-4), judge credited it to GOLD-4 (duplicate golden) | NEAR_MISS (not really missed) | judge/golden dup |
| 7 | #14740 | GOLD-5 MultiEmail init `['']` vs `[]` | **Yes** — added line `+32 useState<string[]>([""])`, component file included | LOW_SEV_SKIP | reviewer (severity policy) |
| 8 | #22345 | GOLD-2 org members excluded when `teamsFromOrg.length === 0` | **Yes, but framed out** — guard shown as *unchanged context* (`158:`–`162:`), binding hidden inside a `… 4 unchanged …` gap | **CONTEXT_GAP (diff window)** | **CodeAtlas** |

## Synthesis of the 8

- **3 = CodeAtlas context/pipeline gaps (fixable, would recover recall):**
  - **#11059-G1 — redactor over-reach.** The secret-redaction pass treated the string literal `"refresh_token"` as a credential value and replaced it with `"[REDACTED]"`. The reviewer literally could not see the bug (`refreshTokenResponse.data.refresh_token = "[REDACTED]"` reads as intentional redaction). **Clearest, highest-value fix** — redaction is destroying real code semantics. Relates to [[project_cascade_architecture]] redactor fragility.
  - **#10967-G5 — cross-file contract fragmentation.** Detecting an interface/implementation contract break needs the changed interface AND the un-updated implementers in one prompt. They landed in *separate* project-pass calls, and the stale `createEvent(event)` signatures appeared only as unchanged context. No single call held both sides → impossible to join. Fix: co-locate interface declarers + their implementers in the same review context.
  - **#22345-G2 — diff window collapsed load-bearing context.** The `teamsFromOrg.length > 0` guard that *causes* the bug was rendered as unchanged context and the relevant binding was hidden inside a `… 4 unchanged …` gap, while the prompt scopes the review to `+/-` lines. The change's correctness depended on adjacent unchanged lines the window de-emphasized. Fix: when a changed block's behavior hinges on adjacent unchanged lines, keep them in-window (don't gap-collapse load-bearing dependencies).

- **1 = genuine model miss:** #10600 — evidence unambiguous and in-window, reviewer simply didn't flag the message/endpoint wording mismatch. Reviewer-side; a stronger model or a targeted "message-vs-behavior" nudge recovers it.

- **3 = low-severity skips (defensible):** #8087, #10967-G2, #14740 — all explicitly Low golden (try/catch nit, redundant `?.`, `['']` vs `[]`). The reviewer deprioritized them *exactly as the precision-discipline prompt instructs*. Recoverable only by accepting more nits — at a precision cost. This is arguably correct behavior, not a defect.

- **1 = not actually a miss:** #11059-G5 — the reviewer found the defect (FIND-4); it went uncredited only because two golden entries describe the same root cause and strict 1:1 consumed one. A golden-dataset duplication artifact.

## Bottom line
Of the 8 "misses": **~1 isn't a miss** (near-miss), **3 are defensible Low-sev skips**, **1 is a real model miss**, and **3 are CodeAtlas-fixable context gaps**. Fixing the three context gaps (redactor over-reach, cross-file contract co-location, diff-window load-bearing context) would lift Claude from **23 → ~26/31 (recall 0.74 → 0.84)** with no model change — and the redactor fix likely helps every model on every PR.
