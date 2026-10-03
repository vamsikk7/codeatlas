/**
 * aiReviewBus.ts — tiny pub/sub for AI-review findings + counts received
 * from the server. Diagram views subscribe to the slice they care about;
 * the bus normalises the per-message updates that arrive over the WS bridge.
 *
 * Why not Redux/Zustand? The webview already uses local React state +
 * window-message events everywhere; a stand-alone bus keeps this feature
 * additive (no app-shell refactor) and easy to remove later.
 */

import type { AiReviewFinding } from './types';

type CountsCell = { error: number; warning: number; info: number; total: number };
export interface FindingCounts {
    byGraph: Record<string, CountsCell>;
    byEntryPoint: Record<string, number>;
    bySeverity: { error: number; warning: number; info: number };
    total: number;
}

type State = {
    findings: AiReviewFinding[];
    counts: FindingCounts;
    lastUpdate: number;
};

const state: State = {
    findings: [],
    counts: { byGraph: {}, byEntryPoint: {}, bySeverity: { error: 0, warning: 0, info: 0 }, total: 0 },
    lastUpdate: 0,
};

type Listener = (s: State) => void;
const listeners = new Set<Listener>();

export function getState(): State { return state; }
export function subscribe(fn: Listener): () => void {
    listeners.add(fn);
    fn(state);
    return () => { listeners.delete(fn); };
}
function emit() { state.lastUpdate = Date.now(); for (const l of listeners) l(state); }

/**
 * Coerce an untrusted counts payload (from the WS bridge) into a COMPLETE
 * `FindingCounts` shape. BUG-AIREVIEW-BLOCKS-L2NAV: the server occasionally
 * sends a counts-only update without `byGraph`/`bySeverity`; storing it raw
 * made `AiReviewLayerChip` (rendered on every layer) throw
 * `counts.byGraph[graphId]` on undefined, crashing the diagram render and
 * breaking navigation. Normalising here guarantees every downstream reader —
 * chips, layer summaries, the nav render — sees the full shape.
 */
function normalizeCounts(c: unknown): FindingCounts {
    const o = (c && typeof c === 'object') ? (c as Record<string, unknown>) : {};
    const sev = (o.bySeverity && typeof o.bySeverity === 'object') ? o.bySeverity as Record<string, unknown> : {};
    return {
        byGraph: (o.byGraph && typeof o.byGraph === 'object') ? o.byGraph as Record<string, CountsCell> : {},
        byEntryPoint: (o.byEntryPoint && typeof o.byEntryPoint === 'object') ? o.byEntryPoint as Record<string, number> : {},
        bySeverity: {
            error: typeof sev.error === 'number' ? sev.error : 0,
            warning: typeof sev.warning === 'number' ? sev.warning : 0,
            info: typeof sev.info === 'number' ? sev.info : 0,
        },
        total: typeof o.total === 'number' ? o.total : 0,
    };
}

/** Replace the full findings list (used after a fresh review run). */
export function setFindings(findings: AiReviewFinding[], counts?: FindingCounts) {
    state.findings = findings;
    if (counts) state.counts = normalizeCounts(counts);
    else recomputeCounts();
    emit();
}

/** Merge in newly arrived findings (preserve dedup by id). */
export function addFindings(findings: AiReviewFinding[]) {
    const byId = new Map(state.findings.map((f) => [f.id, f]));
    for (const f of findings) byId.set(f.id, f);
    state.findings = Array.from(byId.values());
    recomputeCounts();
    emit();
}

export function updateFinding(finding: AiReviewFinding) {
    const idx = state.findings.findIndex((f) => f.id === finding.id);
    if (idx >= 0) state.findings[idx] = finding;
    else state.findings.push(finding);
    recomputeCounts();
    emit();
}

export function setCounts(counts: FindingCounts) {
    state.counts = normalizeCounts(counts);
    emit();
}

/**
 * #536 — flip the listed findings to 'stale'. Stale findings stay in the bus
 * (so the user can still see prior context behind a toggle), but they're
 * excluded from headline counts via the status !== 'open' filter in
 * recomputeCounts.
 */
export function markFindingsStale(ids: string[]) {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    let changed = false;
    state.findings = state.findings.map((f) => {
        if (idSet.has(f.id) && f.status === 'open') { changed = true; return { ...f, status: 'stale' as const }; }
        return f;
    });
    if (changed) { recomputeCounts(); emit(); }
}

/** Top-N findings filtered to a single graphId. `bindings` is optional-guarded
 *  (BUG-AIREVIEW-BLOCKS-L2NAV): a finding that arrives without bindings must
 *  contribute nothing, not throw `bindings.some` on undefined and crash the view. */
export function findingsForGraph(graphId: string): AiReviewFinding[] {
    return state.findings.filter((f) => (f.bindings ?? []).some((b) => b.graphId === graphId));
}

/** Findings touching a specific entity. */
export function findingsForEntity(graphId: string, targetId: string): AiReviewFinding[] {
    return state.findings.filter((f) =>
        (f.bindings ?? []).some((b) => b.graphId === graphId && (b.targetId === targetId || b.targetId.endsWith(`::${targetId}`))),
    );
}

/** Worst severity present at a layer (max-severity rule for the chip color). */
export function worstSeverity(cell?: CountsCell): 'error' | 'warning' | 'info' | null {
    if (!cell || cell.total === 0) return null;
    if (cell.error > 0) return 'error';
    if (cell.warning > 0) return 'warning';
    return 'info';
}

function recomputeCounts() {
    const byGraph: Record<string, CountsCell> = {};
    const byEntryPoint: Record<string, number> = {};
    const bySeverity = { error: 0, warning: 0, info: 0 };
    let total = 0;
    for (const f of state.findings) {
        if (f.status !== 'open') continue;
        total += 1;
        bySeverity[f.severity] += 1;
        byEntryPoint[f.entryPointId] = (byEntryPoint[f.entryPointId] ?? 0) + 1;
        const seen = new Set<string>();
        for (const b of (f.bindings ?? [])) {
            if (seen.has(b.graphId)) continue;
            seen.add(b.graphId);
            const cell = byGraph[b.graphId] ?? { error: 0, warning: 0, info: 0, total: 0 };
            cell[f.severity] += 1;
            cell.total += 1;
            byGraph[b.graphId] = cell;
        }
    }
    state.counts = { byGraph, byEntryPoint, bySeverity, total };
}
