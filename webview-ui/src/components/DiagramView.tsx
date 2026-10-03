import { useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import ReactFlow, {
    Background,
    Controls,
    Node,
    Edge,
    useNodesState,
    useEdgesState,
    MarkerType,
    BackgroundVariant,
} from 'reactflow';
import 'reactflow/dist/style.css';
import AtlasNode from './AtlasNode';
import FlowNode from './FlowNode';
import ClassBlockNode from './ClassBlockNode';
import { ServiceNodeFallback } from './MicroserviceView';
import SequenceView from './SequenceView';
import FeatureView from './FeatureView';
import MicroserviceView from './MicroserviceView';
import MapView from './MapView';
import ApiListPanel from './ApiListPanel';
import ImpactPanel from './ImpactPanel';
import HealthDashboard from './HealthDashboard';
import { getLayoutedElements } from '../layout';

/**
 * Modes that DELEGATE rendering to a dedicated non-React-Flow component
 * (feature/domain → FeatureView, api-list/screen-content → ApiListPanel,
 * health → HealthDashboard). Those components lay themselves out from `graph`
 * and never read the Dagre-layouted nodes/edges, so DiagramView skips the
 * (expensive, synchronous) `graphToReactFlow` layout for them — see the
 * `layoutedNodes` useMemo. Exported so the contract is unit-testable: if a
 * delegated component ever starts consuming layoutedNodes, drop its mode here.
 */
export const DELEGATED_LAYOUT_MODES: ReadonlySet<string> = new Set([
    'feature', 'domain', 'health', 'api-list', 'screen-content',
]);
import { classBlockNodeHeight } from '../lib/classBlockHeight';
import { estimateFlowNodeWidth } from '../lib/flowNodeWidth';
import { EDGE_DIFF_COLORS } from '../diffColors';
import { ForceMeasureNodes } from './ForceMeasureNodes';

interface DiagramViewProps {
    graph: {
        graphId: string;
        type: string;
        nodes: any[];
        edges: any[];
        anchors: Record<string, any>;
        meta: Record<string, any>;
    };
    mode: 'sequence' | 'file' | 'flow' | 'feature' | 'microservice' | 'api-list' | 'health' | 'screen-content' | 'map' | 'domain';
    onNodeClick: (nodeId: string, nodeData: any, event?: React.MouseEvent) => void;
    onNodeRightClick?: (nodeId: string, nodeData: any, event?: React.MouseEvent) => void;
    onEdgeClick: (edgeId: string, edgeData: any) => void;
    impactData?: any | null;
    highlightedNodes?: Record<string, string>;
    highlightReasons?: Record<string, string>;
    commentCounts?: Record<string, number>;
    onImpactClose?: () => void;
    onImpactNavigate?: (filePath: string) => void;
    /** Tour playback: spotlight a single message edge in the L3 sequence view. */
    activeMessageEdgeId?: string;
    /** #750 (2026-06-06) — saved-views toolbar slot. Threaded through
     *  to the ApiListPanel header when the active mode is `api-list`. */
    savedViewsSlot?: React.ReactNode;
    /** #835 — `workspaceInfo.serviceCount`, threaded to MicroserviceView so
     *  the skeletal/bucketed multi-repo L1 header agrees with the home stat. */
    workspaceServiceCount?: number | null;
}

const nodeTypes = { atlasNode: AtlasNode, flowNode: FlowNode, classBlockNode: ClassBlockNode, serviceNode: ServiceNodeFallback };

const edgeDiffColors = EDGE_DIFF_COLORS;

function graphToReactFlow(graph: DiagramViewProps['graph'], direction: 'TB' | 'LR', highlightedNodes?: Record<string, string>) {
    const isFlow = graph.type === 'flow';
    
    // Filter out hidden nodes
    const visibleNodes = graph.nodes.filter(n => !n.hidden);
    
    const rfNodes: Node[] = visibleNodes.map((n) => {
        let type = isFlow ? 'flowNode' : 'atlasNode';
        if (!isFlow && n.meta && Array.isArray(n.meta.items)) {
            type = 'classBlockNode';
        }
        // Service nodes (from microservice graph fallback)
        if (n.type === 'service') {
            type = 'serviceNode';
        }

        return {
            id: n.id,
            type,
            data: {
                label: n.label,
                subtitle: n.subtitle,
                body: n.body,
                type: n.type,
                diff: n.diff,
                diffDetail: n.diffDetail,
                anchor: n.anchor,
                meta: n.meta, // For ServiceNode (technology, exposedApiCount) and AtlasNode (unused)
                items: n.meta?.items, // For ClassBlockNode
                // BUG-POLAR-5: size section/class blocks by their item count so the
                // Dagre layout allocates the box's true height (header + scrollable
                // list) and tall sections (e.g. 41 imports) don't overlap those below.
                ...(type === 'classBlockNode' && Array.isArray(n.meta?.items)
                    ? { height: classBlockNodeHeight((n.meta!.items as unknown[]).length) }
                    : {}),
                // BUG-POLAR-21: reserve accurate horizontal space for L5 flow
                // statement boxes (which render up to 340px) so wide sibling
                // branch nodes don't overlap in the Dagre layout.
                ...(isFlow
                    ? { width: estimateFlowNodeWidth([n.label, n.body].filter(Boolean).join('\n')) }
                    : {}),
                // #542 — thread the parent diagram's id + node id into each
                // node's data.
                graphId: graph.graphId,
                nodeId: n.id,
            },
            position: { x: 0, y: 0 },
        };
    });

    // Filter out hidden edges
    const visibleEdges = graph.edges.filter(e => !e.hidden);

    // Issue 124: Build set of node IDs that are NL-highlighted for edge coloring
    const nlHighlightedNodeIds = new Set<string>();
    if (highlightedNodes) {
        for (const n of visibleNodes) {
            const fp = n.anchor?.filePath;
            const sym = n.anchor?.symbol;
            const key = fp && sym ? `${fp}::${sym}` : undefined;
            if (key && highlightedNodes[key] === 'nl-query') nlHighlightedNodeIds.add(n.id);
            else if (fp && highlightedNodes[`${fp}::*`] === 'nl-query') nlHighlightedNodeIds.add(n.id);
        }
    }

    const rfEdges: Edge[] = visibleEdges.map((e) => {
        const hasDiff = e.diff && e.diff !== 'unchanged';
        // Issue 124: Blue edge when both endpoints are NL-highlighted (diff takes priority)
        const bothNlHighlighted = !hasDiff && nlHighlightedNodeIds.has(e.source) && nlHighlightedNodeIds.has(e.target);
        const color = bothNlHighlighted ? 'var(--ca-nl-query)' : (edgeDiffColors[e.diff || 'unchanged'] || edgeDiffColors.unchanged);
        const isDeleted = e.diff === 'deleted';

        return {
            id: e.id,
            source: e.source,
            target: e.target,
            label: e.label || '',
            type: 'smoothstep',
            animated: e.diff === 'added',
            style: {
                stroke: color,
                strokeWidth: bothNlHighlighted ? 2 : (isDeleted ? 1 : 1.5),
                strokeDasharray: isDeleted ? '6,4' : (e.meta as any)?.loopBack ? '4,3' : undefined,
                opacity: isDeleted ? 0.5 : (e.meta as any)?.loopBack ? 0.6 : 1,
            },
            labelStyle: {
                fontSize: 10,
                fontFamily: "'Inter', system-ui",
                fill: 'var(--ca-edge-label-text)',
                fontWeight: e.diff === 'added' || e.diff === 'deleted' ? 600 : 400,
            },
            labelBgStyle: {
                fill: 'var(--ca-label-bg)',
                fillOpacity: 1,
            },
            markerEnd: {
                type: MarkerType.ArrowClosed,
                color,
                width: 12,
                height: 12,
            },
            data: { diff: e.diff, anchor: graph.anchors?.[e.id] },
        };
    });

    return getLayoutedElements(rfNodes, rfEdges, direction);
}

function DiagramView({ graph, mode, onNodeClick, onNodeRightClick, onEdgeClick, impactData, highlightedNodes, highlightReasons, commentCounts, onImpactClose, onImpactNavigate, activeMessageEdgeId, savedViewsSlot, workspaceServiceCount }: DiagramViewProps) {
    const direction = mode === 'flow' ? 'TB' : (mode === 'file' ? 'LR' : 'LR');
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Issue 193: Proper cleanup for classBlockItemClick listener
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const handler = (e: Event) => {
            const customEvent = e as CustomEvent;
            const { nodeId, nodeData } = customEvent.detail;
            onNodeClick(nodeId, nodeData, customEvent as unknown as React.MouseEvent);
        };
        el.addEventListener('classBlockItemClick', handler);
        return () => el.removeEventListener('classBlockItemClick', handler);
    }, [onNodeClick]);

    const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
        () => {
            // PERF (2026-07-20, "slow L1→L2a open") — modes that delegate to a
            // dedicated non-React-Flow renderer read `graph` directly and NEVER
            // consume `layoutedNodes`/`layoutedEdges`:
            //   • feature / domain → <FeatureView>
            //   • api-list / screen-content → <ApiListPanel>
            //   • health → <HealthDashboard>
            // Running graphToReactFlow (a synchronous Dagre layout) for them was
            // pure waste — measured ~630ms per L2a open on polar's 119-node/
            // 395-edge `feature:server` graph, which was the ENTIRE client-side
            // delay between the graph arriving (~30ms) and the list painting.
            // Skip the layout for those modes; the delegated component lays itself
            // out. React-Flow modes (file/flow/sequence/microservice/map) still
            // compute normally below.
            if (DELEGATED_LAYOUT_MODES.has(mode)) {
                return { nodes: [], edges: [] };
            }
            return graphToReactFlow(graph, direction, highlightedNodes);
        },
        [graph, direction, highlightedNodes, mode]
    );

    // Apply blast-radius / NL-query highlight rings + comment badges to matching nodes
    const displayNodes = useMemo(() => {
        const hasHighlights = highlightedNodes && Object.keys(highlightedNodes).length > 0;
        const hasComments = commentCounts && Object.keys(commentCounts).length > 0;
        if (!hasHighlights && !hasComments) return layoutedNodes;
        return layoutedNodes.map((n) => {
            // Inject comment count from local state
            let updatedData = n.data;
            if (hasComments && commentCounts[n.id] != null) {
                updatedData = { ...updatedData, meta: { ...updatedData.meta, commentCount: commentCounts[n.id] } };
            }
            const fp = updatedData?.anchor?.filePath;
            const sym = updatedData?.anchor?.symbol;
            const key = fp && sym ? `${fp}::${sym}` : undefined;
            // Check direct key match or file-level wildcard match (Issue 118)
            const impactKind = key && highlightedNodes ? highlightedNodes[key] : undefined;
            const wildcardKind = !impactKind && fp && highlightedNodes ? highlightedNodes[`${fp}::*`] : undefined;
            const matchedKind = impactKind ?? wildcardKind;
            if (!matchedKind) {
                // No highlight — return node with just comment data update
                return updatedData !== n.data ? { ...n, data: updatedData } : n;
            }
            const matchedKey = impactKind ? key! : `${fp}::*`;
            const color = matchedKind === 'direct' ? 'var(--ca-danger)'
                : matchedKind === 'transitive' ? 'var(--ca-warning)'
                : matchedKind === 'nl-query' ? 'var(--ca-nl-query)'
                : 'var(--ca-modified-border)'; // review-required
            const reason = highlightReasons?.[matchedKey];
            return {
                ...n,
                style: { ...n.style, outline: `2px solid ${color}`, outlineOffset: '2px', borderRadius: '6px' },
                data: { ...updatedData, ...(reason ? { matchReason: reason } : {}) },
            };
        });
    }, [layoutedNodes, highlightedNodes, highlightReasons, commentCounts]);

    // Pass derived `displayNodes` / `layoutedEdges` as CONTROLLED props. This is
    // the known-good approach (2026-06-09): it fixes overlay propagation AND —
    // critically — avoids the `useNodesState` + effect-sync "edges race" where
    // the first render has an empty node set while edges are already present, so
    // EdgeRenderer skips every edge (intermittent 0-edges on L4/L5). A
    // `useNodesState`-based drag fix reintroduced that race and was reverted;
    // node dragging needs a race-free implementation (a position-override map
    // over these controlled nodes, not `useNodesState`) — tracked in ISSUES.md.
    const nodes = displayNodes;
    const edges = layoutedEdges;

    const handleNodeClick = useCallback((e: React.MouseEvent, node: Node) => {
        onNodeClick(node.id, node.data, e);
    }, [onNodeClick]);

    const handleNodeRightClick = useCallback((e: React.MouseEvent, node: Node) => {
        e.preventDefault();
        onNodeRightClick?.(node.id, node.data, e);
    }, [onNodeRightClick]);

    const handleEdgeClick = useCallback((_: any, edge: Edge) => {
        onEdgeClick(edge.id, edge.data);
    }, [onEdgeClick]);

    // Compute diff stats (exclude structural/container nodes)
    const stats = useMemo(() => {
        const semanticNodes = graph.nodes.filter((n) => n.type !== 'section' && n.type !== 'file');
        const added = semanticNodes.filter((n) => n.diff === 'added').length;
        const deleted = semanticNodes.filter((n) => n.diff === 'deleted').length;
        const modified = semanticNodes.filter((n) => n.diff === 'modified').length;
        return { added, deleted, modified, total: semanticNodes.length };
    }, [graph]);

    // API list mode: interactive list of APIs and subsystem files in a feature cluster
    // v2 phase 4 #485 — screen-content mode also routes here: the
    // panel detects `meta.screenItems` and switches to the 5-section
    // FE/mobile layout. Backend api-list graphs continue with the
    // existing 10-section HTTP renderer.
    if (mode === 'api-list' || mode === 'screen-content') {
        const handleApiClick = (api: any, e?: React.MouseEvent) => {
            onNodeClick(api.apiId, { type: 'api', meta: { apiId: api.apiId }, anchor: { filePath: api.filePath } }, e);
        };
        const handleFileClick = (filePath: string, e?: React.MouseEvent) => {
            onNodeClick(filePath, { type: 'file', anchor: { filePath } }, e);
        };
        return (
            <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                <ApiListPanel
                    graph={graph}
                    onApiClick={handleApiClick}
                    onFileClick={handleFileClick}
                    highlightedNodes={highlightedNodes}
                    savedViewsSlot={savedViewsSlot}
                />
                {impactData && onImpactClose && (
                    <ImpactPanel impact={impactData} onClose={onImpactClose} onNavigate={onImpactNavigate ?? (() => {})} />
                )}
            </div>
        );
    }

    // Health dashboard mode
    if (mode === 'health') {
        return (
            <div style={{ width: '100%', height: '100%', overflow: 'auto', background: 'var(--ca-bg)' }}>
                <HealthDashboard
                    health={graph.meta?.health ?? { deadFunctions: [], godFiles: [], highCouplingFiles: [], cyclicDependencies: [], orphanedClusters: [] }}
                    onNavigate={(fp) => onNodeClick(fp, { type: 'file', anchor: { filePath: fp } })}
                />
            </div>
        );
    }

    // Feature and microservice modes use dedicated views
    // Issue #701 / #735 — Domain mode shares FeatureView's cluster-graph
    // shape, so it routes here too. The Modules ↔ Domains toggle on
    // FeatureView's header lets the user swap between Louvain
    // (`feature:workspace`) and heuristic Domain (`domain:workspace`)
    // clusterings without leaving the canvas.
    if (mode === 'feature' || mode === 'domain') {
        return (
            <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                <FeatureView
                    graph={graph}
                    onNodeClick={onNodeClick}
                    onNodeRightClick={onNodeRightClick}
                    onEdgeClick={onEdgeClick}
                    highlightedNodes={highlightedNodes}
                    commentCounts={commentCounts}
                />
                {impactData && onImpactClose && (
                    <ImpactPanel impact={impactData} onClose={onImpactClose} onNavigate={onImpactNavigate ?? (() => {})} />
                )}
            </div>
        );
    }

    if (mode === 'microservice') {
        return (
            <div key="microservice-view" style={{ width: '100%', height: '100%', position: 'relative' }}>
                <MicroserviceView
                    graph={graph}
                    onNodeClick={onNodeClick}
                    onNodeRightClick={onNodeRightClick}
                    onEdgeClick={onEdgeClick}
                    highlightedNodes={highlightedNodes}
                    commentCounts={commentCounts}
                    workspaceServiceCount={workspaceServiceCount}
                />
                {impactData && onImpactClose && (
                    <ImpactPanel impact={impactData} onClose={onImpactClose} onNavigate={onImpactNavigate ?? (() => {})} />
                )}
            </div>
        );
    }

    // For sequence mode, use dedicated SequenceView with swimlane layout
    if (mode === 'sequence') {
        return (
            <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                <SequenceView
                    graph={graph}
                    onNodeClick={onNodeClick}
                    onNodeRightClick={onNodeRightClick}
                    onEdgeClick={onEdgeClick}
                    highlightedNodes={highlightedNodes}
                    commentCounts={commentCounts}
                    activeMessageEdgeId={activeMessageEdgeId}
                />
                {impactData && onImpactClose && (
                    <ImpactPanel impact={impactData} onClose={onImpactClose} onNavigate={onImpactNavigate ?? (() => {})} />
                )}
            </div>
        );
    }

    // Issue #700 — Map mode routes to the dedicated MapView with per-layer
    // accent + overlay toggle panel. The earlier modeLabel fallback below
    // still applies as belt-and-suspenders in case MapView fails to render.
    // Issue #700 Knowledge Map — single-canvas unified diagram. Routes
    // through MapView for the per-layer accent + overlay toggle panel.
    if (mode === 'map') {
        return (
            <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                <MapView
                    graph={graph}
                    onNodeClick={onNodeClick}
                    onNodeRightClick={onNodeRightClick}
                    onEdgeClick={onEdgeClick}
                    commentCounts={commentCounts}
                />
                {impactData && onImpactClose && (
                    <ImpactPanel impact={impactData} onClose={onImpactClose} onNavigate={onImpactNavigate ?? (() => {})} />
                )}
            </div>
        );
    }

    // Generic React Flow fallback for any modes not handled above. By this
    // point the type narrows to `'file' | 'flow'` since every other case
    // returned earlier.
    const modeLabel = mode === 'file' ? 'File Dependency' : 'Function Flow';
    const graphTitle = graph.meta?.fileName || graph.meta?.functionName || graph.graphId;

    return (
        <div 
            style={{ width: '100%', height: '100%', position: 'relative' }}
            ref={(el) => {
                // Issue 193: Store ref for useEffect cleanup — see classBlockRef below
                (containerRef as any).current = el;
            }}
        >
            {/* Header */}
            <div className="ca-header">
                <div className="ca-header-title">
                    <span className="ca-header-badge">{modeLabel}</span>
                    <span>{graphTitle}</span>
                </div>
                <div className="ca-header-stats">
                    <span className="ca-stat">Nodes: {stats.total}</span>
                    {stats.added > 0 && (
                        <span className="ca-stat"><span className="ca-stat-dot added" /> {stats.added} added</span>
                    )}
                    {stats.deleted > 0 && (
                        <span className="ca-stat"><span className="ca-stat-dot deleted" /> {stats.deleted} deleted</span>
                    )}
                    {stats.modified > 0 && (
                        <span className="ca-stat"><span className="ca-stat-dot modified" /> {stats.modified} modified</span>
                    )}
                </div>
            </div>
            {/* 2026-06-09 — L5 fallback banner. The L3 sequence handler
                redirects to this view when the API's handler has no
                intra-service call chain (typical for terminal Lambdas).
                The banner tells the user what they clicked + why they're
                here so the redirection doesn't feel like a missed click. */}
            {mode === 'flow' && (graph.meta as any)?.fallbackFromSequence && (graph.meta as any)?.originalApi && (
                <div style={{
                    padding: '6px 12px',
                    background: 'var(--vscode-editorWarning-background, rgba(255, 200, 0, 0.08))',
                    borderBottom: '1px solid var(--vscode-editorWarning-border, rgba(255, 200, 0, 0.3))',
                    fontSize: 12,
                    color: 'var(--vscode-foreground)',
                }}>
                    No call chain detected for{' '}
                    <strong>
                        {(graph.meta as any).originalApi.method} {(graph.meta as any).originalApi.route}
                    </strong>
                    {' '}— showing the handler's control flow instead.
                </div>
            )}

            {/* React Flow canvas */}
            <ReactFlow
                key={graph?.graphId ?? 'diagram'}
                nodes={nodes}
                edges={edges}
                onNodeClick={handleNodeClick}
                onNodeContextMenu={handleNodeRightClick}
                onEdgeClick={handleEdgeClick}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                minZoom={0.05}
                maxZoom={2.5}
                defaultEdgeOptions={{ type: 'smoothstep' }}
                proOptions={{ hideAttribution: true }}
            >
                <Background variant={BackgroundVariant.Dots} gap={16} size={1} color={getComputedStyle(document.documentElement).getPropertyValue('--ca-dot-grid').trim() || '#888'} />
                <Controls position="bottom-left" />
                <ForceMeasureNodes nodeIds={nodes.map(n => n.id)} />
            </ReactFlow>

            {/* Blast radius overlay */}
            {impactData && onImpactClose && (
                <ImpactPanel impact={impactData} onClose={onImpactClose} onNavigate={onImpactNavigate ?? (() => {})} />
            )}
        </div>
    );
}

export default DiagramView;

