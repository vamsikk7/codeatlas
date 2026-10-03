/**
 * MicroserviceView.tsx
 *
 * Renders the Microservice layer — a service interaction diagram showing
 * detected services and their inter-service call relationships.
 *
 * Each service node shows:
 * - Service name + technology badge (Express, NestJS, etc.)
 * - API count and root path
 * - Diff status overlay
 *
 * Clicking a service → zooms into its feature clusters.
 * External system nodes show 3rd-party dependencies.
 */

import React, { useMemo, useCallback, useEffect, useRef, CSSProperties, memo } from 'react';
import ReactFlow, {
    Background,
    Controls,
    Handle,
    Node,
    Edge,
    Position,
    useNodesState,
    useEdgesState,
    MarkerType,
    BackgroundVariant,
    type ReactFlowInstance,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { getLayoutedElements, getLayeredMapLayout } from '../layout';
import { deriveSubgroup } from './MapView';
import { ForceMeasureNodes } from './ForceMeasureNodes';
import { EDGE_DIFF_COLORS, NODE_DIFF_COLORS, DIFF_SYMBOLS, DIFF_BORDER_STYLES } from '../diffColors';
import { formatRepoChipLabel, formatRepoChipTooltip } from '../lib/formatRepoChipLabel';
import { resolveL1ServiceHeader, formatL1HeaderCaption } from '../lib/l1HeaderStats';
import { collectRepoLegend, repoAccentColor } from '../lib/repoLegend';
// ADR-034 Phase E Pass 3 (#790) — extracted failure card for reuse.
import FailedRepoFallback from './FailedRepoFallback';

interface MicroserviceViewProps {
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
    highlightedNodes?: Record<string, string>;
    commentCounts?: Record<string, number>;
    /** #835 — `workspaceInfo.serviceCount`, the home page's SERVICES stat.
     *  On a skeletal/bucketed multi-repo L1 the header captions THIS number
     *  (nodes are repos/buckets there, not services); see ADR-036. */
    workspaceServiceCount?: number | null;
}

const diffColors = NODE_DIFF_COLORS;
const edgeDiffColors = EDGE_DIFF_COLORS;

const TECH_COLORS_DARK: Record<string, string> = {
    // JS/TS
    express: '#68d391', fastify: '#63b3ed', nestjs: '#fc8181', koa: '#f6ad55',
    // Python
    django: '#44b884', flask: '#a0aec0', fastapi: '#009688',
    // Java
    spring: '#6db33f', micronaut: '#a0aec0',
    // Go
    gin: '#00add8', echo: '#00add8', chi: '#00add8', fiber: '#00add8',
    // Rust
    actix: '#dea584', axum: '#dea584', rocket: '#dea584',
    // C#
    aspnet: '#512bd4',
    // PHP
    laravel: '#ff2d20', symfony: '#a0aec0',
    // Ruby
    rails: '#cc0000', sinatra: '#cc0000',
    // Swift
    vapor: '#a0aec0',
    // Fallback
    unknown: '#a0aec0',
};

const TECH_COLORS_LIGHT: Record<string, string> = {
    // JS/TS
    express: '#16a34a', fastify: '#2563eb', nestjs: '#dc2626', koa: '#d97706',
    // Python
    django: '#15803d', flask: '#4b5563', fastapi: '#0d9488',
    // Java
    spring: '#4d7c0f', micronaut: '#4b5563',
    // Go
    gin: '#0284c7', echo: '#0284c7', chi: '#0284c7', fiber: '#0284c7',
    // Rust
    actix: '#c2410c', axum: '#c2410c', rocket: '#c2410c',
    // C#
    aspnet: '#6d28d9',
    // PHP
    laravel: '#dc2626', symfony: '#4b5563',
    // Ruby
    rails: '#b91c1c', sinatra: '#b91c1c',
    // Swift
    vapor: '#4b5563',
    // Fallback
    unknown: '#6b7280',
};

function getTechColor(tech: string): string {
    const isLight = document.documentElement.dataset.theme === 'light';
    const map = isLight ? TECH_COLORS_LIGHT : TECH_COLORS_DARK;
    return map[tech] ?? map.unknown;
}

/**
 * Deterministic colour hash so each detected repo gets a consistent accent
 * across renders. Multi-repo mode only — single-repo workspaces don't
 * surface a `repoId` and inherit the default styling.
 */
function ServiceNode({ data }: { data: any }) {
    const diff = data.diff || 'unchanged';
    const isExternal = data.meta?.external === true;
    const colors = diffColors[diff] || diffColors.unchanged;
    const isDeleted = diff === 'deleted';
    const tech = data.meta?.technology ?? 'unknown';
    const techColor = getTechColor(tech);
    const repoId = data.meta?.repoId as string | undefined;
    const repoColor = repoId ? repoAccentColor(repoId) : null;

    const isInfra = data.meta?.infra === true;
    const infraKind = data.meta?.kind as string | undefined;

    function infraIcon() {
        if (!isInfra) return isExternal ? '🌐' : '⬡';
        if (infraKind === 'database') return '🗄️';
        if (infraKind === 'cache') return '⚡';
        if (infraKind === 'queue') return '📨';
        return '🔌';
    }

    // Infra nodes use diff colors when changed, dark neutral when unchanged
    const infraChanged = isInfra && diff !== 'unchanged';
    const containerStyle: CSSProperties = {
        background: infraChanged ? colors.bg : isInfra ? 'var(--ca-infra-bg)' : isExternal ? 'var(--ca-external-bg)' : colors.bg,
        border: `2px ${DIFF_BORDER_STYLES[diff] || 'solid'} ${infraChanged ? colors.border : isInfra ? 'var(--ca-infra-border)' : isExternal ? 'var(--ca-border)' : colors.border}`,
        // Multi-repo grouping: paint a 4px coloured stripe on the left edge
        // keyed off the owning repo. The stripe overrides the inherited
        // border-left so the per-repo accent reads clearly.
        ...(repoColor ? { borderLeft: `4px solid ${repoColor}` } : {}),
        borderRadius: isInfra ? 8 : 14,
        padding: '14px 18px',
        minWidth: isInfra || isExternal ? 130 : 180,
        maxWidth: 260,
        boxShadow: infraChanged
            ? `0 4px 16px ${colors.glow}, 0 1px 4px rgba(0,0,0,0.4)`
            : isInfra || isExternal ? 'none'
            : `0 4px 16px ${colors.glow}, 0 1px 4px rgba(0,0,0,0.4)`,
        opacity: isDeleted ? 0.7 : 1,
        cursor: isInfra ? 'default' : 'pointer',
        fontFamily: "'Inter', system-ui, sans-serif",
        position: 'relative' as const,
    };

    return (
        <div style={{ position: 'relative' }}>
            <div style={containerStyle}>
                {/* Service icon + name */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>{infraIcon()}</span>
                    <span style={{
                        fontSize: 13,
                        fontWeight: 700,
                        color: isDeleted ? 'var(--ca-deleted-text)' : 'var(--ca-text)',
                        textDecoration: isDeleted ? 'line-through' : 'none',
                    }}>
                        {data.label}
                    </span>
                    {data.meta?.commentCount > 0 && (
                        // Issue 134: click opens the Comments Panel
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('codeatlas:open-comments')); }}
                            style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 8, background: 'var(--ca-accent)', color: '#fff', flexShrink: 0, border: 'none', cursor: 'pointer' }}
                            title={`${data.meta.commentCount} comment${data.meta.commentCount > 1 ? 's' : ''} — click to open Comments`}
                            aria-label={`Open ${data.meta.commentCount} comment${data.meta.commentCount > 1 ? 's' : ''}`}
                        >
                            💬{data.meta.commentCount}
                        </button>
                    )}
                    {diff !== 'unchanged' && (
                        <span style={{
                            marginLeft: 'auto',
                            fontSize: 8,
                            fontWeight: 700,
                            padding: '2px 6px',
                            borderRadius: 8,
                            background: colors.border,
                            color: 'var(--ca-bg)',
                            textTransform: 'uppercase',
                        }}>{DIFF_SYMBOLS[diff]} {diff}</span>
                    )}
                </div>

                {/* Repo chip — only renders in multi-repo workspaces.
                    UX-19: prefer `repoName` / `rootPath` over the raw hex
                    repoId so the chip reads `api` not `dc2ef130f90896f2`.
                    Full repoId stays in the tooltip for copy/grep.
                    2026-06-09: skip the chip when its label equals the
                    service node's primary label — common in workspace
                    rollups (`buildWorkspaceMapGraph` writes the repo
                    name as the node label AND surfaces it as rootPath),
                    where the chip is pure visual noise. */}
                {(() => {
                    if (!repoId || !repoColor || isInfra) return null;
                    const chipLabel = formatRepoChipLabel({ repoId, repoName: data.meta?.repoName, rootPath: data.meta?.rootPath });
                    if (chipLabel === String(data.label ?? '')) return null;
                    return (
                        <div
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                marginTop: 6,
                                fontSize: 9,
                                fontWeight: 600,
                                padding: '1px 7px',
                                borderRadius: 8,
                                background: `${repoColor}22`,
                                color: repoColor,
                                border: `1px solid ${repoColor}55`,
                                maxWidth: '100%',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                            }}
                            title={formatRepoChipTooltip({ repoId, repoName: data.meta?.repoName, rootPath: data.meta?.rootPath })}
                        >
                            <span style={{ opacity: 0.7, fontSize: 8 }}>repo</span>
                            <span>{chipLabel}</span>
                        </div>
                    );
                })()}

                {!isExternal && !isInfra && (
                    <>
                        {/* Tech badge — hidden when technology is unknown */}
                        {tech !== 'unknown' && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                                <span style={{
                                    fontSize: 9,
                                    padding: '1px 6px',
                                    borderRadius: 8,
                                    background: `${techColor}22`,
                                    color: techColor,
                                    fontWeight: 600,
                                    border: `1px solid ${techColor}44`,
                                }}>
                                    {tech.toUpperCase()}
                                </span>
                            </div>
                        )}

                        {/* Stats */}
                        <div style={{ marginTop: 8, fontSize: 10, color: 'var(--ca-accent)' }}>
                            {/* Phase 2 #6 residual (2026-06-07): FE / mobile
                                services render `N API calls consumed`
                                because they don't expose HTTP routes —
                                they CALL backend services. Backend services
                                keep the v65 `N HTTP routes exposed` label.
                                Switch is driven by `meta.category`. */}
                            {(() => {
                                const cat = (data.meta as any)?.category;
                                const isFE = cat === 'frontend' || cat === 'mobile';
                                if (isFE) {
                                    const c = (data.meta as any)?.consumedApiCount ?? 0;
                                    if (c === 0) return null;
                                    return (
                                        <div
                                            title="Outbound API calls (fetch / axios / useQuery / Dio / URLSession etc.) this service makes to other services."
                                        >
                                            📡 {c} API call{c !== 1 ? 's' : ''} consumed
                                        </div>
                                    );
                                }
                                const e = data.meta?.exposedApiCount ?? 0;
                                if (e === 0) return null;
                                return (
                                    <div
                                        title="HTTP-reachable entry points exposed by this service. The home page 'APIs' counter shows every entry point including middleware, signals, and background jobs."
                                    >
                                        🔗 {e} HTTP route{e !== 1 ? 's' : ''} exposed
                                    </div>
                                );
                            })()}
                            {data.meta?.rootPath && data.meta.rootPath !== String(data.label ?? '') && (
                                <div style={{ color: 'var(--ca-text-muted)', marginTop: 2, fontFamily: "'SF Mono', monospace", fontSize: 9 }}>
                                    {data.meta.rootPath || '.'}
                                </div>
                            )}
                        </div>

                        {/* Consumed services */}
                        {data.meta?.consumedServices?.length > 0 && (
                            <div style={{ marginTop: 6, fontSize: 9, color: 'var(--ca-text-muted)' }}>
                                Calls: {(data.meta.consumedServices as string[]).map((s: string) => s.replace('service:', '')).join(', ')}
                            </div>
                        )}
                    </>
                )}

                {(isExternal || isInfra) && (
                    <div style={{ fontSize: 9, color: 'var(--ca-text-muted)', marginTop: 4 }}>
                        {isInfra ? `«${infraKind ?? 'external'}»` : '«external»'}
                    </div>
                )}

                {/* ADR-034 Phase E (#790) — per-repo init status surfaces here.
                    Skeletal L1 (`buildSkeletalL1`) sets meta.status to
                    'parsing' | 'ready' | 'failed' | 'stale'. */}
                {!isExternal && !isInfra && data.meta?.status === 'parsing' && (
                    <div style={{ marginTop: 8, fontSize: 9, color: 'var(--ca-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{
                            display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                            background: 'var(--ca-accent)',
                            animation: 'pulse 1.4s ease-in-out infinite',
                        }} />
                        Indexing…
                    </div>
                )}
                {!isExternal && !isInfra && data.meta?.status === 'failed' && (
                    <FailedRepoFallback
                        repoName={String(data.label ?? '')}
                        errorMessage={data.meta?.errorMessage ? String(data.meta.errorMessage) : undefined}
                        compact
                        onRetry={() => {
                            const repoId = data.meta?.repoId;
                            if (!repoId) return;
                            if (window.vscodeApi) {
                                window.vscodeApi.postMessage({ type: 'retryRepo', repoId });
                            } else {
                                window.postMessage({ type: 'retryRepo', repoId }, '*');
                            }
                        }}
                    />
                )}
                {!isExternal && !isInfra && data.meta?.status === 'stale' && (
                    <div style={{ marginTop: 8, fontSize: 9, color: '#d97706', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#d97706' }} />
                        Schema outdated — re-init needed
                    </div>
                )}

                {/* Drill-down affordance for clickable service nodes — hidden
                    when this node is in a non-ready terminal state since the
                    drill-in would show empty data. Pass 3 will replace this
                    with the FailedRepoFallback drill-in. */}
                {!isExternal && !isInfra && (!data.meta?.status || data.meta.status === 'ready') && (
                    <div style={{ marginTop: 8, fontSize: 9, color: 'var(--ca-text-muted)', textAlign: 'right', opacity: 0.6 }}>
                        Explore features →
                    </div>
                )}
            </div>
            {/* React Flow connection handles */}
            <Handle
                type="target"
                position={Position.Left}
                style={{ left: -5, width: 10, height: 10, borderRadius: '50%', background: isExternal ? 'var(--ca-edge-unchanged)' : colors.border, border: 'none' }}
            />
            <Handle
                type="source"
                position={Position.Right}
                style={{ right: -5, width: 10, height: 10, borderRadius: '50%', background: isExternal ? 'var(--ca-edge-unchanged)' : colors.border, border: 'none' }}
            />
        </div>
    );
}

const MemoServiceNode = memo(ServiceNode);
export const ServiceNodeFallback = MemoServiceNode;
const nodeTypes = { serviceNode: MemoServiceNode };

function msGraphToReactFlow(graph: MicroserviceViewProps['graph']) {
    // Issue #790 #8 — for service-heavy monorepos (132 sub-projects in
    // serverless/examples) attach a `layer` + `subgroup` to each node
    // so the layered map layout bands services by cloud (aws / azure /
    // google / openwhisk / ...) and stacks infra / databases / externals
    // in their own columns. Below the threshold the existing Dagre LR
    // path is unchanged, so small workspaces keep their nuanced
    // flow-with-edges rendering.
    const LAYERED_THRESHOLD = 24;
    const useLayered = graph.nodes.length > LAYERED_THRESHOLD;
    const rfNodes: Node[] = graph.nodes.map((n) => {
        const baseData: any = {
            label: n.label,
            subtitle: n.subtitle,
            diff: n.diff,
            type: n.type,
            meta: n.meta,
            anchor: n.anchor,
        };
        if (useLayered) {
            // Layer assignment: services first, then databases/infra/externals.
            // Mirrors the L2 Knowledge Map's layered taxonomy.
            // Issue #790 #8 follow-up — infra nodes built by
            // `enrichWithInfra` carry `type: 'service'` (the L1 schema's
            // common type) but `meta.infra: true` + `meta.external: true`.
            // Check both the type field and the meta flags so they band
            // into the infrastructure column instead of mixing into the
            // service grid.
            const meta: any = n.meta ?? {};
            const isExternal = n.type === 'external' || meta.external === true;
            const isInfra = n.type === 'infrastructure' || n.type === 'database' || meta.infra === true;
            baseData.layer = isInfra ? 'infrastructure' : (isExternal ? 'api' : 'service');
            baseData.subgroup = isInfra || isExternal ? '' : deriveSubgroup(n.label);
        }
        return {
            id: n.id,
            type: 'serviceNode',
            data: baseData,
            position: { x: 0, y: 0 },
        };
    });

    const rfEdges: Edge[] = graph.edges.map((e) => {
        const color = edgeDiffColors[e.diff || 'unchanged'] ?? edgeDiffColors.unchanged;
        return {
            id: e.id,
            source: e.source,
            target: e.target,
            label: e.label ?? '',
            type: 'smoothstep',
            animated: e.diff === 'added',
            style: {
                stroke: color,
                strokeWidth: 2.5,
                strokeDasharray: e.diff === 'deleted' ? '6,4' : e.diff === 'modified' ? '3,3' : undefined,
                opacity: e.diff === 'deleted' ? 0.45 : 1,
            },
            labelStyle: { fontSize: 10, fill: 'var(--ca-edge-label-text)', fontFamily: "'Inter', sans-serif", fontWeight: 500 },
            labelBgStyle: { fill: 'var(--ca-label-bg)', fillOpacity: 1 },
            markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
            data: { diff: e.diff, anchor: graph.anchors?.[e.id] },
        };
    });

    // Issue #790 #8 — route through `getLayeredMapLayout` when the L1
    // graph has many service nodes. The layered layout bands by `layer`
    // and sorts each band by `subgroup` (cloud prefix), so the user
    // can scan e.g. "all aws lambdas" or "everything talking to S3"
    // by visual column instead of hunting a flat grid.
    if (useLayered) {
        return getLayeredMapLayout(rfNodes, rfEdges, 240, 80);
    }
    return getLayoutedElements(rfNodes, rfEdges, 'LR');
}

function MicroserviceView({ graph, onNodeClick, onNodeRightClick, onEdgeClick, highlightedNodes, commentCounts, workspaceServiceCount }: MicroserviceViewProps) {
    const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
        () => msGraphToReactFlow(graph),
        [graph]
    );

    // Apply comment counts + NL query highlights to service nodes
    const displayNodes = useMemo(() => {
        let base = layoutedNodes;
        // Inject comment counts
        if (commentCounts && Object.keys(commentCounts).length > 0) {
            base = base.map(n => {
                const count = commentCounts[n.id];
                if (!count) return n;
                return { ...n, data: { ...n.data, meta: { ...n.data.meta, commentCount: count } } };
            });
        }
        if (!highlightedNodes || Object.keys(highlightedNodes).length === 0) return base;
        const nlFiles = new Set<string>();
        for (const key of Object.keys(highlightedNodes)) {
            if (highlightedNodes[key] === 'nl-query') nlFiles.add(key.split('::')[0]);
        }
        if (nlFiles.size === 0) return base;
        return base.map((n) => {
            const rootPath = n.data?.meta?.rootPath;
            if (!rootPath) return n;
            // Issue 122: Use directory boundary to avoid false positives (auth vs auth-shared)
            const prefix = rootPath.endsWith('/') ? rootPath : rootPath + '/';
            const hasMatch = [...nlFiles].some(fp => fp.startsWith(prefix) || fp === rootPath);
            if (!hasMatch) return n;
            return { ...n, style: { ...n.style, outline: '2px solid var(--ca-nl-query)', outlineOffset: '2px', borderRadius: '8px' } };
        });
    }, [layoutedNodes, highlightedNodes, commentCounts]);

    // 2026-06-09 — pass derived `displayNodes` / `layoutedEdges` directly
    // as ReactFlow's `defaultNodes` / `defaultEdges`. The legacy pattern
    // (`useNodesState` + `useEffect → setNodes`) hit a race where edges
    // landed in RF's zustand store BEFORE nodes were registered with
    // handleBounds, so `EdgeRenderer.useVisibleEdges` skipped every edge
    // and the inner `<g>` rendered empty. Using `defaultNodes`/`defaultEdges`
    // hands the FULL initial snapshot to RF during `applyDefault` in a
    // single store mutation, so both arrays land atomically. The trade-
    // off: RF owns the state internally (drag offsets, selection); for
    // our auto-layout views that's the desired behaviour.
    const nodes = displayNodes;
    const edges = layoutedEdges;

    // 2026-06-03 — Phase 2 finding: ReactFlow's `fitView` prop only fires on
    // initial mount. With useNodesState + useEffect pattern, nodes arrive in a
    // second render pass; the initial fit measured against an empty/partial
    // graph picks a wrong zoom. For multi-service workspaces (kotlin-ktor 31,
    // go-fiber recipes 85), the result is a tiny diagram in the corner of a
    // large empty viewport. Capture the instance via onInit and re-fit after
    // every displayNodes change. `duration: 0` skips the slide animation.
    const flowRef = useRef<ReactFlowInstance | null>(null);
    const onFlowInit = useCallback((instance: ReactFlowInstance) => {
        flowRef.current = instance;
    }, []);

    useEffect(() => {
        // Re-fit after nodes settle. Run on a microtask + RAF so React Flow
        // finishes its own layout pass before we measure.
        const t = window.requestAnimationFrame(() => {
            try { flowRef.current?.fitView({ padding: 0.3, duration: 0 }); }
            catch { /* swallow — fitView throws if mount torn down */ }
        });
        return () => window.cancelAnimationFrame(t);
    }, [displayNodes, layoutedEdges]);

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

    const stats = useMemo(() => ({
        total: graph.nodes.filter((n) => !n.meta?.external).length,
        infraTotal: graph.nodes.filter((n) => n.meta?.infra === true).length,
        added: graph.nodes.filter((n) => n.diff === 'added').length,
        deleted: graph.nodes.filter((n) => n.diff === 'deleted').length,
        modified: graph.nodes.filter((n) => n.diff === 'modified').length,
    }), [graph]);

    // #835 — on a skeletal/bucketed multi-repo L1 the nodes are repos or
    // AWS buckets, so the header captions the workspace's true service
    // count (the home page's SERVICES stat) instead of the node count.
    const serviceHeader = useMemo(
        () => resolveL1ServiceHeader(graph, workspaceServiceCount),
        [graph, workspaceServiceCount],
    );

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            <div className="ca-header">
                <div className="ca-header-title">
                    <span className="ca-header-badge">System Design</span>
                    <span style={{ fontWeight: 700 }}>{graph.meta?.repoName ?? 'workspace'}</span>
                    <span style={{ color: 'var(--ca-text-muted)', fontWeight: 400 }}>·</span>
                    {/* BUG-POLAR-2: lead with the visible node count (repos/groups)
                        so the caption matches the boxes on the canvas. */}
                    <span>{formatL1HeaderCaption(serviceHeader)}</span>
                    {stats.infraTotal > 0 && (
                        <span style={{ color: 'var(--ca-text-muted)' }}>· {stats.infraTotal} infra</span>
                    )}
                </div>
                <div className="ca-header-stats">
                    {stats.added > 0 && <span className="ca-stat"><span className="ca-stat-dot added" /> {stats.added} added</span>}
                    {stats.deleted > 0 && <span className="ca-stat"><span className="ca-stat-dot deleted" /> {stats.deleted} removed</span>}
                    {stats.modified > 0 && <span className="ca-stat"><span className="ca-stat-dot modified" /> {stats.modified} modified</span>}
                    {stats.added === 0 && stats.deleted === 0 && stats.modified === 0 && (
                        <span className="ca-stat" style={{ color: 'var(--ca-text-muted)' }}>No changes</span>
                    )}
                </div>
            </div>

            {/* Navigation hint */}
            <div className="ca-seq-hint">
                {graph.nodes.length > 0
                    ? <>Click a service to explore its <strong>feature domains</strong></>
                    : <>No services detected. CodeAtlas works best with <strong>multi-service or feature-based</strong> repos.</>
                }
            </div>

            {/* BUG-POLAR-15: at-a-glance key for the per-repo colour stripe on
                each service node (multi-repo only; hidden for single-repo). */}
            {(() => {
                const repoLegend = collectRepoLegend(graph.nodes as any);
                if (repoLegend.length === 0) return null;
                return (
                    <div
                        className="ca-repo-legend"
                        title="Each service node's left stripe is coloured by its owning repository"
                        style={{
                            position: 'absolute', top: 92, right: 12, zIndex: 5,
                            display: 'flex', flexWrap: 'wrap', gap: '4px 10px', maxWidth: 320,
                            padding: '6px 10px', borderRadius: 8,
                            background: 'var(--ca-panel-bg, rgba(0,0,0,0.55))',
                            border: '1px solid var(--ca-border, #444)',
                            fontSize: 11, color: 'var(--ca-text-muted, #bbb)',
                            alignItems: 'center',
                        }}
                    >
                        <span style={{ fontWeight: 600, marginRight: 2 }}>Repos</span>
                        {repoLegend.map((r) => (
                            <span key={r.repoId} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ width: 10, height: 10, borderRadius: 2, background: r.color, display: 'inline-block' }} />
                                {r.label}
                            </span>
                        ))}
                    </div>
                );
            })()}

            <ReactFlow
                key={(graph as any).graphId ?? 'microservice'}
                nodes={nodes}
                edges={edges}
                onNodeClick={handleNodeClick}
                onNodeContextMenu={handleNodeRightClick}
                onEdgeClick={handleEdgeClick}
                nodeTypes={nodeTypes}
                onInit={onFlowInit}
                fitView
                fitViewOptions={{ padding: 0.3 }}
                minZoom={0.05}
                maxZoom={2.5}
                defaultEdgeOptions={{ type: 'smoothstep' }}
                proOptions={{ hideAttribution: true }}
            >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={getComputedStyle(document.documentElement).getPropertyValue('--ca-dot-grid').trim() || '#888'} />
                <Controls position="bottom-left" />
                <ForceMeasureNodes nodeIds={nodes.map(n => n.id)} />
            </ReactFlow>
        </div>
    );
}

export default MicroserviceView;
