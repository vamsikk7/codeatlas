/**
 * TDD test for `decideNodeClick` — covers the L1 service, Knowledge Map,
 * and (newly added 2026-06-03) Domain drill branches.
 */
import { describe, it, expect } from 'vitest';
import { decideNodeClick } from '../decideNodeClick';

describe('decideNodeClick', () => {
    it('L1 service node → openFeatureForService', () => {
        const out = decideNodeClick({
            mode: 'microservice',
            nodeData: { type: 'service', meta: { serviceId: 'service:main' } },
            newWindow: false,
        });
        expect(out).toEqual({
            type: 'openFeatureForService',
            serviceId: 'service:main',
            newWindow: false,
        });
    });

    // #L2merge — an api node from the merged backend Feature view opens its
    // sequence, same as the L2b panel (not a source-open).
    it('feature-mode api node → openSequenceForApi', () => {
        const out = decideNodeClick({
            mode: 'feature',
            nodeData: { type: 'api', meta: { apiId: 'auth-login' } },
            newWindow: false,
        });
        expect(out).toEqual({ type: 'openSequenceForApi', apiId: 'auth-login', newWindow: false });
    });

    it('feature-mode cluster node → null (falls through to inline cluster→api-list path)', () => {
        const out = decideNodeClick({
            mode: 'feature',
            nodeData: { type: 'cluster', meta: { clusterId: 'cluster:auth' } },
            newWindow: false,
        });
        expect(out).toBeNull();
    });

    it('L1 external service node → null (no drill target)', () => {
        const out = decideNodeClick({
            mode: 'microservice',
            nodeData: { type: 'service', meta: { serviceId: 'ext:stripe', external: true } },
            newWindow: false,
        });
        expect(out).toBeNull();
    });

    it('Knowledge Map cluster node → openApiListForCluster', () => {
        const out = decideNodeClick({
            mode: 'map',
            nodeData: { meta: { layer: 'cluster', clusterId: 'cluster:auth', serviceId: 'service:main' } },
            newWindow: false,
        });
        expect(out).toEqual({
            type: 'openApiListForCluster',
            clusterId: 'cluster:auth',
            serviceId: 'service:main',
            newWindow: false,
        });
    });

    it('Knowledge Map service node → openFeatureForService', () => {
        const out = decideNodeClick({
            mode: 'map',
            nodeData: { meta: { layer: 'service', serviceId: 'service:main' } },
            newWindow: true,
        });
        expect(out).toEqual({ type: 'openFeatureForService', serviceId: 'service:main', newWindow: true });
    });

    it('Knowledge Map api node → openSequenceForApi', () => {
        const out = decideNodeClick({
            mode: 'map',
            nodeData: { meta: { layer: 'api', apiId: 'GET:/api/articles@src/foo.ts' } },
            newWindow: false,
        });
        expect(out).toEqual({ type: 'openSequenceForApi', apiId: 'GET:/api/articles@src/foo.ts', newWindow: false });
    });

    // Issue UX-1 (2026-06-03) — was a silent dead click before this branch landed.
    it('Domain cluster node uses meta.drillDownGraphId → requestRoute', () => {
        const out = decideNodeClick({
            mode: 'domain',
            nodeData: {
                type: 'cluster',
                meta: {
                    layer: 'domain',
                    domainId: 'auth-domain',
                    drillDownGraphId: 'sequence:src/app/routes/auth/auth.controller.ts:login',
                },
            },
            newWindow: false,
        });
        expect(out).toEqual({
            type: 'requestRoute',
            graphId: 'sequence:src/app/routes/auth/auth.controller.ts:login',
        });
    });

    it('Domain cluster node without drillDownGraphId falls back to openApiListForCluster', () => {
        const out = decideNodeClick({
            mode: 'domain',
            nodeData: {
                type: 'cluster',
                meta: { layer: 'domain', domainId: 'auth-domain', serviceId: 'service:main' },
            },
            newWindow: false,
        });
        expect(out).toEqual({
            type: 'openApiListForCluster',
            clusterId: 'auth-domain',
            serviceId: 'service:main',
            newWindow: false,
        });
    });

    it('Domain edge / non-cluster node → null', () => {
        const out = decideNodeClick({
            mode: 'domain',
            nodeData: { type: 'edge', meta: { layer: 'domain' } },
            newWindow: false,
        });
        expect(out).toBeNull();
    });

    // BUG-FE-NO-L3L4L5-L2A — a FRONTEND L2a screen row carries a `type:'graph'`
    // node with `meta.graphId = screen-content:<id>` (its drill target). Before
    // this branch the click had no matching case in handleNodeClick and did
    // nothing — the render-flow / component-data / screen-content panel were all
    // unreachable from the screen list. Route the drill via `requestRoute`.
    it('screen-list graph node → requestRoute to its meta.graphId (screen-content)', () => {
        const out = decideNodeClick({
            mode: 'feature',
            nodeData: {
                type: 'graph',
                meta: { graphId: 'screen-content:screen:service:web:/(checkout)/checkout/[clientSecret]' },
            },
            newWindow: false,
        });
        expect(out).toEqual({
            type: 'requestRoute',
            graphId: 'screen-content:screen:service:web:/(checkout)/checkout/[clientSecret]',
        });
    });

    it('graph node without a meta.graphId → null (falls through to default open)', () => {
        const out = decideNodeClick({
            mode: 'feature',
            nodeData: { type: 'graph', meta: {} },
            newWindow: false,
        });
        expect(out).toBeNull();
    });

    it('Unknown mode → null (caller falls through to default)', () => {
        const out = decideNodeClick({
            mode: 'flow',
            nodeData: { type: 'block', meta: {} },
            newWindow: false,
        });
        expect(out).toBeNull();
    });

    it('Empty / undefined nodeData → null', () => {
        expect(decideNodeClick({ mode: 'domain', nodeData: undefined, newWindow: false })).toBeNull();
        expect(decideNodeClick({ mode: 'domain', nodeData: null, newWindow: false })).toBeNull();
    });
});
