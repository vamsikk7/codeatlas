/**
 * regressionScopeAdapter.ts — #911 (2026-06-26).
 *
 * Folds the bespoke regression-scope panel into the overlay registry: the SAME
 * `computeRegressionScope` core, now exposed as a paintable lens so "what's at
 * risk from my changes" rides the unified anchor-join contract instead of a
 * one-off panel. Changed entities paint `warn`; changed-AND-untested entities
 * (in the blast radius) paint `error`.
 *
 * Diff-style adapter — reads `ctx.baseline` (added to the contract for #911).
 * No baseline ⇒ no diff ⇒ no points (the bespoke panel behaves the same).
 */

import { computeRegressionScope } from '../analysis/regressionScope';
import { loadCoverageData } from '../analysis/coverageReader';
import type { OverlayDataPoint, OverlayDescriptor, OverlayFetchContext } from './overlayTypes';

export const regressionScopeOverlay: OverlayDescriptor = {
    id: 'regression-scope',
    displayName: 'Regression scope',
    emptyHint: 'No working changes vs baseline — edit a file to see its regression blast radius.',
    join: 'anchor',
    paint: 'severity',
    aggregation: 'max',
    refreshPolicy: { kind: 'onCascade' },
    async fetch(ctx: OverlayFetchContext): Promise<OverlayDataPoint[]> {
        if (!ctx.baseline) return [];
        let coverage = null;
        try { coverage = loadCoverageData(ctx.workspaceRoot); } catch { /* optional */ }
        const scope = computeRegressionScope({
            working: ctx.working,
            baseline: ctx.baseline,
            coverage,
        });
        const points: OverlayDataPoint[] = [];
        // Changed entities — the edit surface (warn).
        for (const e of scope.changedEntities) {
            points.push({
                key: e.functionName ? { filePath: e.filePath, functionName: e.functionName } : { filePath: e.filePath },
                value: 1,
                severity: 'warn',
                meta: { changeKind: e.changeKind },
            });
        }
        // Untested blast radius — highest risk (error): downstream of a change
        // AND not covered by any test.
        for (const fn of scope.untestedBlastRadius) {
            points.push({
                key: fn.functionName ? { filePath: fn.filePath, functionName: fn.functionName } : { filePath: fn.filePath },
                value: 2,
                severity: 'error',
                meta: { reason: 'untested-in-blast-radius', impactKind: (fn as { impactKind?: string }).impactKind },
            });
        }
        return points;
    },
};
