/**
 * AI Review types — LLM-powered code review bubbles on diff diagram nodes.
 */

export type ReviewSeverity = 'info' | 'warning' | 'error';

export type ReviewStatus = 'open' | 'resolved' | 'ignored';

export type ReviewCategory =
    | 'architecture'
    | 'api-design'
    | 'code-quality'
    | 'logic-bug'
    | 'security'
    | 'performance';

export interface AiReviewItem {
    /** Unique ID: `review_<index>_<graphId>_<nodeId>` */
    id: string;
    /** The graphId this review belongs to (e.g. "flow:src/auth.ts:login") */
    graphId: string;
    /** The nodeId (or edgeId) within the graph */
    targetId: string;
    /** Whether target is a node or edge */
    targetType: 'node' | 'edge';
    /** Severity drives color coding: info=blue, warning=amber, error=red */
    severity: ReviewSeverity;
    /** Short title (one line, shown in collapsed bubble) */
    title: string;
    /** Expanded explanation with suggestion (shown on click, <100 words) */
    body: string;
    /** Category tag for grouping */
    category: ReviewCategory | string;
    /** Source anchor for navigation */
    anchor?: { filePath: string; symbol?: string };
    /** Status: open (default), resolved (addressed), ignored (dismissed) */
    status: ReviewStatus;
}

export interface BatchFailure {
    /** Which layer the failed batch belonged to */
    layer: string;
    /** Short error message */
    error: string;
    /** Whether this was a timeout */
    isTimeout: boolean;
}

export interface AiReviewResult {
    /** All review items across all graphs */
    items: AiReviewItem[];
    /** Keyed by graphId for quick per-diagram lookup */
    byGraph: Record<string, AiReviewItem[]>;
    /** Summary counts (open items only) */
    summary: { info: number; warning: number; error: number; total: number };
    /** Batches that failed after retries */
    failures: BatchFailure[];
    /** Model and token usage metadata */
    meta: { model: string; totalTokens: number; durationMs: number };
}

/** In-memory cache entry, keyed by `${baseHash}:${headHash}` */
export interface AiReviewCacheEntry {
    key: string;
    result: AiReviewResult;
    timestamp: number;
}
