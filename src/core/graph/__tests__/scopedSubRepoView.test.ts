/**
 * scopedSubRepoView.test.ts — #819 (2026-06-10).
 *
 * Pins the two failure modes the dev-walkthrough found on the 2-repo
 * fixture: (1) `#/map/api-service` rendered the WRONG repo's content +
 * stripped the hash because the name-based scope filter couldn't match
 * Phase-5-scoped per-repo maps; (2) the bare-`#/map` fold dropped one
 * repo's nodes because per-repo maps share generated node ids.
 */

import { describe, it, expect } from 'vitest';
import {
    filterSnapshotToSubRepo,
    buildScopedSubRepoMapGraph,
    foldPerRepoMapGraphs,
} from '../scopedSubRepoView';

/* eslint-disable @typescript-eslint/no-explicit-any */

function subRepoSnapshot(): any {
    // Phase-5-scoped per-repo store shape: ONE inner service whose name
    // (`node-app`) differs from the repo folder (`api-service`).
    return {
        files: {
            'api-service/src/services/auth.service.js': { path: 'api-service/src/services/auth.service.js', hash: 'h1', symbols: { functions: [], variables: [], imports: [] } },
        },
        apiIndex: {
            'GET:/v1/users': { apiId: 'GET:/v1/users', method: 'GET', route: '/v1/users', filePath: 'api-service/src/services/auth.service.js', handlerName: 'h' },
        },
        services: {
            'service:node-app': { id: 'service:node-app', name: 'node-app', rootPath: 'api-service', technology: 'express', exposedApiCount: 1, consumedUrls: [], consumedServices: [] },
        },
        clusters: {
            'cluster:auth': { id: 'cluster:auth', name: 'auth', label: 'auth', serviceId: 'service:node-app', files: ['api-service/src/services/auth.service.js'], entryPoints: [], apisInCluster: [], internalCallCount: 0, externalCallCount: 0 },
        },
        graphs: {
            // Stale cached workspace-overview map — MUST be cleared by the filter.
            'map:workspace': { graphId: 'map:workspace', type: 'map', nodes: [{ id: 'stale-1' }], edges: [], anchors: {} },
        },
    };
}

function workspaceShapedSnapshot(): any {
    // Defensive case: a per-repo store polluted with workspace-wide data
    // (pre-Phase-5 builds / WorkspaceOrchestrator post-init write-back).
    const s = subRepoSnapshot();
    s.services['service:payments'] = { id: 'service:payments', name: 'payments', rootPath: 'payments-service', technology: 'fastify', exposedApiCount: 3, consumedUrls: [], consumedServices: [] };
    s.files['payments-service/src/app.ts'] = { path: 'payments-service/src/app.ts', hash: 'h2', symbols: { functions: [], variables: [], imports: [] } };
    s.apiIndex['POST:/pay'] = { apiId: 'POST:/pay', method: 'POST', route: '/pay', filePath: 'payments-service/src/app.ts', handlerName: 'p' };
    s.clusters['cluster:pay'] = { id: 'cluster:pay', name: 'pay', label: 'pay', serviceId: 'service:payments', files: ['payments-service/src/app.ts'], entryPoints: [], apisInCluster: [], internalCallCount: 0, externalCallCount: 0 };
    return s;
}

describe('#819 — filterSnapshotToSubRepo', () => {
    it('passes a Phase-5-scoped snapshot through (everything already in scope) + clears cached graphs', () => {
        const out: any = filterSnapshotToSubRepo(subRepoSnapshot(), 'api-service');
        expect(Object.keys(out.services)).toEqual(['service:node-app']);
        expect(Object.keys(out.files)).toHaveLength(1);
        expect(Object.keys(out.apiIndex)).toHaveLength(1);
        expect(Object.keys(out.clusters)).toEqual(['cluster:auth']);
        expect(out.graphs).toEqual({});
    });

    it('strips sibling-repo entities from a workspace-shaped snapshot (defensive)', () => {
        const out: any = filterSnapshotToSubRepo(workspaceShapedSnapshot(), 'api-service');
        expect(Object.keys(out.services)).toEqual(['service:node-app']);
        expect(Object.keys(out.files)).toEqual(['api-service/src/services/auth.service.js']);
        expect(Object.keys(out.apiIndex)).toEqual(['GET:/v1/users']);
        expect(Object.keys(out.clusters)).toEqual(['cluster:auth']);
    });
});

describe('#819 — buildScopedSubRepoMapGraph', () => {
    const matched = { repoId: 'abc123', name: 'api-service', rootPath: 'api-service' };

    it('rebuilds the map from the sub-snapshot + stamps meta.scopedRepo (hash preservation contract)', () => {
        const g: any = buildScopedSubRepoMapGraph({
            matched,
            subSnapshot: subRepoSnapshot(),
            workspaceRoot: '/ws',
            scopedRepo: 'api-service',
        });
        expect(g, 'graph must build').toBeTruthy();
        expect(g.meta.scopedRepo, 'frontend hash sync keys off this').toBe('api-service');
        expect(g.nodes.length).toBeGreaterThan(0);
        // The map must contain the inner service + the cluster — content
        // the broken name-based filter dropped to 0.
        const labels = g.nodes.map((n: any) => n.label);
        expect(labels).toContain('node-app');
        expect(labels).toContain('auth');
        // And NO stale node from the cached workspace-overview graph.
        expect(g.nodes.some((n: any) => n.id === 'stale-1')).toBe(false);
    });

    it('workspace-shaped snapshot → siblings filtered out of the rebuilt map', () => {
        const g: any = buildScopedSubRepoMapGraph({
            matched,
            subSnapshot: workspaceShapedSnapshot(),
            workspaceRoot: '/ws',
            scopedRepo: 'api-service',
        });
        expect(g).toBeTruthy();
        const labels = g.nodes.map((n: any) => n.label);
        expect(labels).toContain('node-app');
        expect(labels).not.toContain('payments');
        expect(labels).not.toContain('pay');
    });

    it('returns null when the sub-snapshot is empty (caller falls back)', () => {
        const g = buildScopedSubRepoMapGraph({
            matched,
            subSnapshot: { files: {}, apiIndex: {}, services: {}, clusters: {}, graphs: {} } as any,
            workspaceRoot: '/ws',
            scopedRepo: 'api-service',
        });
        expect(g).toBeNull();
    });
});

describe('#819 — foldPerRepoMapGraphs id-collision fix', () => {
    it('both repos survive when their maps share generated node ids (the walkthrough repro)', () => {
        // Both per-repo maps use the SAME generated ids (map-1, map-2) —
        // exactly what resetIds() produces per build. Pre-#819 the fold
        // deduped by raw id and the second repo's content vanished
        // (hasApiSvc:false in the walkthrough).
        const apiSvcMap = {
            nodes: [
                { id: 'map-1', label: 'node-app', type: 'service' },
                { id: 'map-2', label: 'auth', type: 'cluster' },
            ],
            edges: [{ id: 'edge-1', source: 'map-1', target: 'map-2', label: 'contains' }],
            anchors: { 'edge-1': { filePath: 'api-service/src/a.js' } },
        };
        const paymentsMap = {
            nodes: [
                { id: 'map-1', label: 'main', type: 'service' },
                { id: 'map-2', label: 'payments', type: 'cluster' },
            ],
            edges: [{ id: 'edge-1', source: 'map-1', target: 'map-2', label: 'contains' }],
            anchors: { 'edge-1': { filePath: 'payments-service/src/b.ts' } },
        };

        const fold = foldPerRepoMapGraphs([
            { repoKey: 'api-service', graph: apiSvcMap },
            { repoKey: 'payments-service', graph: paymentsMap },
        ]);

        expect(fold.nodes).toHaveLength(4);
        const labels = fold.nodes.map(n => n.label).sort();
        expect(labels).toEqual(['auth', 'main', 'node-app', 'payments']);
        // Edge endpoints rekeyed into each repo's namespace — no cross-wiring.
        expect(fold.edges).toHaveLength(2);
        for (const e of fold.edges) {
            const ns = e.source.split('::')[0];
            expect(e.target.startsWith(ns + '::')).toBe(true);
        }
        // Anchors rekeyed alongside.
        expect(Object.keys(fold.anchors).sort()).toEqual([
            'api-service::edge-1',
            'payments-service::edge-1',
        ]);
        expect(fold.repoContributors).toEqual(['api-service', 'payments-service']);
    });

    it('empty per-repo maps contribute nothing and are not listed as contributors', () => {
        const fold = foldPerRepoMapGraphs([
            { repoKey: 'empty-repo', graph: { nodes: [], edges: [], anchors: {} } },
            { repoKey: 'real-repo', graph: { nodes: [{ id: 'map-1', label: 'svc' }], edges: [], anchors: {} } },
        ]);
        expect(fold.nodes).toHaveLength(1);
        expect(fold.repoContributors).toEqual(['real-repo']);
    });
});

// #846b (2026-06-11) — live per-repo service records carry rootPath ''
// (the detector runs repo-relative; #831 lesson). The scope filter dropped
// them, so a small sls repo's scoped Knowledge Map rendered ONLY its
// cluster node — no service card, no infra siblings, no API chips.
describe('#846b — filterSnapshotToSubRepo keeps the repo\'s own service records', () => {
    function snapWith(services: Record<string, any>) {
        return {
            files: { 'ts-repo/todos/create.ts': { path: 'ts-repo/todos/create.ts', hash: 'h', mtime: 0, symbols: { functions: [], variables: [], imports: [] } } },
            apiIndex: { 'sls:x': { apiId: 'sls:x', method: 'POST', route: '/todos', filePath: 'ts-repo/todos/create.ts', handlerName: 'create' } },
            clusters: { 'cluster:todos': { id: 'cluster:todos', name: 'todos', files: ['ts-repo/todos/create.ts'], serviceId: 'service:main', apisInCluster: [] } },
            graphs: {}, services,
        } as any;
    }

    it('keeps the bare-rootPath own record (the live detector signature)', () => {
        const out: any = filterSnapshotToSubRepo(snapWith({
            'service:main': { id: 'service:main', name: 'main', rootPath: '' },
        }), 'ts-repo');
        expect(Object.keys(out.services)).toEqual(['service:main']);
    });

    it('keeps repo-RELATIVE multi-service rows when backed by in-scope files', () => {
        const snap = snapWith({
            'service:lambda1': { id: 'service:lambda1', name: 'l1', rootPath: 'functions/one' },
        });
        snap.files['ts-repo/functions/one/handler.ts'] = { path: 'ts-repo/functions/one/handler.ts', hash: 'h', mtime: 0, symbols: { functions: [], variables: [], imports: [] } };
        const out: any = filterSnapshotToSubRepo(snap, 'ts-repo');
        expect(Object.keys(out.services)).toEqual(['service:lambda1']);
    });

    it('drops repo-relative-LOOKING rows with no backing files (foreign masquerade)', () => {
        const out: any = filterSnapshotToSubRepo(snapWith({
            'service:fake': { id: 'service:fake', name: 'fake', rootPath: 'payments-service' },
        }), 'ts-repo');
        expect(Object.keys(out.services)).toEqual([]);
    });

    it('still DROPS foreign workspace rows (the #811 defensive contract)', () => {
        const out: any = filterSnapshotToSubRepo(snapWith({
            'service:main': { id: 'service:main', name: 'main', rootPath: '' },
            'service:other': { id: 'service:other', name: 'other', rootPath: 'other-repo' },
        }), 'ts-repo');
        expect(Object.keys(out.services)).toEqual(['service:main']);
    });
});
