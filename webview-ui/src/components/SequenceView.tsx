import React, { useCallback, useMemo, useEffect, useState } from 'react';
import ReactFlow, {
    Background,
    Controls,
    Node,
    Edge,
    useNodesState,
    useEdgesState,
    MarkerType,
    BackgroundVariant,
    Position,
    Handle,
} from 'reactflow';
import 'reactflow/dist/style.css';
import SequenceNode from './SequenceNode';
import { EDGE_DIFF_COLORS } from '../diffColors';
import { ForceMeasureNodes } from './ForceMeasureNodes';

interface SequenceViewProps {
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
    /**
     * When set, the matching message edge id is highlighted (thicker stroke,
     * animated, glow); all other message edges dim. Drives the tour playback
     * walker — see TourPlaybackControls.
     */
    activeMessageEdgeId?: string;
}

function AnchorNode({ sourcePosition, targetPosition }: any) {
    return (
        <div style={{ width: 1, height: 1, opacity: 0 }}>
            <Handle type="target" position={targetPosition} style={{ opacity: 0 }} />
            <Handle type="source" position={sourcePosition} style={{ opacity: 0 }} />
        </div>
    );
}

const nodeTypes = { sequenceNode: SequenceNode, anchorNode: AnchorNode };

// Layout constants
const BASE_LANE_WIDTH = 300;
const MIN_LANE_WIDTH = 220;
const PARTICIPANT_GUTTER = 30;  // breathing room between adjacent participant nodes
const PARTICIPANT_Y = 40;
const MSG_START_Y = 160;
const MSG_GAP = 50;
const LIFELINE_OFFSET_Y = 20; // gap below participant to start lifeline

/** Compute lane width — shrinks for many participants to fit narrow panels. */
function computeLaneWidth(participantCount: number): number {
    if (participantCount <= 4) return BASE_LANE_WIDTH;
    // Gradually narrow lanes: 300 → 220 as participants increase from 5 → 12+.
    // Slower decay than before so participant nodes (max width 240) never
    // overlap with their neighbours. Each step trims 10px instead of 12.
    return Math.max(MIN_LANE_WIDTH, Math.round(BASE_LANE_WIDTH - (participantCount - 4) * 10));
}

const edgeDiffColors = EDGE_DIFF_COLORS;

/**
 * Build a swimlane-style sequence diagram from the graph data.
 * 
 * Layout strategy:
 *  1. Separate participant nodes and other nodes
 *  2. Place participants horizontally at equal intervals
 *  3. Create lifeline nodes below each participant
 *  4. Route message edges between source/target lifeline positions at stacked Y levels
 */
/**
 * Order sequence participants left-to-right: API Client (actor) first, then the
 * ENTRY-POINT file (the route/handler file), then modules, external services, ghosts.
 *
 * Issue 241 established the class buckets (actor → module → service → ghost) with an
 * alphabetical tiebreak within a class. BUG-CONNECT-3: the entry-point file and its
 * callees frequently share the `«module»` class, so the alphabetical tiebreak floated
 * a callee ahead of the entry file (e.g. CustomFieldService before endpoints.py) — a
 * caller-before-callee violation, endpoint-specific because it's purely alphabetical.
 * Fix: after the class sort, pin the entry-point file (identified by
 * `anchor.filePath === meta.filePath`, or `body === meta.fileName`) to lane 2 (right
 * after the actor). No-op when it's already there, so already-correct cases don't regress.
 */
export function orderSequenceParticipants(
    participantNodes: any[],
    meta?: { filePath?: string; fileName?: string },
): any[] {
    const classifyParticipant = (n: any): number => {
        if (n.label === 'API Client') return 0;
        const kind = n.meta?.participantKind ?? n.subtitle ?? '';
        if (kind.includes('module') || kind.includes('handler') || kind.includes('function')) return 1;
        if (kind.includes('service') || kind.includes('database') || kind.includes('external')) return 3;
        if (n.type === 'ghost') return 4;
        return 2; // unknown — between modules and external
    };
    const ordered = [...participantNodes].sort((a, b) => {
        const ca = classifyParticipant(a), cb = classifyParticipant(b);
        if (ca !== cb) return ca - cb;
        return a.label.localeCompare(b.label); // alphabetical within same class
    });
    const entryPath = meta?.filePath;
    const entryName = meta?.fileName;
    if (entryPath || entryName) {
        // BUG-CONNECT-3: the entry-file participant is uniquely identified by its
        // `body` (the file basename, e.g. 'order.py'). Match on body FIRST — callees
        // invoked FROM the entry file share the entry's `anchor.filePath`
        // (e.g. CustomerOrderService is anchored to order.py because that's where it's
        // called), so an anchor-only match can land on an alphabetically-earlier callee
        // that the sort floated to lane 1, leaving the pin a no-op. Fall back to the
        // anchor only when no participant carries the entry filename as its body.
        let idx = entryName
            ? ordered.findIndex((n) => n.label !== 'API Client' && n.body === entryName)
            : -1;
        if (idx < 0 && entryPath) {
            idx = ordered.findIndex((n) => n.label !== 'API Client' && n.anchor?.filePath === entryPath);
        }
        if (idx > 1) {
            const [entry] = ordered.splice(idx, 1);
            ordered.splice(1, 0, entry); // lane 2 — right after the actor
        }
    }
    return ordered;
}

function buildSequenceLayout(graph: SequenceViewProps['graph']): { nodes: Node[]; edges: Edge[] } {
    const rfNodes: Node[] = [];
    const rfEdges: Edge[] = [];

    // Separate participant nodes and identify message edges
    const participantNodes = graph.nodes.filter(n => n.type === 'participant' || n.type === 'ghost');
    const messageEdges = graph.edges.filter(e => e.edgeType === 'message' || e.diff === 'deleted');

    // Issue 241 + BUG-CONNECT-3: stable participant ordering with the entry-point
    // file pinned to lane 2 (right after the actor).
    const orderedParticipants = orderSequenceParticipants(participantNodes, graph.meta as any);
    const participantIdToIndex = new Map<string, number>();
    orderedParticipants.forEach((p, i) => participantIdToIndex.set(p.id, i));

    const laneWidth = computeLaneWidth(orderedParticipants.length);

    // Calculate lifeline height based on number of messages
    const lifelineHeight = Math.max(300, (messageEdges.length + 2) * MSG_GAP);

    // Create participant header nodes
    // Cap node width so adjacent nodes never visually overlap — leave at
    // least PARTICIPANT_GUTTER pixels of breathing room between them.
    const maxNodeWidth = Math.max(140, laneWidth - PARTICIPANT_GUTTER);
    orderedParticipants.forEach((p, index) => {
        const x = index * laneWidth + 40;

        // Participant header node
        rfNodes.push({
            id: p.id,
            type: 'sequenceNode',
            data: {
                label: p.label,
                subtitle: p.subtitle,
                body: p.body,
                type: p.type,
                kind: p.kind,
                diff: p.diff,
                diffDetail: p.diffDetail,
                anchor: p.anchor,
                isLifeline: false,
                participantIndex: index,
                maxNodeWidth,
                // #542 — thread graphId+nodeId into each participant node's data.
                graphId: graph.graphId,
                nodeId: p.id,
            },
            position: { x, y: PARTICIPANT_Y },
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
        });

        // Lifeline node (invisible dashed line placeholder)
        const lifelineId = `lifeline_${p.id}`;
        rfNodes.push({
            id: lifelineId,
            type: 'sequenceNode',
            data: {
                label: '',
                type: 'lifeline',
                diff: p.diff,
                isLifeline: true,
                lifelineHeight,
                participantIndex: index,
                anchor: p.anchor,
            },
            position: { x: x + 89, y: PARTICIPANT_Y + 80 + LIFELINE_OFFSET_Y },
            sourcePosition: Position.Bottom,
            targetPosition: Position.Top,
            selectable: false,
            draggable: false,
        });
    });

    // Create message edges as horizontal arrows between lifelines
    messageEdges.forEach((e, msgIndex) => {
        const sourceParticipantIdx = participantIdToIndex.get(e.source);
        const targetParticipantIdx = participantIdToIndex.get(e.target);

        if (sourceParticipantIdx == null || targetParticipantIdx == null) return;

        const y = MSG_START_Y + (msgIndex + 1) * MSG_GAP;
        const sourceX = sourceParticipantIdx * laneWidth + 40 + 90;
        const targetX = targetParticipantIdx * laneWidth + 40 + 90;

        const isSelfCall = sourceParticipantIdx === targetParticipantIdx;
        const isReverse = sourceParticipantIdx > targetParticipantIdx;
        // Propagate participant diff onto an INCOMING edge only: if the
        // target participant changed, mark the arrow into it so users see
        // "this call enters a changed module". Issue 379: previously this
        // also fired when the SOURCE participant was modified, which made
        // every outgoing arrow from a modified participant look modified
        // too (e.g. prisma.user.findUnique and generateToken arrows from a
        // modified auth.service.ts), creating visual noise that contradicted
        // the underlying graph data and confused users about what actually
        // changed. The call into the modified participant is the meaningful
        // signal; calls out of it are routing detail, not changes.
        const rawDiff = e.diff || 'unchanged';
        const targetParticipant = orderedParticipants[targetParticipantIdx];
        const participantDiff = targetParticipant?.diff !== 'unchanged' ? targetParticipant?.diff : undefined;
        const diff = rawDiff === 'unchanged' && participantDiff ? participantDiff : rawDiff;
        const color = edgeDiffColors[diff] || edgeDiffColors.unchanged;
        const isDeleted = diff === 'deleted';

        // Truncate labels that would be wider than the arrow between participants.
        // At ~6.6px per monospace char (font-size 11), labels wider than the arrow
        // cover the arrowhead entirely, making the message invisible.
        const spanCount = Math.abs(targetParticipantIdx - sourceParticipantIdx);
        const maxLabelChars = isSelfCall ? 30 : Math.max(18, spanCount * 25);
        const rawLabel = e.label || '';
        const displayLabel = rawLabel.length > maxLabelChars
            ? rawLabel.slice(0, maxLabelChars - 1) + '…'
            : rawLabel;

        // Create invisible anchor nodes for message endpoints on the lifelines
        const srcAnchorId = `msg_src_${e.id}`;
        const tgtAnchorId = `msg_tgt_${e.id}`;

        if (isSelfCall) {
            // Self-call: render as a right-side loop using smoothstep edge.
            // Place source and target anchors at slightly different Y positions,
            // both with Right-side handles so ReactFlow routes the edge outward.
            const SELF_CALL_GAP = 24;

            rfNodes.push({
                id: srcAnchorId,
                type: 'anchorNode',
                data: { label: '' },
                position: { x: sourceX - 1, y },
                style: { width: 2, height: 2, background: 'transparent', border: 'none', padding: 0 },
                sourcePosition: Position.Right,
                targetPosition: Position.Right,
                selectable: false,
                draggable: false,
            });

            rfNodes.push({
                id: tgtAnchorId,
                type: 'anchorNode',
                data: { label: '' },
                position: { x: sourceX - 1, y: y + SELF_CALL_GAP },
                style: { width: 2, height: 2, background: 'transparent', border: 'none', padding: 0 },
                sourcePosition: Position.Right,
                targetPosition: Position.Right,
                selectable: false,
                draggable: false,
            });

            rfEdges.push({
                id: e.id,
                source: srcAnchorId,
                target: tgtAnchorId,
                label: displayLabel,
                type: 'smoothstep',
                animated: diff === 'added',
                style: {
                    stroke: color,
                    strokeWidth: isDeleted ? 1 : (e.meta as any)?.isReturn ? 1.5 : 2,
                    strokeDasharray: isDeleted ? '6,4' : diff === 'modified' ? '3,3' : (e.meta as any)?.isReturn ? '6,3' : undefined,
                    opacity: isDeleted ? 0.5 : (e.meta as any)?.isReturn ? 0.7 : 1,
                },
                labelStyle: {
                    fontSize: 11,
                    fontFamily: "'SF Mono', 'Fira Code', monospace",
                    fill: diff !== 'unchanged' ? color : 'var(--ca-edge-label-text)',
                    fontWeight: diff !== 'unchanged' ? 700 : 500,
                },
                labelBgStyle: {
                    fill: 'var(--ca-label-bg)',
                    fillOpacity: 0.85,
                    rx: 4,
                    ry: 4,
                },
                labelBgPadding: [6, 4] as [number, number],
                markerEnd: {
                    type: MarkerType.ArrowClosed,
                    color,
                    width: 14,
                    height: 14,
                },
                data: {
                    diff: e.diff,
                    anchor: graph.anchors?.[e.id],
                    source: e.source,
                    target: e.target,
                    edgeType: e.edgeType,
                    sourceParticipant: orderedParticipants[sourceParticipantIdx],
                    targetParticipant: orderedParticipants[targetParticipantIdx],
                },
            });
        } else {
            // Normal cross-participant message
            rfNodes.push({
                id: srcAnchorId,
                type: 'anchorNode',
                data: { label: '' },
                position: { x: sourceX - 1, y },
                style: { width: 2, height: 2, background: 'transparent', border: 'none', padding: 0 },
                sourcePosition: isReverse ? Position.Left : Position.Right,
                targetPosition: isReverse ? Position.Right : Position.Left,
                selectable: false,
                draggable: false,
            });

            rfNodes.push({
                id: tgtAnchorId,
                type: 'anchorNode',
                data: { label: '' },
                position: { x: targetX - 1, y },
                style: { width: 2, height: 2, background: 'transparent', border: 'none', padding: 0 },
                sourcePosition: isReverse ? Position.Right : Position.Left,
                targetPosition: isReverse ? Position.Left : Position.Right,
                selectable: false,
                draggable: false,
            });

            rfEdges.push({
                id: e.id,
                source: srcAnchorId,
                target: tgtAnchorId,
                label: displayLabel,
                type: 'straight',
                animated: diff === 'added',
                style: {
                    stroke: color,
                    strokeWidth: isDeleted ? 1 : (e.meta as any)?.isReturn ? 1.5 : 2,
                    strokeDasharray: isDeleted ? '6,4' : diff === 'modified' ? '3,3' : (e.meta as any)?.isReturn ? '6,3' : undefined,
                    opacity: isDeleted ? 0.5 : (e.meta as any)?.isReturn ? 0.7 : 1,
                },
                labelStyle: {
                    fontSize: 11,
                    fontFamily: "'SF Mono', 'Fira Code', monospace",
                    fill: diff !== 'unchanged' ? color : 'var(--ca-edge-label-text)',
                    fontWeight: diff !== 'unchanged' ? 700 : 500,
                },
                labelBgStyle: {
                    fill: 'var(--ca-label-bg)',
                    fillOpacity: 1,
                    rx: 4,
                    ry: 4,
                },
                labelBgPadding: [6, 4] as [number, number],
                markerEnd: {
                    type: MarkerType.ArrowClosed,
                    color,
                    width: 14,
                    height: 14,
                },
                data: {
                    diff: e.diff,
                    anchor: graph.anchors?.[e.id],
                    source: e.source,
                    target: e.target,
                    edgeType: e.edgeType,
                    sourceParticipant: orderedParticipants[sourceParticipantIdx],
                    targetParticipant: orderedParticipants[targetParticipantIdx],
                },
            });
        }
    });

    return { nodes: rfNodes, edges: rfEdges };
}

function SequenceView({ graph, onNodeClick, onNodeRightClick, onEdgeClick, highlightedNodes, commentCounts, activeMessageEdgeId }: SequenceViewProps) {
    const [searchQuery, setSearchQuery] = useState('');

    // Reset search when navigating to a different diagram
    useEffect(() => { setSearchQuery(''); }, [graph]);

    const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(
        () => buildSequenceLayout(graph),
        [graph]
    );

    // 2026-06-09 — see DiagramView for the full rationale. The legacy
    // `useNodesState`/`useEdgesState` + `useEffect → setNodes/setEdges`
    // pattern hit a handleBounds race that dropped every edge. Pass the
    // filtered nodes/edges as `defaultNodes`/`defaultEdges` and use
    // `ForceMeasureNodes` to stamp handleBounds on the RF store.
    // Filtered-shadow variants (`filteredNodes`/`filteredEdges`)
    // computed below; we don't need the local-state copy.

    // Build set of file paths that have NL query highlights
    const nlHighlightedFiles = useMemo(() => {
        if (!highlightedNodes || Object.keys(highlightedNodes).length === 0) return null;
        const files = new Set<string>();
        for (const key of Object.keys(highlightedNodes)) {
            if (highlightedNodes[key] === 'nl-query') files.add(key.split('::')[0]);
        }
        return files.size > 0 ? files : null;
    }, [highlightedNodes]);

    // Apply comment counts + search filter + NL query highlight
    const filteredNodes = useMemo(() => {
        let result = layoutedNodes;
        // Inject comment counts into participant nodes
        if (commentCounts && Object.keys(commentCounts).length > 0) {
            result = result.map(n => {
                if (n.data?.isLifeline) return n;
                const count = commentCounts[n.id];
                if (!count) return n;
                return { ...n, data: { ...n.data, meta: { ...n.data?.meta, commentCount: count } } };
            });
        }
        // Apply NL query highlights to participant headers
        if (nlHighlightedFiles) {
            result = result.map(n => {
                if (n.data?.isLifeline) return n;
                const anchor = n.data?.anchor;
                if (!anchor?.filePath) return n;
                const hasMatch = nlHighlightedFiles.has(anchor.filePath);
                if (!hasMatch) return n;
                return { ...n, style: { ...n.style, outline: '2px solid var(--ca-nl-query)', outlineOffset: '2px', borderRadius: '6px' } };
            });
        }
        if (!searchQuery) return result;
        const q = searchQuery.toLowerCase();
        return result.map(n => {
            if (n.data?.isLifeline) return n;
            const label = (n.data?.label ?? '').toLowerCase();
            const matches = label.includes(q);
            return { ...n, data: { ...n.data, dimmed: !matches } };
        });
    }, [layoutedNodes, searchQuery, nlHighlightedFiles, commentCounts]);

    // Build participant node ID → filePath lookup for edge highlighting
    const participantFileMap = useMemo(() => {
        const map = new Map<string, string>();
        for (const n of layoutedNodes) {
            if (n.data?.anchor?.filePath && !n.data?.isLifeline) {
                map.set(n.id, n.data.anchor.filePath);
            }
        }
        return map;
    }, [layoutedNodes]);

    const filteredEdges = useMemo(() => {
        let result = layoutedEdges;
        // Issue 119: Apply NL query highlight to edges between highlighted participants
        if (nlHighlightedFiles && participantFileMap.size > 0) {
            result = result.map(e => {
                const srcFile = participantFileMap.get(e.source);
                const tgtFile = participantFileMap.get(e.target);
                const srcMatch = srcFile && nlHighlightedFiles.has(srcFile);
                const tgtMatch = tgtFile && nlHighlightedFiles.has(tgtFile);
                if (srcMatch && tgtMatch) {
                    return { ...e, style: { ...e.style, stroke: 'var(--ca-nl-query)', strokeWidth: 2.5 } };
                }
                return e;
            });
        }
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            result = result.map(e => {
                const label = (typeof e.label === 'string' ? e.label : '').toLowerCase();
                const matches = label.includes(q);
                return { ...e, style: { ...e.style, opacity: matches ? (e.style?.opacity ?? 1) : 0.15 } };
            });
        }
        // Tour playback: spotlight one message edge, dim the rest. Applied
        // after search/NL highlight so the active edge always stands out
        // regardless of other filters.
        if (activeMessageEdgeId) {
            result = result.map(e => {
                const isMessage = e.data?.edgeType === 'message';
                if (!isMessage) return e;
                if (e.id === activeMessageEdgeId) {
                    return {
                        ...e,
                        animated: true,
                        style: {
                            ...e.style,
                            stroke: 'var(--ca-accent)',
                            strokeWidth: 3.5,
                            opacity: 1,
                            filter: 'drop-shadow(0 0 4px var(--ca-accent))',
                        },
                        labelStyle: { ...(e.labelStyle as any), fontWeight: 700, fill: 'var(--ca-accent)' },
                    };
                }
                return { ...e, style: { ...e.style, opacity: 0.25 } };
            });
        }
        return result;
    }, [layoutedEdges, searchQuery, nlHighlightedFiles, participantFileMap, activeMessageEdgeId]);

    const nodes = filteredNodes;
    const edges = filteredEdges;

    const handleNodeClick = useCallback((e: React.MouseEvent, node: Node) => {
        // Only respond to participant header clicks, not lifelines or anchors
        if (node.data?.isLifeline || node.type === 'default') return;
        onNodeClick(node.id, node.data, e);
    }, [onNodeClick]);

    const handleNodeRightClick = useCallback((e: React.MouseEvent, node: Node) => {
        if (node.data?.isLifeline || node.type === 'default') return;
        e.preventDefault();
        onNodeRightClick?.(node.id, node.data, e);
    }, [onNodeRightClick]);

    const handleEdgeClick = useCallback((_: any, edge: Edge) => {
        onEdgeClick(edge.id, edge.data);
    }, [onEdgeClick]);

    // Compute diff stats
    const stats = useMemo(() => {
        const participantNodes = graph.nodes.filter(n => n.type === 'participant');
        const added = participantNodes.filter(n => n.diff === 'added').length;
        const deleted = participantNodes.filter(n => n.diff === 'deleted').length;
        const modified = participantNodes.filter(n => n.diff === 'modified').length;
        const msgEdges = graph.edges.filter(e => e.edgeType === 'message');
        const changedMsgs = msgEdges.filter(e =>
            e.diff === 'modified' || e.diff === 'added' || e.diff === 'deleted'
        ).length;
        return {
            participants: participantNodes.length,
            messages: msgEdges.length,
            added, deleted, modified, changedMsgs,
        };
    }, [graph]);

    const graphTitle = graph.meta?.fileName || graph.graphId;

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            {/* Header */}
            <div className="ca-header">
                <div className="ca-header-title">
                    <span className="ca-header-badge ca-badge-sequence">API Sequence</span>
                    <span>{graphTitle}</span>
                </div>
                <div className="ca-header-stats">
                    <span className="ca-stat">👤 {stats.participants} participant{stats.participants !== 1 ? 's' : ''}</span>
                    <span className="ca-stat">→ {stats.messages} message{stats.messages !== 1 ? 's' : ''}</span>
                    {stats.added > 0 && (
                        <span className="ca-stat"><span className="ca-stat-dot added" /> {stats.added} added</span>
                    )}
                    {stats.deleted > 0 && (
                        <span className="ca-stat"><span className="ca-stat-dot deleted" /> {stats.deleted} deleted</span>
                    )}
                    {stats.modified > 0 && (
                        <span className="ca-stat"><span className="ca-stat-dot modified" /> {stats.modified} modified</span>
                    )}
                    {stats.changedMsgs > 0 && (
                        <span className="ca-stat"><span className="ca-stat-dot modified" /> {stats.changedMsgs} msg change{stats.changedMsgs !== 1 ? 's' : ''}</span>
                    )}
                </div>
            </div>

            {/* Navigation hint + search */}
            <div className="ca-seq-hint" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ flex: 1 }}>
                    {stats.participants > 0
                        ? <>Click a participant to open its <strong>File Diagram</strong> · Click a message to open <strong>Function Flow</strong></>
                        : <>No external calls detected in this handler. The function doesn&apos;t call other services or modules.</>
                    }
                </span>
                {stats.participants > 0 && (
                    <input
                        type="text"
                        placeholder="Filter messages..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        style={{
                            width: 160,
                            padding: '3px 8px',
                            fontSize: 10,
                            background: 'var(--ca-surface)',
                            border: '1px solid var(--ca-border)',
                            borderRadius: 4,
                            color: 'var(--ca-text)',
                            outline: 'none',
                        }}
                    />
                )}
            </div>

            {/* React Flow canvas */}
            <ReactFlow
                key={(graph as any).graphId ?? 'sequence'}
                nodes={nodes}
                edges={edges}
                onNodeClick={handleNodeClick}
                onNodeContextMenu={handleNodeRightClick}
                onEdgeClick={handleEdgeClick}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.3 }}
                minZoom={0.05}
                maxZoom={2.5}
                defaultEdgeOptions={{ type: 'straight' }}
                proOptions={{ hideAttribution: true }}
                nodesDraggable={false}
                nodesConnectable={false}
            >
                <Background variant={BackgroundVariant.Dots} gap={16} size={1} color={getComputedStyle(document.documentElement).getPropertyValue('--ca-dot-grid').trim() || '#888'} />
                <Controls position="bottom-left" />
                <ForceMeasureNodes nodeIds={nodes.map(n => n.id)} />
            </ReactFlow>
        </div>
    );
}

export default SequenceView;
