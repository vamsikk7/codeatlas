/**
 * reviewCostEstimator.ts — Issue 608 — Cost + budget guardrails for AI Review
 *
 * Estimates the cost of a full AI Review run before it starts. Drives:
 *   • The pre-flight modal that warns users on large workspaces.
 *   • The mid-review budget guard that aborts the run if it exceeds
 *     `codeatlas.aiReview.maxBudgetUSD`.
 *
 * Pricing table is best-effort + intentionally conservative — when a
 * model isn't in the table we fall back to a per-1k-token charge that
 * over-estimates for safety. Local models (Ollama) report cost = 0.
 */

export interface ModelPricing {
    /** USD per 1,000 input tokens. */
    inputPer1k: number;
    /** USD per 1,000 output tokens. */
    outputPer1k: number;
}

/**
 * Conservative pricing table. Sourced from each provider's pricing page —
 * last verified 2026-05-24. Keep updated when prices change. Errs on the
 * expensive side so the pre-flight warning is never an under-estimate.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
    // OpenAI / Azure OpenAI
    'gpt-4o':                 { inputPer1k: 0.0025, outputPer1k: 0.01 },
    'gpt-4o-mini':            { inputPer1k: 0.00015, outputPer1k: 0.0006 },
    'gpt-4-turbo':            { inputPer1k: 0.01, outputPer1k: 0.03 },
    'gpt-3.5-turbo':          { inputPer1k: 0.0005, outputPer1k: 0.0015 },
    // Anthropic
    'claude-3-5-sonnet':      { inputPer1k: 0.003, outputPer1k: 0.015 },
    'claude-3-opus':          { inputPer1k: 0.015, outputPer1k: 0.075 },
    'claude-3-haiku':         { inputPer1k: 0.00025, outputPer1k: 0.00125 },
    // OpenRouter (free tier flagged as 0; others left null so the resolver
    // falls back to a conservative default).
    'openrouter/free':        { inputPer1k: 0, outputPer1k: 0 },
    // Local Ollama — zero cost.
    'ollama':                 { inputPer1k: 0, outputPer1k: 0 },
};

/** Conservative default for unknown remote models — assume gpt-4o-like pricing. */
const DEFAULT_PRICING: ModelPricing = { inputPer1k: 0.005, outputPer1k: 0.02 };

/**
 * Resolve pricing for a model id, doing case-insensitive prefix matches.
 * `provider === 'ollama'` short-circuits to zero regardless of model id.
 */
export function resolveModelPricing(modelId: string, provider?: string): ModelPricing {
    if (provider && provider.toLowerCase() === 'ollama') return MODEL_PRICING.ollama;
    const m = String(modelId ?? '').toLowerCase();
    // Exact-match first.
    if (MODEL_PRICING[m]) return MODEL_PRICING[m];
    // Substring match against known keys (e.g. `claude-3-5-sonnet-20240620` → `claude-3-5-sonnet`).
    for (const [k, v] of Object.entries(MODEL_PRICING)) {
        if (k === 'ollama') continue; // Don't treat random strings as free.
        if (m.includes(k)) return v;
    }
    return DEFAULT_PRICING;
}

export interface CostEstimateInput {
    entryPointCount: number;
    /** Optional override of the average prompt size in tokens. Defaults are
     *  based on observed entry-point pack sizes against the test workspace. */
    avgPromptTokens?: number;
    avgCompletionTokens?: number;
    /** When true, account for the #527 retry pass that fires roughly 30% of
     *  the time on small models. Default true. */
    accountForRetry?: boolean;
    model: string;
    provider?: string;
}

export interface CostEstimate {
    entryPointCount: number;
    promptTokensTotal: number;
    completionTokensTotal: number;
    estimatedUSD: number;
    /** When the resolver fell back to DEFAULT_PRICING — banner the user. */
    pricingIsEstimate: boolean;
    model: string;
}

/** Estimate the dollar cost of a full review run. */
export function estimateReviewCost(input: CostEstimateInput): CostEstimate {
    const pricing = resolveModelPricing(input.model, input.provider);
    // Defaults sized for an Express + Prisma single-handler entry-point
    // (system prompt ~600 tokens, user pack ~1800 tokens, completion ~500).
    const avgPromptTokens = input.avgPromptTokens ?? 2400;
    const avgCompletionTokens = input.avgCompletionTokens ?? 500;
    const retryMultiplier = input.accountForRetry === false ? 1.0 : 1.3;
    const promptTokensTotal = Math.round(input.entryPointCount * avgPromptTokens * retryMultiplier);
    const completionTokensTotal = Math.round(input.entryPointCount * avgCompletionTokens * retryMultiplier);
    const estimatedUSD = (
        (promptTokensTotal / 1000) * pricing.inputPer1k
        + (completionTokensTotal / 1000) * pricing.outputPer1k
    );
    return {
        entryPointCount: input.entryPointCount,
        promptTokensTotal,
        completionTokensTotal,
        // Round to 4 decimals — sub-cent precision is fine, sub-tenth-cent isn't.
        estimatedUSD: Math.round(estimatedUSD * 10000) / 10000,
        pricingIsEstimate: pricing === DEFAULT_PRICING,
        model: input.model,
    };
}

/**
 * Format an estimate as a one-line summary for the pre-flight modal.
 *   "This review will hit ~120 entry points, est. $0.45 with gpt-4o-mini."
 */
export function formatEstimate(estimate: CostEstimate): string {
    const cost = estimate.estimatedUSD === 0
        ? 'free (local model)'
        : `est. $${estimate.estimatedUSD.toFixed(estimate.estimatedUSD < 0.01 ? 4 : 2)}`;
    const tag = estimate.pricingIsEstimate ? ' (pricing estimated — model not in table)' : '';
    return `This review will hit ~${estimate.entryPointCount} entry points, ${cost} with ${estimate.model}${tag}.`;
}

/**
 * Budget-exceeded predicate used by the mid-review guard. `actualSpend` is
 * a running tally; `cap` is the user's `maxBudgetUSD` setting. `cap <= 0`
 * disables the guard.
 */
export function isBudgetExceeded(actualSpend: number, cap: number): boolean {
    if (!Number.isFinite(cap) || cap <= 0) return false;
    return actualSpend >= cap;
}
