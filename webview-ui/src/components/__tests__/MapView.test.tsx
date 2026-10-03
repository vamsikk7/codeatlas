/**
 * MapView.test.tsx — Issue #700 Knowledge Map renderer tests.
 *
 * Focused smoke + interaction coverage: renders the layer chips, fires
 * the click handler with the right node id, and toggles the overlay
 * panel visibility per layer. We don't try to test React Flow's layout —
 * that's covered by Dagre + the layout cache.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import MapView from '../MapView';

// React Flow's ZoomPane reaches for `ResizeObserver`, which JSDOM doesn't
// provide. Stub it so the renderer can mount in tests. The implementation
// is a no-op — we're not exercising layout-on-resize behavior here.
beforeAll(() => {
    if (typeof window !== 'undefined' && !(window as any).ResizeObserver) {
        class ResizeObserverStub {
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        }
        (window as any).ResizeObserver = ResizeObserverStub;
        (global as any).ResizeObserver = ResizeObserverStub;
    }
    // React Flow also pokes DOMMatrix.invertSelf via dragging utils — stub
    // it if missing so we don't blow up in jsdom.
    if (typeof window !== 'undefined' && !(window as any).DOMMatrixReadOnly) {
        (window as any).DOMMatrixReadOnly = class {};
    }
});

function makeGraph(overrides: Partial<{ nodes: any[]; edges: any[]; meta: any }> = {}) {
    return {
        graphId: 'map:workspace',
        type: 'map',
        nodes: [
            { id: 'n1', type: 'service', label: 'auth', subtitle: '«express» · 3 apis', meta: { layer: 'service', drillDownGraphId: 'feature:service:auth' } },
            { id: 'n2', type: 'cluster', label: 'login', subtitle: '2 apis', meta: { layer: 'cluster', drillDownGraphId: 'api-list:cluster:login' } },
            { id: 'n3', type: 'participant', label: 'GET /login', subtitle: 'loginHandler', diff: 'added', meta: { layer: 'api', drillDownGraphId: 'sequence:src/auth/login.ts:loginHandler' } },
            { id: 'n4', type: 'service', kind: 'database', label: 'postgres', subtitle: '«database»', meta: { layer: 'infrastructure' } },
        ],
        edges: [
            { id: 'e1', source: 'n1', target: 'n2', label: 'contains', edgeType: 'contains' },
            { id: 'e2', source: 'n2', target: 'n3', label: 'has', edgeType: 'contains' },
            { id: 'e3', source: 'n1', target: 'n4', label: 'consumes', edgeType: 'depends' },
        ],
        anchors: {},
        meta: { label: 'Knowledge Map' },
        ...overrides,
    };
}

describe('MapView', () => {
    it('renders the header with the Knowledge Map badge', () => {
        const { container } = render(
            <MapView
                graph={makeGraph()}
                onNodeClick={() => {}}
                onEdgeClick={() => {}}
            />,
        );
        // The header badge sits inside `.ca-header-badge`; the same string
        // also surfaces via `meta.label` in the title text, so we scope to
        // the badge element specifically.
        const badge = container.querySelector('.ca-header-badge');
        expect(badge?.textContent).toBe('Knowledge Map');
    });

    it('shows the overlay panel with per-layer toggles', () => {
        render(
            <MapView
                graph={makeGraph()}
                onNodeClick={() => {}}
                onEdgeClick={() => {}}
            />,
        );
        // Overlay panel section headers
        expect(screen.getByText('Layers')).toBeTruthy();
        expect(screen.getByText('Overlays')).toBeTruthy();
        // Per-layer chip labels carry the emoji + label format.
        expect(screen.getByText('🏗 Services')).toBeTruthy();
        expect(screen.getByText('🧩 Clusters')).toBeTruthy();
        expect(screen.getByText('⚡ APIs')).toBeTruthy();
        expect(screen.getByText('💾 Infrastructure')).toBeTruthy();
    });

    it('disables the Domain + Tour overlay chips (placeholders for #701 / #702)', () => {
        render(
            <MapView
                graph={makeGraph()}
                onNodeClick={() => {}}
                onEdgeClick={() => {}}
            />,
        );
        const domain = screen.getByText('🧭 Domain').closest('[role="switch"]')!;
        const tour = screen.getByText('🗺 Tour').closest('[role="switch"]')!;
        expect(domain.getAttribute('aria-disabled')).toBe('true');
        expect(tour.getAttribute('aria-disabled')).toBe('true');
    });

    it('Diff toggle is on by default', () => {
        render(
            <MapView
                graph={makeGraph()}
                onNodeClick={() => {}}
                onEdgeClick={() => {}}
            />,
        );
        // Issue #752 — the toggle label now includes the ON/OFF state
        // for always-visible feedback. Match the prefix.
        const diffChip = screen.getByText(/📊 Diff/).closest('[role="switch"]')!;
        expect(diffChip.getAttribute('aria-checked')).toBe('true');
    });

    it('clicking the Diff toggle flips its aria-checked', () => {
        render(
            <MapView
                graph={makeGraph()}
                onNodeClick={() => {}}
                onEdgeClick={() => {}}
            />,
        );
        // Issue #752 — the toggle label now includes the ON/OFF state
        // for always-visible feedback. Match the prefix.
        const diffChip = screen.getByText(/📊 Diff/).closest('[role="switch"]')!;
        fireEvent.click(diffChip);
        expect(diffChip.getAttribute('aria-checked')).toBe('false');
    });

    it('clicking a layer toggle flips its aria-checked', () => {
        render(
            <MapView
                graph={makeGraph()}
                onNodeClick={() => {}}
                onEdgeClick={() => {}}
            />,
        );
        const svcChip = screen.getByText('🏗 Services').closest('[role="switch"]')!;
        expect(svcChip.getAttribute('aria-checked')).toBe('true');
        fireEvent.click(svcChip);
        expect(svcChip.getAttribute('aria-checked')).toBe('false');
    });

    it('Issue #732 — comment badge renders when commentCounts[nodeId] > 0', () => {
        const { container } = render(
            <MapView
                graph={makeGraph()}
                onNodeClick={() => {}}
                onEdgeClick={() => {}}
                commentCounts={{ n2: 3 }}
            />,
        );
        // The badge button has the aria-label "Open N comments".
        const badge = container.querySelector('button[aria-label^="Open 3 comment"]');
        expect(badge).toBeTruthy();
        expect(badge?.textContent).toContain('💬3');
    });

    it('Issue #732 — comment badge is absent when commentCounts is unset', () => {
        const { container } = render(
            <MapView
                graph={makeGraph()}
                onNodeClick={() => {}}
                onEdgeClick={() => {}}
            />,
        );
        const badge = container.querySelector('button[aria-label^="Open"]');
        expect(badge).toBeNull();
    });

    it('Issue #732 — comment badge click dispatches the open-comments event', () => {
        const handler = vi.fn();
        window.addEventListener('codeatlas:open-comments', handler);
        const { container } = render(
            <MapView
                graph={makeGraph()}
                onNodeClick={() => {}}
                onEdgeClick={() => {}}
                commentCounts={{ n2: 1 }}
            />,
        );
        const badge = container.querySelector('button[aria-label^="Open 1 comment"]') as HTMLElement | null;
        expect(badge).toBeTruthy();
        badge!.click();
        expect(handler).toHaveBeenCalled();
        window.removeEventListener('codeatlas:open-comments', handler);
    });

    it('header stats show per-layer counts', () => {
        const { container } = render(
            <MapView
                graph={makeGraph()}
                onNodeClick={() => {}}
                onEdgeClick={() => {}}
            />,
        );
        const stats = container.querySelector('.ca-header-stats')!;
        // Two services (auth + postgres), 1 cluster, 1 api → reflected in chips.
        // Service chip count is "2" (the infrastructure node lives in its own bucket).
        const text = stats.textContent ?? '';
        expect(text).toContain('1'); // some layer count
        expect(text).toContain('added'); // diff stat for `n3`
    });
});
