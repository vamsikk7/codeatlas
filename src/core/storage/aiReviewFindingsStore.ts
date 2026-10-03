/**
 * aiReviewFindingsStore.ts — in-memory mirror of the `ai_review_findings`
 * table. Mirrors `commentStore.ts` ergonomics; persistence happens via the
 * SnapshotStore (which owns the sqlite handle).
 *
 * #498/#499 — durable storage + count APIs. Re-anchoring on graph rebuild
 * still pending (will plug into the same 4-tier strategy CommentStore uses).
 */

import type { AiReviewFinding, AiReviewStatus, AiReviewSeverity, AiReviewBinding } from '../graph/graphTypes';

let findingIdCounter = 0;
/**
 * Issue 613 — resolve a human-readable actor for the audit trail. We try
 * standard env vars in order; fall back to `'local'` so the trail row
 * always has a stable, non-empty actor.
 *
 * When real auth lands (GitHub OAuth tied to the same user) this should
 * be wired to the authenticated identity instead. For now the local
 * username is the right level of fidelity for team review contexts.
 */
function resolveLocalActor(): string {
    return (
        process.env.USER
        || process.env.USERNAME
        || process.env.LOGNAME
        || 'local'
    );
}

function generateFindingId(): string {
    return `f_${++findingIdCounter}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export interface FindingFilter {
    graphId?: string;
    entryPointId?: string;
    severity?: AiReviewSeverity;
    status?: AiReviewStatus;
    categoryIn?: string[];
}

export interface FindingCounts {
    byGraph: Record<string, { error: number; warning: number; info: number; total: number }>;
    byEntryPoint: Record<string, number>;
    bySeverity: { error: number; warning: number; info: number };
    total: number;
}

export class AiReviewFindingsStore {
    private findings: AiReviewFinding[] = [];

    constructor(initial: AiReviewFinding[] = []) {
        this.findings = [...initial];
    }

    /** Replace the entire store (used on load from sqlite). */
    loadAll(records: AiReviewFinding[]): void {
        this.findings = [...records];
    }

    getAll(): AiReviewFinding[] {
        return [...this.findings];
    }

    list(filter: FindingFilter = {}): AiReviewFinding[] {
        return this.findings.filter((f) => {
            if (filter.severity && f.severity !== filter.severity) return false;
            if (filter.status && f.status !== filter.status) return false;
            if (filter.entryPointId && f.entryPointId !== filter.entryPointId) return false;
            if (filter.graphId && !f.bindings.some((b) => b.graphId === filter.graphId)) return false;
            if (filter.categoryIn && !filter.categoryIn.includes(f.category)) return false;
            return true;
        });
    }

    getById(id: string): AiReviewFinding | undefined {
        return this.findings.find((f) => f.id === id);
    }

    /** Returns findings that touch a specific entity (graphId + targetId). */
    listForEntity(graphId: string, targetId: string): AiReviewFinding[] {
        return this.findings.filter((f) =>
            f.bindings.some((b) => b.graphId === graphId && b.targetId === targetId),
        );
    }

    /**
     * Insert a new finding or update an existing one (matched by id).
     * Returns the persisted record. On first insertion we seed a single
     * audit entry recording the original `open` state (#613 — Resolve / Ignore audit trail).
     */
    upsert(record: Omit<AiReviewFinding, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): AiReviewFinding {
        const now = new Date().toISOString();
        const existingIdx = record.id ? this.findings.findIndex((f) => f.id === record.id) : -1;
        if (existingIdx >= 0) {
            const merged: AiReviewFinding = {
                ...this.findings[existingIdx],
                ...record,
                id: this.findings[existingIdx].id,
                updatedAt: now,
            };
            this.findings[existingIdx] = merged;
            return merged;
        }
        const created: AiReviewFinding = {
            ...record,
            id: record.id ?? generateFindingId(),
            createdAt: now,
            updatedAt: now,
            // Issue 613 — seed the audit trail on first insert. Preserves
            // back-compat: rows written before this commit have no trail
            // and readers default to `[]`.
            auditTrail: (record as any).auditTrail ?? [{
                ts: now,
                fromStatus: null,
                toStatus: (record as any).status ?? 'open',
                actor: (record as any).model ?? 'system',
            }],
        } as AiReviewFinding;
        this.findings.push(created);
        return created;
    }

    /**
     * Issue 613 — record the status change in the audit trail. `opts.actor`
     * defaults to the local username; `opts.note` is the optional comment
     * the user typed in the popover.
     */
    updateStatus(id: string, status: AiReviewStatus, opts?: { actor?: string; note?: string }): AiReviewFinding | undefined {
        const idx = this.findings.findIndex((f) => f.id === id);
        if (idx < 0) return undefined;
        const prev = this.findings[idx];
        if (prev.status === status) {
            // No-op transition — still bump updatedAt for consistency, but
            // don't pollute the trail with same-status entries.
            this.findings[idx] = { ...prev, updatedAt: new Date().toISOString() };
            return this.findings[idx];
        }
        const ts = new Date().toISOString();
        const entry = {
            ts,
            fromStatus: prev.status,
            toStatus: status,
            actor: opts?.actor || resolveLocalActor(),
            ...(opts?.note ? { note: opts.note } : {}),
        };
        const trail = Array.isArray(prev.auditTrail) ? [...prev.auditTrail, entry] : [entry];
        this.findings[idx] = {
            ...prev,
            status,
            updatedAt: ts,
            auditTrail: trail,
        };
        return this.findings[idx];
    }

    remove(id: string): boolean {
        const before = this.findings.length;
        this.findings = this.findings.filter((f) => f.id !== id);
        return this.findings.length < before;
    }

    clearScope(scope: { entryPointId?: string; graphId?: string }): number {
        const before = this.findings.length;
        this.findings = this.findings.filter((f) => {
            if (scope.entryPointId && f.entryPointId === scope.entryPointId) return false;
            if (scope.graphId && f.bindings.some((b) => b.graphId === scope.graphId)) return false;
            return true;
        });
        return before - this.findings.length;
    }

    clearAll(): number {
        const n = this.findings.length;
        this.findings = [];
        return n;
    }

    /** Aggregate counts for layer-chip badges + summary tool. */
    counts(filter: FindingFilter = {}): FindingCounts {
        const items = this.list({ ...filter, status: filter.status ?? 'open' });
        const out: FindingCounts = {
            byGraph: {},
            byEntryPoint: {},
            bySeverity: { error: 0, warning: 0, info: 0 },
            total: 0,
        };
        for (const f of items) {
            out.total += 1;
            out.bySeverity[f.severity] += 1;
            out.byEntryPoint[f.entryPointId] = (out.byEntryPoint[f.entryPointId] ?? 0) + 1;
            const seen = new Set<string>();
            for (const b of f.bindings) {
                if (seen.has(b.graphId)) continue;
                seen.add(b.graphId);
                const cell = out.byGraph[b.graphId] ?? { error: 0, warning: 0, info: 0, total: 0 };
                cell[f.severity] += 1;
                cell.total += 1;
                out.byGraph[b.graphId] = cell;
            }
        }
        return out;
    }
}

/** Stable hash for an entity binding (graphId + targetId) — used for dedup. */
export function bindingKey(b: AiReviewBinding): string {
    return `${b.graphId}::${b.targetType}::${b.targetId}`;
}
