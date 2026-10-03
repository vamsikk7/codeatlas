/**
 * FeatureView.toggle.test.tsx — the L2a view toggle: List · Entry Points · Domains.
 *
 * List↔Entry Points is a client-side render swap over the same `feature:*` graph
 * (localStorage `codeatlas.featureView.render` + a `ca:featureRender` event the
 * FeatureView dispatcher listens for). Domains switches the graph via
 * `openDomainDiagram`; coming back from Domains re-fetches via `openFeatureDiagram`.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import FeatureView from '../FeatureView';

beforeAll(() => {
    if (typeof window !== 'undefined' && !(window as any).ResizeObserver) {
        class R { observe() {} unobserve() {} disconnect() {} }
        (window as any).ResizeObserver = R;
        (global as any).ResizeObserver = R;
    }
});

function mockStorage(initial: Record<string, string> = {}) {
    const store = { ...initial };
    const setItem = vi.fn((k: string, v: string) => { store[k] = v; });
    Object.defineProperty(window, 'localStorage', {
        value: { setItem, getItem: (k: string) => store[k] ?? null, removeItem: (k: string) => { delete store[k]; } },
        configurable: true,
    });
    return setItem;
}

function makeGraph(graphId: string) {
    return {
        graphId,
        type: graphId.startsWith('domain:') ? 'domain' : 'feature',
        nodes: [{ id: 'n1', type: 'cluster', label: 'auth', meta: { files: [], apisInCluster: [] } }],
        edges: [], anchors: {},
        meta: { clusterCount: 1 },
    };
}

describe('FeatureView view toggle (List · Entry Points · Domains)', () => {
    beforeEach(() => {
        (window as any).vscodeApi = { postMessage: vi.fn() };
        mockStorage();
    });

    it('renders all three options + marks "List" active for a feature:* graph (default render)', () => {
        render(<FeatureView graph={makeGraph('feature:workspace') as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        expect(screen.getByTestId('cluster-mode-list').getAttribute('aria-checked')).toBe('true');
        expect(screen.getByTestId('cluster-mode-entrypoints').getAttribute('aria-checked')).toBe('false');
        expect(screen.getByTestId('cluster-mode-domains').getAttribute('aria-checked')).toBe('false');
    });

    it('marks "Entry Points" active for a feature:* graph when render=map', () => {
        mockStorage({ 'codeatlas.featureView.render': 'map' });
        render(<FeatureView graph={makeGraph('feature:workspace') as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        // render=map → the cluster map (Entry Points) is shown; its toggle marks Entry Points.
        expect(screen.getByTestId('cluster-mode-entrypoints').getAttribute('aria-checked')).toBe('true');
        expect(screen.getByTestId('cluster-mode-list').getAttribute('aria-checked')).toBe('false');
    });

    it('marks "Domains" active for a domain:* graph', () => {
        render(<FeatureView graph={makeGraph('domain:workspace') as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        expect(screen.getByTestId('cluster-mode-domains').getAttribute('aria-checked')).toBe('true');
        expect(screen.getByTestId('cluster-mode-list').getAttribute('aria-checked')).toBe('false');
    });

    it('clicking "Entry Points" flips the render mode via localStorage + a ca:featureRender event', () => {
        const setItem = mockStorage();
        const events: any[] = [];
        const handler = (e: Event) => events.push((e as CustomEvent).detail);
        window.addEventListener('ca:featureRender', handler);
        render(<FeatureView graph={makeGraph('feature:workspace') as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        fireEvent.click(screen.getByTestId('cluster-mode-entrypoints'));
        window.removeEventListener('ca:featureRender', handler);
        expect(setItem).toHaveBeenCalledWith('codeatlas.featureView.render', 'map');
        expect(events).toContainEqual({ mode: 'map' });
    });

    it('clicking "Domains" from List posts openDomainDiagram', () => {
        const postMessage = vi.fn();
        (window as any).vscodeApi = { postMessage };
        render(<FeatureView graph={makeGraph('feature:workspace') as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        fireEvent.click(screen.getByTestId('cluster-mode-domains'));
        expect(postMessage).toHaveBeenCalledWith({ type: 'openDomainDiagram' });
    });

    it('clicking "List" from Domains re-fetches the feature graph', () => {
        const postMessage = vi.fn();
        (window as any).vscodeApi = { postMessage };
        render(<FeatureView graph={makeGraph('domain:workspace') as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        fireEvent.click(screen.getByTestId('cluster-mode-list'));
        expect(postMessage).toHaveBeenCalledWith({ type: 'openFeatureDiagram', serviceId: '' });
    });

    it('clicking the already-active option is a no-op', () => {
        const postMessage = vi.fn();
        (window as any).vscodeApi = { postMessage };
        render(<FeatureView graph={makeGraph('feature:workspace') as any} onNodeClick={() => {}} onEdgeClick={() => {}} />);
        fireEvent.click(screen.getByTestId('cluster-mode-list')); // already List
        expect(postMessage).not.toHaveBeenCalled();
    });
});
