/**
 * adapters.ts — #826 R6 (partial) + reference adapter (2026-06-11).
 *
 * Shipped adapters:
 *   - `todo-comments` — the spec's reference adapter: counts TODO/FIXME
 *     markers per file, pure-local, no external API. Demonstrates the
 *     full contract (fetch → points → join → roll-up → paint) in ~40
 *     lines; the docs template for Sentry/APM adapters.
 *   - `coverage` — migrates the LCOV/Istanbul reader through the
 *     contract (R6 step 1). Per-function hit counts where the report has
 *     them, else per-file line rates.
 *   - `diff` — descriptor-only registration so the toggle panel lists it;
 *     the cascade keeps writing diff state (load-bearing, R6 migrates the
 *     render side later). fetch() returns [] by design.
 *   - `comments` — descriptor-only for the same reason: comment pins keep
 *     their existing render until R6; registering them gives the user the
 *     R2b hide toggle surface now.
 */

import { loadCoverageData } from '../analysis/coverageReader';
import { sentryErrorsOverlay } from './sentryAdapter';
import { regressionScopeOverlay } from './regressionScopeAdapter';
import type { OverlayDataPoint, OverlayDescriptor, OverlayFetchContext } from './overlayTypes';

const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b/g;

export const todoCommentsOverlay: OverlayDescriptor = {
    id: 'todo-comments',
    displayName: 'TODO / FIXME density',
    emptyHint: 'No TODO / FIXME / HACK markers found in indexed files.',
    join: 'anchor',
    paint: 'badge',
    aggregation: 'sum',
    refreshPolicy: { kind: 'onCascade' },
    async fetch(ctx: OverlayFetchContext): Promise<OverlayDataPoint[]> {
        const points: OverlayDataPoint[] = [];
        for (const filePath of Object.keys(ctx.working.files ?? {})) {
            const content = ctx.getFileContent?.(filePath);
            if (!content) continue;
            TODO_PATTERN.lastIndex = 0;
            let count = 0;
            while (TODO_PATTERN.exec(content) !== null) count++;
            if (count > 0) {
                points.push({ key: { filePath }, value: count, severity: count >= 5 ? 'warn' : 'info' });
            }
        }
        return points;
    },
};

export const coverageOverlay: OverlayDescriptor = {
    id: 'coverage',
    displayName: 'Test coverage',
    emptyHint: 'No LCOV / Istanbul coverage data found — run your test suite with coverage first.',
    join: 'anchor',
    paint: 'metric',
    aggregation: 'avg',
    refreshPolicy: { kind: 'manual' },
    async fetch(ctx: OverlayFetchContext): Promise<OverlayDataPoint[]> {
        const report = loadCoverageData(ctx.workspaceRoot);
        if (!report) return [];
        const points: OverlayDataPoint[] = [];
        for (const [filePath, fileCov] of Object.entries(report)) {
            const fns = Object.entries(fileCov.functions ?? {});
            if (fns.length > 0) {
                for (const [fn, cov] of fns) {
                    points.push({
                        key: { filePath, functionName: fn },
                        value: Math.round((cov.lineRate ?? 0) * 100),
                        severity: cov.hits === 0 ? 'warn' : 'info',
                    });
                }
            } else {
                points.push({
                    key: { filePath },
                    value: Math.round((fileCov.lineRate ?? 0) * 100),
                    severity: (fileCov.lineRate ?? 0) === 0 ? 'warn' : 'info',
                });
            }
        }
        return points;
    },
};

/** Descriptor-only rows — toggle surface now, render migration later (R6). */
export const diffOverlayDescriptor: OverlayDescriptor = {
    id: 'diff',
    displayName: 'Diff (baseline vs working)',
    join: 'anchor',
    paint: 'severity',
    refreshPolicy: { kind: 'onCascade' },
    async fetch(): Promise<OverlayDataPoint[]> { return []; },
};

export const commentsOverlayDescriptor: OverlayDescriptor = {
    id: 'comments',
    displayName: 'Comments',
    emptyHint: 'No comments yet — right-click a node to add one.',
    join: 'anchor',
    paint: 'badge',
    refreshPolicy: { kind: 'onCascade' },
    async fetch(): Promise<OverlayDataPoint[]> { return []; },
};

export function registerBuiltinOverlays(registry: { register(d: OverlayDescriptor): void }): void {
    registry.register(diffOverlayDescriptor);
    registry.register(commentsOverlayDescriptor);
    registry.register(coverageOverlay);
    registry.register(todoCommentsOverlay);
    // #911 — runtime-data adapter (Sentry error rate) + regression-scope folded
    // into the registry. Both flow through the generic fetch → join → paint
    // contract; no bespoke render path.
    registry.register(sentryErrorsOverlay);
    registry.register(regressionScopeOverlay);
}
