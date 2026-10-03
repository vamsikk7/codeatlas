/**
 * overlayTypes.ts — #826 v1 (2026-06-11).
 *
 * The generic overlay contract: layers are the canvas, overlays are the
 * lens, anchors/stable keys are the join key. Every signal painted on a
 * graph node — coverage, TODO density, Sentry errors, APM latency,
 * regression scope, comments — flows through ONE descriptor shape, ONE
 * join engine, ONE roll-up engine, and ONE render slot, so a new signal
 * is an adapter, not a pipeline.
 *
 * scope notes (the rest of the #826 spec is tracked in ISSUES.md):
 *   - join + roll-up engines and the registry are fully generic;
 *   - shipped adapters: `todo-comments` (reference, pure-local), `coverage`
 *     (LCOV/Istanbul through the contract), `sentry-errors` (#911 — the first
 *     RUNTIME-DATA adapter: fetch → join → paint against the Sentry issues API),
 *     and `regression-scope` (#911 — the bespoke panel folded into the registry,
 *     reading `baseline` from the fetch context);
 *   - diff / impact / AI-findings keep their bespoke render paths for now
 *     (R6 migrates them later — diff is load-bearing);
 *   - overlay state persists per workspace with an optional `layer`
 *     column reserved so per-layer overrides stay additive (R2b).
 */

export type OverlayJoinKind = 'anchor' | 'apiRecord' | 'service';
export type OverlayPaint = 'badge' | 'metric' | 'severity' | 'heat';
export type OverlayAggregation = 'sum' | 'max' | 'avg';

export interface OverlayDataPoint {
    key: {
        filePath?: string;
        functionName?: string;
        apiId?: string;
        serviceId?: string;
    };
    value: number | string;
    severity?: 'info' | 'warn' | 'error';
    meta?: Record<string, unknown>;
}

export interface OverlayFetchContext {
    workspaceRoot: string;
    /** Working snapshot of the scoped store (per-repo in multi-repo). */
    working: import('../graph/graphTypes').Snapshot;
    /** Baseline snapshot — adapters that diff working-vs-baseline (e.g. the
     *  regression-scope overlay, #911) read this; pure-local adapters ignore it. */
    baseline?: import('../graph/graphTypes').Snapshot;
    /** Lazy file-content reader (post-save records drop `.content`). */
    getFileContent?: (filePath: string) => string | undefined;
}

export interface OverlayDescriptor {
    id: string;
    displayName: string;
    /** Short empty-state hint when fetch() returns no points (R2b). */
    emptyHint?: string;
    join: OverlayJoinKind;
    paint: OverlayPaint;
    /** Roll-up aggregator for numeric values (R4). Default 'sum'. */
    aggregation?: OverlayAggregation;
    refreshPolicy:
        | { kind: 'manual' }
        | { kind: 'interval'; seconds: number }
        | { kind: 'onCascade' };
    timeWindowed?: boolean;
    fetch(ctx: OverlayFetchContext): Promise<OverlayDataPoint[]>;
}

/** One node's resolved overlay value after join + roll-up. */
export interface OverlayNodeValue {
    overlayId: string;
    /** Aggregated numeric value (counts, percentages, ms). */
    value: number;
    /** Highest severity among contributing points. */
    severity?: 'info' | 'warn' | 'error';
    /** Number of raw points contributing to this node. */
    pointCount: number;
}

export interface OverlayJoinResult {
    /** nodeId → resolved value. */
    values: Map<string, OverlayNodeValue>;
    /** Points that matched no node — surfaced, never silently dropped (R3). */
    unresolved: OverlayDataPoint[];
}

/** Persisted per-workspace toggle row (R2b). `layer` reserved for v2. */
export interface OverlayStateRow {
    overlayId: string;
    enabled: boolean;
    layer?: string;
}
