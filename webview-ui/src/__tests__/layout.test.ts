import { describe, it, expect } from 'vitest';
import { getLayoutedElements, getLayeredMapLayout } from '../layout';
import type { Node, Edge } from 'reactflow';

function makeNodes(ids: string[]): Node[] {
    return ids.map(id => ({ id, data: {}, position: { x: 0, y: 0 } }));
}

function makeEdges(pairs: [string, string][]): Edge[] {
    return pairs.map(([s, t], i) => ({ id: `e${i}`, source: s, target: t }));
}

describe('getLayoutedElements', () => {
    it('returns positioned nodes for a simple graph', () => {
        const nodes = makeNodes(['a', 'b']);
        const edges = makeEdges([['a', 'b']]);
        const result = getLayoutedElements(nodes, edges, 'LR');
        expect(result.nodes).toHaveLength(2);
        expect(result.nodes[0].position.x).toBeDefined();
        expect(result.nodes[0].position.y).toBeDefined();
    });

    it('handles empty graph without crashing', () => {
        const result = getLayoutedElements([], [], 'TB');
        expect(result.nodes).toHaveLength(0);
        expect(result.edges).toHaveLength(0);
    });

    it('handles nodes with no edges', () => {
        const nodes = makeNodes(['a', 'b', 'c']);
        const result = getLayoutedElements(nodes, [], 'LR');
        expect(result.nodes).toHaveLength(3);
    });

    it('reuses cached positions on second call with same topology', () => {
        const nodes = makeNodes(['x', 'y']);
        const edges = makeEdges([['x', 'y']]);
        const r1 = getLayoutedElements(nodes, edges, 'LR');
        const r2 = getLayoutedElements(nodes, edges, 'LR');
        // Result objects are always fresh so data updates propagate to React Flow (#387c)
        expect(r1).not.toBe(r2);
        // But positions are reused from cache
        expect(r2.nodes[0].position).toEqual(r1.nodes[0].position);
        expect(r2.nodes[1].position).toEqual(r1.nodes[1].position);
    });

    it('produces fresh node objects when only node.data changes (#387c regression)', () => {
        const edges = makeEdges([['a', 'b']]);
        const initial: Node[] = [
            { id: 'a', data: { diff: 'unchanged' }, position: { x: 0, y: 0 } },
            { id: 'b', data: { diff: 'unchanged' }, position: { x: 0, y: 0 } },
        ];
        const updated: Node[] = [
            { id: 'a', data: { diff: 'modified' }, position: { x: 0, y: 0 } },
            { id: 'b', data: { diff: 'unchanged' }, position: { x: 0, y: 0 } },
        ];
        const r1 = getLayoutedElements(initial, edges, 'LR');
        const r2 = getLayoutedElements(updated, edges, 'LR');
        // Positions are cached (same topology), but node objects must be fresh
        // and carry the new data so React Flow re-renders with the modified diff.
        expect(r2.nodes[0].data.diff).toBe('modified');
        expect(r2.nodes[0]).not.toBe(r1.nodes[0]);
        expect(r2.nodes[0].position).toEqual(r1.nodes[0].position);
    });

    it('produces different positions when direction changes', () => {
        const nodes = makeNodes(['x', 'y']);
        const edges = makeEdges([['x', 'y']]);
        const lr = getLayoutedElements(nodes, edges, 'LR');
        const tb = getLayoutedElements(nodes, edges, 'TB');
        // In LR, layout flows horizontally; in TB, it flows vertically.
        // The same two-node chain should yield different shapes.
        const lrSpread = Math.abs(lr.nodes[1].position.x - lr.nodes[0].position.x);
        const tbSpread = Math.abs(tb.nodes[1].position.y - tb.nodes[0].position.y);
        expect(lrSpread).toBeGreaterThan(0);
        expect(tbSpread).toBeGreaterThan(0);
    });

    it('recomputes layout when nodes change', () => {
        const edges = makeEdges([['a', 'b']]);
        const r1 = getLayoutedElements(makeNodes(['a', 'b']), edges, 'LR');
        const r2 = getLayoutedElements(makeNodes(['a', 'b', 'c']), edges, 'LR');
        expect(r1.nodes).toHaveLength(2);
        expect(r2.nodes).toHaveLength(3);
    });

    it('sets correct source/target positions for LR direction', () => {
        const nodes = makeNodes(['a', 'b']);
        const edges = makeEdges([['a', 'b']]);
        const result = getLayoutedElements(nodes, edges, 'LR');
        expect(result.nodes[0].sourcePosition).toBe('right');
        expect(result.nodes[0].targetPosition).toBe('left');
    });

    it('sets correct source/target positions for TB direction', () => {
        const nodes = makeNodes(['a', 'b']);
        const edges = makeEdges([['a', 'b']]);
        const result = getLayoutedElements(nodes, edges, 'TB');
        expect(result.nodes[0].sourcePosition).toBe('bottom');
        expect(result.nodes[0].targetPosition).toBe('top');
    });

    // User observation 2026-05-16: rust-actix's L1 system-design view rendered
    // 11 services stacked vertically in a single column because Dagre's
    // rank-based layout has no topological information to distribute
    // disconnected nodes — they all end up on the same rank, stacking along
    // the cross-axis. For a graph with many disconnected nodes (no edges),
    // a grid layout is far more readable than a tall column.
    it('arranges many disconnected nodes in a grid, not a single column (rust-actix L1 fix)', () => {
        // 11 nodes, ZERO edges — the rust-actix L1 scenario.
        const nodes = makeNodes(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11']);
        const result = getLayoutedElements(nodes, [], 'LR');
        expect(result.nodes).toHaveLength(11);
        // The bounding box should be wider than a single node's width and
        // shorter than 11 stacked nodes' height.
        const xs = result.nodes.map(n => n.position.x);
        const ys = result.nodes.map(n => n.position.y);
        const xSpread = Math.max(...xs) - Math.min(...xs);
        const ySpread = Math.max(...ys) - Math.min(...ys);
        // Heuristic: in a grid (≥2 cols × ≥2 rows), both spreads should be
        // non-trivial. Single column would have xSpread = 0.
        expect(
            xSpread,
            `disconnected nodes should spread horizontally (grid layout). Got xSpread=${xSpread}, ySpread=${ySpread}. Positions: ${result.nodes.map(n => `(${n.position.x},${n.position.y})`).join(' ')}`,
        ).toBeGreaterThan(100);
        // Sanity: ySpread should also be non-trivial (we want a grid, not a single row either)
        expect(ySpread).toBeGreaterThan(0);
    });

    it('keeps Dagre layout when there are real edges between nodes', () => {
        // 3 connected nodes — Dagre rank-based layout should still apply.
        const nodes = makeNodes(['a', 'b', 'c']);
        const edges = makeEdges([['a', 'b'], ['b', 'c']]);
        const result = getLayoutedElements(nodes, edges, 'LR');
        // Expect Dagre's horizontal flow: x positions should be strictly
        // increasing along the chain (LR direction).
        const xMap = new Map(result.nodes.map(n => [n.id, n.position.x]));
        expect(xMap.get('b')!).toBeGreaterThan(xMap.get('a')!);
        expect(xMap.get('c')!).toBeGreaterThan(xMap.get('b')!);
    });

    // 2026-06-03 — Phase 2 finding: go-fiber recipes fixture has 85 isolated
    // example projects. The grid layout produces an 85-node bounding box ~2000x
    // 1000 px. ReactFlow's initial-mount `fitView` measures the viewport BEFORE
    // displayNodes is fully populated (useNodesState + useEffect timing), so the
    // viewport zoom is wrong on first paint. The layout-side invariant for this
    // is that the bounding box of N isolated nodes is `approximately square`
    // (10-column grid for 85 nodes → ~10×9 cells) — NOT a tall strip. If this
    // invariant breaks, the fitView padding can't possibly recover.
    it('85 isolated nodes lay out as a roughly-square grid (go-fiber recipes scenario)', () => {
        const nodes = makeNodes(Array.from({ length: 85 }, (_, i) => `svc${i}`));
        const result = getLayoutedElements(nodes, [], 'LR');
        expect(result.nodes).toHaveLength(85);
        const xs = result.nodes.map(n => n.position.x);
        const ys = result.nodes.map(n => n.position.y);
        const xSpread = Math.max(...xs) - Math.min(...xs);
        const ySpread = Math.max(...ys) - Math.min(...ys);
        // Grid should be at least 10 columns wide × ~9 rows tall.
        // x spread ≈ 9 columns × (NODE_WIDTH 200 + padding 40) = ~2160
        // y spread ≈ 8 rows × (NODE_HEIGHT 80 + padding 30) = ~880
        expect(xSpread, `xSpread should reflect a wide grid; got ${xSpread}`).toBeGreaterThan(1500);
        expect(ySpread, `ySpread should reflect a multi-row grid; got ${ySpread}`).toBeGreaterThan(500);
        // Aspect ratio sanity: width/height between 1.5 and 5 (roughly square).
        // Way out of this band means single-column / single-row regression.
        const ratio = xSpread / ySpread;
        expect(ratio, `grid aspect ratio out of band: ${ratio.toFixed(2)}`).toBeGreaterThan(1.5);
        expect(ratio).toBeLessThan(5.0);
    });

    it('31 isolated nodes (kotlin-ktor Gradle modules) lay out as a grid', () => {
        const nodes = makeNodes(Array.from({ length: 31 }, (_, i) => `mod${i}`));
        const result = getLayoutedElements(nodes, [], 'LR');
        const xs = result.nodes.map(n => n.position.x);
        const ys = result.nodes.map(n => n.position.y);
        const xSpread = Math.max(...xs) - Math.min(...xs);
        const ySpread = Math.max(...ys) - Math.min(...ys);
        // 31 nodes → ceil(sqrt(31)) = 6-column grid → 6 × 240 = 1440px wide,
        // 5 × 110 = 550px tall. Allow ample headroom.
        expect(xSpread).toBeGreaterThan(900);
        expect(ySpread).toBeGreaterThan(300);
    });

    // Issue UX-5 (2026-06-03) — Knowledge Map vertical-strip layout.
    //
    // The Knowledge Map fuses Services + Clusters + APIs + Infrastructure
    // into one canvas. On the test project that's 35 nodes wired into
    // ~10 small (cluster → service → infra) chains. The PREVIOUS layout
    // only grid-packed nodes with ZERO edges — small connected
    // components were still handed to Dagre. Dagre rank-aligned every
    // component along the same x-axis and collapsed everything into a
    // tall narrow column (live user report: 262-node Map renders at min
    // zoom as a single vertical strip).
    //
    // The fix: detect each connected component via BFS, layout each
    // component independently with Dagre, then grid-pack the components.
    // After this fix, 35 nodes split into 10 mini-components should
    // still produce a wide layout, not a vertical strip.
    it('many small connected components grid-pack horizontally (Knowledge Map fix)', () => {
        // Build 10 disconnected 3-node chains: 30 nodes, 20 edges total.
        // Each chain is `s_i → c_i → a_i` (service → cluster → api).
        const nodes: Node[] = [];
        const edges: Edge[] = [];
        for (let i = 0; i < 10; i++) {
            nodes.push({ id: `s${i}`, data: {}, position: { x: 0, y: 0 } });
            nodes.push({ id: `c${i}`, data: {}, position: { x: 0, y: 0 } });
            nodes.push({ id: `a${i}`, data: {}, position: { x: 0, y: 0 } });
            edges.push({ id: `e${i}a`, source: `s${i}`, target: `c${i}` });
            edges.push({ id: `e${i}b`, source: `c${i}`, target: `a${i}` });
        }
        const result = getLayoutedElements(nodes, edges, 'LR');
        const xs = result.nodes.map(n => n.position.x);
        const ys = result.nodes.map(n => n.position.y);
        const xSpread = Math.max(...xs) - Math.min(...xs);
        const ySpread = Math.max(...ys) - Math.min(...ys);
        // Before the fix the previous layout stacked all 10 chains along
        // the y-axis at the same x: ySpread >> xSpread, ratio > 5.
        // After the fix: components are tiled in a roughly square grid.
        const ratio = ySpread / Math.max(1, xSpread);
        expect(
            ratio,
            `disconnected-components should tile in a grid (got xSpread=${xSpread}, ySpread=${ySpread}, ratio=${ratio.toFixed(2)})`,
        ).toBeLessThan(3);
        // Also: x-axis spread must be substantial (each component is ~3 nodes
        // wide = ~720px; 4 columns × 720 = ~2880px minimum).
        expect(xSpread).toBeGreaterThan(900);
    });

    // Issue UX-5 (2026-06-03) — the Knowledge Map specifically.
    it('getLayeredMapLayout — 27 APIs wrap into sub-columns under their layer', () => {
        // Knowledge-Map-shaped graph: 1 service, 6 clusters, 27 APIs,
        // 1 infra. Each node carries `data.layer` so the layered
        // layout kicks in.
        const nodes: Node[] = [];
        nodes.push({ id: 'svc', data: { layer: 'service' }, position: { x: 0, y: 0 } });
        for (let i = 0; i < 6; i++) {
            nodes.push({ id: `c${i}`, data: { layer: 'cluster' }, position: { x: 0, y: 0 } });
        }
        for (let i = 0; i < 27; i++) {
            nodes.push({ id: `a${i}`, data: { layer: 'api' }, position: { x: 0, y: 0 } });
        }
        nodes.push({ id: 'inf', data: { layer: 'infrastructure' }, position: { x: 0, y: 0 } });
        // Edges: tree shape so naive Dagre would stack into one rank.
        const edges: Edge[] = [];
        for (let i = 0; i < 6; i++) {
            edges.push({ id: `e_svc_c${i}`, source: 'svc', target: `c${i}` });
        }
        for (let i = 0; i < 27; i++) {
            edges.push({ id: `e_c_a${i}`, source: `c${i % 6}`, target: `a${i}` });
        }
        edges.push({ id: 'e_svc_inf', source: 'svc', target: 'inf' });

        const out = getLayeredMapLayout(nodes, edges, 180, 64);
        const positions = new Map(out.nodes.map(n => [n.id, n.position]));

        // The 27 APIs must NOT all sit at the same x (which is what
        // Dagre LR does — that's the bug). Sub-columns should give
        // them at least 2 distinct x positions.
        const apiXs = new Set<number>();
        for (let i = 0; i < 27; i++) apiXs.add(positions.get(`a${i}`)!.x);
        expect(apiXs.size, `27 APIs should wrap into ≥2 sub-columns; got ${apiXs.size} distinct x positions`).toBeGreaterThanOrEqual(2);

        // Layered ordering — service col-x < cluster col-x < api col-x.
        const svcX = positions.get('svc')!.x;
        const cX = Math.min(...[...Array(6).keys()].map(i => positions.get(`c${i}`)!.x));
        const aX = Math.min(...[...Array(27).keys()].map(i => positions.get(`a${i}`)!.x));
        expect(svcX).toBeLessThan(cX);
        expect(cX).toBeLessThan(aX);

        // Aspect ratio sanity — overall bounding box should NOT be a
        // tall narrow strip. Pre-fix Dagre LR produced ratio ~6;
        // post-fix should be < 3.
        const allX = out.nodes.map(n => n.position.x);
        const allY = out.nodes.map(n => n.position.y);
        const xSpread = Math.max(...allX) - Math.min(...allX);
        const ySpread = Math.max(...allY) - Math.min(...allY);
        expect(
            ySpread / Math.max(1, xSpread),
            `aspect ratio ySpread/xSpread should be < 3; got ${(ySpread / xSpread).toFixed(2)}`,
        ).toBeLessThan(3);
    });

    // Phase 3 #3 residual (2026-06-07) — Knowledge Map for 50+ disjoint
    // chains in a multi-repo workspace. With 8 services + ~50 clusters
    // + ~190 APIs, the previous fixed `MAP_TARGET_MAX_ROWS = 12` packed
    // the API layer into 16 sub-columns × 12 rows → canvas reaches
    // ~3700px wide just for the APIs and ReactFlow's fit-view zooms
    // out aggressively, leaving a tall thin strip down the middle.
    // Locks in an aspect-ratio bound and a per-layer width bound so the
    // adaptive max-rows scaling can't regress.
    it('getLayeredMapLayout — 200 APIs stay within a reasonable bounding box', () => {
        const nodes: Node[] = [];
        nodes.push({ id: 'svc', data: { layer: 'service' }, position: { x: 0, y: 0 } });
        for (let i = 0; i < 50; i++) {
            nodes.push({ id: `c${i}`, data: { layer: 'cluster' }, position: { x: 0, y: 0 } });
        }
        for (let i = 0; i < 190; i++) {
            nodes.push({ id: `a${i}`, data: { layer: 'api' }, position: { x: 0, y: 0 } });
        }
        nodes.push({ id: 'inf', data: { layer: 'infrastructure' }, position: { x: 0, y: 0 } });
        const edges: Edge[] = [];
        for (let i = 0; i < 50; i++) edges.push({ id: `e_svc_c${i}`, source: 'svc', target: `c${i}` });
        for (let i = 0; i < 190; i++) edges.push({ id: `e_c_a${i}`, source: `c${i % 50}`, target: `a${i}` });

        const out = getLayeredMapLayout(nodes, edges, 180, 64);
        const allX = out.nodes.map(n => n.position.x);
        const allY = out.nodes.map(n => n.position.y);
        const xSpread = Math.max(...allX) - Math.min(...allX);
        const ySpread = Math.max(...allY) - Math.min(...allY);

        // Bounded canvas — should not exceed 4000px in either axis even
        // at 240 total nodes. (180×64 nodes; pre-fix the API layer alone
        // crossed 3700px wide; post-fix the adaptive sub-column count
        // should keep total width comfortably under 4000.)
        expect(xSpread, `total xSpread should be < 4000 for 240 nodes; got ${xSpread.toFixed(0)}`).toBeLessThan(4000);
        // Aspect ratio sanity — not a tall thin strip, not a giant wide
        // strip. Should be between 0.3 and 3.0.
        const ratio = ySpread / Math.max(1, xSpread);
        expect(ratio, `aspect ratio ySpread/xSpread should be 0.3 ≤ r ≤ 3.0; got ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(0.3);
        expect(ratio).toBeLessThanOrEqual(3.0);
    });

    it('BUG-POLAR-23: a service-ONLY map (multi-repo) spreads into a 2D grid, not one vertical strip', () => {
        // 105 nodes all `layer: 'service'` (no clusters/apis) — the multi-repo
        // `map:workspace` shape. Pre-fix they stacked in one far-left column.
        const nodes: Node[] = [];
        for (let i = 0; i < 105; i++) {
            nodes.push({ id: `svc${i}`, data: { layer: 'service' }, position: { x: 0, y: 0 } });
        }
        const out = getLayeredMapLayout(nodes, [], 180, 64);
        const positions = new Map(out.nodes.map(n => [n.id, n.position]));
        const distinctX = new Set(out.nodes.map(n => n.position.x));
        // Must occupy many columns, not one.
        expect(distinctX.size, `services should wrap into a grid; got ${distinctX.size} distinct x`).toBeGreaterThanOrEqual(8);
        // Aspect-ratio sanity — not a tall thin strip.
        const allX = out.nodes.map(n => n.position.x);
        const allY = out.nodes.map(n => n.position.y);
        const xSpread = Math.max(...allX) - Math.min(...allX);
        const ySpread = Math.max(...allY) - Math.min(...allY);
        expect(ySpread / Math.max(1, xSpread)).toBeLessThan(3.0);
        void positions;
    });

    it('getLayeredMapLayout — small map (15 nodes) keeps the existing 12-row sub-column shape', () => {
        // Regression: the adaptive scaling must not change behavior for
        // small maps. 6 clusters + 8 APIs → fits in one 12-row column.
        const nodes: Node[] = [];
        nodes.push({ id: 'svc', data: { layer: 'service' }, position: { x: 0, y: 0 } });
        for (let i = 0; i < 6; i++) nodes.push({ id: `c${i}`, data: { layer: 'cluster' }, position: { x: 0, y: 0 } });
        for (let i = 0; i < 8; i++) nodes.push({ id: `a${i}`, data: { layer: 'api' }, position: { x: 0, y: 0 } });
        const edges: Edge[] = [];
        for (let i = 0; i < 6; i++) edges.push({ id: `e_svc_c${i}`, source: 'svc', target: `c${i}` });
        for (let i = 0; i < 8; i++) edges.push({ id: `e_c_a${i}`, source: `c${i % 6}`, target: `a${i}` });

        const out = getLayeredMapLayout(nodes, edges, 180, 64);
        const positions = new Map(out.nodes.map(n => [n.id, n.position]));
        // 8 APIs ≤ 12 rows → single sub-column → all APIs share the same x.
        const apiXs = new Set<number>();
        for (let i = 0; i < 8; i++) apiXs.add(positions.get(`a${i}`)!.x);
        expect(apiXs.size, `small map: 8 APIs should fit in 1 sub-column`).toBe(1);
    });

    // Phase 3 #3 residual (2026-06-07) — when a multi-repo workspace
    // surfaces 30+ singleton service nodes carrying `data.repoId`,
    // pack each repo's singletons into its own row instead of one
    // sqrt-grid that mixes repos. Locks in the per-repo banding so
    // visual scanning ("which services live in api-svc?") is O(1).
    it('singletons with data.repoId pack into per-repo rows when count exceeds the threshold', () => {
        // 40 isolated nodes split 50/50 across two repos. Pre-fix:
        // single grid mixing both repos. Post-fix: two distinct row
        // bands (per-repo) with the repo with more nodes wrapping
        // into 2 sub-rows.
        const nodes: Node[] = [];
        for (let i = 0; i < 25; i++) {
            nodes.push({ id: `a${i}`, data: { repoId: 'repo:api-service' }, position: { x: 0, y: 0 } });
        }
        for (let i = 0; i < 15; i++) {
            nodes.push({ id: `p${i}`, data: { repoId: 'repo:payments' }, position: { x: 0, y: 0 } });
        }
        const out = getLayoutedElements(nodes, [], 'LR');
        const positions = new Map(out.nodes.map(n => [n.id, n.position]));
        // All nodes from repo A live at distinct Y-bands from repo B.
        const aYs = new Set<number>();
        for (let i = 0; i < 25; i++) aYs.add(positions.get(`a${i}`)!.y);
        const pYs = new Set<number>();
        for (let i = 0; i < 15; i++) pYs.add(positions.get(`p${i}`)!.y);
        // Every y in repo A must be strictly < every y in repo B
        // (banding by repoId, smaller repoId first alphabetically:
        // 'repo:api-service' < 'repo:payments').
        const maxA = Math.max(...aYs);
        const minP = Math.min(...pYs);
        expect(maxA, 'repo A max y should be below repo B min y (bands are distinct)').toBeLessThan(minP);
    });

    it('singletons WITHOUT data.repoId fall back to the legacy sqrt-grid (no regression)', () => {
        // No repoId on any node → keep existing grid behaviour.
        const nodes = Array.from({ length: 40 }, (_, i) => ({
            id: `n${i}`, data: {}, position: { x: 0, y: 0 } as { x: number; y: number },
        }));
        const out = getLayoutedElements(nodes, [], 'LR');
        const xs = new Set(out.nodes.map(n => n.position.x));
        const ys = new Set(out.nodes.map(n => n.position.y));
        // sqrt(40) ≈ 7 columns → ~6 rows. Both axes should have
        // several distinct values (i.e. not a single column / row).
        expect(xs.size).toBeGreaterThan(3);
        expect(ys.size).toBeGreaterThan(3);
    });

    it('getLayeredMapLayout falls back to generic LR when no node has data.layer', () => {
        const nodes = makeNodes(['n0', 'n1', 'n2']);
        const edges = makeEdges([['n0', 'n1'], ['n1', 'n2']]);
        const out = getLayeredMapLayout(nodes, edges, 200, 80);
        // Generic LR keeps Dagre's rank order.
        const xs = out.nodes.map(n => n.position.x);
        expect(xs[1]).toBeGreaterThan(xs[0]);
        expect(xs[2]).toBeGreaterThan(xs[1]);
    });

    it('a single large connected component still uses Dagre rank-flow (no regression)', () => {
        // 8-node linear chain — one connected component. Dagre LR should
        // produce strictly increasing x along the chain.
        const nodes = makeNodes(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']);
        const edges = makeEdges([
            ['n0', 'n1'], ['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'],
            ['n4', 'n5'], ['n5', 'n6'], ['n6', 'n7'],
        ]);
        const result = getLayoutedElements(nodes, edges, 'LR');
        const xMap = new Map(result.nodes.map(n => [n.id, n.position.x]));
        for (let i = 0; i < 7; i++) {
            expect(xMap.get(`n${i + 1}`)!, `n${i + 1}.x > n${i}.x`).toBeGreaterThan(xMap.get(`n${i}`)!);
        }
    });
});

// #848 (2026-06-11) — cluster-banded Knowledge Map layout. The user-visible
// complaint: APIs were packed into global sub-column grids far from their
// owning cluster, with long crossing edges (screenshot: 35-node map
// unreadable). Contract: each cluster's APIs stack vertically in a band
// ADJACENT to that cluster; bands tile into columns to keep the canvas
// roughly square.
describe('getLayeredMapLayout — cluster banding (#848)', () => {
    function mapFixture(clusters: number, apisPerCluster: number) {
        const nodes: Node[] = [{ id: 'svc', data: { layer: 'service' }, position: { x: 0, y: 0 } }];
        const edges: Edge[] = [];
        for (let c = 0; c < clusters; c++) {
            nodes.push({ id: `c${c}`, data: { layer: 'cluster' }, position: { x: 0, y: 0 } });
            edges.push({ id: `e_s_c${c}`, source: 'svc', target: `c${c}` });
            for (let a = 0; a < apisPerCluster; a++) {
                nodes.push({ id: `a${c}_${a}`, data: { layer: 'api' }, position: { x: 0, y: 0 } });
                edges.push({ id: `e_c${c}_a${a}`, source: `c${c}`, target: `a${c}_${a}` });
            }
        }
        nodes.push({ id: 'inf', data: { layer: 'infrastructure' }, position: { x: 0, y: 0 } });
        edges.push({ id: 'e_s_inf', source: 'svc', target: 'inf' });
        return { nodes, edges };
    }

    it("each cluster's APIs sit in a contiguous vertical stack adjacent to the cluster", () => {
        const { nodes, edges } = mapFixture(4, 5);
        const out = getLayeredMapLayout(nodes, edges, 180, 64);
        const pos = new Map(out.nodes.map(n => [n.id, n.position]));
        for (let c = 0; c < 4; c++) {
            const ys = [...Array(5).keys()].map(a => pos.get(`a${c}_${a}`)!.y);
            const xs = new Set([...Array(5).keys()].map(a => pos.get(`a${c}_${a}`)!.x));
            // single stack: one x per band (≤2 when the band wraps internally)
            expect(xs.size, `cluster c${c} APIs should stack (one inner column)`).toBeLessThanOrEqual(2);
            // contiguous: the cluster's APIs span without another cluster's APIs interleaving at the same x
            const top = Math.min(...ys), bottom = Math.max(...ys);
            for (let other = 0; other < 4; other++) {
                if (other === c) continue;
                for (let a = 0; a < 5; a++) {
                    const p = pos.get(`a${other}_${a}`)!;
                    const sameColumn = xs.has(p.x);
                    if (sameColumn) {
                        expect(p.y < top || p.y > bottom,
                            `a${other}_${a} interleaves cluster c${c}'s band`).toBe(true);
                    }
                }
            }
            // adjacency: the cluster node y is within its band's vertical range (±2 rows)
            const cy = pos.get(`c${c}`)!.y;
            expect(cy).toBeGreaterThanOrEqual(top - 160);
            expect(cy).toBeLessThanOrEqual(bottom + 160);
        }
    });

    it('bands tile into columns so big maps stay roughly square (old aspect guard preserved)', () => {
        const { nodes, edges } = mapFixture(50, 4); // ~250 nodes
        const out = getLayeredMapLayout(nodes, edges, 180, 64);
        const allX = out.nodes.map(n => n.position.x);
        const allY = out.nodes.map(n => n.position.y);
        const xSpread = Math.max(...allX) - Math.min(...allX);
        const ySpread = Math.max(...allY) - Math.min(...allY);
        expect(ySpread / Math.max(1, xSpread)).toBeLessThan(3);
        expect(xSpread / Math.max(1, ySpread)).toBeLessThan(4);
    });

    it('service column sits left of the bands; infrastructure right of them', () => {
        const { nodes, edges } = mapFixture(3, 3);
        const out = getLayeredMapLayout(nodes, edges, 180, 64);
        const pos = new Map(out.nodes.map(n => [n.id, n.position]));
        const clusterXs = [0, 1, 2].map(c => pos.get(`c${c}`)!.x);
        const apiXs = out.nodes.filter(n => n.id.startsWith('a')).map(n => n.position.x);
        expect(pos.get('svc')!.x).toBeLessThan(Math.min(...clusterXs));
        expect(pos.get('inf')!.x).toBeGreaterThan(Math.max(...apiXs));
    });

    it('APIs with no owning cluster land in a trailing ungrouped band (not dropped)', () => {
        const nodes: Node[] = [
            { id: 'svc', data: { layer: 'service' }, position: { x: 0, y: 0 } },
            { id: 'c0', data: { layer: 'cluster' }, position: { x: 0, y: 0 } },
            { id: 'owned', data: { layer: 'api' }, position: { x: 0, y: 0 } },
            { id: 'orphan', data: { layer: 'api' }, position: { x: 0, y: 0 } },
        ];
        const edges: Edge[] = [
            { id: 'e1', source: 'svc', target: 'c0' },
            { id: 'e2', source: 'c0', target: 'owned' },
        ];
        const out = getLayeredMapLayout(nodes, edges, 180, 64);
        const orphan = out.nodes.find(n => n.id === 'orphan');
        expect(orphan).toBeDefined();
        expect(Number.isFinite(orphan!.position.x)).toBe(true);
        expect(Number.isFinite(orphan!.position.y)).toBe(true);
    });
});
