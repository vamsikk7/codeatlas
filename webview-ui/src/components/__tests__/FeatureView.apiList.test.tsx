/**
 * FeatureView.apiList.test.tsx — backend L2a+L2b merge.
 *
 * For a backend `feature:*` graph, FeatureView renders the features-grouped
 * API list (FeatureApiListView) instead of the React-Flow cluster map: each
 * feature is a collapsible group of its APIs (HTTP-first), and features with
 * no entry point sink to a single "Internal modules · no entry points" group
 * at the end. FE/mobile (`screen-list`) and `domain:*` graphs are unaffected.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import FeatureView from '../FeatureView';

beforeAll(() => {
    if (typeof window !== 'undefined' && !(window as any).ResizeObserver) {
        class R { observe() {} unobserve() {} disconnect() {} }
        (window as any).ResizeObserver = R;
        (global as any).ResizeObserver = R;
    }
});

beforeEach(() => {
    (window as any).vscodeApi = { postMessage: vi.fn() };
});

function backendGraph() {
    return {
        graphId: 'feature:service:api',
        type: 'feature',
        nodes: [
            {
                id: 'cluster:auth', type: 'cluster', label: 'auth', diff: 'unchanged',
                meta: {
                    files: ['src/auth.ts'], domainPhrase: 'Authenticate users',
                    apisInCluster: [
                        { apiId: 'a1', method: 'POST', route: '/login', handlerName: 'login', filePath: 'src/auth.ts' },
                        { apiId: 'a2', method: 'GET', route: '/me', handlerName: 'me', filePath: 'src/auth.ts' },
                    ],
                },
            },
            {
                id: 'cluster:util', type: 'cluster', label: 'util', diff: 'unchanged',
                meta: { files: ['src/util.ts', 'src/helpers.ts'], apisInCluster: [] },
            },
        ],
        edges: [], anchors: {}, meta: { clusterCount: 2 },
    };
}

describe('FeatureApiListView — backend L2a+L2b merge', () => {
    it('renders the features-grouped API list for a backend feature:* graph', () => {
        render(<FeatureView graph={backendGraph() as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        expect(screen.getByTestId('feature-api-list')).toBeTruthy();
        // feature group header + its routes are visible (defaultOpen)
        expect(screen.getByText('auth')).toBeTruthy();
        expect(screen.getByText('/login')).toBeTruthy();
        expect(screen.getByText('/me')).toBeTruthy();
        // the empty-API cluster is folded into the trailing "Internal modules" group
        expect(screen.getByText(/Internal modules · no entry points/)).toBeTruthy();
    });

    it('header count is labeled "entry points", not "APIs" (BUG-EXP-2 — migrations/jobs/hooks are not APIs)', () => {
        const { container } = render(<FeatureView graph={backendGraph() as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        const header = container.querySelector('.ca-header-title')!;
        // The merged L2a list counts ALL entry points (HTTP + migrations + jobs + hooks),
        // so the numeric count must read "N entry points", never "N APIs".
        expect(header.textContent).toMatch(/\d+ entry point/);
        expect(header.textContent).not.toMatch(/\d+ API/);
        // The view-name badge intentionally stays "Feature APIs".
        expect(header.textContent).toContain('Feature APIs');
    });

    // BUG-EXPLORE-15: the headline counted ALL features including empty
    // ("internal module") ones, so it frequently read as MORE features than
    // entry points (e.g. "15 features · 4 entry points") — confusing, since a
    // feature is supposed to GROUP entry points. The headline now counts only
    // features that HAVE entry points (always ≤ entry points) and surfaces the
    // empty ones as a separate "internal modules" stat.
    it('headline counts only features WITH entry points; empties shown separately (BUG-EXPLORE-15)', () => {
        const { container } = render(<FeatureView graph={backendGraph() as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        const header = container.querySelector('.ca-header-title')!;
        // auth has 2 entry points, util has 0 → 1 feature area, not 2 features.
        expect(header.textContent).toMatch(/1 feature area\b/);
        expect(header.textContent).not.toMatch(/2 features?\b/);
        expect(header.textContent).toMatch(/2 entry points/);
        // the single empty cluster surfaces as an "internal module" stat.
        expect(header.textContent).toMatch(/1 internal module\b/);
    });

    it('groups no-entry-point features at the END, after features that have APIs', () => {
        render(<FeatureView graph={backendGraph() as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        const auth = screen.getByText('auth');
        const internal = screen.getByText(/Internal modules · no entry points/);
        // auth (has APIs) must appear before the internal-modules group in the DOM
        expect(auth.compareDocumentPosition(internal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // util has no API so it is NOT a top-level feature group; it lives inside
        // the (collapsed) internal-modules group — expand it to confirm.
        expect(screen.queryByText('util')).toBeNull();
        fireEvent.click(internal);
        expect(screen.getByText('util')).toBeTruthy();
    });

    it('clicking an API row opens its L3 sequence via a type:"api" node', () => {
        const onNodeClick = vi.fn();
        render(<FeatureView graph={backendGraph() as any} onNodeClick={onNodeClick} onEdgeClick={() => {}} />);
        fireEvent.click(screen.getByText('/login'));
        expect(onNodeClick).toHaveBeenCalled();
        const [nodeId, nodeData] = onNodeClick.mock.calls[0];
        expect(nodeId).toBe('a1');
        expect(nodeData.type).toBe('api');
        expect(nodeData.meta.apiId).toBe('a1');
    });

    it('sorts APIs HTTP-first within a feature (POST before GET here → source order preserved by rank, GET<POST)', () => {
        render(<FeatureView graph={backendGraph() as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        const list = screen.getByTestId('feature-api-list');
        const routes = within(list).getAllByText(/^\/(login|me)$/).map((el) => el.textContent);
        // GET ranks before POST, so /me (GET) renders before /login (POST)
        expect(routes).toEqual(['/me', '/login']);
    });

    it('does NOT apply the merge to a frontend screen-list graph', () => {
        const screenGraph = {
            graphId: 'feature:service:web',
            type: 'feature',
            nodes: [{ id: 's1', type: 'screen', label: '/dashboard', subtitle: '«screen»', meta: { screenId: 's1', opensGraphId: 'screen-content:s1' } }],
            edges: [], anchors: {},
            meta: { mode: 'screen-list', serviceId: 'service:web', framework: 'next', screenCount: 1, prefixGroups: [] },
        };
        render(<FeatureView graph={screenGraph as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        expect(screen.queryByTestId('feature-api-list')).toBeNull();
        expect(screen.getByText('/dashboard')).toBeTruthy();
    });

    // BUG-FE-NO-L3L4L5-L2A — clicking a screen row on the FRONTEND L2a list must
    // NAVIGATE (drill into its screen-content L2b panel). Assert the row fires
    // onNodeClick with a `type:'graph'` node whose target is the screen's
    // `meta.opensGraphId` (`screen-content:<id>`) — the id App routes via
    // requestRoute. Before the fix the row wired the callback but App had no
    // matching branch, so the hash never changed.
    it('clicking a screen row fires onNodeClick to its screen-content graph id', () => {
        const onNodeClick = vi.fn();
        const screenGraph = {
            graphId: 'feature:service:web',
            type: 'feature',
            nodes: [{
                id: 's1', type: 'screen', label: '/(checkout)/checkout/[clientSecret]', subtitle: '«next»',
                anchor: { filePath: 'app/(checkout)/checkout/[clientSecret]/page.tsx' },
                meta: { screenId: 'screen:service:web:/checkout', opensGraphId: 'screen-content:screen:service:web:/checkout' },
            }],
            edges: [], anchors: {},
            meta: { mode: 'screen-list', serviceId: 'service:web', framework: 'next', screenCount: 1, prefixGroups: [] },
        };
        render(<FeatureView graph={screenGraph as any} onNodeClick={onNodeClick} onEdgeClick={() => {}} />);
        fireEvent.click(screen.getByText('/(checkout)/checkout/[clientSecret]'));
        expect(onNodeClick).toHaveBeenCalled();
        const [nodeId, nodeData] = onNodeClick.mock.calls[0];
        expect(nodeId).toBe('screen-content:screen:service:web:/checkout');
        expect(nodeData.type).toBe('graph');
        expect(nodeData.meta.graphId).toBe('screen-content:screen:service:web:/checkout');
    });

    // Graceful degradation — a screen with NO opensGraphId (e.g. a deleted-ghost
    // node) must still do something useful: open its file via anchor rather than
    // no-op. The row falls back to a file-typed node the default open path handles.
    it('screen row without opensGraphId falls back to a file-typed node with its anchor', () => {
        const onNodeClick = vi.fn();
        const screenGraph = {
            graphId: 'feature:service:web',
            type: 'feature',
            nodes: [{
                id: 's-ghost', type: 'screen', label: '/legacy (deleted)', subtitle: '«next»',
                anchor: { filePath: 'app/legacy/page.tsx' },
                meta: { screenId: 'screen:service:web:/legacy', filePath: 'app/legacy/page.tsx' },
            }],
            edges: [], anchors: {},
            meta: { mode: 'screen-list', serviceId: 'service:web', framework: 'next', screenCount: 1, prefixGroups: [] },
        };
        render(<FeatureView graph={screenGraph as any} onNodeClick={onNodeClick} onEdgeClick={() => {}} />);
        fireEvent.click(screen.getByText('/legacy (deleted)'));
        expect(onNodeClick).toHaveBeenCalled();
        const [, nodeData] = onNodeClick.mock.calls[0];
        expect(nodeData.type).toBe('file');
        expect(nodeData.anchor.filePath).toBe('app/legacy/page.tsx');
    });

    it('does NOT apply the merge to a domain:* graph (keeps the cluster map)', () => {
        const domainGraph = {
            graphId: 'domain:workspace',
            type: 'domain',
            nodes: [{ id: 'n1', type: 'cluster', label: 'auth', meta: { files: [], apisInCluster: [] } }],
            edges: [], anchors: {}, meta: { clusterCount: 1 },
        };
        render(<FeatureView graph={domainGraph as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        expect(screen.queryByTestId('feature-api-list')).toBeNull();
        // the Modules↔Domains toggle still renders on the cluster map header
        expect(screen.getByTestId('cluster-mode-domains')).toBeTruthy();
    });

    // #L2merge Tier-1 — the per-feature comment badge (was on the old cluster card).
    it('shows a per-feature comment badge from commentCounts', () => {
        render(
            <FeatureView
                graph={backendGraph() as any}
                onNodeClick={() => {}}
                onEdgeClick={() => {}}
                commentCounts={{ 'cluster:auth': 3 }}
            />,
        );
        expect(screen.getByLabelText('3 comments on auth')).toBeTruthy();
        expect(screen.getByText('💬3')).toBeTruthy();
    });

    // #L2merge Tier-1 — a sub-divided (>15-file) cluster expands into nested sub-modules.
    it('splits a cluster with sub-clusters into nested sub-module sections', () => {
        const graph = {
            graphId: 'feature:service:api',
            type: 'feature',
            nodes: [{
                id: 'cluster:big', type: 'cluster', label: 'big', diff: 'unchanged',
                meta: {
                    files: ['src/core.ts', 'src/util.ts'],
                    subClusters: {
                        'sub:core': { id: 'sub:core', label: 'core', files: ['src/core.ts'] },
                        'sub:util': { id: 'sub:util', label: 'util', files: ['src/util.ts'] },
                    },
                    apisInCluster: [
                        { apiId: 'c1', method: 'GET', route: '/core', handlerName: 'core', filePath: 'src/core.ts' },
                        { apiId: 'u1', method: 'GET', route: '/util', handlerName: 'util', filePath: 'src/util.ts' },
                    ],
                },
            }],
            edges: [], anchors: {}, meta: { clusterCount: 1 },
        };
        render(<FeatureView graph={graph as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        // The top-level feature group plus a nested sub-section per sub-cluster.
        expect(screen.getByText('big')).toBeTruthy();
        expect(screen.getByText('core')).toBeTruthy();
        expect(screen.getByText('util')).toBeTruthy();
        expect(screen.getByText('/core')).toBeTruthy();
        expect(screen.getByText('/util')).toBeTruthy();
    });
});

// BUG-EXP-9 — a Rails-style graph whose feature clusters are generic framework
// directories (app/db/migrate) rather than domain names. Structural clustering
// degenerated; the Domains view recovers business grouping, so a hint is shown.
function degenerateGraph() {
    return {
        graphId: 'feature:service:main',
        type: 'feature',
        nodes: [
            { id: 'cluster:app', type: 'cluster', label: 'app', diff: 'unchanged',
              meta: { files: ['app/controllers/articles_controller.rb'], domainPhrase: 'Publish content',
                apisInCluster: [{ apiId: 'r1', method: 'GET', route: '/articles', handlerName: 'index', filePath: 'app/controllers/articles_controller.rb' }] } },
            { id: 'cluster:db', type: 'cluster', label: 'db', diff: 'unchanged',
              meta: { files: ['db/seeds.rb'], domainPhrase: 'Other',
                apisInCluster: [{ apiId: 'r2', method: 'DB_SEED', route: '/seed', handlerName: 'seed', filePath: 'db/seeds.rb' }] } },
            { id: 'cluster:migrate', type: 'cluster', label: 'migrate', diff: 'unchanged',
              meta: { files: ['db/migrate/001.rb'], domainPhrase: 'Other',
                apisInCluster: [{ apiId: 'r3', method: 'DB_MIGRATION', route: '/m', handlerName: 'M', filePath: 'db/migrate/001.rb' }] } },
        ],
        edges: [], anchors: {}, meta: {},
    };
}

describe('FeatureApiListView — degenerate-clustering hint (BUG-EXP-9)', () => {
    it('shows a "switch to Domains" hint when clusters are generic framework dirs (app/db/migrate)', () => {
        render(<FeatureView graph={degenerateGraph() as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        expect(screen.getByTestId('degenerate-clustering-hint')).toBeTruthy();
    });

    it('does NOT show the hint for real feature-named clusters (auth/util)', () => {
        render(<FeatureView graph={backendGraph() as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        expect(screen.queryByTestId('degenerate-clustering-hint')).toBeNull();
    });
});
