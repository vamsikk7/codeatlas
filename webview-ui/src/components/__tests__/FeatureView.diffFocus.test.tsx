/**
 * FeatureView.diffFocus.test.tsx — the L2 api-list change-highlighting
 * (diff-focus) features on the backend feature-grouped list: the Changed /
 * +/−/~ filter chips, filtering out unchanged rows + features, changed-first
 * ordering, and the jump stepper. (The scrollbar minimap needs real layout so
 * it's covered in the browser pass, not jsdom.)
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import FeatureView from '../FeatureView';

beforeAll(() => {
    if (typeof window !== 'undefined' && !(window as any).ResizeObserver) {
        class R { observe() {} unobserve() {} disconnect() {} }
        (window as any).ResizeObserver = R;
        (global as any).ResizeObserver = R;
    }
});
beforeEach(() => { (window as any).vscodeApi = { postMessage: vi.fn() }; });

function api(apiId: string, method: string, route: string, diff?: string) {
    return { apiId, method, route, handlerName: apiId, filePath: 'src/x.ts', diff };
}

/** orders(modified): +POST create, −DELETE remove, GET list unchanged.
 *  auth(unchanged): POST login unchanged, ~GET me modified.
 *  util(unchanged, no apis) — internal module. */
function changedGraph() {
    return {
        graphId: 'feature:service:api', type: 'feature',
        nodes: [
            { id: 'cluster:orders', type: 'cluster', label: 'orders', diff: 'modified', meta: { files: ['src/orders.ts'], apisInCluster: [
                api('o1', 'GET', '/orders/list', 'unchanged'),
                api('o2', 'POST', '/orders/create', 'added'),
                api('o3', 'DELETE', '/orders/remove', 'deleted'),
            ] } },
            { id: 'cluster:auth', type: 'cluster', label: 'auth', diff: 'unchanged', meta: { files: ['src/auth.ts'], apisInCluster: [
                api('a1', 'POST', '/auth/login', 'unchanged'),
                api('a2', 'GET', '/auth/me', 'modified'),
            ] } },
            { id: 'cluster:util', type: 'cluster', label: 'util', diff: 'unchanged', meta: { files: ['src/util.ts'], apisInCluster: [] } },
        ],
        edges: [], anchors: {}, meta: {},
    };
}

function allUnchangedGraph() {
    const g = changedGraph();
    g.nodes.forEach((n: any) => { n.diff = 'unchanged'; (n.meta.apisInCluster || []).forEach((a: any) => { a.diff = 'unchanged'; }); });
    return g;
}

const renderFV = (graph: any) => render(<FeatureView graph={graph as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);

describe('diff-focus bar visibility (feature #1 gate)', () => {
    it('is shown with correct counts when there are changes', () => {
        renderFV(changedGraph());
        const bar = screen.getByTestId('diff-focus-bar');
        expect(bar).toBeTruthy();
        expect(within(bar).getByText('All 5')).toBeTruthy();       // 5 total apis
        expect(within(bar).getByText(/Changed 3/)).toBeTruthy();   // 1 add + 1 del + 1 mod
        expect(within(bar).getByText('+1')).toBeTruthy();
        expect(within(bar).getByText('−1')).toBeTruthy();
        expect(within(bar).getByText('~1')).toBeTruthy();
    });
    it('is HIDDEN when nothing changed', () => {
        renderFV(allUnchangedGraph());
        expect(screen.queryByTestId('diff-focus-bar')).toBeNull();
    });
});

describe('Changed filter (feature #1)', () => {
    it('clicking "Changed" hides unchanged rows AND unchanged features', () => {
        renderFV(changedGraph());
        // before: an unchanged row is present
        expect(screen.queryByText('/orders/list')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /Changed/ }));
        // changed rows remain
        expect(screen.getByText('/orders/create')).toBeTruthy();
        expect(screen.getByText('/orders/remove')).toBeTruthy();
        expect(screen.getByText('/auth/me')).toBeTruthy();
        // unchanged rows are gone
        expect(screen.queryByText('/orders/list')).toBeNull();
        expect(screen.queryByText('/auth/login')).toBeNull();
        // the fully-unchanged "util" internal module is hidden too
        expect(screen.queryByText('util')).toBeNull();
    });

    it('the "+" chip isolates only added rows', () => {
        renderFV(changedGraph());
        fireEvent.click(screen.getByRole('button', { name: '+1' }));
        expect(screen.getByText('/orders/create')).toBeTruthy();     // the added one
        expect(screen.queryByText('/orders/remove')).toBeNull();     // deleted — filtered out
        expect(screen.queryByText('/auth/me')).toBeNull();           // modified — filtered out
        expect(screen.queryByText('/orders/list')).toBeNull();       // unchanged — filtered out
    });

    it('clicking an active chip again toggles back to All', () => {
        renderFV(changedGraph());
        const changedChip = screen.getByRole('button', { name: /Changed/ });
        fireEvent.click(changedChip);
        expect(screen.queryByText('/orders/list')).toBeNull();
        fireEvent.click(changedChip); // toggle off → All
        expect(screen.getByText('/orders/list')).toBeTruthy();
    });
});

describe('changed-first + auto-expand (feature #2)', () => {
    it('in ALL mode with a diff, a feature whose rows are all unchanged is auto-collapsed', () => {
        const g = changedGraph();
        g.nodes.push({ id: 'cluster:reports', type: 'cluster', label: 'reports', diff: 'unchanged', meta: { files: ['src/reports.ts'], apisInCluster: [
            api('r1', 'GET', '/reports/daily', 'unchanged'),
        ] } } as any);
        renderFV(g);
        // features WITH changes stay expanded → their rows are visible
        expect(screen.getByText('/orders/create')).toBeTruthy();
        expect(screen.getByText('/auth/me')).toBeTruthy();
        // the all-unchanged "reports" feature is collapsed even in All mode:
        // header present, but its row hidden so it doesn't add to the scroll.
        expect(screen.getByText('reports')).toBeTruthy();
        expect(screen.queryByText('/reports/daily')).toBeNull();
    });
});

describe('jump stepper (feature #4)', () => {
    it('renders the ◂ N/M ▸ stepper with the changed-count total', () => {
        renderFV(changedGraph());
        const stepper = screen.getByTestId('diff-jump-stepper');
        expect(stepper).toBeTruthy();
        expect(within(stepper).getByText('1/3')).toBeTruthy(); // 3 changed rows
        expect(within(stepper).getByLabelText('Next change')).toBeTruthy();
        expect(within(stepper).getByLabelText('Previous change')).toBeTruthy();
    });
});

// Search + method filtering (parity with the L2b ApiListPanel). changedGraph()
// has: GET /orders/list, POST /orders/create, DELETE /orders/remove,
// POST /auth/login, GET /auth/me → GET×2, POST×2, DELETE×1.
// BUG-EXPLORE-4: the method-tab bar must adapt to the entry-point KINDS actually
// present (SCREEN / NAV_ROUTE / JOB / MQ_CONSUMER for mobile/backend-job repos),
// not just fixed HTTP verbs — and it must hide entirely when only one kind exists
// (a lone "ALL" tab is useless, e.g. a pure-mobile or pure-worker repo).
function mobileGraph() {
    return {
        graphId: 'feature:workspace', type: 'feature',
        nodes: [
            { id: 'cluster:home', type: 'cluster', label: 'home', diff: 'unchanged', meta: { files: ['a.dart'], apisInCluster: [
                api('s1', 'SCREEN', '/home', 'unchanged'),
                api('s2', 'SCREEN', '/profile', 'unchanged'),
                api('n1', 'NAV_ROUTE', '/settings', 'unchanged'),
            ] } },
        ],
        edges: [], anchors: {}, meta: {},
    };
}
function singleKindGraph() {
    return {
        graphId: 'feature:service:worker', type: 'feature',
        nodes: [
            { id: 'cluster:jobs', type: 'cluster', label: 'jobs', diff: 'unchanged', meta: { files: ['w.py'], apisInCluster: [
                api('j1', 'MQ_CONSUMER', '/topic-a', 'unchanged'),
                api('j2', 'MQ_CONSUMER', '/topic-b', 'unchanged'),
            ] } },
        ],
        edges: [], anchors: {}, meta: {},
    };
}

describe('method tabs — dynamic entry-point kinds (BUG-EXPLORE-4)', () => {
    it('shows KIND tabs (SCREEN / NAV) for a non-HTTP mobile list, not just ALL', () => {
        renderFV(mobileGraph());
        const tabs = [...document.querySelectorAll('.ca-method-tab')].map((t) => t.textContent);
        expect(tabs.some((t) => /^ALL/.test(t ?? ''))).toBe(true);
        expect(tabs.some((t) => /SCREEN/.test(t ?? ''))).toBe(true);   // kind tab
        expect(tabs.some((t) => /NAV/.test(t ?? ''))).toBe(true);      // kind tab
    });
    it('clicking a KIND tab filters to that kind', () => {
        renderFV(mobileGraph());
        fireEvent.click([...document.querySelectorAll('.ca-method-tab')].find((t) => /SCREEN/.test(t.textContent ?? ''))!);
        expect(screen.getByText('/home')).toBeTruthy();      // SCREEN
        expect(screen.getByText('/profile')).toBeTruthy();   // SCREEN
        expect(screen.queryByText('/settings')).toBeNull();  // NAV — filtered out
    });
    it('HIDES the method-tab bar when only ONE kind is present (lone ALL is useless)', () => {
        renderFV(singleKindGraph());
        expect(document.querySelectorAll('.ca-method-tab').length).toBe(0);
    });
});

describe('search + method filtering (L2b parity)', () => {
    it('renders a search box and method tabs with counts', () => {
        renderFV(changedGraph());
        expect(screen.getByTestId('feature-api-search')).toBeTruthy();
        expect(screen.getByRole('button', { name: /^GET/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /^POST/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /^DELETE/ })).toBeTruthy();
        // PUT / PATCH tabs are suppressed when their count is 0.
        expect(screen.queryByRole('button', { name: /^PUT/ })).toBeNull();
    });

    it('a method tab filters rows to just that method', () => {
        renderFV(changedGraph());
        fireEvent.click(screen.getByRole('button', { name: /^POST/ }));
        expect(screen.getByText('/orders/create')).toBeTruthy(); // POST
        expect(screen.getByText('/auth/login')).toBeTruthy();    // POST
        expect(screen.queryByText('/orders/list')).toBeNull();   // GET — filtered
        expect(screen.queryByText('/orders/remove')).toBeNull(); // DELETE — filtered
        expect(screen.queryByText('/auth/me')).toBeNull();       // GET — filtered
    });

    it('the search box filters rows by route text (debounced)', async () => {
        renderFV(changedGraph());
        fireEvent.change(screen.getByTestId('feature-api-search'), { target: { value: 'auth' } });
        await waitFor(() => expect(screen.queryByText('/orders/list')).toBeNull());
        expect(screen.getByText('/auth/login')).toBeTruthy();
        expect(screen.getByText('/auth/me')).toBeTruthy();
        expect(screen.queryByText('/orders/create')).toBeNull();
    });

    it('shows a no-match hint when nothing matches', async () => {
        renderFV(changedGraph());
        fireEvent.change(screen.getByTestId('feature-api-search'), { target: { value: 'zzzznope' } });
        await screen.findByTestId('feature-api-no-match');
        expect(screen.queryByText('/orders/create')).toBeNull();
    });

    it('composes method + change filter: POST + Changed shows only the added POST', () => {
        renderFV(changedGraph());
        fireEvent.click(screen.getByRole('button', { name: /^POST/ }));   // POST only
        fireEvent.click(screen.getByRole('button', { name: /Changed/ })); // + changed only
        expect(screen.getByText('/orders/create')).toBeTruthy();  // POST + added ✓
        expect(screen.queryByText('/auth/login')).toBeNull();     // POST but unchanged ✗
        expect(screen.queryByText('/orders/remove')).toBeNull();  // changed but DELETE ✗
    });
});
