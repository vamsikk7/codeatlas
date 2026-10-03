/**
 * DiagramView edges regression — 2026-06-09
 *
 * Live verification on `v7.2.0.77` against `node-express-realworld-example-app`
 * and `serverless-examples` showed React Flow rendering 0 edges across every
 * mode (L1 microservice, L2 Map, L4 file, L5 flow) even though the DB had
 * 1-48 edges per graph and a fiber walk confirmed the props reached the
 * `<ReactFlow>` component. The `<g.react-flow__edges>` container was present
 * with a `<defs>` child but the inner `<g>` group was empty — RF's internal
 * EdgeRenderer iterated over zero edges.
 *
 * This file mounts each of the four canvases against a minimal graph and
 * asserts the rendered DOM contains the right number of `.react-flow__edge`
 * elements. If the suite goes green in jsdom but the live browser still
 * shows zero edges, the bug is browser-specific (viewport / fitView /
 * measurement timing). If it goes red here, the bug is in the data flow
 * (useNodesState / useEdgesState desync with the useEffect setNodes/setEdges
 * pattern).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render } from '@testing-library/react';
import DiagramView from './DiagramView';

// jsdom doesn't paint, so React Flow's measurement step needs a size. Stub
// `getBoundingClientRect` so the EdgeRenderer's source/target lookups don't
// silently bail.
beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            x: 0, y: 0, width: 200, height: 60,
            top: 0, right: 200, bottom: 60, left: 0,
            toJSON: () => ({}),
        }),
    });
    // RF reads `offsetWidth`/`offsetHeight` (not getBoundingClientRect) in
    // `getDimensions`. In jsdom both default to 0, which causes
    // `updateNodeDimensions` to skip every node — handleBounds never get
    // registered and EdgeRenderer drops every edge. Stubbing both keeps
    // the EdgeRenderer's validity check happy.
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true, get() { return 200; },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true, get() { return 60; },
    });
    // jsdom doesn't implement SVGGraphicsElement.getBBox — RF v11's
    // EdgeText component calls it to size the label background rect.
    const SVG = (window as any).SVGElement;
    if (SVG && !SVG.prototype.getBBox) {
        SVG.prototype.getBBox = function () {
            return { x: 0, y: 0, width: 40, height: 14 };
        };
    }
    // ResizeObserver: jsdom has none. RF instantiates one per
    // NodeRenderer. We need observe() to synchronously call the callback
    // with the observed entry so handleBounds register on mount.
    (global as any).ResizeObserver = class {
        constructor(private cb: (entries: any[]) => void) {}
        observe(el: Element): void {
            // Fire the callback once, synchronously, mimicking the
            // browser firing on first measurement.
            try { this.cb([{ target: el, contentRect: { width: 200, height: 60 } } as any]); }
            catch { /* swallow */ }
        }
        unobserve(): void { /* noop */ }
        disconnect(): void { /* noop */ }
    };
    // DOMMatrixReadOnly is required by RF for viewport transform math.
    if (!(global as any).DOMMatrixReadOnly) {
        (global as any).DOMMatrixReadOnly = class {
            constructor(public values: string | number[] = '') {}
            m22 = 1; m41 = 0; m42 = 0;
        };
    }
});

function microserviceGraph() {
    return {
        graphId: 'microservice:workspace',
        type: 'microservice',
        nodes: [
            { id: 'service_1', type: 'service', label: 'main', subtitle: '«express» 26 routes', meta: { serviceId: 'service:main', technology: 'express' } },
            { id: 'infra_2', type: 'service', label: 'Postgres', subtitle: '«database»', meta: { external: true, infra: true, kind: 'database' } },
        ],
        edges: [
            { id: 'edge_3', source: 'service_1', target: 'infra_2', label: 'stores', edgeType: 'inter-service', diff: 'unchanged' as const },
        ],
        anchors: {},
        meta: {},
    };
}

function fileGraph() {
    return {
        graphId: 'file:src/server.ts',
        type: 'file',
        nodes: [
            { id: 'file_imp_1', type: 'import', label: 'express', meta: {} },
            { id: 'file_fn_2',  type: 'function', label: 'createApp', meta: {} },
            { id: 'file_fn_3',  type: 'function', label: 'registerRoutes', meta: {} },
        ],
        edges: [
            { id: 'edge_1', source: 'file_imp_1', target: 'file_fn_2', label: 'used-by', diff: 'unchanged' as const },
            { id: 'edge_2', source: 'file_fn_2',  target: 'file_fn_3', label: 'calls',   diff: 'unchanged' as const },
        ],
        anchors: {},
        meta: {},
    };
}

function flowGraph() {
    return {
        graphId: 'flow:src/server.ts:createApp',
        type: 'flow',
        nodes: [
            { id: 'flow_1', type: 'start',     label: 'createApp', meta: {} },
            { id: 'flow_2', type: 'statement', label: 'app = express()', meta: {} },
            { id: 'flow_3', type: 'end',       label: 'return app', meta: {} },
        ],
        edges: [
            { id: 'edge_a', source: 'flow_1', target: 'flow_2', diff: 'unchanged' as const },
            { id: 'edge_b', source: 'flow_2', target: 'flow_3', diff: 'unchanged' as const },
        ],
        anchors: {},
        meta: {},
    };
}

const noop = () => { /* noop */ };

describe('DiagramView — React Flow renders the edges prop in the DOM', () => {
    it('microservice mode: 1 edge in graph → 1 react-flow__edge in DOM', () => {
        const { container } = render(
            <DiagramView
                graph={microserviceGraph() as any}
                mode="microservice"
                onNodeClick={noop}
                onEdgeClick={noop}
            />,
        );
        expect(container.querySelectorAll('.react-flow__node').length).toBeGreaterThanOrEqual(2);
        const edges = container.querySelectorAll('.react-flow__edge');
        expect(edges.length, 'microservice L1 should render 1 edge').toBeGreaterThanOrEqual(1);
    });

    it('file mode: 2 edges in graph → 2 react-flow__edges in DOM', () => {
        const { container } = render(
            <DiagramView
                graph={fileGraph() as any}
                mode="file"
                onNodeClick={noop}
                onEdgeClick={noop}
            />,
        );
        expect(container.querySelectorAll('.react-flow__node').length).toBeGreaterThanOrEqual(3);
        const edges = container.querySelectorAll('.react-flow__edge');
        expect(edges.length, 'file L4 should render 2 edges').toBeGreaterThanOrEqual(2);
    });

    it('flow mode: 2 edges in graph → 2 react-flow__edges in DOM', () => {
        const { container } = render(
            <DiagramView
                graph={flowGraph() as any}
                mode="flow"
                onNodeClick={noop}
                onEdgeClick={noop}
            />,
        );
        expect(container.querySelectorAll('.react-flow__node').length).toBeGreaterThanOrEqual(3);
        const edges = container.querySelectorAll('.react-flow__edge');
        expect(edges.length, 'flow L5 should render 2 edges').toBeGreaterThanOrEqual(2);
    });

    // BUG-EXPLORE-3 (2026-07-15): navigating file↔flow keeps the same
    // DiagramView instance mounted and only remounts `<ReactFlow key={graphId}>`.
    // The edges of the NEW graph must still render after that keyed remount.
    // (jsdom's synchronous ResizeObserver stub can't reproduce the real-browser
    // async race this guards — the live verification does — but this pins the
    // controlled-props + ForceMeasureNodes contract on the remount path so a
    // regression that drops edges on graph-change fails here.)
    it('graph change (file → flow) still renders the new graph edges after keyed remount', () => {
        const { container, rerender } = render(
            <DiagramView graph={fileGraph() as any} mode="file" onNodeClick={noop} onEdgeClick={noop} />,
        );
        expect(container.querySelectorAll('.react-flow__edge').length).toBeGreaterThanOrEqual(2);
        // Same component instance, different graphId → RF key remounts.
        rerender(
            <DiagramView graph={flowGraph() as any} mode="flow" onNodeClick={noop} onEdgeClick={noop} />,
        );
        expect(container.querySelectorAll('.react-flow__node').length).toBeGreaterThanOrEqual(3);
        expect(
            container.querySelectorAll('.react-flow__edge').length,
            'flow edges should render after navigating from the file graph',
        ).toBeGreaterThanOrEqual(2);
    });
});

// 2026-06-09 — regression test for the `defaultNodes`/`defaultEdges`
// trap that v85 left behind. `defaultNodes` only seeds the RF zustand
// store on FIRST mount; subsequent renders with new derived data
// (highlightedNodes, commentCounts, hover state, search
// filter) silently update the React prop but RF ignores them. The
// symptom: comments / NL highlights / hover-to-dim / search filtering
// all stop working post-mount. The fix is controlled props
// (`nodes={...}`/`edges={...}`) which RF reads on every render.
describe('DiagramView — derived state changes propagate to RF render (controlled props contract)', () => {
    it('adding a comment count after mount applies the comment badge to the node DOM', async () => {
        const baseGraph = {
            graphId: 'file:src/server.ts',
            type: 'file',
            nodes: [
                { id: 'n_a', type: 'function', label: 'fnA', meta: {} },
                { id: 'n_b', type: 'function', label: 'fnB', meta: {} },
            ],
            edges: [{ id: 'e_1', source: 'n_a', target: 'n_b', label: '', diff: 'unchanged' as const }],
            anchors: {},
            meta: {},
        };
        // Initial render: no comments.
        const { container, rerender } = render(
            <DiagramView
                graph={baseGraph as any}
                mode="file"
                onNodeClick={noop}
                onEdgeClick={noop}
            />,
        );
        // Re-render with a comment count on node n_a. Under the v85
        // `defaultNodes` regression this is silently dropped — the
        // node DOM still shows no commentCount in its data prop.
        rerender(
            <DiagramView
                graph={baseGraph as any}
                mode="file"
                onNodeClick={noop}
                onEdgeClick={noop}
                commentCounts={{ n_a: 3 }}
            />,
        );
        // AtlasNode stamps `data-comment-count` onto the node element
        // when commentCount > 0; we don't rely on text matching the
        // badge UI here (component owns the render). The point is the
        // DERIVED-STATE prop must reach RF's internal `data` payload.
        const targetNode = container.querySelector('.react-flow__node[data-id="n_a"]');
        expect(targetNode, 'node n_a should be in the DOM').toBeTruthy();
        // AtlasNode renders the badge as `💬{count}` (see AtlasNode.tsx:123).
        // The badge only appears when `data.meta.commentCount > 0`, so its
        // presence is a clean signal that the derived-state prop reached the
        // RF internal store and the per-node `data` was updated.
        const text = targetNode!.textContent ?? '';
        expect(text.includes('💬3'), 'commentCount 3 should reach node render after rerender (badge "💬3" expected, got: ' + text.slice(0, 200) + ')').toBe(true);
    });
});
