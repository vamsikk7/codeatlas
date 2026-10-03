import dagre from 'dagre';
import { Position } from 'reactflow';
import type { Node, Edge } from 'reactflow';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;

// LRU cache — caches only positions (topology-derived), not full node objects.
// Caching full nodes caused stale `data.diff` to bleed across updateGraph pushes
// when node IDs were unchanged but diff annotations were not (#387 sub-case c).
const CACHE_MAX = 5;
type PositionMap = Map<string, { x: number; y: number }>;
const layoutCache = new Map<string, PositionMap>();

function makeCacheKey(nodes: Node[], edges: Edge[], direction: string): string {
    const nodeIds = nodes
        .map(n => {
            const w = n.data?.width || (n.data?.type === 'section' ? 220 : NODE_WIDTH);
            const h = n.data?.height || NODE_HEIGHT;
            return `${n.id}@${w}x${h}`;
        })
        .sort()
        .join(',');
    const edgeIds = edges.map(e => `${e.source}-${e.target}`).sort().join(',');
    return `${direction}:${nodeIds}:${edgeIds}`;
}

/**
 * Pick a column count for grid layout of disconnected nodes — same heuristic
 * the FeatureView (L2a) uses for cluster cards.
 */
function gridColumnsFor(count: number): number {
    if (count <= 2) return 2;
    if (count <= 6) return 3;
    if (count <= 12) return 4;
    return Math.max(4, Math.ceil(Math.sqrt(count)));
}

/**
 * Identify nodes that have NO edges (isolated). Returns the set of isolated
 * node IDs and the set of nodes that DO participate in at least one edge.
 */
function partitionByConnectivity(nodes: Node[], edges: Edge[]): {
    isolated: Node[];
    connected: Node[];
} {
    const touched = new Set<string>();
    for (const e of edges) {
        touched.add(e.source);
        touched.add(e.target);
    }
    const isolated: Node[] = [];
    const connected: Node[] = [];
    for (const n of nodes) {
        if (touched.has(n.id)) connected.push(n);
        else isolated.push(n);
    }
    return { isolated, connected };
}

/**
 * Issue UX-5 (2026-06-03) — find connected components in an undirected
 * view of the graph via BFS. Returns one array of node-id sets per
 * component, in stable input order (the first node defines the
 * component's seed).
 *
 * The Knowledge Map fuses Services + Clusters + APIs + Infrastructure
 * into one canvas where many edges form small chains (`service ←
 * cluster ← api`, `service → infra`). Dagre's rank-based layout treats
 * all chains as ranks of one big graph and stacks them along the
 * cross-axis — at 35+ nodes the result is an unreadable vertical strip.
 * Splitting into components first, laying each one out with Dagre, then
 * tiling the components in a coarse grid keeps the connection
 * topology while restoring usable horizontal density.
 */
function findConnectedComponents(nodes: Node[], edges: Edge[]): Node[][] {
    const adj = new Map<string, Set<string>>();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const e of edges) {
        adj.get(e.source)?.add(e.target);
        adj.get(e.target)?.add(e.source);
    }
    const seen = new Set<string>();
    const components: Node[][] = [];
    const byId = new Map(nodes.map(n => [n.id, n]));
    for (const n of nodes) {
        if (seen.has(n.id)) continue;
        const comp: Node[] = [];
        const queue: string[] = [n.id];
        seen.add(n.id);
        while (queue.length > 0) {
            const cur = queue.shift()!;
            const node = byId.get(cur);
            if (node) comp.push(node);
            for (const nb of adj.get(cur) ?? []) {
                if (!seen.has(nb)) {
                    seen.add(nb);
                    queue.push(nb);
                }
            }
        }
        components.push(comp);
    }
    return components;
}

/**
 * Layout a single connected component with Dagre and shift its positions
 * so the bounding box's top-left is at (0, 0). Returns positions per
 * node-id plus the component's bounding-box width/height for the
 * outer grid packer to use.
 */
function layoutComponentWithDagre(
    component: Node[],
    edges: Edge[],
    direction: 'TB' | 'LR',
    defaultW: number,
    defaultH: number,
): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({
        rankdir: direction,
        nodesep: direction === 'TB' ? 60 : 50,
        ranksep: direction === 'TB' ? 80 : 80,
        marginx: 30,
        marginy: 30,
    });
    const compIds = new Set(component.map(n => n.id));
    for (const node of component) {
        const w = node.data?.width || (node.data?.type === 'section' ? 220 : defaultW);
        const h = node.data?.height || defaultH;
        g.setNode(node.id, { width: w, height: h });
    }
    for (const edge of edges) {
        if (compIds.has(edge.source) && compIds.has(edge.target)) {
            g.setEdge(edge.source, edge.target);
        }
    }
    dagre.layout(g);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of component) {
        const np = g.node(node.id);
        if (!np) continue;
        const w = node.data?.width || defaultW;
        const h = node.data?.height || defaultH;
        const x = np.x - w / 2;
        const y = np.y - h / 2;
        positions.set(node.id, { x, y });
        if (x < minX) minX = x;
        if (x + w > maxX) maxX = x + w;
        if (y < minY) minY = y;
        if (y + h > maxY) maxY = y + h;
    }
    // Normalise positions so the bounding box starts at (0, 0).
    if (positions.size > 0 && isFinite(minX) && isFinite(minY)) {
        for (const [id, p] of positions) {
            positions.set(id, { x: p.x - minX, y: p.y - minY });
        }
    }
    const width = isFinite(minX) ? maxX - minX : 0;
    const height = isFinite(minY) ? maxY - minY : 0;
    return { positions, width, height };
}

/**
 * Apply Dagre layout to React Flow nodes and edges.
 * Returns nodes with computed positions and correct handle positions for the direction.
 * Positions are cached by topology — repeated calls reuse positions but always produce
 * fresh node objects from the current input so `data` mutations propagate to React Flow.
 *
 * User-observation fix (2026-05-16): when many nodes are disconnected (no edges
 * to anything), Dagre's rank-based layout has no topological signal and puts
 * them all on the same rank → they stack along the cross-axis as a single
 * column (rankdir=LR) or single row (rankdir=TB). rust-actix's L1 system
 * design with 11 standalone Cargo-workspace services rendered as an 11-tall
 * vertical strip. The fix: identify isolated nodes (no incident edges) and
 * lay them out in a grid alongside the Dagre-laid connected components.
 */
export function getLayoutedElements(
    nodes: Node[],
    edges: Edge[],
    direction: 'TB' | 'LR' = 'LR',
    nodeWidth: number = NODE_WIDTH,
    nodeHeight: number = NODE_HEIGHT,
): { nodes: Node[]; edges: Edge[] } {
    const cacheKey = makeCacheKey(nodes, edges, direction);
    const sourcePos = direction === 'TB' ? Position.Bottom : Position.Right;
    const targetPos = direction === 'TB' ? Position.Top : Position.Left;

    let positions: PositionMap | undefined;
    if (layoutCache.has(cacheKey)) {
        positions = layoutCache.get(cacheKey)!;
        // LRU touch — move to end of iteration order
        layoutCache.delete(cacheKey);
        layoutCache.set(cacheKey, positions);
    } else {
        positions = new Map();

        // Issue UX-5 (2026-06-03) — split the graph into connected
        // components. The PREVIOUS approach handed every edge-touching
        // node to one Dagre instance which rank-aligned disconnected
        // chains and produced a vertical strip on graphs like the
        // Knowledge Map (~35 nodes / ~10 small chains). Lay each
        // component out independently, then grid-pack the components.
        const components = findConnectedComponents(nodes, edges);
        const multiComponents: Array<{ comp: Node[]; pos: Map<string, { x: number; y: number }>; w: number; h: number }> = [];
        const singletons: Node[] = [];
        for (const comp of components) {
            if (comp.length <= 1) {
                singletons.push(...comp);
            } else {
                const { positions: cpos, width: w, height: h } = layoutComponentWithDagre(comp, edges, direction, nodeWidth, nodeHeight);
                multiComponents.push({ comp, pos: cpos, w, h });
            }
        }

        // Grid-pack the multi-node components. Pick a column count that
        // produces a roughly square overall bounding box so the canvas
        // doesn't read as a long horizontal or vertical strip.
        const componentCols = gridColumnsFor(multiComponents.length || 1);
        const componentGap = 80;
        const rowHeights: number[] = [];
        const colWidths: number[] = [];
        // Compute row + col extents.
        multiComponents.forEach((mc, i) => {
            const row = Math.floor(i / componentCols);
            const col = i % componentCols;
            rowHeights[row] = Math.max(rowHeights[row] ?? 0, mc.h);
            colWidths[col] = Math.max(colWidths[col] ?? 0, mc.w);
        });
        // Prefix sums for grid origins.
        const colX: number[] = [0];
        for (let i = 0; i < colWidths.length; i++) {
            colX.push((colX[i] ?? 0) + colWidths[i] + componentGap);
        }
        const rowY: number[] = [0];
        for (let i = 0; i < rowHeights.length; i++) {
            rowY.push((rowY[i] ?? 0) + rowHeights[i] + componentGap);
        }
        let multiMinX = Infinity, multiMaxX = -Infinity;
        let multiMinY = Infinity, multiMaxY = -Infinity;
        multiComponents.forEach((mc, i) => {
            const row = Math.floor(i / componentCols);
            const col = i % componentCols;
            const baseX = (colX[col] ?? 0) + 30;
            const baseY = (rowY[row] ?? 0) + 30;
            for (const [id, p] of mc.pos) {
                positions!.set(id, { x: baseX + p.x, y: baseY + p.y });
            }
            if (baseX < multiMinX) multiMinX = baseX;
            if (baseX + mc.w > multiMaxX) multiMaxX = baseX + mc.w;
            if (baseY < multiMinY) multiMinY = baseY;
            if (baseY + mc.h > multiMaxY) multiMaxY = baseY + mc.h;
        });

        // Grid-pack the isolated nodes alongside the multi-component
        // block (right in LR, below in TB) — same placement rule the
        // previous implementation used for rust-actix L1.
        if (singletons.length > 0) {
            const cellW = nodeWidth + 40;
            const cellH = nodeHeight + 30;
            let baseX: number;
            let baseY: number;
            if (multiComponents.length === 0) {
                baseX = 30;
                baseY = 30;
            } else if (direction === 'LR') {
                baseX = multiMaxX + componentGap;
                baseY = multiMinY;
            } else {
                baseX = multiMinX;
                baseY = multiMaxY + componentGap;
            }
            // Phase 3 #3 residual (2026-06-07) — when every singleton
            // carries a `data.repoId`, pack each repo's nodes into its
            // own row band so visual scanning ("which services live
            // in api-svc?") is O(1). Falls back to the legacy sqrt-grid
            // when any singleton lacks `repoId` (single-repo / monorepo
            // / mixed workspaces stay on the existing layout).
            const everyHasRepo = singletons.every(n => typeof (n.data as any)?.repoId === 'string' && (n.data as any).repoId);
            if (everyHasRepo) {
                const byRepo = new Map<string, Node[]>();
                for (const n of singletons) {
                    const rid = (n.data as any).repoId as string;
                    const list = byRepo.get(rid) ?? [];
                    list.push(n);
                    byRepo.set(rid, list);
                }
                // Stable alphabetical order so the bands are
                // deterministic across rebuilds.
                const orderedRepos = [...byRepo.keys()].sort();
                // Per-band column count derives from the WIDEST band so
                // every band uses the same grid width — visually
                // tidier than mixing column counts.
                const widestBand = Math.max(...orderedRepos.map(r => byRepo.get(r)!.length));
                const cols = gridColumnsFor(widestBand);
                const bandGap = 40; // extra vertical gap between repos
                let cursorY = baseY;
                for (const rid of orderedRepos) {
                    const band = byRepo.get(rid)!;
                    band.forEach((node, i) => {
                        const col = i % cols;
                        const row = Math.floor(i / cols);
                        positions!.set(node.id, {
                            x: baseX + col * cellW,
                            y: cursorY + row * cellH,
                        });
                    });
                    const bandRows = Math.ceil(band.length / cols);
                    cursorY += bandRows * cellH + bandGap;
                }
            } else {
                const cols = gridColumnsFor(singletons.length);
                singletons.forEach((node, i) => {
                    const col = i % cols;
                    const row = Math.floor(i / cols);
                    positions!.set(node.id, {
                        x: baseX + col * cellW,
                        y: baseY + row * cellH,
                    });
                });
            }
        }

        // Evict oldest entry if cache is full
        if (layoutCache.size >= CACHE_MAX) {
            const firstKey = layoutCache.keys().next().value;
            if (firstKey !== undefined) layoutCache.delete(firstKey);
        }
        layoutCache.set(cacheKey, positions);
    }

    const layoutedNodes = nodes.map((node) => {
        const pos = positions!.get(node.id);
        if (!pos) return node;
        return {
            ...node,
            position: { x: pos.x, y: pos.y },
            sourcePosition: sourcePos,
            targetPosition: targetPos,
        };
    });

    return { nodes: layoutedNodes, edges };
}

/**
 * Issue UX-5 (2026-06-03) — Knowledge Map layered grid layout.
 *
 * Default `getLayoutedElements` falls back to plain Dagre LR for one
 * connected component. When that component is a 3-deep tree like the
 * Knowledge Map (Service → Clusters → APIs, plus Infra siblings), the
 * deepest rank can have 25-30 API leaves and Dagre stacks them all
 * along the rank cross-axis → the canvas reads as a tall narrow strip.
 *
 * This function takes the same nodes/edges plus the layer for each
 * node (read from `node.data.layer`) and lays out one column per
 * layer in a fixed order (service / cluster / api / infrastructure /
 * domain). Within each column, nodes wrap into multiple sub-columns so
 * the column's effective height stays bounded (target ≤ 12 rows). The
 * net result: 27 APIs occupy 3 columns × 9 rows instead of 27 rows.
 *
 * Falls back to `getLayoutedElements` when no node carries
 * `data.layer` (i.e. the caller isn't a Knowledge Map graph).
 */
const MAP_LAYER_ORDER: ReadonlyArray<string> = [
    'service',
    'cluster',
    'api',
    'infrastructure',
    'domain',
];
const MAP_LAYER_GAP = 100;
const MAP_INTRA_NODE_GAP_X = 40;
// Issue #790 #7a — vertical gap was 24, but at 132+ services the
// chip labels (4 lines on long names like `aws-node-typescript-rest-
// api-with-dynamodb`) collided with the row beneath them. 40 gives
// the chip a clear horizontal band even at the longest label.
const MAP_INTRA_NODE_GAP_Y = 40;
const MAP_LAYER_GAP_X = 120;
const MAP_TARGET_MAX_ROWS = 12;
// Issue #790 #7b — extra horizontal gap between subgroup boundaries
// inside one layer (e.g. between the `aws` services and the `azure`
// services), so visual grouping by cloud-provider reads from the
// layout itself instead of requiring the user to read every chip.
const MAP_SUBGROUP_GAP_X = 28;

export function getLayeredMapLayout(
    nodes: Node[],
    edges: Edge[],
    nodeWidth: number = NODE_WIDTH,
    nodeHeight: number = NODE_HEIGHT,
): { nodes: Node[]; edges: Edge[] } {
    // Bail out if none of the nodes carry a layer hint — the function
    // is Knowledge-Map-shaped, not a generic LR fallback.
    const hasLayers = nodes.some(n => typeof n.data?.layer === 'string');
    if (!hasLayers) {
        return getLayoutedElements(nodes, edges, 'LR', nodeWidth, nodeHeight);
    }

    // #848 (2026-06-11) — cluster-banded layout. The previous design packed
    // each LAYER into a global sub-column grid, so a cluster's APIs landed
    // arbitrarily far from the cluster with long crossing edges (user
    // screenshot: a 35-node map read as a tangle). New contract:
    //   • each cluster owns a BAND: the cluster node sits beside a vertical
    //     stack of ITS OWN APIs (short horizontal edges, growth is vertical);
    //   • bands tile into K band-columns so big maps stay roughly square
    //     (preserves the Phase-3 aspect-ratio guard);
    //   • services stack on the far left, infrastructure (and any other
    //     trailing layers) on the far right.
    const layerOf = (n: Node) => (n.data?.layer as string | undefined) ?? 'other';
    const cellW = nodeWidth + MAP_INTRA_NODE_GAP_X;
    const cellH = nodeHeight + MAP_INTRA_NODE_GAP_Y;

    const clusters = nodes.filter(n => layerOf(n) === 'cluster');
    const apis = nodes.filter(n => layerOf(n) === 'api');
    const services = nodes.filter(n => layerOf(n) === 'service');
    const rest = nodes.filter(n => !['cluster', 'api', 'service'].includes(layerOf(n)));

    // api → owning cluster from the edges (cluster→api direction).
    const clusterIds = new Set(clusters.map(n => n.id));
    const apiIds = new Set(apis.map(n => n.id));
    const ownerOf = new Map<string, string>();
    for (const e of edges) {
        if (clusterIds.has(e.source) && apiIds.has(e.target) && !ownerOf.has(e.target)) {
            ownerOf.set(e.target, e.source);
        }
    }

    // Bands: input cluster order, plus one trailing band for orphan APIs.
    type Band = { cluster: Node | null; bandApis: Node[] };
    const bands: Band[] = clusters.map(c => ({
        cluster: c,
        bandApis: apis.filter(a => ownerOf.get(a.id) === c.id),
    }));
    const orphans = apis.filter(a => !ownerOf.has(a.id));
    if (orphans.length > 0) bands.push({ cluster: null, bandApis: orphans });

    // Band geometry: an inner API stack wraps to 2 columns past 16 rows.
    const bandInnerCols = (count: number) => (count > 16 ? 2 : 1);
    const bandHeight = (b: Band) => {
        const cols = bandInnerCols(b.bandApis.length);
        const rows = Math.max(1, Math.ceil(b.bandApis.length / cols));
        return Math.max(rows, 1) * cellH;
    };
    const BAND_GAP_Y = Math.round(cellH * 0.6);
    const totalBandsH = bands.reduce((acc, b) => acc + bandHeight(b) + BAND_GAP_Y, 0);

    // K band-columns sized so the canvas stays roughly square: a
    // band-column is (cluster col + API col) wide — plus a second API
    // column only when some band actually wraps. The 0.8 damping keeps
    // total width bounded on disjoint-chain mega-maps (Phase-3 guard).
    const anyBandWraps = bands.some(b => bandInnerCols(b.bandApis.length) > 1);
    const bandColW = cellW * (anyBandWraps ? 3 : 2) + MAP_INTRA_NODE_GAP_X;
    const K = Math.min(
        Math.max(1, Math.round(Math.sqrt(totalBandsH / Math.max(1, bandColW)) * 0.8)),
        Math.max(1, bands.length),
    );
    const targetColH = Math.ceil(totalBandsH / K);

    const positions = new Map<string, { x: number; y: number }>();
    const SERVICE_X = 30;
    const bandsStartX = SERVICE_X + cellW + MAP_LAYER_GAP_X;

    let colIndex = 0;
    let cursorY = 30;
    let maxColBottom = 30;
    for (const band of bands) {
        const h = bandHeight(band);
        if (colIndex < K - 1 && cursorY > 30 && cursorY + h > 30 + targetColH) {
            colIndex++;
            cursorY = 30;
        }
        const clusterX = bandsStartX + colIndex * bandColW;
        const apiX = clusterX + cellW + MAP_INTRA_NODE_GAP_X;
        if (band.cluster) {
            positions.set(band.cluster.id, { x: clusterX, y: cursorY });
        }
        const cols = bandInnerCols(band.bandApis.length);
        const rows = Math.max(1, Math.ceil(band.bandApis.length / cols));
        band.bandApis.forEach((a, i) => {
            positions.set(a.id, {
                x: apiX + Math.floor(i / rows) * cellW,
                y: cursorY + (i % rows) * cellH,
            });
        });
        cursorY += h + BAND_GAP_Y;
        maxColBottom = Math.max(maxColBottom, cursorY);
    }

    const bandsRightX = bandsStartX + K * bandColW;

    // Services: far-left column, vertically distributed over the canvas.
    const canvasH = Math.max(maxColBottom - 30, cellH);
    if (services.length > 1 && bands.length === 0 && rest.length === 0) {
        // BUG-POLAR-23: a service-ONLY map (every node is a `service`, as on a
        // multi-repo `map:workspace`) has no clusters/apis/infra to anchor other
        // columns, so the single far-left service column collapsed 105 nodes into
        // one unreadable vertical strip. Wrap them into a near-square grid so the
        // map spreads in 2D and fitView frames a readable layout.
        const cols = Math.max(1, Math.ceil(Math.sqrt(services.length)));
        const rows = Math.ceil(services.length / cols);
        services.forEach((svc, i) => {
            positions.set(svc.id, {
                x: SERVICE_X + Math.floor(i / rows) * cellW,
                y: 30 + (i % rows) * cellH,
            });
        });
    } else {
        services.forEach((svc, i) => {
            const y = services.length === 1
                ? 30 + Math.max(0, canvasH / 2 - nodeHeight / 2)
                : 30 + i * Math.max(cellH, canvasH / services.length);
            positions.set(svc.id, { x: SERVICE_X, y });
        });
    }

    // Remaining layers (infrastructure, domain, tour stops, …): columns to
    // the right of the bands in MAP_LAYER_ORDER sequence, simple stacks.
    const restByLayer = new Map<string, Node[]>();
    for (const n of rest) {
        const l = layerOf(n);
        const list = restByLayer.get(l) ?? [];
        list.push(n);
        restByLayer.set(l, list);
    }
    const restLayerOrder: string[] = [];
    for (const l of MAP_LAYER_ORDER) if (restByLayer.has(l)) restLayerOrder.push(l);
    for (const l of restByLayer.keys()) if (!restLayerOrder.includes(l)) restLayerOrder.push(l);
    let restX = bandsRightX + MAP_LAYER_GAP_X;
    for (const l of restLayerOrder) {
        const list = restByLayer.get(l)!;
        const maxRows = Math.max(12, Math.ceil(Math.sqrt(list.length * 2)));
        const subCols = Math.max(1, Math.ceil(list.length / maxRows));
        const rows = Math.ceil(list.length / subCols);
        list.forEach((n, i) => {
            positions.set(n.id, {
                x: restX + Math.floor(i / rows) * cellW,
                y: 30 + (i % rows) * cellH,
            });
        });
        restX += subCols * cellW + MAP_LAYER_GAP_X;
    }

    const layoutedNodes = nodes.map(n => {
        const pos = positions.get(n.id);
        if (!pos) return n;
        return {
            ...n,
            position: pos,
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
        };
    });
    return { nodes: layoutedNodes, edges };
}
