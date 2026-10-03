/**
 * apiDiff.ts
 *
 * Computes diff status for API records in a cluster by comparing
 * baseline vs working snapshots. Used by buildApiListGraph in extension.ts.
 */

import type { ApiRecord, DiffStatus, DiagramGraph } from '../graph/graphTypes';

/**
 * Compute diff status for a single API record.
 *
 * Priority:
 * 1. Not in baseline → 'added'
 * 2. Has a sequence graph → that graph is AUTHORITATIVE: 'modified' iff it has
 *    node/edge diffs, else 'unchanged'. (BUG-EXP-7 — do NOT fall through to the
 *    file-hash fallback; otherwise editing/adding a SIBLING endpoint in the same
 *    file marks every unchanged route in that file `~ MODIFIED`.)
 * 3. No sequence graph (mobile SCREEN / NAV_ROUTE / NETWORK / DI_BINDING items):
 *    file hash changed → 'modified'.
 * 4. Otherwise → 'unchanged'
 */
export function computeApiDiff(
    api: ApiRecord,
    baselineApiIndex: Record<string, ApiRecord>,
    seqGraph: DiagramGraph | undefined,
    baselineFileHash: string | undefined,
    workingFileHash: string | undefined,
): DiffStatus {
    if (!baselineApiIndex[api.apiId]) {
        return 'added';
    }

    // BUG-EXP-7 — the endpoint's own sequence graph is the per-endpoint signal.
    // When it exists it fully decides the diff; the coarse file-hash fallback is
    // ONLY for entry points that have no sequence graph (mobile items).
    if (seqGraph) {
        const hasChanges =
            seqGraph.nodes.some(n => n.diff === 'modified' || n.diff === 'added' || n.diff === 'deleted') ||
            seqGraph.edges.some(e => e.diff === 'modified' || e.diff === 'added' || e.diff === 'deleted');
        return hasChanges ? 'modified' : 'unchanged';
    }

    // Fallback: file hash changed (covers mobile items without sequence graphs)
    if (baselineFileHash && workingFileHash && baselineFileHash !== workingFileHash) {
        return 'modified';
    }

    return 'unchanged';
}
