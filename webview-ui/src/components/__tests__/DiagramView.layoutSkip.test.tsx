/**
 * DiagramView.layoutSkip.test.tsx
 *
 * PERF regression (2026-07-20, "slow L1→L2a open"): DiagramView ran the
 * synchronous Dagre layout (`graphToReactFlow` → `getLayoutedElements`) on the
 * `useMemo` at the top of the component for EVERY mode — including modes that
 * delegate to a dedicated non-React-Flow renderer (feature/domain →
 * FeatureView, api-list → ApiListPanel, health → HealthDashboard) and therefore
 * never read the layouted result. On polar's 119-node `feature:server` graph
 * that wasted ~630ms per L2a open — the whole client-side delay between the
 * graph arriving and the list painting.
 *
 * These tests lock in that the layout is SKIPPED for delegated modes and still
 * RUNS for real React-Flow modes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// Spy on the Dagre layout entry point. `vi.hoisted` so the spy exists before
// the hoisted `vi.mock` factory runs.
const { getLayoutedElements } = vi.hoisted(() => ({
    getLayoutedElements: vi.fn(() => ({ nodes: [], edges: [] })),
}));
vi.mock('../../layout', () => ({ getLayoutedElements }));

// Stub every heavy child so rendering DiagramView stays cheap + deterministic.
vi.mock('reactflow', () => {
    const Passthrough = ({ children }: any) => <div data-testid="reactflow">{children}</div>;
    return {
        __esModule: true,
        default: Passthrough,
        Background: () => null,
        Controls: () => null,
        MarkerType: { ArrowClosed: 'arrowclosed' },
        BackgroundVariant: { Dots: 'dots' },
        useNodesState: (init: any) => [init, vi.fn(), vi.fn()],
        useEdgesState: (init: any) => [init, vi.fn(), vi.fn()],
    };
});
vi.mock('../FeatureView', () => ({ __esModule: true, default: () => <div data-testid="feature-view" /> }));
vi.mock('../MicroserviceView', () => ({ __esModule: true, default: () => <div />, ServiceNodeFallback: () => null }));
vi.mock('../MapView', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('../SequenceView', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('../ApiListPanel', () => ({ __esModule: true, default: () => <div data-testid="api-list" /> }));
vi.mock('../HealthDashboard', () => ({ __esModule: true, default: () => <div data-testid="health" /> }));
vi.mock('../ImpactPanel', () => ({ __esModule: true, default: () => null }));
vi.mock('../ForceMeasureNodes', () => ({ ForceMeasureNodes: () => null }));

import DiagramView, { DELEGATED_LAYOUT_MODES } from '../DiagramView';

const graph = {
    graphId: 'feature:server',
    type: 'feature',
    nodes: Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, label: `N${i}`, meta: {} })),
    edges: Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, source: `n${i % 20}`, target: `n${(i + 1) % 20}` })),
    anchors: {},
    meta: {},
};

const baseProps = {
    graph,
    onNodeClick: vi.fn(),
    onEdgeClick: vi.fn(),
};

describe('DiagramView — Dagre layout is skipped for delegated modes (perf)', () => {
    beforeEach(() => getLayoutedElements.mockClear());

    it('does NOT run the layout for feature mode (renders FeatureView)', () => {
        render(<DiagramView {...(baseProps as any)} mode="feature" />);
        expect(getLayoutedElements).not.toHaveBeenCalled();
    });

    it('does NOT run the layout for health / api-list modes', () => {
        render(<DiagramView {...(baseProps as any)} mode="health" />);
        render(<DiagramView {...(baseProps as any)} mode="api-list" />);
        expect(getLayoutedElements).not.toHaveBeenCalled();
    });

    it('DOES run the layout for a real React-Flow mode (file)', () => {
        render(<DiagramView {...(baseProps as any)} mode="file" />);
        expect(getLayoutedElements).toHaveBeenCalled();
    });

    it('every delegated mode is a mode DiagramView renders without React Flow', () => {
        expect(DELEGATED_LAYOUT_MODES.has('feature')).toBe(true);
        expect(DELEGATED_LAYOUT_MODES.has('domain')).toBe(true);
        expect(DELEGATED_LAYOUT_MODES.has('health')).toBe(true);
        expect(DELEGATED_LAYOUT_MODES.has('api-list')).toBe(true);
        expect(DELEGATED_LAYOUT_MODES.has('screen-content')).toBe(true);
        // React-Flow modes must NOT be in the skip set.
        expect(DELEGATED_LAYOUT_MODES.has('file')).toBe(false);
        expect(DELEGATED_LAYOUT_MODES.has('sequence')).toBe(false);
        expect(DELEGATED_LAYOUT_MODES.has('microservice')).toBe(false);
        expect(DELEGATED_LAYOUT_MODES.has('map')).toBe(false);
    });
});
