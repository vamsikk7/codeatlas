/**
 * formatReviewMeta — the AI-review panel footer string ("model | N tokens | Ns").
 *
 * BUG-AIREVIEW-PANEL-NANS: an incomplete `meta` (no totalTokens / durationMs, or
 * no meta at all) must degrade gracefully — never render "NaN", never throw.
 * Each segment is included only when its value is a finite number / present.
 */
export interface ReviewMeta {
    model?: string;
    totalTokens?: number;
    durationMs?: number;
}

export function formatReviewMeta(meta: ReviewMeta | undefined | null): string {
    const m = meta ?? {};
    const parts: string[] = [];
    if (m.model) parts.push(String(m.model));
    if (typeof m.totalTokens === 'number' && Number.isFinite(m.totalTokens)) {
        parts.push(`${m.totalTokens.toLocaleString('en-US')} tokens`);
    }
    if (typeof m.durationMs === 'number' && Number.isFinite(m.durationMs)) {
        parts.push(`${Math.round(m.durationMs / 1000)}s`);
    }
    return parts.join(' | ');
}
