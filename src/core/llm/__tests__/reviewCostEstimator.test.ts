/**
 * reviewCostEstimator.test.ts — Issue 608 — Cost + budget guardrails for AI Review
 */
import { describe, it, expect } from 'vitest';
import {
    estimateReviewCost,
    resolveModelPricing,
    isBudgetExceeded,
    formatEstimate,
    MODEL_PRICING,
} from '../reviewCostEstimator';

describe('resolveModelPricing (Issue 608)', () => {
    it('returns exact-match for known models', () => {
        expect(resolveModelPricing('gpt-4o-mini')).toEqual(MODEL_PRICING['gpt-4o-mini']);
        expect(resolveModelPricing('GPT-4O-MINI')).toEqual(MODEL_PRICING['gpt-4o-mini']);
    });

    it('substring-matches versioned model ids', () => {
        expect(resolveModelPricing('claude-3-5-sonnet-20240620')).toEqual(MODEL_PRICING['claude-3-5-sonnet']);
        expect(resolveModelPricing('anthropic/claude-3-opus-latest')).toEqual(MODEL_PRICING['claude-3-opus']);
    });

    it('treats ollama provider as zero cost regardless of model id', () => {
        expect(resolveModelPricing('deepseek-coder:6.7b', 'ollama')).toEqual(MODEL_PRICING.ollama);
        expect(resolveModelPricing('made-up-model', 'ollama')).toEqual(MODEL_PRICING.ollama);
    });

    it('falls back to a conservative default for unknown models', () => {
        const p = resolveModelPricing('some-future-model');
        // Should be at least as expensive as gpt-4o-mini (i.e. never under-estimate).
        expect(p.inputPer1k).toBeGreaterThanOrEqual(MODEL_PRICING['gpt-4o-mini'].inputPer1k);
    });
});

describe('estimateReviewCost (Issue 608)', () => {
    it('produces near-zero cost for local Ollama models', () => {
        const e = estimateReviewCost({ entryPointCount: 30, model: 'deepseek-coder:6.7b', provider: 'ollama' });
        expect(e.estimatedUSD).toBe(0);
    });

    it('produces a small but non-zero cost for gpt-4o-mini', () => {
        const e = estimateReviewCost({ entryPointCount: 30, model: 'gpt-4o-mini' });
        // Quick sanity: 30 entry pts × 2400 prompt × 1.3 retry × $0.00015 / 1k = ~$0.014
        // plus 30 × 500 × 1.3 × $0.0006 / 1k = ~$0.012 → ~$0.026
        expect(e.estimatedUSD).toBeGreaterThan(0.01);
        expect(e.estimatedUSD).toBeLessThan(0.10);
    });

    it('flags pricingIsEstimate when the model is unknown', () => {
        const e = estimateReviewCost({ entryPointCount: 10, model: 'fictional-2099-model' });
        expect(e.pricingIsEstimate).toBe(true);
    });

    it('scales linearly with entry-point count', () => {
        const e1 = estimateReviewCost({ entryPointCount: 10, model: 'gpt-4o', accountForRetry: false });
        const e2 = estimateReviewCost({ entryPointCount: 100, model: 'gpt-4o', accountForRetry: false });
        // 10× the entry points → ~10× the cost.
        expect(e2.estimatedUSD).toBeCloseTo(e1.estimatedUSD * 10, 2);
    });

    it('accountForRetry: false drops cost by ~23%', () => {
        const withRetry = estimateReviewCost({ entryPointCount: 30, model: 'gpt-4o' });
        const noRetry = estimateReviewCost({ entryPointCount: 30, model: 'gpt-4o', accountForRetry: false });
        // 1.3 retry multiplier → no-retry should be 1/1.3 ≈ 77% of with-retry.
        expect(noRetry.estimatedUSD / withRetry.estimatedUSD).toBeCloseTo(1 / 1.3, 2);
    });

    it('respects custom avgPromptTokens / avgCompletionTokens', () => {
        const big = estimateReviewCost({ entryPointCount: 10, model: 'gpt-4o', avgPromptTokens: 10000, avgCompletionTokens: 2000 });
        const small = estimateReviewCost({ entryPointCount: 10, model: 'gpt-4o', avgPromptTokens: 1000, avgCompletionTokens: 200 });
        expect(big.estimatedUSD).toBeGreaterThan(small.estimatedUSD * 5);
    });
});

describe('formatEstimate (Issue 608)', () => {
    it('formats local-model cost as "free"', () => {
        const e = estimateReviewCost({ entryPointCount: 20, model: 'deepseek-coder:6.7b', provider: 'ollama' });
        expect(formatEstimate(e)).toMatch(/free \(local model\)/);
        expect(formatEstimate(e)).toMatch(/~20 entry points/);
    });

    it('formats remote-model cost in $ with 2 decimals for ≥ $0.01', () => {
        const e = estimateReviewCost({ entryPointCount: 200, model: 'gpt-4o' });
        // 200 entry pts × gpt-4o pricing should be > $0.10 — formatted with 2 decimals.
        expect(formatEstimate(e)).toMatch(/\$\d+\.\d{2}/);
    });

    it('formats sub-cent cost with 4 decimals', () => {
        const e = estimateReviewCost({ entryPointCount: 1, model: 'gpt-4o-mini', accountForRetry: false });
        // 1 entry pt × gpt-4o-mini ≈ $0.0009 — needs 4-decimal precision.
        expect(formatEstimate(e)).toMatch(/\$\d+\.\d{4}/);
    });

    it('appends "pricing estimated" when the model wasn\'t in the table', () => {
        const e = estimateReviewCost({ entryPointCount: 10, model: 'mystery-model' });
        expect(formatEstimate(e)).toMatch(/pricing estimated/);
    });
});

describe('isBudgetExceeded (Issue 608)', () => {
    it('returns true when actual ≥ cap', () => {
        expect(isBudgetExceeded(1.0, 1.0)).toBe(true);
        expect(isBudgetExceeded(1.5, 1.0)).toBe(true);
    });

    it('returns false when actual < cap', () => {
        expect(isBudgetExceeded(0.5, 1.0)).toBe(false);
    });

    it('returns false when cap ≤ 0 (guard disabled)', () => {
        expect(isBudgetExceeded(1000, 0)).toBe(false);
        expect(isBudgetExceeded(1000, -1)).toBe(false);
    });

    it('returns false when cap is not finite', () => {
        expect(isBudgetExceeded(1000, NaN)).toBe(false);
        expect(isBudgetExceeded(1000, Infinity)).toBe(false);
    });
});
