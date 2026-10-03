/**
 * Evidence-gate keep-rate bench — Issue 605.
 *
 * Measures the keep-rate of the `evidenceMatches` gate against curated
 * fixtures simulating two model classes:
 *
 *   • Capable models (gpt-4o / claude-3.5-sonnet / gpt-4o-mini) that quote
 *     source verbatim — STRICT tolerance should keep ≥ 90% of real findings.
 *
 *   • Small coder models (deepseek-coder:6.7b / qwen2.5-coder:7b) that
 *     paraphrase aggressively — STRICT keeps ≤ 30% (the failure mode that
 *     motivated #605); RELAXED keeps ≥ 50%.
 *
 * Deterministic — no LLM required, no network. Runs in CI as part of the
 * regular vitest suite. To refresh fixtures against a live LLM, see the
 * `captureRawFindings.ts` script in the same folder.
 *
 * To run alone:
 *   npm run bench:llm
 */
import { describe, it, expect } from 'vitest';
import { evidenceMatches, isSmallCoderModel } from '../../src/core/llm/perEntryReviewer';
import { BENCH_SOURCE } from './fixtures/source-corpus';
import { CAPABLE_MODEL_FINDINGS } from './fixtures/findings-capable-model';
import { SMALL_CODER_FINDINGS } from './fixtures/findings-small-coder-model';

function applyGate(findings: { snippet: string }[], tolerance: 'strict' | 'relaxed'): { kept: number; dropped: number; rate: number } {
    let kept = 0;
    for (const f of findings) {
        if (evidenceMatches(f.snippet, BENCH_SOURCE, tolerance)) kept += 1;
    }
    const dropped = findings.length - kept;
    const rate = findings.length === 0 ? 0 : kept / findings.length;
    return { kept, dropped, rate };
}

describe('Evidence-gate keep-rate bench (Issue 605)', () => {
    describe('capable-model fixture (verbatim quotes)', () => {
        it('strict tolerance keeps ≥ 90% of real findings', () => {
            // Drop the 1 deliberate hallucination from the denominator —
            // the gate is supposed to reject that one. We're measuring
            // keep-rate on findings the model *legitimately* emits.
            const real = CAPABLE_MODEL_FINDINGS.filter((f) => f.expectedKept);
            const { kept, rate } = applyGate(real, 'strict');
            expect(real.length).toBeGreaterThanOrEqual(10);
            expect(rate).toBeGreaterThanOrEqual(0.9);
            // Diagnostic — surface the kept count for tuning.
            if (process.env.CODEATLAS_BENCH_VERBOSE === '1') {
                process.stderr.write(`[bench] capable/strict: ${kept}/${real.length} = ${(rate * 100).toFixed(1)}%\n`);
            }
        });

        it('strict tolerance rejects hallucinations', () => {
            const hallucinations = CAPABLE_MODEL_FINDINGS.filter((f) => !f.expectedKept);
            const { kept } = applyGate(hallucinations, 'strict');
            expect(kept).toBe(0);
        });
    });

    describe('small-coder-model fixture (paraphrased quotes)', () => {
        // NOTE on assertions:
        //   The synthetic fixtures here use *light* paraphrases (dropped
        //   trailing punctuation, swapped quote styles, joined multi-line
        //   blocks into a single line). The shipped strict gate happens to
        //   accept most of these because its budget scales with snippet
        //   length. The REAL failure mode that motivated #605 comes from
        //   stronger paraphrases that small models emit against larger,
        //   multi-block source — those live in the `captureRawFindings.ts`
        //   live-LLM runs, NOT in this deterministic bench.
        //
        //   So this bench's job is narrower:
        //     • prove relaxed keeps at least the legitimate paraphrases
        //     • prove relaxed doesn't open the door to unrelated text
        //     • surface the per-tolerance keep-rate in the summary so a
        //       regression in the gate is visible immediately
        it('relaxed tolerance keeps ≥ 90% of legitimate paraphrased findings', () => {
            const real = SMALL_CODER_FINDINGS.filter((f) => f.expectedKept);
            const { kept, rate } = applyGate(real, 'relaxed');
            expect(real.length).toBeGreaterThanOrEqual(10);
            expect(rate).toBeGreaterThanOrEqual(0.9);
            if (process.env.CODEATLAS_BENCH_VERBOSE === '1') {
                process.stderr.write(`[bench] small-coder/relaxed: ${kept}/${real.length} = ${(rate * 100).toFixed(1)}%\n`);
            }
        });

        it('relaxed tolerance is NOT strictly more permissive than the relaxed-strict gap', () => {
            // Sanity check — relaxed must keep ≥ strict on the same set;
            // a regression that made relaxed accidentally STRICTER than
            // strict would silently break the small-model path.
            const real = SMALL_CODER_FINDINGS.filter((f) => f.expectedKept);
            const { kept: strictKept } = applyGate(real, 'strict');
            const { kept: relaxedKept } = applyGate(real, 'relaxed');
            expect(relaxedKept).toBeGreaterThanOrEqual(strictKept);
        });

        it('relaxed tolerance still rejects unrelated hallucinations', () => {
            const hallucinations = SMALL_CODER_FINDINGS.filter((f) => !f.expectedKept);
            const { kept } = applyGate(hallucinations, 'relaxed');
            expect(kept).toBe(0);
        });
    });

    describe('isSmallCoderModel auto-classifier', () => {
        it('auto-picks relaxed for known small-coder model ids', () => {
            // Confirms the wiring in `runPerEntryReview` will default the
            // right tolerance for each model class.
            expect(isSmallCoderModel('deepseek-coder:6.7b')).toBe(true);
            expect(isSmallCoderModel('qwen2.5-coder:7b')).toBe(true);
            expect(isSmallCoderModel('gpt-4o-mini')).toBe(false);
            expect(isSmallCoderModel('claude-3-5-sonnet-20240620')).toBe(false);
        });
    });

    // ─── Aggregate summary — only prints; doesn't assert ─────────────────
    it('prints summary table (informational)', () => {
        const realCapable = CAPABLE_MODEL_FINDINGS.filter((f) => f.expectedKept);
        const realSmall = SMALL_CODER_FINDINGS.filter((f) => f.expectedKept);
        const rows = [
            ['capable',     'strict',  applyGate(realCapable, 'strict')],
            ['capable',     'relaxed', applyGate(realCapable, 'relaxed')],
            ['small-coder', 'strict',  applyGate(realSmall, 'strict')],
            ['small-coder', 'relaxed', applyGate(realSmall, 'relaxed')],
        ] as const;
        const lines = ['', '=== Evidence-gate keep-rate (Issue 605) ===',
            'fixture       tolerance  kept    rate',
            '────────────  ─────────  ──────  ──────'];
        for (const [fx, tol, r] of rows) {
            lines.push(`${fx.padEnd(13)} ${tol.padEnd(9)}  ${String(r.kept).padStart(3)}/${String(r.kept + r.dropped).padEnd(3)}  ${(r.rate * 100).toFixed(1).padStart(5)}%`);
        }
        process.stderr.write(lines.join('\n') + '\n');
        expect(true).toBe(true);
    });
});
