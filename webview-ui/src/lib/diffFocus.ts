/**
 * diffFocus.ts — pure logic for the L2 api-list "diff focus" (change
 * highlighting) feature. Lets users stop scrolling a long api list to find
 * what changed: counts, the Changed / + / − / ~ filter, changed-first
 * ordering, the auto-expand/hide gate, and the jump-stepper ordering.
 *
 * Shared by FeatureApiListView (feature-grouped) and ApiListPanel (method
 * tabs + search), so the filter composes with those without duplicating the
 * change semantics. Kept dependency-free + pure so it's exhaustively unit
 * tested (`diffFocus.test.ts`) and cheap to call per render.
 */

export type ChangeKind = 'added' | 'deleted' | 'modified' | 'unchanged';

/** The Changed-filter modes surfaced as chips in the diff-focus bar. */
export type ChangeFilter = 'all' | 'changed' | 'added' | 'deleted' | 'modified';

export interface ChangeCounts {
    added: number;
    deleted: number;
    modified: number;
    /** added + deleted + modified — drives the "Changed N" chip + bar visibility. */
    changed: number;
    /** every row, changed or not. */
    total: number;
}

/** Coerce any diff-ish value to a known ChangeKind (undefined/unknown → unchanged). */
export function normalizeDiff(diff: string | undefined | null): ChangeKind {
    return diff === 'added' || diff === 'deleted' || diff === 'modified' ? diff : 'unchanged';
}

export function isChanged(diff: string | undefined | null): boolean {
    return normalizeDiff(diff) !== 'unchanged';
}

export function computeChangeCounts(items: ReadonlyArray<{ diff?: string }>): ChangeCounts {
    let added = 0, deleted = 0, modified = 0;
    for (const it of items) {
        switch (normalizeDiff(it.diff)) {
            case 'added': added++; break;
            case 'deleted': deleted++; break;
            case 'modified': modified++; break;
            default: break;
        }
    }
    return { added, deleted, modified, changed: added + deleted + modified, total: items.length };
}

/** Does a row with this diff pass the active Changed filter? */
export function apiMatchesChangeFilter(diff: string | undefined, filter: ChangeFilter): boolean {
    if (filter === 'all') return true;
    const d = normalizeDiff(diff);
    if (filter === 'changed') return d !== 'unchanged';
    return d === filter; // 'added' | 'deleted' | 'modified'
}

/**
 * Sort key so changed rows bubble to the top: added < modified < deleted <
 * unchanged. Use with a STABLE sort so equal-rank rows keep their prior order
 * (e.g. the method-rank ordering already applied).
 */
export function changeRank(diff: string | undefined): number {
    switch (normalizeDiff(diff)) {
        case 'added': return 0;
        case 'modified': return 1;
        case 'deleted': return 2;
        default: return 3; // unchanged — last
    }
}

/**
 * True when a group (feature / section / file-group) has anything worth
 * surfacing — any changed row, OR a group-level diff (an added/deleted feature
 * whose rows may read unchanged). Drives auto-expand + hide-under-Changed.
 */
export function groupHasChanges(
    items: ReadonlyArray<{ diff?: string }>,
    groupDiff?: string,
): boolean {
    if (isChanged(groupDiff)) return true;
    return items.some((it) => isChanged(it.diff));
}

/** Ids of changed rows, in the order they're displayed — drives the ◂ N/M ▸ stepper. */
export function orderedChangedIds<T>(
    itemsInDisplayOrder: ReadonlyArray<T & { diff?: string }>,
    idOf: (t: T) => string,
): string[] {
    const out: string[] = [];
    for (const it of itemsInDisplayOrder) {
        if (isChanged(it.diff)) out.push(idOf(it));
    }
    return out;
}
