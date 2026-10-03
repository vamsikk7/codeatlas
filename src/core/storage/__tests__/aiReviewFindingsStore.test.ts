import { describe, it, expect } from 'vitest';
import { AiReviewFindingsStore } from '../aiReviewFindingsStore';
import type { AiReviewFinding } from '../../graph/graphTypes';

function mkFinding(over: Partial<AiReviewFinding> = {}): AiReviewFinding {
    const now = new Date().toISOString();
    return {
        id: over.id ?? `f_${Math.random().toString(36).slice(2)}`,
        entryPointId: over.entryPointId ?? 'GET:/api/articles',
        bindings: over.bindings ?? [
            { graphId: 'sequence:src/x.ts:create', targetId: 'GET:/api/articles::entry', targetType: 'node', layer: 'sequence' },
            { graphId: 'file:src/x.ts', targetId: 'GET:/api/articles::entry', targetType: 'node', layer: 'file' },
        ],
        severity: over.severity ?? 'warning',
        category: over.category ?? 'code-quality',
        title: over.title ?? 'sample finding',
        body: over.body ?? 'body text',
        status: over.status ?? 'open',
        model: over.model ?? 'gpt-test',
        createdAt: over.createdAt ?? now,
        updatedAt: over.updatedAt ?? now,
        anchor: over.anchor,
        guidelinesHash: over.guidelinesHash,
    };
}

describe('AiReviewFindingsStore', () => {
    it('lists all findings by default', () => {
        const s = new AiReviewFindingsStore([mkFinding(), mkFinding()]);
        expect(s.list()).toHaveLength(2);
    });

    it('filters by graphId binding', () => {
        const a = mkFinding({ bindings: [{ graphId: 'sequence:a:fn', targetId: 'x', targetType: 'node', layer: 'sequence' }] });
        const b = mkFinding({ bindings: [{ graphId: 'sequence:b:fn', targetId: 'x', targetType: 'node', layer: 'sequence' }] });
        const s = new AiReviewFindingsStore([a, b]);
        expect(s.list({ graphId: 'sequence:a:fn' })).toEqual([a]);
    });

    it('filters by severity and status', () => {
        const open = mkFinding({ severity: 'error', status: 'open' });
        const resolved = mkFinding({ severity: 'error', status: 'resolved' });
        const info = mkFinding({ severity: 'info', status: 'open' });
        const s = new AiReviewFindingsStore([open, resolved, info]);
        expect(s.list({ severity: 'error', status: 'open' })).toEqual([open]);
    });

    it('upserts by id and updates updatedAt', async () => {
        const s = new AiReviewFindingsStore();
        const first = s.upsert({
            entryPointId: 'POST:/api/articles',
            bindings: [{ graphId: 'g', targetId: 't', targetType: 'node', layer: 'sequence' }],
            severity: 'warning', category: 'code-quality',
            title: 't', body: 'b', status: 'open', model: 'm',
        });
        const initialUpdated = first.updatedAt;
        // wait a tick to ensure updatedAt changes (ISO string differs by ms)
        await new Promise((r) => setTimeout(r, 5));
        const second = s.upsert({ id: first.id, entryPointId: first.entryPointId, bindings: first.bindings, severity: 'error', category: 'security', title: 't2', body: 'b2', status: 'open', model: 'm' });
        expect(second.id).toBe(first.id);
        expect(second.severity).toBe('error');
        expect(second.updatedAt).not.toBe(initialUpdated);
    });

    it('updateStatus mutates only the matched record', () => {
        const a = mkFinding();
        const b = mkFinding();
        const s = new AiReviewFindingsStore([a, b]);
        const updated = s.updateStatus(a.id, 'resolved');
        expect(updated?.status).toBe('resolved');
        expect(s.list({ status: 'open' })).toHaveLength(1);
    });

    it('counts groups by graphId and severity', () => {
        const f1 = mkFinding({ severity: 'error', bindings: [{ graphId: 'sequence:a', targetId: 'x', targetType: 'node', layer: 'sequence' }] });
        const f2 = mkFinding({ severity: 'warning', bindings: [{ graphId: 'sequence:a', targetId: 'x', targetType: 'node', layer: 'sequence' }, { graphId: 'file:a.ts', targetId: 'x', targetType: 'node', layer: 'file' }] });
        const s = new AiReviewFindingsStore([f1, f2]);
        const c = s.counts();
        expect(c.total).toBe(2);
        expect(c.bySeverity.error).toBe(1);
        expect(c.bySeverity.warning).toBe(1);
        expect(c.byGraph['sequence:a'].total).toBe(2);
        expect(c.byGraph['file:a.ts'].total).toBe(1);
    });

    it('clearScope removes only matching findings', () => {
        const a = mkFinding({ entryPointId: 'GET:/x' });
        const b = mkFinding({ entryPointId: 'POST:/y' });
        const s = new AiReviewFindingsStore([a, b]);
        const removed = s.clearScope({ entryPointId: 'GET:/x' });
        expect(removed).toBe(1);
        expect(s.list()).toEqual([b]);
    });

    it('listForEntity returns findings touching that entity', () => {
        const a = mkFinding({ bindings: [{ graphId: 'sequence:s1', targetId: 'msg-1', targetType: 'edge', layer: 'sequence' }] });
        const b = mkFinding({ bindings: [{ graphId: 'sequence:s1', targetId: 'msg-2', targetType: 'edge', layer: 'sequence' }] });
        const s = new AiReviewFindingsStore([a, b]);
        expect(s.listForEntity('sequence:s1', 'msg-1')).toEqual([a]);
    });

    // ── Issue 613 — audit trail
    describe('audit trail (Issue 613)', () => {
        it('seeds a single audit entry on upsert', () => {
            const s = new AiReviewFindingsStore([]);
            const inserted = s.upsert({
                entryPointId: 'GET:/x', bindings: [], severity: 'warning', category: 'code-quality',
                title: 't', body: 'b', status: 'open', model: 'gpt-4o',
            });
            expect(inserted.auditTrail).toBeDefined();
            expect(inserted.auditTrail).toHaveLength(1);
            expect(inserted.auditTrail![0]).toMatchObject({ fromStatus: null, toStatus: 'open' });
            expect(inserted.auditTrail![0].ts).toBeDefined();
        });

        it('appends an entry on every status change', () => {
            const s = new AiReviewFindingsStore([]);
            const f = s.upsert({
                entryPointId: 'GET:/x', bindings: [], severity: 'warning', category: 'code-quality',
                title: 't', body: 'b', status: 'open', model: 'gpt-4o',
            });
            s.updateStatus(f.id, 'resolved', { actor: 'alice', note: 'fixed in commit abc' });
            s.updateStatus(f.id, 'open', { actor: 'bob', note: 'reopening — repro still works' });
            const got = s.getById(f.id);
            expect(got!.auditTrail).toHaveLength(3);
            expect(got!.auditTrail![1]).toMatchObject({ fromStatus: 'open', toStatus: 'resolved', actor: 'alice', note: 'fixed in commit abc' });
            expect(got!.auditTrail![2]).toMatchObject({ fromStatus: 'resolved', toStatus: 'open', actor: 'bob', note: 'reopening — repro still works' });
        });

        it('does NOT append on same-status no-op transitions', () => {
            const s = new AiReviewFindingsStore([]);
            const f = s.upsert({
                entryPointId: 'GET:/x', bindings: [], severity: 'warning', category: 'code-quality',
                title: 't', body: 'b', status: 'resolved', model: 'gpt-4o',
            });
            s.updateStatus(f.id, 'resolved', { actor: 'alice' });
            const got = s.getById(f.id);
            expect(got!.auditTrail).toHaveLength(1);
        });

        it('falls back to local actor when none supplied', () => {
            const s = new AiReviewFindingsStore([]);
            const f = s.upsert({
                entryPointId: 'GET:/x', bindings: [], severity: 'warning', category: 'code-quality',
                title: 't', body: 'b', status: 'open', model: 'gpt-4o',
            });
            s.updateStatus(f.id, 'resolved');
            const got = s.getById(f.id);
            expect(got!.auditTrail).toHaveLength(2);
            expect(typeof got!.auditTrail![1].actor).toBe('string');
            expect(got!.auditTrail![1].actor.length).toBeGreaterThan(0);
        });

        it('preserves existing audit trail across upserts (merge does not clobber)', () => {
            const s = new AiReviewFindingsStore([]);
            const f = s.upsert({
                entryPointId: 'GET:/x', bindings: [], severity: 'warning', category: 'code-quality',
                title: 't', body: 'b', status: 'open', model: 'gpt-4o',
            });
            s.updateStatus(f.id, 'resolved', { actor: 'alice' });
            const updated = s.upsert({
                id: f.id,
                entryPointId: 'GET:/x', bindings: [], severity: 'error', category: 'code-quality',
                title: 't', body: 'b', status: 'resolved', model: 'gpt-4o',
            });
            expect(updated.severity).toBe('error');
            expect(updated.auditTrail).toHaveLength(2);
        });
    });
});
