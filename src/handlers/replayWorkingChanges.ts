/**
 * replayWorkingChanges.ts
 *
 * Pure helpers for the Replay Working Changes flow. Lives in its own file
 * (no `vscode` imports) so it can be unit-tested and so the T3 scenario
 * tier imports the same function that production does — avoiding the
 * "test re-implements production logic" trap that hides handler regressions.
 *
 * - `workingDiffersFromBaseline` answers "are there working changes worth
 *   replaying?". Source of truth: file hash. `.content` is lazily dropped
 *   after every save, so comparing content fields would silently return
 *   false post-persist.
 * - `buildWorkingDiffBundle` produces the per-graph diff annotations the
 *   timeline replayer steps through. Mirrors what `replayWorkingDiff` in
 *   `replayHandlers.ts` runs before calling `playFromDiffResult`.
 */

import type { DiagramGraph, Snapshot } from '../core/graph/graphTypes';
import { diffGraphs } from '../core/diff/graphDiff';
import {
    upgradeFileDiffAnnotations,
    upgradeSequenceDiffAnnotations,
    upgradeServiceClusterDiffAnnotations,
    buildApiListGraphsForSnapshots,
} from '../core/git/commitDiffer';

export function workingDiffersFromBaseline(baseline: Snapshot, working: Snapshot): boolean {
    const baselineFiles = baseline.files ?? {};
    const workingFiles = working.files ?? {};
    const allFilePaths = new Set([
        ...Object.keys(baselineFiles),
        ...Object.keys(workingFiles),
    ]);
    for (const fp of allFilePaths) {
        const b = baselineFiles[fp]?.hash;
        const w = workingFiles[fp]?.hash;
        if (b === w) continue;
        return true;
    }
    return false;
}

/**
 * Compute the workingDiffed bundle (one DiagramGraph per graphId, annotated
 * for diff display) that drives Replay Working Changes. Inline-diffed file:
 * and flow: graphs are shallow-copied as-is (they already carry their own
 * inline diff annotations from `buildFileGraph` / `buildFlowGraph`). All
 * other graphs are reconciled via `diffGraphs(baseline, working)` and then
 * upgraded by the cascade-aware passes the live extension uses.
 *
 * Shared by `replayWorkingDiff` (handler) and the T3 timeline-replay
 * scenarios so future drift in this logic is observed by tests.
 */
export function buildWorkingDiffBundle(
    baseline: Snapshot,
    working: Snapshot,
): Record<string, DiagramGraph> {
    const allGraphIds = new Set([
        ...Object.keys(baseline.graphs),
        ...Object.keys(working.graphs),
    ]);
    const out: Record<string, DiagramGraph> = {};
    for (const gid of allGraphIds) {
        const bg = baseline.graphs[gid];
        const wg = working.graphs[gid];
        // file: and flow: graphs already have correct inline diff annotations
        // from buildFileGraph(code, path, oldCode) / buildFlowGraph(code, path, fn, oldCode).
        // Using diffGraphs() would overwrite them with a structural comparison
        // that misses body-only changes. Shallow-copy to prevent mutation of snapshot state.
        const isInlineDiffed = gid.startsWith('file:') || gid.startsWith('flow:');
        if (isInlineDiffed && wg) {
            out[gid] = { ...wg, nodes: [...wg.nodes], edges: [...wg.edges] };
        } else if (isInlineDiffed && bg) {
            out[gid] = {
                ...bg,
                nodes: bg.nodes.map(n => ({ ...n, diff: 'deleted' as const })),
                edges: bg.edges.map(e => ({ ...e, diff: 'deleted' as const })),
            };
        } else if (bg && wg) {
            out[gid] = diffGraphs(bg, wg).graph;
        } else if (wg) {
            out[gid] = {
                ...wg,
                nodes: wg.nodes.map(n => ({ ...n, diff: 'added' as const })),
                edges: wg.edges.map(e => ({ ...e, diff: 'added' as const })),
            };
        } else if (bg) {
            out[gid] = {
                ...bg,
                nodes: bg.nodes.map(n => ({ ...n, diff: 'deleted' as const })),
                edges: bg.edges.map(e => ({ ...e, diff: 'deleted' as const })),
            };
        }
    }
    upgradeFileDiffAnnotations(out, baseline, working);
    upgradeSequenceDiffAnnotations(out);
    const apiLists = buildApiListGraphsForSnapshots(working, baseline, out);
    for (const [gid, graph] of Object.entries(apiLists)) {
        out[gid] = graph;
    }
    upgradeServiceClusterDiffAnnotations(out);
    return out;
}
