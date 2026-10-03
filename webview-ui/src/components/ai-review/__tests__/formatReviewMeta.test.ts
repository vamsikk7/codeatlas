import { describe, it, expect } from 'vitest';
import { formatReviewMeta } from '../formatReviewMeta';

/**
 * BUG-AIREVIEW-PANEL-NANS (2026-07-22) — the AI-review panel footer rendered
 * `{model} | {totalTokens} tokens | {round(durationMs/1000)}s` directly. When a
 * review result arrived without `totalTokens`/`durationMs` (or without `meta`),
 * the footer showed "NaN tokens | NaNs" (and, unguarded, could throw). The
 * formatter must degrade gracefully — never "NaN", never throw.
 */
describe('formatReviewMeta', () => {
    it('formats a complete meta', () => {
        expect(formatReviewMeta({ model: 'gpt-4', totalTokens: 1500, durationMs: 3200 }))
            .toBe('gpt-4 | 1,500 tokens | 3s');
    });
    it('omits missing pieces instead of rendering NaN (partial meta)', () => {
        const out = formatReviewMeta({ model: 'x' } as never);
        expect(out).not.toMatch(/NaN/);
        expect(out).toContain('x');
    });
    it('never throws / NaN on undefined meta', () => {
        expect(() => formatReviewMeta(undefined as never)).not.toThrow();
        expect(formatReviewMeta(undefined as never)).not.toMatch(/NaN/);
    });
    it('drops the tokens segment when totalTokens is missing', () => {
        expect(formatReviewMeta({ model: 'm', durationMs: 2000 } as never)).toBe('m | 2s');
    });
    it('drops the duration segment when durationMs is missing', () => {
        expect(formatReviewMeta({ model: 'm', totalTokens: 100 } as never)).toBe('m | 100 tokens');
    });
});
