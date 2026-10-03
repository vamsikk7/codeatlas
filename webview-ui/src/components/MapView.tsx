/**
 * MapView.tsx — Knowledge Map renderer (Issue #700).
 *
 * Single-canvas unified diagram covering services, clusters, APIs, and
 * infrastructure on one view. Backed by `mapGraphBuilder.buildMapGraph`
 * (extension host); rendered here via React Flow + Dagre LR layout.
 *
 * Per-layer accent colors + an in-canvas overlay panel let the user toggle
 * layers and diff annotations on/off without leaving the view. Clicking
 * any node drills into the corresponding existing layer view via the
 * `meta.drillDownGraphId` set by the builder.
 *
 * Future overlays (`Domain` for #701, `Tour` for #702) are rendered as
 * disabled chips with a coming-soon tooltip so the panel layout doesn't
 * jump when those features land.
 */

import React, { memo, useMemo, useCallback, useState, CSSProperties } from 'react';
import ReactFlow, {
    Background,
    BackgroundVariant,
    Controls,
    Handle,
    Position,
    Node,
    Edge,
    useNodesState,
    useEdgesState,
    MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { getLayoutedElements, getLayeredMapLayout } from '../layout';
import { NODE_DIFF_COLORS, EDGE_DIFF_COLORS, DIFF_SYMBOLS, DIFF_BORDER_STYLES } from '../diffColors';
import { ForceMeasureNodes } from './ForceMeasureNodes';

interface MapViewProps {
    graph: {
        graphId: string;
        type: string;
        nodes: any[];
        edges: any[];
        anchors: Record<string, any>;
        meta: Record<string, any>;
    };
    onNodeClick: (nodeId: string, nodeData: any, event?: React.MouseEvent) => void;
    onNodeRightClick?: (nodeId: string, nodeData: any, event?: React.MouseEvent) => void;
    onEdgeClick: (edgeId: string, edgeData: any) => void;
    /**
     * Issue #732 — per-node comment count, keyed by `node.id`. Threaded
     * through `DiagramView` from `App.tsx`. When > 0 we render a 💬 chip
     * inside the node header.
     */
    commentCounts?: Record<string, number>;
}

// ─── Per-layer visual identity ───────────────────────────────────────────────
// Each layer gets a stable accent color + emoji icon so a glance at the
// map immediately tells you "this is a service / this is a cluster / etc."
// Colors are CSS variables so dark/light themes inherit naturally.

type MapLayer = 'service' | 'cluster' | 'api' | 'infrastructure' | 'domain';

const LAYER_CONFIG: Record<MapLayer, { icon: string; accent: string; label: string }> = {
    service: { icon: '🏗', accent: 'var(--ca-layer-service, #5b8def)', label: 'Services' },
    cluster: { icon: '🧩', accent: 'var(--ca-layer-cluster, #a777e3)', label: 'Clusters' },
    api: { icon: '⚡', accent: 'var(--ca-layer-api, #4fb286)', label: 'APIs' },
    infrastructure: { icon: '💾', accent: 'var(--ca-layer-infra, #e89b3c)', label: 'Infrastructure' },
    // Issue #701 — Domain layer: business-intent clusters. Reuses the
    // MapView shell (Dagre LR + per-layer accent + overlay panel) since
    // the layout shape is identical to a flat cluster set.
    domain: { icon: '🧭', accent: 'var(--ca-layer-domain, #d97757)', label: 'Domains' },
};

/**
 * BUG-POLAR-9: the layer for a map node. Prefer the explicit `meta.layer` set by
 * mapGraphBuilder, but on a MULTI-REPO `map:workspace` the nodes are the
 * skeletal repo/service nodes (`type: 'service'`) with NO `meta.layer`, so every
 * layer count read 0 and the map rendered blank. Fall back to the node's `type`
 * so those nodes bucket into the Services layer (and clusters/apis/infra/domains
 * likewise) instead of vanishing.
 */
const NODE_TYPE_TO_LAYER: Record<string, MapLayer> = {
    service: 'service', cluster: 'cluster', api: 'api',
    infrastructure: 'infrastructure', infra: 'infrastructure', domain: 'domain',
};
export function mapNodeLayer(n: { type?: string; meta?: { layer?: unknown } | null }): MapLayer | undefined {
    const explicit = n.meta?.layer;
    if (typeof explicit === 'string' && explicit in LAYER_CONFIG) return explicit as MapLayer;
    return n.type ? NODE_TYPE_TO_LAYER[n.type] : undefined;
}

const ALL_LAYERS: MapLayer[] = ['service', 'cluster', 'api', 'infrastructure', 'domain'];

// ─── MapNode — custom React Flow node with layer-aware accent ────────────────

interface MapNodeData {
    label: string;
    subtitle?: string;
    layer: MapLayer;
    diff?: string;
    diffEnabled: boolean;
    /** #732 — count of comments anchored on this node, if any. */
    commentCount?: number;
    /** #542 — threaded per-node graph + node identity. Empty string when
     *  the parent graph hasn't supplied one. */
    graphId?: string;
    nodeId?: string;
}

const MapNode = memo(({ data }: { data: MapNodeData }) => {
    const [hover, setHover] = useState(false);
    const layerConfig = LAYER_CONFIG[data.layer];
    const diff = data.diff ?? 'unchanged';
    const showDiff = data.diffEnabled && diff !== 'unchanged';
    const diffColors = showDiff ? NODE_DIFF_COLORS[diff] : null;
    const isDeleted = showDiff && diff === 'deleted';
    const commentCount = data.commentCount ?? 0;

    const containerStyle: CSSProperties = {
        background: diffColors?.bg ?? 'var(--ca-node-body-bg)',
        // Left-edge accent stripe encodes the layer, border encodes the diff.
        // This lets us show BOTH cues at once without conflict on a node
        // that's both "a cluster" and "newly added".
        borderLeft: `4px solid ${layerConfig.accent}`,
        border: `1.5px ${showDiff ? (DIFF_BORDER_STYLES[diff] ?? 'solid') : 'solid'} ${diffColors?.border ?? 'var(--ca-border)'}`,
        borderLeftWidth: 4,
        borderLeftColor: layerConfig.accent,
        borderRadius: 8,
        padding: '8px 12px',
        minWidth: 150,
        maxWidth: 260,
        // Issue #732 — hover state. Strengthens the shadow + bumps the
        // border opacity slightly so the node feels "clickable" on hover
        // without changing color (which would conflict with diff cues).
        boxShadow: hover
            ? `0 4px 14px ${layerConfig.accent}55, 0 1px 4px rgba(0,0,0,0.3)`
            : '0 1px 4px rgba(0,0,0,0.2)',
        transform: hover ? 'translateY(-1px)' : undefined,
        opacity: isDeleted ? 0.6 : 1,
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        fontFamily: "'Inter', system-ui, sans-serif",
        position: 'relative' as const,
    };

    return (
        <div
            style={{ position: 'relative', overflow: 'visible' }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
        >
            <div style={containerStyle}>
                <Handle type="target" position={Position.Left} style={{ background: 'transparent', border: 'none' }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 14 }} aria-hidden>{layerConfig.icon}</span>
                    <span style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: 'var(--ca-text)',
                        textDecoration: isDeleted ? 'line-through' : 'none',
                        lineHeight: 1.3,
                        flex: 1,
                        wordBreak: 'break-word' as const,
                    }}>
                        {data.label}
                    </span>
                    {commentCount > 0 && (
                        // Issue #732 / Issue 134 pattern — click opens the
                        // Comments panel scoped to this node's anchor.
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                window.dispatchEvent(new CustomEvent('codeatlas:open-comments'));
                            }}
                            style={{
                                fontSize: 9, fontWeight: 700, padding: '1px 5px',
                                borderRadius: 8, background: 'var(--ca-accent)', color: '#fff',
                                flexShrink: 0, border: 'none', cursor: 'pointer',
                            }}
                            title={`${commentCount} comment${commentCount > 1 ? 's' : ''} — click to open Comments`}
                            aria-label={`Open ${commentCount} comment${commentCount > 1 ? 's' : ''}`}
                        >
                            💬{commentCount}
                        </button>
                    )}
                    {showDiff && (
                        <span style={{
                            fontSize: 11,
                            fontWeight: 700,
                            color: diffColors?.border ?? 'var(--ca-text-muted)',
                        }} aria-label={`diff: ${diff}`}>
                            {DIFF_SYMBOLS[diff]}
                        </span>
                    )}
                </div>
                {data.subtitle && (
                    <div style={{ fontSize: 10, color: 'var(--ca-text-muted)', marginTop: 2 }}>
                        {data.subtitle}
                    </div>
                )}
                <Handle type="source" position={Position.Right} style={{ background: 'transparent', border: 'none' }} />
            </div>
        </div>
    );
});

const nodeTypes = { mapNode: MapNode };

// Issue #790 #7b — derive the cloud / infrastructure prefix from a
// service or repo name so the Knowledge Map can band same-cloud chips
// together. Recognises the `<cloud>-<runtime>-<purpose>` convention
// used across serverless/examples (`aws-node-rest-api`),
// SAM monorepos, FaaS-host wrappers (`azure-python-simple`,
// `google-golang-http-endpoint`, `openwhisk-ruby-cron`,
// `twilio-node-forward-call`, `kubeless-python-simple-function`).
// Returns '' for names that don't follow the convention — stable sort
// then leaves them in input order so single-cloud / single-token
// workspaces lay out exactly as before.
const KNOWN_CLOUDS = new Set<string>([
    'aws', 'azure', 'google', 'gcp', 'openwhisk', 'kubeless', 'twilio',
    'firebase', 'netlify', 'vercel', 'cloudflare', 'fastly',
]);
export function deriveSubgroup(label: string | undefined): string {
    if (!label) return '';
    // The label may carry decorative prefixes (emojis, repo glyphs).
    // Strip non-alphanumeric leading characters before the dash check.
    const cleaned = label.replace(/^[^a-z0-9]+/i, '').toLowerCase();
    const dash = cleaned.indexOf('-');
    if (dash <= 0) return '';
    const prefix = cleaned.slice(0, dash);
    return KNOWN_CLOUDS.has(prefix) ? prefix : '';
}

// ─── MapView — main component ────────────────────────────────────────────────

function MapView({ graph, onNodeClick, onNodeRightClick, onEdgeClick, commentCounts }: MapViewProps) {
    // Per-layer visibility toggles. Default: all layers on.
    const [visibleLayers, setVisibleLayers] = useState<Set<MapLayer>>(
        () => new Set<MapLayer>(ALL_LAYERS),
    );
    // Diff overlay toggle. Default: on (so the map doubles as a diff view).
    const [diffEnabled, setDiffEnabled] = useState(true);

    const layerCounts = useMemo(() => {
        const counts: Record<MapLayer, number> = { service: 0, cluster: 0, api: 0, infrastructure: 0, domain: 0 };
        for (const n of graph.nodes) {
            const layer = mapNodeLayer(n);
            if (layer && layer in counts) counts[layer]++;
        }
        return counts;
    }, [graph.nodes]);

    const diffCounts = useMemo(() => {
        const counts = { added: 0, deleted: 0, modified: 0 };
        for (const n of graph.nodes) {
            if (n.diff === 'added') counts.added++;
            else if (n.diff === 'deleted') counts.deleted++;
            else if (n.diff === 'modified') counts.modified++;
        }
        return counts;
    }, [graph.nodes]);

    const { rfNodes, rfEdges } = useMemo(() => {
        // Drop nodes whose layer is toggled off + edges whose endpoint vanished.
        const visibleNodeIds = new Set<string>();
        const rawNodes = graph.nodes.filter(n => {
            const layer = mapNodeLayer(n);
            return layer ? visibleLayers.has(layer) : true;
        });
        for (const n of rawNodes) visibleNodeIds.add(n.id);

        const mapped: Node[] = rawNodes.map(n => ({
            id: n.id,
            type: 'mapNode',
            position: { x: 0, y: 0 },
            data: {
                label: n.label,
                subtitle: n.subtitle,
                layer: mapNodeLayer(n) ?? 'service',
                diff: n.diff,
                diffEnabled,
                anchor: n.anchor,
                meta: n.meta,
                // Issue #732 — thread per-node comment count + the
                // (graphId, nodeId) pair so the node can render the
                // AI-review marker + comment badge.
                commentCount: commentCounts?.[n.id] ?? 0,
                graphId: graph.graphId,
                nodeId: n.id,
                // Issue #790 #7b — derive a stable `subgroup` token
                // from the service / repo name so the layered layout
                // can band same-cloud chips together. Matches the
                // canonical `<cloud>-<runtime>-<purpose>` shape used
                // by serverless/examples and AWS-SAM monorepos:
                // `aws-node-rest-api` → `aws`, `openwhisk-ruby-cron`
                // → `openwhisk`, `twilio-node-forward-call` → `twilio`.
                // Falls back to '' when the name doesn't have a dash
                // (single-token service ids stay in input order).
                subgroup: deriveSubgroup(n.label),
            },
        }));

        const edgesFiltered = graph.edges.filter(e =>
            visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target),
        );
        const mappedEdges: Edge[] = edgesFiltered.map(e => {
            const showDiff = diffEnabled && e.diff && e.diff !== 'unchanged';
            const color = showDiff
                ? (EDGE_DIFF_COLORS[e.diff!] ?? EDGE_DIFF_COLORS.unchanged)
                : 'var(--ca-edge, #888)';
            return {
                id: e.id,
                source: e.source,
                target: e.target,
                label: e.label ?? '',
                type: 'smoothstep',
                animated: showDiff && e.diff === 'added',
                style: {
                    stroke: color,
                    strokeWidth: 1.2,
                    strokeDasharray: showDiff && e.diff === 'deleted' ? '6,4' : undefined,
                    opacity: showDiff && e.diff === 'deleted' ? 0.55 : 0.9,
                },
                labelStyle: { fontSize: 10, fill: 'var(--ca-edge-label-text)' },
                labelBgStyle: { fill: 'var(--ca-label-bg)', fillOpacity: 0.9 },
                markerEnd: { type: MarkerType.ArrowClosed, color, width: 12, height: 12 },
            };
        });

        // Issue UX-5 (2026-06-03) — the Knowledge Map has natural layers
        // (Services / Clusters / APIs / Infrastructure / Domains). Default
        // Dagre LR collapses 27 API leaves into a single rank and the
        // canvas reads as a tall narrow strip. Switch to a layered grid
        // that wraps each layer into multiple sub-columns when the count
        // exceeds ~12 rows.
        // Issue #790 #7a — the mapNode chip renders at ~260px wide with
        // a 64px minimum height (taller for two-line labels). The previous
        // 180px width estimate caused horizontal overlap on long names
        // like `aws-node-typescript-rest-api-with-dynamodb` even with the
        // intra-node-gap of 30px. Pass the real chip width so the layout
        // grid leaves room for the chip plus a usable gutter.
        const layouted = getLayeredMapLayout(mapped, mappedEdges, 260, 64);
        // Fallback: if the layered layout produced anything weird and
        // every node ended up at (0,0), retry with the generic LR path.
        const hasPositions = layouted.nodes.some(n => n.position.x !== 0 || n.position.y !== 0);
        const final = hasPositions
            ? layouted
            : getLayoutedElements(mapped, mappedEdges, 'LR', 180, 64);
        return { rfNodes: final.nodes, rfEdges: final.edges };
    }, [graph, visibleLayers, diffEnabled, commentCounts]);

    // 2026-06-09 — hand `rfNodes` / `rfEdges` to RF as defaults so the
    // zustand store fills both arrays atomically inside `applyDefault`.
    // See DiagramView for the full rationale — the legacy `setNodes` /
    // `setEdges` pattern hit a handleBounds race that left every edge's
    // visibility check returning false. The keyed remount discards the
    // stale RF store whenever the parent graph identity changes so
    // toggling layers / scopes rebuilds the canvas cleanly.
    const nodes = rfNodes;
    const edges = rfEdges;

    const handleNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
        onNodeClick(node.id, node.data, event);
    }, [onNodeClick]);

    const handleNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
        event.preventDefault();
        if (onNodeRightClick) onNodeRightClick(node.id, node.data, event);
    }, [onNodeRightClick]);

    const handleEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
        onEdgeClick(edge.id, edge.data);
    }, [onEdgeClick]);

    const toggleLayer = useCallback((layer: MapLayer) => {
        setVisibleLayers(prev => {
            const next = new Set(prev);
            if (next.has(layer)) next.delete(layer); else next.add(layer);
            return next;
        });
    }, []);

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            {/* Header */}
            <div className="ca-header">
                <div className="ca-header-title">
                    <span className="ca-header-badge">Knowledge Map</span>
                    <span>{String(graph.meta?.label ?? graph.graphId)}</span>
                </div>
                <div className="ca-header-stats">
                    {ALL_LAYERS.map(layer => layerCounts[layer] > 0 && (
                        <span key={layer} className="ca-stat" title={LAYER_CONFIG[layer].label}>
                            <span aria-hidden>{LAYER_CONFIG[layer].icon}</span> {layerCounts[layer]}
                        </span>
                    ))}
                    {diffCounts.added > 0 && (
                        <span className="ca-stat"><span className="ca-stat-dot added" /> {diffCounts.added} added</span>
                    )}
                    {diffCounts.deleted > 0 && (
                        <span className="ca-stat"><span className="ca-stat-dot deleted" /> {diffCounts.deleted} deleted</span>
                    )}
                    {diffCounts.modified > 0 && (
                        <span className="ca-stat"><span className="ca-stat-dot modified" /> {diffCounts.modified} modified</span>
                    )}
                </div>
            </div>

            {/* Overlay toggle panel — floats top-right inside the canvas. */}
            <OverlayPanel
                visibleLayers={visibleLayers}
                onToggleLayer={toggleLayer}
                diffEnabled={diffEnabled}
                onToggleDiff={() => setDiffEnabled(d => !d)}
                layerCounts={layerCounts}
                diffCounts={diffCounts}
            />

            {/* React Flow canvas */}
            <ReactFlow
                key={(graph as any).graphId ?? 'map'}
                nodes={nodes}
                edges={edges}
                onNodeClick={handleNodeClick}
                onNodeContextMenu={handleNodeContextMenu}
                onEdgeClick={handleEdgeClick}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                minZoom={0.05}
                maxZoom={2.5}
                defaultEdgeOptions={{ type: 'smoothstep' }}
                proOptions={{ hideAttribution: true }}
            >
                <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
                <ForceMeasureNodes nodeIds={nodes.map(n => n.id)} />
                <Controls position="bottom-left" />
            </ReactFlow>
        </div>
    );
}

// ─── Overlay toggle panel ────────────────────────────────────────────────────

function OverlayPanel({
    visibleLayers,
    onToggleLayer,
    diffEnabled,
    onToggleDiff,
    layerCounts,
    diffCounts,
}: {
    visibleLayers: Set<MapLayer>;
    onToggleLayer: (l: MapLayer) => void;
    diffEnabled: boolean;
    onToggleDiff: () => void;
    layerCounts: Record<MapLayer, number>;
    diffCounts: { added: number; deleted: number; modified: number };
}) {
    const panelStyle: CSSProperties = {
        position: 'absolute',
        top: 56,
        right: 12,
        zIndex: 10,
        background: 'var(--ca-panel-bg, rgba(20,20,28,0.94))',
        border: '1px solid var(--ca-border)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 11,
        color: 'var(--ca-text)',
        minWidth: 180,
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    };
    const sectionTitle: CSSProperties = {
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        color: 'var(--ca-text-muted)',
        marginBottom: 4,
    };
    return (
        <div style={panelStyle}>
            <div>
                <div style={sectionTitle}>Layers</div>
                {ALL_LAYERS.map(layer => (
                    <Toggle
                        key={layer}
                        on={visibleLayers.has(layer)}
                        onChange={() => onToggleLayer(layer)}
                        label={`${LAYER_CONFIG[layer].icon} ${LAYER_CONFIG[layer].label}`}
                        count={layerCounts[layer]}
                        accent={LAYER_CONFIG[layer].accent}
                    />
                ))}
            </div>
            <div>
                <div style={sectionTitle}>Overlays</div>
                {/* Issue #752: the Diff toggle previously had no
                    always-visible state indicator — on a clean cycle
                    (no diff to render) clicking it produced no
                    observable change because the background colour
                    swap was the only signal. We now include the ON/OFF
                    text + a count of modified entities so the user
                    sees both the toggle state and what it would
                    affect. */}
                <Toggle
                    on={diffEnabled}
                    onChange={onToggleDiff}
                    label={`📊 Diff · ${diffEnabled ? 'ON' : 'OFF'}`}
                    count={
                        (diffCounts.modified + diffCounts.added + diffCounts.deleted) || undefined
                    }
                />
                {/* Issue #701 + #702 — disabled chips so layout doesn't
                    reshuffle when those features ship later. */}
                <Toggle on={false} onChange={() => {}} label="🧭 Domain" disabled hint="Coming with #701" />
                <Toggle on={false} onChange={() => {}} label="🗺 Tour" disabled hint="Coming with #702" />
            </div>
        </div>
    );
}

function Toggle({ on, onChange, label, count, accent, disabled, hint }: {
    on: boolean;
    onChange: () => void;
    label: string;
    count?: number;
    accent?: string;
    disabled?: boolean;
    hint?: string;
}) {
    const style: CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 6px',
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: on ? 'var(--ca-toggle-on-bg, rgba(91,141,239,0.18))' : 'transparent',
        opacity: disabled ? 0.4 : 1,
        userSelect: 'none' as const,
    };
    return (
        <div
            style={style}
            onClick={disabled ? undefined : onChange}
            title={hint ?? label}
            role="switch"
            aria-checked={on}
            aria-disabled={disabled || undefined}
        >
            {accent && (
                <span style={{
                    width: 8, height: 8, borderRadius: 2, background: accent,
                    opacity: on ? 1 : 0.3,
                }} aria-hidden />
            )}
            <span style={{ flex: 1 }}>{label}</span>
            {typeof count === 'number' && (
                <span style={{ color: 'var(--ca-text-muted)', fontSize: 10 }}>{count}</span>
            )}
        </div>
    );
}

export default memo(MapView);
