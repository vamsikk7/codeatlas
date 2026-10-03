/**
 * FeatureView.tsx — the L2a Feature layer dispatcher.
 *
 * Renders one of three surfaces depending on the graph:
 * - Backend `feature:*` → FeatureApiListView: endpoints grouped by feature (the
 *   L2a+L2b merge). Each feature is a collapsible group of its APIs (HTTP-first);
 *   features with no entry point sink to an "Internal modules" group; per-feature
 *   AI-review + comment affordances live on the group headers; >15-file clusters
 *   expand into nested sub-module sections.
 * - FE/mobile (`meta.mode === 'screen-list'`) → ScreenListView: a flat list of
 *   screens/pages grouped by URL prefix.
 * - `domain:*` → ClusterFeatureView: the React-Flow cluster map (business-intent
 *   domains) with cohesion metrics + inter-cluster call edges.
 *
 * Clicking an API row opens its L3 sequence; the Modules↔Domains toggle swaps the
 * grouped list (Modules) for the cluster map (Domains).
 */

import React, { useMemo, useCallback, useState, useRef } from 'react';
import { DiffFocusBar, DiffMinimap } from './DiffFocusBar';
import {
    computeChangeCounts, apiMatchesChangeFilter, changeRank, groupHasChanges,
    orderedChangedIds, type ChangeFilter,
} from '../lib/diffFocus';
import { ApiRow, CollapsibleSection, methodColors, type ApiRecord } from './ApiListPanel';
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
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useEffect, CSSProperties, memo } from 'react';
import { EDGE_DIFF_COLORS, NODE_DIFF_COLORS, DIFF_SYMBOLS, DIFF_BORDER_STYLES } from '../diffColors';
import { ForceMeasureNodes } from './ForceMeasureNodes';
import { resolveFeatureRenderDefault } from '../lib/featureRender';
import { formatScreenFrameworkLabel } from '../lib/screenFrameworkSummary';

interface FeatureViewProps {
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
}

const diffColors = NODE_DIFF_COLORS;
const edgeDiffColors = EDGE_DIFF_COLORS;

// Grid layout constants
const GRID_NODE_W = 300;
const GRID_NODE_H = 185;
const GRID_GAP_X = 80;
const GRID_GAP_Y = 60;

function gridColumns(count: number): number {
    if (count <= 2) return 2;
    if (count <= 6) return 3;
    return 4;
}

function ClusterNode({ data }: { data: any }) {
    const diff = data.diff || 'unchanged';
    const colors = diffColors[diff] || diffColors.unchanged;
    const isDeleted = diff === 'deleted';
    const cohesion = data.meta?.cohesion ?? 0;
    const isDimmed = data.dimmed ?? false;
    const isHighlighted = data.highlighted ?? false;

    const style: CSSProperties = {
        background: colors.bg,
        border: `2px ${DIFF_BORDER_STYLES[diff] || 'solid'} ${colors.border}`,
        borderRadius: 12,
        padding: '12px 16px',
        minWidth: 200,
        maxWidth: 300,
        boxShadow: isHighlighted
            ? `0 8px 32px ${colors.glow}, 0 2px 8px rgba(0,0,0,0.6)`
            : `0 3px 12px ${colors.glow}, 0 1px 4px rgba(0,0,0,0.4)`,
        opacity: isDimmed ? 0.2 : (isDeleted ? 0.7 : 1),
        cursor: 'pointer',
        fontFamily: "'Inter', system-ui, sans-serif",
        position: 'relative' as const,
        transform: isHighlighted ? 'scale(1.03)' : 'scale(1)',
        transition: 'opacity 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease',
    };

    const cohesionBarStyle: CSSProperties = {
        height: 3,
        borderRadius: 2,
        background: `linear-gradient(to right, ${colors.border} ${cohesion}%, var(--ca-border) ${cohesion}%)`,
        marginTop: 8,
        opacity: 0.7,
    };

    return (
        <div style={{ position: 'relative' }}>
            {diff !== 'unchanged' && (
                <span style={{
                    position: 'absolute',
                    top: -8,
                    right: -8,
                    fontSize: 8,
                    fontWeight: 700,
                    padding: '2px 6px',
                    borderRadius: 8,
                    background: colors.border,
                    color: 'var(--ca-bg)',
                    textTransform: 'uppercase',
                    zIndex: 1,
                }}>{DIFF_SYMBOLS[diff]} {diff}</span>
            )}
            <div style={style}>
                {/* Cluster header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 16 }}>⬡</span>
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
                </div>

                {/* Subtitle */}
                <div style={{ fontSize: 10, color: 'var(--ca-text-muted)', fontStyle: 'italic' }}>
                    {data.subtitle}
                </div>

                {/* UX-8 (2026-06-04): Domain phrase secondary subtitle.
                    Renders only in Modules mode (Louvain folder-named
                    clusters) when the workspace Domain detector found a
                    matching verb-phrase domain for this cluster's files.
                    Bridges the "auth folder" → "Authenticate users"
                    semantic gap without forcing the user to flip layers. */}
                {data.meta?.domainPhrase && (
                    <div
                        style={{
                            fontSize: 10,
                            marginTop: 2,
                            color: 'var(--ca-accent)',
                            opacity: 0.85,
                            fontWeight: 500,
                        }}
                        title="Domain inferred by the verb-phrase Domain detector"
                    >
                        🧭 {data.meta.domainPhrase}
                    </div>
                )}

                {/* Stats row */}
                <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 10, color: 'var(--ca-accent)' }}>
                    <span title="entry points">🔗 {(() => { const c = data.meta?.apisInCluster?.length ?? data.meta?.entryPoints?.length ?? data.meta?.routeCount ?? 0; return `${c} entry point${c !== 1 ? 's' : ''}`; })()}</span>
                    {/* Issue UX-9 (2026-06-03) — hide the cohesion chip when it
                        reads 0% because a flat zero on small clusters reads
                        as "this metric is broken" rather than carrying signal.
                        The cohesion bar below shows the same value visually
                        for the cases where it IS non-zero. */}
                    {cohesion > 0 && (
                        <span title="Internal cohesion — calls between files in this cluster as a fraction of total calls">◉ {cohesion}% cohesion</span>
                    )}
                </div>

                {/* Cohesion bar — only when cohesion > 0 so empty clusters
                    don't render a stripe of pure border colour. */}
                {cohesion > 0 && (
                    <div style={cohesionBarStyle} title={`${cohesion}% internal calls`} />
                )}

                {/* Sub-clusters (when cluster has >15 files and was sub-divided) */}
                {data.meta?.subClusters && Object.keys(data.meta.subClusters).length >= 2 ? (
                    <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {Object.values(data.meta.subClusters as Record<string, any>).map((sc: any) => {
                            // Issue 123: Highlight sub-cluster pills whose files overlap with NL query
                            const scFiles: string[] = sc.files ?? [];
                            const scHighlighted = data.nlHighlighted && scFiles.some((fp: string) =>
                                (data as any)._nlHighlightedFiles?.has(fp)
                            );
                            return (
                                <span
                                    key={sc.id}
                                    data-subcluster-id={sc.id}
                                    style={{
                                        fontSize: 9,
                                        padding: '2px 6px',
                                        background: scHighlighted ? 'var(--ca-nl-query-bg)' : 'var(--ca-node-body-bg)',
                                        border: `1px solid ${scHighlighted ? 'var(--ca-nl-query)' : 'var(--ca-border)'}`,
                                        borderRadius: 6,
                                        color: scHighlighted ? 'var(--ca-nl-query)' : 'var(--ca-accent)',
                                        fontFamily: "'Inter', sans-serif",
                                        cursor: 'pointer',
                                    }}
                                    title={`${sc.files?.length ?? 0} files`}
                                >
                                    {sc.label} ({sc.files?.length ?? 0})
                                </span>
                            );
                        })}
                    </div>
                ) : (
                    /* File list preview (top 4) — shown for small clusters without sub-clusters */
                    data.meta?.files && (
                        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                            {(data.meta.files as string[]).slice(0, 4).map((fp: string) => (
                                <span key={fp} style={{
                                    fontSize: 9,
                                    padding: '1px 5px',
                                    background: 'var(--ca-node-body-bg)',
                                    borderRadius: 4,
                                    color: 'var(--ca-accent)',
                                    fontFamily: "'SF Mono', monospace",
                                }}>
                                    {fp.split('/').pop()}
                                </span>
                            ))}
                            {data.meta.files.length > 4 && (
                                <span style={{ fontSize: 9, color: 'var(--ca-text-muted)' }}>
                                    +{data.meta.files.length - 4} more
                                </span>
                            )}
                        </div>
                    )
                )}

                {/* Drill-down affordance */}
                <div style={{ marginTop: 6, fontSize: 9, color: 'var(--ca-text-muted)', textAlign: 'right', opacity: 0.6 }}>
                    View APIs →
                </div>
            </div>
            {/* React Flow connection handles */}
            <Handle
                type="target"
                position={Position.Left}
                style={{ left: -5, width: 10, height: 10, borderRadius: '50%', background: colors.border, border: 'none' }}
            />
            <Handle
                type="source"
                position={Position.Right}
                style={{ right: -5, width: 10, height: 10, borderRadius: '50%', background: colors.border, border: 'none' }}
            />
        </div>
    );
}

const nodeTypes = { clusterNode: memo(ClusterNode) };

function featureGraphToReactFlow(graph: FeatureViewProps['graph']) {
    const count = graph.nodes.length;
    const cols = gridColumns(count);

    const rfNodes: Node[] = graph.nodes.map((n, i) => ({
        id: n.id,
        type: 'clusterNode',
        data: {
            label: n.label,
            subtitle: n.subtitle,
            diff: n.diff,
            type: n.type,
            meta: n.meta,
            anchor: n.anchor,
            dimmed: false,
            highlighted: false,
        },
        position: {
            x: (i % cols) * (GRID_NODE_W + GRID_GAP_X),
            y: Math.floor(i / cols) * (GRID_NODE_H + GRID_GAP_Y),
        },
    }));

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
                strokeWidth: 2,
                strokeDasharray: e.diff === 'deleted' ? '6,4' : e.diff === 'modified' ? '3,3' : undefined,
                opacity: e.diff === 'deleted' ? 0.5 : 0.85,
            },
            labelStyle: { fontSize: 10, fill: 'var(--ca-edge-label-text)', fontFamily: "'Inter', sans-serif" },
            labelBgStyle: { fill: 'var(--ca-label-bg)', fillOpacity: 1 },
            markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
            data: { diff: e.diff, callCount: e.callCount, baseColor: color },
        };
    });

    return { nodes: rfNodes, edges: rfEdges };
}

/**
 * v2 follow-up #716 — flat list of screens for FE/mobile L2a.
 *
 * The graph is built by `buildScreenListGraph` in
 * `featureGraphBuilder.ts` with `meta.mode === 'screen-list'`. Each
 * node is one screen; `meta.parentNavGroup` flags screens that share
 * a URL prefix (≥2 screens under `/admin/*`, `/onboarding/*`).
 *
 * Click a row → opens that screen's L2b content panel via the deep-
 * link target stored in `meta.opensGraphId` (`screen-content:<id>`).
 */
function ScreenListView({
    graph,
    onNodeClick,
    highlightedNodes,
}: {
    graph: FeatureViewProps['graph'];
    onNodeClick: FeatureViewProps['onNodeClick'];
    highlightedNodes?: FeatureViewProps['highlightedNodes'];
}) {
    const screens = graph.nodes;
    const prefixGroups: string[] = (graph.meta?.prefixGroups as string[]) ?? [];
    const serviceName = (graph.meta?.serviceId as string)?.replace(/^service:/, '') ?? 'service';
    const framework = graph.meta?.framework ?? 'unknown';
    const screenCount = (graph.meta?.screenCount as number) ?? screens.length;

    // Group screens by parentNavGroup. Screens without a group go in
    // the default bucket. Each group renders as a collapsible section.
    const groups: Record<string, typeof screens> = { '': [] };
    for (const g of prefixGroups) groups[g] = [];
    for (const node of screens) {
        const g = (node.meta?.parentNavGroup as string) || '';
        if (!(g in groups)) groups[g] = [];
        groups[g].push(node);
    }
    // Sort group keys: prefixGroups first (alphabetical), then '' last.
    const orderedKeys = [...prefixGroups, ''].filter((k) => groups[k]?.length > 0);

    const handleRowClick = (node: typeof screens[number], e: React.MouseEvent) => {
        const opensGraphId = node.meta?.opensGraphId as string | undefined;
        if (opensGraphId) {
            // Route to the L2b screen-content panel for this screen. The
            // `type:'graph'` node is picked up by App.tsx's handleNodeClick,
            // which posts `requestRoute { graphId }` so the hash actually
            // changes and the extension serves the screen-content graph
            // (BUG-FE-NO-L3L4L5-L2A). From there L3/L4/L5 are reachable.
            onNodeClick(opensGraphId, { type: 'graph', meta: { graphId: opensGraphId }, anchor: node.anchor }, e);
            return;
        }
        // Graceful fallback (e.g. a deleted-ghost screen with no drill graph):
        // open the underlying file instead of no-op'ing. A `type:'file'` node
        // with the screen's anchor routes through the default file-open path.
        const filePath = (node.anchor?.filePath ?? node.meta?.filePath) as string | undefined;
        if (filePath) {
            onNodeClick(node.id, { type: 'file', anchor: { filePath }, meta: node.meta }, e);
            return;
        }
        // Last resort: pass the node through untouched.
        onNodeClick(node.id, node, e);
    };

    const diffBadge = (diff?: string) =>
        diff === 'added' ? '+' :
        diff === 'modified' ? '~' :
        diff === 'deleted' ? '−' : '';

    const diffColor = (diff?: string) =>
        diff === 'added' ? 'var(--ca-success)' :
        diff === 'modified' ? 'var(--ca-warning)' :
        diff === 'deleted' ? 'var(--ca-danger)' : 'var(--ca-text-muted)';

    return (
        <div style={{ width: '100%', height: '100%', overflow: 'auto', padding: 16, background: 'var(--ca-bg)' }}>
            <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--ca-text)' }}>{serviceName}</div>
                <div style={{ fontSize: 11, color: 'var(--ca-text-muted)', marginTop: 4 }}>
                    {/* BUG-POLAR-25: when screens span multiple frameworks, show a
                        per-framework breakdown so the header can't contradict the rows. */}
                    {formatScreenFrameworkLabel(screens as any, framework)} · {screenCount} {screenCount === 1 ? 'screen' : 'screens'}
                </div>
            </div>
            {orderedKeys.map((groupKey) => {
                const groupScreens = groups[groupKey];
                if (!groupScreens || groupScreens.length === 0) return null;
                return (
                    <div key={groupKey || '__default'} style={{ marginBottom: 12 }}>
                        {groupKey && (
                            <div style={{
                                fontWeight: 600, fontSize: 12, color: 'var(--ca-text-muted)',
                                padding: '4px 8px', marginBottom: 4,
                            }}>
                                {groupKey}/*
                            </div>
                        )}
                        {groupScreens.map((node) => {
                            const isHighlighted = highlightedNodes && (highlightedNodes[node.id] || highlightedNodes[(node.meta?.screenId as string) ?? '']);
                            return (
                                <div
                                    key={node.id}
                                    onClick={(e) => handleRowClick(node, e)}
                                    style={{
                                        display: 'flex', gap: 8, padding: '8px 12px', cursor: 'pointer',
                                        background: isHighlighted ? 'var(--ca-color-blue-bg, rgba(33, 150, 243, 0.12))' : 'var(--ca-bg-elev)',
                                        border: isHighlighted ? '1px solid var(--ca-color-blue, #2196f3)' : '1px solid transparent',
                                        borderRadius: 4, marginBottom: 2,
                                        fontSize: 13, alignItems: 'baseline',
                                    }}
                                >
                                    {node.diff && node.diff !== 'unchanged' && (
                                        <span style={{
                                            fontFamily: 'var(--ca-mono)', fontSize: 10, fontWeight: 600,
                                            color: diffColor(node.diff), minWidth: 12,
                                        }}>
                                            {diffBadge(node.diff)}
                                        </span>
                                    )}
                                    <span style={{ flex: 1, color: 'var(--ca-text)', fontFamily: 'var(--ca-mono)' }}>
                                        {node.label}
                                    </span>
                                    <span style={{ fontSize: 10, color: 'var(--ca-text-muted)' }}>
                                        {node.subtitle?.replace(/[«»]/g, '')}
                                    </span>
                                    {node.body && (
                                        <span style={{ fontSize: 10, color: 'var(--ca-text-muted)' }}>
                                            {node.body}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                );
            })}
            {screenCount === 0 && (
                <div style={{ padding: 24, color: 'var(--ca-text-muted)', textAlign: 'center' }}>
                    No screens detected. Add a route or page export to surface this service in L2a.
                </div>
            )}
        </div>
    );
}

// ─── Backend L2a+L2b merge — features-grouped API list ───────────────────
//
// For a backend `feature:*` graph, render every cluster's APIs grouped UNDER
// the feature (instead of the React-Flow cluster map). Clusters that own at
// least one entry point come first (most APIs first); clusters with NO entry
// point sink to a single collapsed "Internal modules · no entry points" group
// at the end. Clicking an API row opens its L3 sequence via the same
// `type:'api'` node the L2b panel uses; clicking an internal module opens its
// (files-only) L2b view. FE/mobile keep the screen list; `domain:*` keep the
// cluster map — so only backend feature areas are merged.
const HTTP_VERB_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY', 'ROUTE', 'CONTROLLER', 'RESOURCE'];
// BUG-EXPLORE-4: compact labels for non-HTTP entry-point KINDS shown as filter tabs.
const METHOD_TAB_LABEL: Record<string, string> = {
    NAV_ROUTE: 'NAV', MQ_CONSUMER: 'MQ', DI_BINDING: 'DI', CLI_COMMAND: 'CLI',
    MODEL_HOOK: 'HOOK', DB_MIGRATION: 'MIGRATE', DB_SEED: 'SEED', SOCKET_EVENT: 'SOCKET',
    CONTENT_PROVIDER: 'PROVIDER', PUSH_HANDLER: 'PUSH', DEEP_LINK: 'DEEPLINK', NETWORK: 'NET',
};
function methodRank(m: string): number {
    const i = HTTP_VERB_ORDER.indexOf(String(m || '').toUpperCase());
    return i >= 0 ? i : HTTP_VERB_ORDER.length; // non-HTTP entry points sort after HTTP verbs
}

// BUG-EXP-9 — generic framework / structural directory names. When the backend
// feature clusters are DOMINATED by these (Rails' `app`/`db`/`migrate`/…),
// Louvain found no real communities (convention-based frameworks have few
// explicit imports) and fell back to top-level directories. In that case the
// Domains view recovers the business grouping, so we surface a hint. NOTE: this
// is a curated set of *structural* dirs — real feature/domain names (articles,
// users, auth, owner, vet, …) are intentionally excluded so the hint fires ONLY
// on genuinely degenerate clustering (verified: ruby-rails yes; py-django,
// ts-express, java-spring, csharp-aspnet no).
const GENERIC_STRUCTURAL_LABELS = new Set([
    'app', 'apps', 'db', 'migrate', 'migration', 'migrations', 'misc', 'helpers',
    'helper', 'initializers', 'initializer', 'environments', 'environment',
    'javascripts', 'javascript', 'stylesheets', 'assets', 'public', 'vendor',
    'config', 'configs', 'lib', 'libs', 'bin', 'spec', 'specs', 'tmp', 'storage',
    'static', 'channels', 'mailers', 'views', 'concerns',
]);

/** BUG-EXP-9 — true when the with-API feature clusters are DOMINATED by generic
 * framework dirs (Rails app/db/migrate). The Domains view (always built by
 * domainGraphBuilder) recovers the business grouping, so we recommend it. Not
 * gated on per-cluster `domainPhrase` — that's unreliably populated on the real
 * feature graph (depends on domain-vs-feature build order); the generic-label
 * dominance across ≥2 clusters is itself the signal. */
function isDegenerateClustering(withApiClusters: Array<{ label: any }>): boolean {
    if (withApiClusters.length < 2) return false;
    const generic = withApiClusters.filter(
        (c) => GENERIC_STRUCTURAL_LABELS.has(String(c.label ?? '').toLowerCase()),
    ).length;
    return generic / withApiClusters.length >= 0.6;
}

function FeatureApiListView({
    graph,
    onNodeClick,
    highlightedNodes,
    commentCounts,
}: {
    graph: FeatureViewProps['graph'];
    onNodeClick: FeatureViewProps['onNodeClick'];
    highlightedNodes?: FeatureViewProps['highlightedNodes'];
    commentCounts?: FeatureViewProps['commentCounts'];
}) {
    // AI-review markers + comment badges anchor to the cluster id on this graph.
    const gid = String((graph as any).graphId ?? 'feature:workspace');
    const clusters = useMemo(() => graph.nodes.map((n) => {
        const apis = ((n.meta?.apisInCluster as ApiRecord[]) ?? []).slice().sort(
            (a, b) => methodRank(a.method) - methodRank(b.method) || String(a.route ?? '').localeCompare(String(b.route ?? '')),
        );
        // Sub-clusters (>15-file clusters split by communityDetector) survive as a
        // nested breakdown in the merged view instead of the old drill-down pills.
        const sub = (n.meta?.subClusters as Record<string, { id?: string; label?: string; files?: string[] }>) ?? {};
        return {
            id: String(n.id),
            label: n.label,
            diff: n.diff as string | undefined,
            domainPhrase: n.meta?.domainPhrase as string | undefined,
            files: (n.meta?.files as string[]) ?? [],
            subClusters: Object.keys(sub).length >= 2 ? Object.values(sub) : [],
            apis,
            node: n,
        };
    }), [graph.nodes]);

    const withApis = useMemo(
        () => clusters.filter((c) => c.apis.length > 0)
            .sort((a, b) => b.apis.length - a.apis.length || String(a.label).localeCompare(String(b.label))),
        [clusters],
    );
    const noApis = useMemo(
        () => clusters.filter((c) => c.apis.length === 0)
            .sort((a, b) => b.files.length - a.files.length || String(a.label).localeCompare(String(b.label))),
        [clusters],
    );
    const totalApis = withApis.reduce((s, c) => s + c.apis.length, 0);
    const featureCount = withApis.length + noApis.length;

    // BUG-EXP-9 — recommend the Domains view when structural clustering degenerated
    // to generic framework directories (Rails app/db/migrate) but real domains exist.
    const degenerate = useMemo(() => isDegenerateClustering(withApis), [withApis]);

    const stats = useMemo(() => ({
        added: graph.nodes.filter((n) => n.diff === 'added').length,
        deleted: graph.nodes.filter((n) => n.diff === 'deleted').length,
        modified: graph.nodes.filter((n) => n.diff === 'modified').length,
    }), [graph.nodes]);

    // ─── Diff-focus (L2 change highlighting) ─────────────────────────────────
    // Change counts across every entry point → drives the Changed filter chips
    // + stepper + minimap. The whole affordance is hidden when nothing changed.
    const [changeFilter, setChangeFilter] = useState<ChangeFilter>('all');
    // Search + method filtering (parity with the L2b ApiListPanel), so a
    // backend feature list with many endpoints is navigable without scrolling.
    const [filterMethod, setFilterMethod] = useState<string>('ALL');
    const [searchInput, setSearchInput] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const searchRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Debounce the search box so typing doesn't thrash layout (Issue 251 parity).
    useEffect(() => {
        const t = setTimeout(() => setSearchQuery(searchInput), 200);
        return () => clearTimeout(t);
    }, [searchInput]);
    // "/" focuses the search box (matches ApiListPanel).
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && !document.querySelector('.ca-modal-overlay')) {
                e.preventDefault();
                searchRef.current?.focus();
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, []);

    const searchMethodActive = filterMethod !== 'ALL' || searchQuery.trim().length > 0;
    const matchMethodSearch = useCallback((api: ApiRecord) => {
        if (filterMethod !== 'ALL' && api.method !== filterMethod) return false;
        const q = searchQuery.trim().toLowerCase();
        if (!q) return true;
        return String(api.route ?? '').toLowerCase().includes(q)
            || String(api.handlerName ?? '').toLowerCase().includes(q)
            || String(api.method ?? '').toLowerCase().includes(q);
    }, [filterMethod, searchQuery]);

    // Stage 1 — method + search. Each feature keeps only matching endpoints;
    // groups with nothing left drop out while a search/method filter is active.
    const searchedWithApis = useMemo(() => {
        if (!searchMethodActive) return withApis;
        return withApis
            .map((c) => ({ ...c, apis: c.apis.filter(matchMethodSearch) }))
            .filter((c) => c.apis.length > 0);
    }, [withApis, searchMethodActive, matchMethodSearch]);

    // Method-tab counts derive from the SEARCH-filtered (not method-filtered) set
    // so each tab shows how many of that method match the current search text.
    const methodCounts = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        const counts: Record<string, number> = {};
        for (const c of withApis) for (const api of c.apis) {
            if (q && !(String(api.route ?? '').toLowerCase().includes(q)
                || String(api.handlerName ?? '').toLowerCase().includes(q)
                || String(api.method ?? '').toLowerCase().includes(q))) continue;
            counts[api.method] = (counts[api.method] ?? 0) + 1;
        }
        return counts;
    }, [withApis, searchQuery]);

    // BUG-EXPLORE-4: tab bar adapts to the entry-point KINDS actually present —
    // HTTP verbs first (canonical order), then other kinds (SCREEN / NAV_ROUTE /
    // JOB / MQ_CONSUMER / …) by count. Hidden when only one kind exists (a lone
    // "ALL + single tab" is useless on pure-mobile / pure-worker repos).
    const orderedMethods = useMemo(() => {
        const present = Object.keys(methodCounts).filter((m) => (methodCounts[m] ?? 0) > 0);
        const http = HTTP_VERB_ORDER.filter((m) => present.includes(m));
        const other = present.filter((m) => !HTTP_VERB_ORDER.includes(m))
            .sort((a, b) => (methodCounts[b] - methodCounts[a]) || a.localeCompare(b));
        return [...http, ...other];
    }, [methodCounts]);
    const showMethodTabs = orderedMethods.length >= 2;

    const allApis = useMemo(() => searchedWithApis.flatMap((c) => c.apis), [searchedWithApis]);
    const counts = useMemo(() => computeChangeCounts(allApis), [allApis]);
    const diffActive = counts.changed > 0;
    // Snap back to "All" when a resync clears the diff so the filter can't strand
    // the user on an empty view.
    useEffect(() => { if (!diffActive && changeFilter !== 'all') setChangeFilter('all'); }, [diffActive, changeFilter]);

    // Stage 2 — change filter + changed-first ordering, over the searched set.
    const displayWithApis = useMemo(() => {
        let list = searchedWithApis.map((c) => ({
            ...c,
            apis: changeFilter === 'all' ? c.apis : c.apis.filter((a) => apiMatchesChangeFilter(a.diff, changeFilter)),
        }));
        if (changeFilter !== 'all') {
            list = list.filter((c) => c.apis.length > 0 || apiMatchesChangeFilter(c.diff, changeFilter));
        }
        if (diffActive) {
            list = list.map((c) => ({ ...c, apis: [...c.apis].sort((a, b) => changeRank(a.diff) - changeRank(b.diff)) }));
            list = [...list].sort((a, b) =>
                (groupHasChanges(a.apis, a.diff) ? 0 : 1) - (groupHasChanges(b.apis, b.diff) ? 0 : 1));
        }
        return list;
    }, [searchedWithApis, changeFilter, diffActive]);

    // No-entry-point features are noise while searching / filtering by method → hide them.
    const displayNoApis = useMemo(() => {
        if (searchMethodActive) return [];
        let list = changeFilter === 'all' ? noApis : noApis.filter((c) => apiMatchesChangeFilter(c.diff, changeFilter));
        if (diffActive) list = [...list].sort((a, b) => changeRank(a.diff) - changeRank(b.diff));
        return list;
    }, [noApis, changeFilter, diffActive, searchMethodActive]);

    // Feature #4 (stepper): changed api ids in display order.
    const changedIds = useMemo(
        () => orderedChangedIds(displayWithApis.flatMap((c) => c.apis), (a) => a.apiId),
        [displayWithApis],
    );
    // Feature #2 (auto-expand): expand features with changes, collapse the rest
    // once a diff is active. `key` folds in the filter so this re-applies when
    // the user flips a chip.
    const featureDefaultOpen = (c: { apis: ApiRecord[]; diff?: string }) =>
        searchMethodActive || !diffActive || groupHasChanges(c.apis, c.diff);

    const isNlHighlighted = (api: ApiRecord) =>
        !!highlightedNodes && highlightedNodes[`${api.filePath}::${api.handlerName}`] === 'nl-query';

    const handleApiClick = (api: ApiRecord, e: React.MouseEvent) => {
        onNodeClick(api.apiId, { type: 'api', meta: { apiId: api.apiId }, anchor: { filePath: api.filePath } }, e);
    };
    const handleClusterClick = (c: typeof clusters[number], e: React.MouseEvent) => {
        onNodeClick(c.id, c.node, e);
    };

    const diffPill = (diff?: string) => diff && diff !== 'unchanged'
        ? <span className="ca-method-badge" style={{ background: diff === 'added' ? 'var(--ca-success)' : diff === 'deleted' ? 'var(--ca-danger)' : 'var(--ca-warning)', marginLeft: 6 }}>{DIFF_SYMBOLS[diff] ?? '~'}</span>
        : null;

    const apiRows = (apis: ApiRecord[]) => (
        <div className="ca-api-rows">
            {apis.map((api) => (
                <ApiRow key={api.apiId} api={api} onApiClick={handleApiClick} showFile nlHighlighted={isNlHighlighted(api)} />
            ))}
        </div>
    );

    // Body for one feature group. When the cluster was sub-divided (>15 files),
    // split its endpoints into nested sub-module sections by file membership so
    // the sub-cluster structure is preserved instead of a flat list.
    const renderFeatureBody = (c: typeof clusters[number]) => {
        if (c.subClusters.length < 2) return apiRows(c.apis);
        const assigned = new Set<string>();
        const groups = c.subClusters.map((sc) => {
            const files = new Set(sc.files ?? []);
            const apis = c.apis.filter((a) => files.has(a.filePath));
            apis.forEach((a) => assigned.add(a.apiId));
            return { sc, apis };
        }).filter((g) => g.apis.length > 0);
        const rest = c.apis.filter((a) => !assigned.has(a.apiId));
        if (groups.length < 2) return apiRows(c.apis); // no useful split — keep flat
        return (
            <div className="ca-api-rows">
                {groups.map(({ sc, apis }) => (
                    <CollapsibleSection
                        key={String(sc.id ?? sc.label)}
                        title={String(sc.label ?? 'sub-module')}
                        icon="↳"
                        color="var(--ca-edge-unchanged)"
                        count={apis.length}
                        defaultOpen
                        headerTitle={`Sub-module of ${c.label} — ${sc.files?.length ?? 0} files`}
                    >
                        {apiRows(apis)}
                    </CollapsibleSection>
                ))}
                {rest.length > 0 && apiRows(rest)}
            </div>
        );
    };

    return (
        <div className="ca-api-list" data-testid="feature-api-list">
            <div className="ca-api-panel-top">
                <div className="ca-header-title">
                    <span className="ca-header-badge">Feature APIs</span>
                    {/* BUG-EXP-2: this count spans ALL entry points (HTTP + migrations + jobs +
                        hooks), so it's labeled "entry points", not "APIs". L1's per-service
                        "N HTTP routes exposed" is the HTTP-only subset — the two are distinct
                        metrics by design and no longer contradict.
                        BUG-EXPLORE-15: the headline counts only feature areas that HAVE entry
                        points (always ≤ entry points — a feature groups ≥1 entry point), so it
                        never reads as "more features than entry points". No-entry-point clusters
                        are surfaced as a separate "internal modules" stat instead of inflating
                        the feature count. */}
                    <span>
                        {withApis.length} feature area{withApis.length !== 1 ? 's' : ''} · {totalApis} entry point{totalApis !== 1 ? 's' : ''}
                        {noApis.length > 0 && ` · ${noApis.length} internal module${noApis.length !== 1 ? 's' : ''}`}
                    </span>
                </div>
                <div className="ca-header-stats">
                    {/* This is the List view (FeatureApiListView) → toggle shows List active. */}
                    <ClusterModeToggle currentGraphId={String((graph as any).graphId ?? '')} activeMode="list" />
                    {stats.added > 0 && <span className="ca-stat"><span className="ca-stat-dot added" /> {stats.added} added</span>}
                    {stats.deleted > 0 && <span className="ca-stat"><span className="ca-stat-dot deleted" /> {stats.deleted} deleted</span>}
                    {stats.modified > 0 && <span className="ca-stat"><span className="ca-stat-dot modified" /> {stats.modified} modified</span>}
                </div>
            </div>

            <div
                className="ca-seq-hint"
                data-testid={degenerate ? 'degenerate-clustering-hint' : undefined}
                // In-flow (not the shared absolute overlay) so it stacks ABOVE the
                // search + method filter bar instead of floating over its top edge.
                style={{
                    position: 'static', flexShrink: 0,
                    ...(degenerate ? { background: 'rgba(230, 160, 30, 0.12)', borderLeft: '3px solid var(--ca-warning)', padding: '4px 8px' } : {}),
                }}
            >
                {featureCount === 0
                    ? <>No features detected. Run <strong>Initialize</strong> to analyze the codebase.</>
                    : degenerate
                        ? <>⚠ These feature areas are <strong>folder-based</strong> — this framework has few explicit imports, so structural clustering is weak. Switch to <strong>Domains</strong> (top-right) for business-grouped features.</>
                        : <>Endpoints grouped by feature. Click an API to open its <strong>sequence (L3)</strong> · features with no entry points are at the end.</>}
            </div>

            <div className="ca-api-filter-bar" style={{ padding: '4px 16px 0' }}>
                <input
                    ref={searchRef}
                    className="ca-api-search"
                    type="text"
                    placeholder="Filter by route or handler… (press /)"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    data-testid="feature-api-search"
                />
                {showMethodTabs && (
                    <div className="ca-method-tabs">
                        {['ALL', ...orderedMethods].map((m) => {
                            const allFilteredCount = Object.values(methodCounts).reduce((s, c) => s + c, 0);
                            const count = m === 'ALL' ? allFilteredCount : (methodCounts[m] ?? 0);
                            const label = m === 'ALL' ? 'ALL' : (METHOD_TAB_LABEL[m] ?? m);
                            const accent = methodColors[m] ?? 'var(--ca-accent)';
                            return (
                                <button
                                    key={m}
                                    className={`ca-method-tab${filterMethod === m ? ' active' : ''}`}
                                    style={filterMethod === m && m !== 'ALL' ? { borderColor: accent, color: accent } : undefined}
                                    onClick={() => setFilterMethod(m)}
                                    title={m === 'ALL' ? 'All entry points' : `Filter to ${m}`}
                                >
                                    {label}<span className="ca-method-tab-count">{count}</span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
            <div style={{ padding: '0 16px' }}>
                <DiffFocusBar
                    counts={counts}
                    filter={changeFilter}
                    onFilterChange={setChangeFilter}
                    changedIds={changedIds}
                    scrollContainerRef={scrollRef}
                />
            </div>

            <div className="ca-api-list-main" ref={scrollRef}>
                {searchMethodActive && displayWithApis.length === 0 && (
                    <div className="ca-seq-hint" data-testid="feature-api-no-match" style={{ opacity: 0.8 }}>
                        No entry points match{searchQuery.trim() ? <> “<strong>{searchQuery.trim()}</strong>”</> : null}
                        {filterMethod !== 'ALL' ? <> for <strong>{filterMethod}</strong></> : null}.
                    </div>
                )}
                {displayWithApis.map((c) => (
                    <CollapsibleSection
                        key={`${c.id}:${changeFilter}:${filterMethod}:${searchQuery}:${diffActive ? 1 : 0}`}
                        title={c.label}
                        icon="⬡"
                        color="var(--ca-accent)"
                        count={c.apis.length}
                        defaultOpen={featureDefaultOpen(c)}
                        headerTitle={`${c.files.length} file${c.files.length !== 1 ? 's' : ''} in this feature — click a row to open its sequence`}
                        headerExtra={
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                {c.domainPhrase && (
                                    <span style={{ fontSize: 10, fontWeight: 500, color: 'var(--ca-accent)', opacity: 0.85 }} title="Domain inferred by the verb-phrase Domain detector">🧭 {c.domainPhrase}</span>
                                )}
                                {/* #L2merge — per-feature comment affordance (was on the old cluster card). */}
                                {(commentCounts?.[c.id] ?? 0) > 0 && (
                                    <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('codeatlas:open-comments')); }}
                                        style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 8, background: 'var(--ca-accent)', color: '#fff', border: 'none', cursor: 'pointer' }}
                                        title={`${commentCounts![c.id]} comment${commentCounts![c.id] > 1 ? 's' : ''} — click to open Comments`}
                                        aria-label={`${commentCounts![c.id]} comments on ${c.label}`}
                                    >💬{commentCounts![c.id]}</button>
                                )}
                                {diffPill(c.diff)}
                            </span>
                        }
                    >
                        {renderFeatureBody(c)}
                    </CollapsibleSection>
                ))}

                {displayNoApis.length > 0 && (
                    <CollapsibleSection
                        key={`no-apis:${changeFilter}`}
                        title="Internal modules · no entry points"
                        icon="🧩"
                        color="var(--ca-edge-unchanged)"
                        count={displayNoApis.length}
                        defaultOpen={diffActive && changeFilter !== 'all'}
                        headerTitle="Feature clusters with no API / entry point — utility & internal modules"
                    >
                        <div className="ca-api-rows">
                            {displayNoApis.map((c) => (
                                <div
                                    key={c.id}
                                    className="ca-api-row ca-clickable"
                                    role="button"
                                    tabIndex={0}
                                    onClick={(e) => handleClusterClick(c, e)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClusterClick(c, e as unknown as React.MouseEvent); } }}
                                    title={`${c.files.length} file${c.files.length !== 1 ? 's' : ''} — open this module's files`}
                                >
                                    <span className="ca-method-badge" style={{ background: 'var(--ca-edge-unchanged)' }}>MODULE</span>
                                    <span className="ca-api-route">{c.label}</span>
                                    <span className="ca-api-handler" style={{ color: 'var(--ca-text-muted)' }}>
                                        {c.files.length} file{c.files.length !== 1 ? 's' : ''}
                                    </span>
                                    {diffPill(c.diff)}
                                </div>
                            ))}
                        </div>
                    </CollapsibleSection>
                )}

                {featureCount === 0 && (
                    <div className="ca-api-list-empty">
                        <p>No features detected. Run <strong>Initialize</strong> to analyze the codebase.</p>
                    </div>
                )}
            </div>

            {/* Feature #3 — scrollbar change markers, pinned to the panel's right
                edge (measures rows in the scroll container by data-api-id). */}
            <DiffMinimap scrollContainerRef={scrollRef} version={`${changeFilter}:${gid}:${counts.changed}`} />
        </div>
    );
}

// v2 follow-up #716 — top-level dispatcher.
// When the L2a feature graph is in `screen-list` mode (built for an
// FE/mobile service by featureGraphBuilder.ts), render a flat list of
// screens grouped by URL prefix. Backend `feature:*` graphs render the
// merged features-grouped API list (`FeatureApiListView`); `domain:*`
// graphs keep the React Flow cluster diagram via `<ClusterFeatureView>`.
//
// The split is necessary to keep React's Rules of Hooks happy — the
// cluster view calls `useState` / `useNodesState` / `useEdgesState`
// while the screen list doesn't. Branching with an early return INSIDE
// a single component would cause hook-order drift if the graph mode
// flipped between renders.
function FeatureView(props: FeatureViewProps) {
    // #L2merge — a backend `feature:*` graph renders either the grouped API
    // "List" (FeatureApiListView) or the "Entry Points" call-topology map
    // (ClusterFeatureView) — both the SAME graph, different render. Persisted +
    // event-driven so the toggle (nested in the child views) flips it without a
    // graph re-fetch. `domain:*` always renders the business-intent cluster map.
    // BUG-POLAR-16: a dense feature graph (many clusters) is unreadable as the
    // Entry-Points map, so the INITIAL render defaults to List even if 'map' was
    // persisted. Explicit toggles (the ca:featureRender event below) set the mode
    // directly, so the map stays reachable — dense graphs just don't OPEN on it.
    const [featureRender, setFeatureRender] = useState<'list' | 'map'>(
        () => resolveFeatureRenderDefault(readFeatureRender(), props.graph.nodes?.length ?? 0),
    );
    useEffect(() => {
        const h = (e: Event) => {
            const mode = (e as CustomEvent).detail?.mode;
            if (mode === 'list' || mode === 'map') setFeatureRender(mode);
        };
        window.addEventListener('ca:featureRender', h as EventListener);
        return () => window.removeEventListener('ca:featureRender', h as EventListener);
    }, []);

    if (props.graph.meta?.mode === 'screen-list') {
        return (
            <ScreenListView
                graph={props.graph}
                onNodeClick={props.onNodeClick}
                highlightedNodes={props.highlightedNodes}
            />
        );
    }
    const gid = String((props.graph as any).graphId ?? '');
    if (gid.startsWith('feature:') && featureRender === 'list') {
        return (
            <FeatureApiListView
                graph={props.graph}
                onNodeClick={props.onNodeClick}
                highlightedNodes={props.highlightedNodes}
                commentCounts={props.commentCounts}
            />
        );
    }
    // feature:* + 'map' → Entry Points topology; domain:* → Domains cluster map.
    return <ClusterFeatureView {...props} />;
}

function ClusterFeatureView({ graph, onNodeClick, onNodeRightClick, onEdgeClick, highlightedNodes, commentCounts }: FeatureViewProps) {
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

    const { nodes: baseNodes, edges: baseEdges } = useMemo(
        () => featureGraphToReactFlow(graph),
        [graph]
    );

    // 2026-06-09 — see DiagramView for the full rationale. The legacy
    // `useNodesState`/`useEdgesState` + `useEffect → setNodes/setEdges`
    // pattern hit a handleBounds race that left every edge's validity
    // check returning false. Pass `baseNodes`/`baseEdges` as
    // `defaultNodes`/`defaultEdges` instead and use `ForceMeasureNodes`
    // (rendered as an RF child below) to stamp handleBounds on the store.
    const nodes = baseNodes;
    const edges = baseEdges;

    // Build set of file paths that have NL query highlights for cluster matching
    const nlHighlightedFiles = useMemo(() => {
        if (!highlightedNodes || Object.keys(highlightedNodes).length === 0) return null;
        const files = new Set<string>();
        for (const key of Object.keys(highlightedNodes)) {
            if (highlightedNodes[key] === 'nl-query') {
                files.add(key.split('::')[0]);
            }
        }
        return files.size > 0 ? files : null;
    }, [highlightedNodes]);

    // Compute hover-derived rendering nodes/edges (does NOT mutate state — avoids re-render cascade)
    const renderNodes = useMemo(() => {
        let result = nodes;
        // Inject comment counts
        if (commentCounts && Object.keys(commentCounts).length > 0) {
            result = result.map(n => {
                const count = commentCounts[n.id];
                if (!count) return n;
                return { ...n, data: { ...n.data, meta: { ...n.data.meta, commentCount: count } } };
            });
        }
        // Apply NL query highlight: check if any file in the cluster matches
        if (nlHighlightedFiles) {
            result = result.map((n) => {
                const clusterFiles: string[] = n.data?.meta?.files ?? [];
                const hasMatch = clusterFiles.some((fp: string) => nlHighlightedFiles.has(fp));
                if (!hasMatch) return n;
                return {
                    ...n,
                    style: { ...n.style, outline: '2px solid var(--ca-nl-query)', outlineOffset: '2px', borderRadius: '8px' },
                    data: { ...n.data, nlHighlighted: true, _nlHighlightedFiles: nlHighlightedFiles },
                };
            });
        }
        if (!hoveredNodeId) return result;
        const neighborIds = new Set<string>([hoveredNodeId]);
        for (const e of graph.edges) {
            if (e.source === hoveredNodeId) neighborIds.add(e.target);
            if (e.target === hoveredNodeId) neighborIds.add(e.source);
        }
        return result.map((n) => ({
            ...n,
            data: {
                ...n.data,
                dimmed: !neighborIds.has(n.id),
                highlighted: n.id === hoveredNodeId,
            },
        }));
    }, [nodes, hoveredNodeId, graph.edges, nlHighlightedFiles]);

    const renderEdges = useMemo(() => {
        if (!hoveredNodeId) return edges;
        const connectedIds = new Set<string>();
        for (const e of graph.edges) {
            if (e.source === hoveredNodeId || e.target === hoveredNodeId) {
                connectedIds.add(e.id);
            }
        }
        return edges.map((e) => ({
            ...e,
            style: {
                ...e.style,
                stroke: connectedIds.has(e.id) ? (e.data?.baseColor ?? e.style?.stroke) : 'var(--ca-border)',
                strokeWidth: connectedIds.has(e.id) ? 3 : 1,
                opacity: connectedIds.has(e.id) ? 1 : 0.15,
            },
        }));
    }, [edges, hoveredNodeId, graph.edges]);

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

    const handleNodeMouseEnter = useCallback((_: React.MouseEvent, node: Node) => {
        setHoveredNodeId(node.id);
    }, []);

    const handleNodeMouseLeave = useCallback(() => {
        setHoveredNodeId(null);
    }, []);

    // Diff stats
    const stats = useMemo(() => ({
        total: graph.nodes.length,
        added: graph.nodes.filter((n) => n.diff === 'added').length,
        deleted: graph.nodes.filter((n) => n.diff === 'deleted').length,
        modified: graph.nodes.filter((n) => n.diff === 'modified').length,
    }), [graph]);

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            {/* Header */}
            <div className="ca-header">
                <div className="ca-header-title">
                    {/* #L2merge — feature:* renders here as the "Entry Points" call-topology
                        map; domain:* as the business-intent "Domains" map. */}
                    <span className="ca-header-badge">{String((graph as any).graphId ?? '').startsWith('domain:') ? 'Domains' : 'Entry Points'}</span>
                    <span>{graph.meta?.clusterCount ?? stats.total} {String((graph as any).graphId ?? '').startsWith('domain:') ? 'domains' : 'features'}</span>
                </div>
                <div className="ca-header-stats">
                    {/* Issue #735 — Modules ↔ Domains toggle. Sits inline
                        on the FeatureView header so the user can switch
                        clusterings (Louvain structural vs heuristic
                        business-intent) without leaving the canvas. */}
                    {/* This is the cluster-map view → Entry Points (feature:*) or Domains (domain:*) active. */}
                    <ClusterModeToggle
                        currentGraphId={String((graph as any).graphId ?? '')}
                        activeMode={String((graph as any).graphId ?? '').startsWith('domain:') ? 'domains' : 'entrypoints'}
                    />
                    <span className="ca-stat">Clusters: {stats.total}</span>
                    {stats.added > 0 && <span className="ca-stat"><span className="ca-stat-dot added" /> {stats.added} added</span>}
                    {stats.deleted > 0 && <span className="ca-stat"><span className="ca-stat-dot deleted" /> {stats.deleted} deleted</span>}
                    {stats.modified > 0 && <span className="ca-stat"><span className="ca-stat-dot modified" /> {stats.modified} modified</span>}
                </div>
            </div>

            {/* Navigation hint */}
            <div className="ca-seq-hint">
                {graph.nodes.length > 0
                    ? String((graph as any).graphId ?? '').startsWith('domain:')
                        ? <>Each node is a business domain. Click a domain to view its APIs{graph.edges.length > 0 && <span> · Hover to highlight shared code</span>}</>
                        : <>Each node is a feature; <strong>edges are calls between them</strong>. Click a feature to view its APIs{graph.edges.length > 0 && <span> · Hover to highlight connections</span>}</>
                    : <>No clusters detected. Run <strong>Initialize</strong> to analyze the codebase.</>
                }
            </div>

            <ReactFlow
                key={(graph as any).graphId ?? 'feature'}
                nodes={renderNodes}
                edges={renderEdges}
                onNodeClick={handleNodeClick}
                onNodeContextMenu={handleNodeRightClick}
                onEdgeClick={handleEdgeClick}
                onNodeMouseEnter={handleNodeMouseEnter}
                onNodeMouseLeave={handleNodeMouseLeave}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.25 }}
                minZoom={0.05}
                maxZoom={2.5}
                defaultEdgeOptions={{ type: 'smoothstep' }}
                proOptions={{ hideAttribution: true }}
            >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} color={getComputedStyle(document.documentElement).getPropertyValue('--ca-dot-grid').trim() || '#888'} />
                <Controls position="bottom-left" />
                <ForceMeasureNodes nodeIds={renderNodes.map(n => n.id)} />
            </ReactFlow>
        </div>
    );
}

// ─── Issue #735 / #L2merge — List · Entry Points · Domains view toggle ────

const CLUSTER_MODE_STORAGE_KEY = 'codeatlas.featureView.clusterMode';
const FEATURE_RENDER_KEY = 'codeatlas.featureView.render';

function readFeatureRender(): 'list' | 'map' {
    try { return window.localStorage?.getItem(FEATURE_RENDER_KEY) === 'map' ? 'map' : 'list'; } catch { return 'list'; }
}

type ToggleMode = 'list' | 'entrypoints' | 'domains';

/**
 * Segmented control for the backend Feature layer:
 *   - List        → FeatureApiListView(feature:*): endpoints grouped by feature.
 *   - Entry Points → ClusterFeatureView(feature:*): the call-topology map (which
 *                    feature calls which, cohesion + inter-cluster edges).
 *   - Domains     → ClusterFeatureView(domain:*): the business-intent cluster map.
 *
 * List↔Entry Points is a client-side render swap over the SAME feature graph
 * (localStorage + a `ca:featureRender` event the FeatureView dispatcher listens
 * for); Domains switches the graph via `openDomainDiagram`.
 */
function ClusterModeToggle({ currentGraphId, activeMode }: { currentGraphId: string; activeMode?: ToggleMode }) {
    const isDomain = currentGraphId.startsWith('domain:');
    // BUG-POLAR-16 follow-up: prefer the ACTUAL rendered mode (passed by whichever
    // view draws the toggle) over raw localStorage — otherwise a dense feature
    // graph that density-defaulted to List still highlighted "Entry Points"
    // because localStorage held 'map'. Fall back to localStorage for safety.
    const active: ToggleMode = activeMode ?? (isDomain ? 'domains' : (readFeatureRender() === 'map' ? 'entrypoints' : 'list'));

    const post = (msg: any) => {
        try { (window as any).vscodeApi?.postMessage(msg); } catch { /* noop — bus may not be ready in tests */ }
    };

    const setRender = (mode: 'list' | 'map') => {
        try {
            window.localStorage?.setItem(FEATURE_RENDER_KEY, mode);
            window.localStorage?.setItem(CLUSTER_MODE_STORAGE_KEY, 'modules');
        } catch { /* noop */ }
        try { window.dispatchEvent(new CustomEvent('ca:featureRender', { detail: { mode } })); } catch { /* noop */ }
    };

    const switchTo = (next: ToggleMode) => {
        if (next === active) return;
        if (next === 'domains') {
            try { window.localStorage?.setItem(CLUSTER_MODE_STORAGE_KEY, 'domains'); } catch { /* noop */ }
            post({ type: 'openDomainDiagram' });
            return;
        }
        // List / Entry Points render the feature graph; flip the client-side mode
        // (and re-fetch the feature graph if we were on Domains).
        setRender(next === 'entrypoints' ? 'map' : 'list');
        if (isDomain) post({ type: 'openFeatureDiagram', serviceId: '' });
    };

    const baseStyle: React.CSSProperties = {
        display: 'inline-flex',
        border: '1px solid var(--ca-border)',
        borderRadius: 6,
        overflow: 'hidden',
        fontSize: 11,
    };
    const optionStyle = (isActive: boolean): React.CSSProperties => ({
        padding: '3px 9px',
        cursor: isActive ? 'default' : 'pointer',
        background: isActive ? 'var(--ca-toggle-on-bg, rgba(91,141,239,0.18))' : 'transparent',
        color: isActive ? 'var(--ca-accent)' : 'var(--ca-text-muted)',
        fontWeight: isActive ? 600 : 500,
        userSelect: 'none' as const,
        whiteSpace: 'nowrap' as const,
    });

    return (
        <div
            role="radiogroup"
            aria-label="Feature view"
            style={baseStyle}
            title="List = endpoints grouped by feature · Entry Points = the feature call-topology map · Domains = business-intent cluster map"
        >
            <span role="radio" aria-checked={active === 'list'} onClick={() => switchTo('list')} style={optionStyle(active === 'list')} data-testid="cluster-mode-list">List</span>
            <span role="radio" aria-checked={active === 'entrypoints'} onClick={() => switchTo('entrypoints')} style={optionStyle(active === 'entrypoints')} data-testid="cluster-mode-entrypoints">Entry Points</span>
            <span role="radio" aria-checked={active === 'domains'} onClick={() => switchTo('domains')} style={optionStyle(active === 'domains')} data-testid="cluster-mode-domains">Domains</span>
        </div>
    );
}

export default FeatureView;
