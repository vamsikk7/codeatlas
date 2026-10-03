import { describe, it, expect, beforeEach } from 'vitest';
import { setCounts, setFindings, getState, subscribe, addFindings, findingsForGraph, findingsForEntity } from '../aiReviewBus';

/**
 * BUG-AIREVIEW-BLOCKS-L2NAV (2026-07-21) — an active AI review broke L1→L2
 * navigation. Root cause: `setCounts` blindly stored the server's counts
 * payload; when a counts-only update (aiFindings / aiReviewComplete) lacked
 * `byGraph`, `AiReviewLayerChip` — rendered on EVERY layer — read
 * `counts.byGraph[graphId]` and threw "Cannot read properties of undefined",
 * crashing the diagram render so the next layer never mounted. These tests lock
 * in that the bus always exposes a complete counts shape.
 */
describe('aiReviewBus — counts shape is always complete', () => {
    beforeEach(() => { setFindings([]); }); // reset findings between tests

    it('setCounts normalizes a partial payload so byGraph/bySeverity are always present', () => {
        // The exact poison: a server counts update missing byGraph.
        setCounts({ total: 3 } as never);
        const c = getState().counts;
        expect(c.byGraph).toBeDefined();
        expect(typeof c.byGraph).toBe('object');
        // The access that used to crash the chip must now be safe.
        expect(() => c.byGraph['microservice:workspace']).not.toThrow();
        expect(c.byGraph['microservice:workspace']).toBeUndefined();
        expect(c.bySeverity).toEqual({ error: 0, warning: 0, info: 0 });
        expect(c.byEntryPoint).toBeDefined();
        expect(c.total).toBe(3);
    });

    it('setCounts survives null/undefined without throwing', () => {
        expect(() => setCounts(null as never)).not.toThrow();
        expect(getState().counts.byGraph).toBeDefined();
        expect(getState().counts.total).toBe(0);
    });

    it('setFindings with a malformed counts also normalizes', () => {
        setFindings([], { total: 1 } as never);
        expect(getState().counts.byGraph).toBeDefined();
        expect(() => getState().counts.byGraph['x']).not.toThrow();
    });

    it('preserves a well-formed counts payload', () => {
        const good = {
            byGraph: { g1: { error: 1, warning: 0, info: 0, total: 1 } },
            byEntryPoint: { ep1: 1 },
            bySeverity: { error: 1, warning: 0, info: 0 },
            total: 1,
        };
        setCounts(good);
        expect(getState().counts.byGraph.g1.total).toBe(1);
        expect(getState().counts.total).toBe(1);
    });

    it('a finding without bindings does not crash recomputeCounts / findingsForGraph', () => {
        // A finding that arrives (mid-stream) without a `bindings` array must be
        // tolerated — the old code did `f.bindings.some(...)` and threw.
        expect(() => addFindings([{ id: 'nb', title: 'no bindings', severity: 'error', status: 'open' } as never])).not.toThrow();
        expect(() => findingsForGraph('microservice:workspace')).not.toThrow();
        expect(() => findingsForEntity('microservice:workspace', 'service_1')).not.toThrow();
        expect(getState().counts.byGraph).toBeDefined();
    });

    it('a subscriber reading counts.byGraph[id] never throws after a malformed update', () => {
        let threw = false;
        const unsub = subscribe((s) => {
            try { void s.counts.byGraph['microservice:workspace']; } catch { threw = true; }
        });
        setCounts({ total: 9 } as never); // malformed → normalized
        unsub();
        expect(threw).toBe(false);
    });
});
