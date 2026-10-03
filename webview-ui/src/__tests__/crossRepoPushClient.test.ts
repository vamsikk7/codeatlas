/**
 * crossRepoPushClient.test.ts — #817.5 (2026-06-11).
 *
 * Pins the active-refresh / passive-badge decision for incoming
 * `crossRepoEdgeChanged` pushes.
 */

import { describe, it, expect } from 'vitest';
import { decideCrossRepoAction, routeAndScopeFromHash, type CrossRepoEdgeChangedMsg } from '../crossRepoPushClient';

const MSG: CrossRepoEdgeChangedMsg = {
    type: 'crossRepoEdgeChanged',
    producerRepoId: 'prod1',
    producerRepoName: 'auth-service',
    edges: [
        { consumerRepoId: 'con1', consumerRepoName: 'gateway', method: 'POST', route: '/login', diff: 'modified' },
    ],
    at: 0,
};

describe('#817 — routeAndScopeFromHash', () => {
    it('parses bare and scoped routes', () => {
        expect(routeAndScopeFromHash('#/system-design')).toEqual({ route: 'system-design', scope: null });
        expect(routeAndScopeFromHash('#/system-design/gateway')).toEqual({ route: 'system-design', scope: 'gateway' });
        expect(routeAndScopeFromHash('#/map/auth-service')).toEqual({ route: 'map', scope: 'auth-service' });
        expect(routeAndScopeFromHash('#/home')).toBeNull();
        expect(routeAndScopeFromHash('')).toBeNull();
    });
});

describe('#817 — decideCrossRepoAction', () => {
    it('workspace L1 (no scope) → refresh with toast', () => {
        const d = decideCrossRepoAction('#/system-design', MSG);
        expect(d.refresh).toBe(true);
        expect(d.toast).toContain('auth-service updated POST /login');
        expect(d.toast).toContain('gateway');
    });

    it('tab scoped to the affected CONSUMER → refresh', () => {
        expect(decideCrossRepoAction('#/system-design/gateway', MSG).refresh).toBe(true);
        expect(decideCrossRepoAction('#/map/con1', MSG).refresh).toBe(true);
    });

    it('tab scoped to the PRODUCER → refresh (its L1 renders the same edges)', () => {
        expect(decideCrossRepoAction('#/system-design/auth-service', MSG).refresh).toBe(true);
    });

    it('tab scoped to an UNRELATED repo → passive badge, no toast', () => {
        const d = decideCrossRepoAction('#/system-design/reports', MSG);
        expect(d.refresh).toBe(false);
        expect(d.toast).toBeNull();
        expect(d.affectedConsumers).toEqual(['gateway']);
    });

    it('non-L1 routes (file, apis, home) → passive badge', () => {
        expect(decideCrossRepoAction('#/file/src%2Fapp.ts', MSG).refresh).toBe(false);
        expect(decideCrossRepoAction('#/apis/cluster:auth', MSG).refresh).toBe(false);
        expect(decideCrossRepoAction('#/home', MSG).refresh).toBe(false);
    });

    it('revert-clear (diff null) toast reads "back in sync"', () => {
        const cleared = { ...MSG, edges: [{ ...MSG.edges[0], diff: null }] };
        const d = decideCrossRepoAction('#/system-design', cleared);
        expect(d.refresh).toBe(true);
        expect(d.toast).toContain('back in sync');
    });

    it('revert-clear via the derived "unchanged" literal also reads "back in sync"', () => {
        const cleared = { ...MSG, edges: [{ ...MSG.edges[0], diff: 'unchanged' }] };
        const d = decideCrossRepoAction('#/system-design', cleared);
        expect(d.toast).toContain('back in sync');
    });

    it('multi-edge fan-out lists unique consumers + summary toast', () => {
        const multi = {
            ...MSG,
            edges: [
                MSG.edges[0],
                { consumerRepoId: 'con2', consumerRepoName: 'reports', method: 'GET', route: '/users/:id', diff: 'modified' },
                { consumerRepoId: 'con1', consumerRepoName: 'gateway', method: 'GET', route: '/health', diff: 'modified' },
            ],
        };
        const d = decideCrossRepoAction('#/map', multi);
        expect(d.refresh).toBe(true);
        expect(d.affectedConsumers).toEqual(['gateway', 'reports']);
        expect(d.toast).toContain('3 consumed endpoints');
    });
});
