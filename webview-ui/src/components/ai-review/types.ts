/** Mirror of extension-host `AiReviewFinding` for the webview side. */

export type AiReviewSeverity = 'error' | 'warning' | 'info';
export type AiReviewCategory =
    | 'architecture' | 'api-design' | 'code-quality'
    | 'logic-bug' | 'security' | 'performance' | 'guideline';
export type AiReviewStatus = 'open' | 'resolved' | 'ignored' | 'stale';

export interface AiReviewBinding {
    graphId: string;
    targetId: string;
    targetType: 'node' | 'edge';
    layer: string;
}

export interface AiReviewBaselineRef {
    kind: 'git' | 'snapshot';
    ref: string;
    capturedAt: string;
}

/**
 * Issue 613 — one row of the finding's resolve/ignore/reopen history.
 * Append-only on the server; the webview just renders it.
 */
export interface AiReviewAuditEntry {
    ts: string;                       // ISO 8601
    fromStatus: AiReviewStatus | null;  // null on creation
    toStatus: AiReviewStatus;
    actor: string;
    note?: string;
}

export interface AiReviewFinding {
    id: string;
    entryPointId: string;
    bindings: AiReviewBinding[];
    severity: AiReviewSeverity;
    category: AiReviewCategory;
    title: string;
    body: string;
    anchor?: { filePath?: string; symbol?: string };
    status: AiReviewStatus;
    model: string;
    guidelinesHash?: string;
    baselineRef?: AiReviewBaselineRef;
    createdAt: string;
    updatedAt: string;
    /**
     * Issue 613 — status-change history. Optional for back-compat with rows
     * created before the field existed; readers default to `[]`.
     */
    auditTrail?: AiReviewAuditEntry[];
}
