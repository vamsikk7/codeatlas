/**
 * reviewDelta.ts — Issue 606 — Cascade-aware incremental review
 *
 * Cascade-aware incremental review. Given the current working snapshot and
 * the set of per-entry review cursors recorded by previous runs, partitions
 * the entry-point list into three buckets:
 *
 *   - `changed`  → entries whose handler digest or guidelines hash differ
 *                  from the cursor (or no cursor exists). LLM is invoked.
 *   - `reused`   → entries whose cursor matches the current state. Existing
 *                  findings carry forward; the LLM is skipped.
 *   - `deleted`  → cursors for entries that no longer exist in `apiIndex`
 *                  (route renamed, deleted, file removed). Their findings
 *                  and cursors are dropped before the review starts.
 *
 * The handler digest is intentionally file-level granularity: any change to
 * the containing file invalidates every entry-point inside it. That's
 * conservative (over-includes neighbours) but cheap to compute and matches
 * how the diff cascade already tracks "this file changed" — there's no
 * point reusing a finding when the source it was grounded in might have
 * been edited around it.
 */

import * as crypto from 'node:crypto';
import type { ApiRecord, Snapshot } from '../graph/graphTypes';
import type { AiReviewEntryCursor } from '../storage/snapshotStore';

/**
 * Stable `method:route` key matching the format emitted elsewhere in the
 * review pipeline (perEntryReviewer.entryPointId, finding.entryPointId).
 * Method is uppercased; route is taken verbatim.
 */
export function entryPointKey(api: Pick<ApiRecord, 'method' | 'route'>): string {
    return `${String(api.method ?? '').toUpperCase()}:${api.route ?? ''}`;
}

/**
 * Deterministic short digest representing the source state that backs an
 * entry point. Two reviews against an identical (file content, span,
 * route) tuple produce the same hash; any byte-level change to the
 * containing file shifts it.
 *
 * Returns a 12-char hex string. Stable across processes — only depends on
 * the snapshot's per-file hash (which is already persisted in `files`).
 */
export function computeEntryPointHandlerHash(
    api: Pick<ApiRecord, 'method' | 'route' | 'filePath' | 'handlerName' | 'anchor'>,
    snapshot: Pick<Snapshot, 'files'>,
): string {
    const filePath = api.filePath ?? '';
    const fileRec = filePath ? (snapshot.files ?? {})[filePath] : undefined;
    const fileHash = (fileRec as any)?.hash ?? '';
    const span = api.anchor?.span;
    const spanStr = span ? `${span.start ?? ''}-${span.end ?? ''}` : '';
    const key = [
        entryPointKey(api),
        filePath,
        '@',
        fileHash,
        '::',
        api.handlerName ?? '',
        '::',
        spanStr,
    ].join('');
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export interface ReviewDelta {
    /** ApiRecords whose handler hash or guidelines hash differ from the cursor. */
    changed: ApiRecord[];
    /** apiIds whose cursor matches — LLM is skipped, findings retained. */
    reused: string[];
    /**
     * apiIds whose cursor row should be dropped — the underlying
     * `ApiRecord` no longer exists in the snapshot's apiIndex (route
     * renamed, file deleted, function removed). Caller drops the cursor
     * rows; findings cleanup is decided separately via `deletedFindings`.
     */
    deletedCursors: string[];
    /**
     * `entry_point_id` values (`method:route`) whose findings should be
     * dropped — the cursor's api vanished AND no other live `ApiRecord`
     * still claims that entry_point_id. Without this second check we'd
     * incorrectly delete findings when a synthetic key like
     * `NETWORK:mutation` is partially removed (one call site deleted, the
     * other still present and reviewed).
     */
    deletedFindings: string[];
}

export interface ComputeReviewDeltaOpts {
    snapshot: Pick<Snapshot, 'apiIndex' | 'files'>;
    cursors: Record<string, AiReviewEntryCursor>;
    /** Current guidelines hash (from `getReviewGuidelines().hash`). */
    guidelinesHash: string;
    /**
     * Optional filter — when set, only ApiRecords for which this returns
     * true are considered for the changed/reused split. Used by the
     * `'changed'` scope to mix the incremental gate with the existing
     * diff-only filter.
     */
    scopeFilter?: (api: ApiRecord) => boolean;
}

/**
 * Partition the apiIndex into the four review buckets. The caller decides
 * how to act on each: drop deleted cursors + (selectively) deleted
 * findings, skip the reused apiIds, invoke the LLM on `changed`.
 *
 * #606-SYNTHETIC — cursors are keyed by `apiId` so multiple call sites
 * sharing the same `method:route` (NETWORK `useMutation`, SCREEN, JOB,
 * etc.) each track independently. Findings remain keyed by `entryPointId`
 * (`method:route`) per the existing storage schema, which is why this
 * function returns separate `deletedCursors` and `deletedFindings` lists.
 */
export function computeReviewDelta(opts: ComputeReviewDeltaOpts): ReviewDelta {
    const apis = Object.values(opts.snapshot.apiIndex ?? {}) as ApiRecord[];
    const liveApiIds = new Set<string>();
    const liveEntryPointIds = new Set<string>();
    const changed: ApiRecord[] = [];
    const reused: string[] = [];

    for (const api of apis) {
        liveApiIds.add(api.apiId);
        liveEntryPointIds.add(entryPointKey(api));
        if (opts.scopeFilter && !opts.scopeFilter(api)) continue;
        const cur = opts.cursors[api.apiId];
        if (!cur) {
            changed.push(api);
            continue;
        }
        const curHash = computeEntryPointHandlerHash(api, opts.snapshot);
        if (cur.handlerHash !== curHash) { changed.push(api); continue; }
        if ((cur.guidelinesHash ?? '') !== (opts.guidelinesHash ?? '')) { changed.push(api); continue; }
        reused.push(api.apiId);
    }

    // Cursors whose api no longer exists in the snapshot — always dropped.
    const deletedCursors: string[] = [];
    // Their entry_point_id values, deduped — candidates for finding cleanup.
    const orphanEntryPointIds = new Set<string>();
    for (const cursorApiId of Object.keys(opts.cursors)) {
        if (!liveApiIds.has(cursorApiId)) {
            deletedCursors.push(cursorApiId);
            const epid = opts.cursors[cursorApiId]?.entryPointId;
            if (epid) orphanEntryPointIds.add(epid);
        }
    }
    // Only delete findings for entry_point_ids that NO live api still claims.
    // Protects synthetic keys (e.g. `NETWORK:mutation`) where one call site
    // is removed but siblings remain — their findings should survive.
    const deletedFindings: string[] = [];
    for (const epid of orphanEntryPointIds) {
        if (!liveEntryPointIds.has(epid)) deletedFindings.push(epid);
    }

    return { changed, reused, deletedCursors, deletedFindings };
}
