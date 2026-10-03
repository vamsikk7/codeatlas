/**
 * CommentsPanel.tsx
 *
 * Right-side collapsible panel showing all comments grouped by layer.
 * Click a comment to navigate to the diagram containing it.
 * Resolve/reopen comments inline.
 */

import React, { useMemo, useState } from 'react';

interface Comment {
    id: string;
    status: 'open' | 'resolved';
    layer: string;
    targetType: string;
    targetId: string;
    anchor: { filePath?: string; symbol?: string };
    body: string;
    author: string;
    createdAt: string;
}

const LAYER_LABELS: Record<string, string> = {
    flow: 'L5 Flow', file: 'L4 File', sequence: 'L3 Sequence',
    'api-list': 'L2b API List', feature: 'L2a Feature', microservice: 'L1 System',
};

interface CommentsPanelProps {
    comments: Comment[];
    visible: boolean;
    onClose: () => void;
    onNavigate: (comment: Comment) => void;
    onResolve: (commentId: string) => void;
}

export default function CommentsPanel({ comments, visible, onClose, onNavigate, onResolve }: CommentsPanelProps) {
    // #504 — source filter: All / User / AI.
    const [sourceFilter, setSourceFilter] = useState<'all' | 'user' | 'ai'>('all');

    // All hooks must be called unconditionally on every render — the
    // `if (!visible) return null` must come AFTER, not before, the
    // useMemo calls below. Putting the early return between hooks made
    // the hook count vary across renders (1 when hidden, 7 when shown),
    // tripping React's invariant ("Rendered more hooks than the previous
    // render") the first time the panel opens on top of a diagram view.

    const filteredBySource = useMemo(() => {
        if (sourceFilter === 'all') return comments;
        return comments.filter((c: any) => (c.source ?? 'user') === sourceFilter);
    }, [comments, sourceFilter]);

    const userCount = useMemo(() => comments.filter((c: any) => (c.source ?? 'user') === 'user' && c.status === 'open').length, [comments]);
    const aiCount = useMemo(() => comments.filter((c: any) => c.source === 'ai' && c.status === 'open').length, [comments]);

    const openComments = useMemo(() => filteredBySource.filter(c => c.status === 'open'), [filteredBySource]);
    const resolvedComments = useMemo(() => filteredBySource.filter(c => c.status === 'resolved'), [filteredBySource]);

    const grouped = useMemo(() => {
        const groups: Record<string, Comment[]> = {};
        for (const c of openComments) {
            const key = LAYER_LABELS[c.layer] ?? c.layer;
            if (!groups[key]) groups[key] = [];
            groups[key].push(c);
        }
        return groups;
    }, [openComments]);

    if (!visible) return null;

    return (
        <div style={panelStyle}>
            {/* Header */}
            <div style={headerStyle}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>
                    💬 Comments ({openComments.length} open)
                </span>
                <button onClick={onClose} style={closeBtnStyle} aria-label="Close comments panel">x</button>
            </div>

            {/* #504 — source-filter tabs */}
            <div style={{ display: 'flex', gap: 0, fontSize: 11, borderBottom: '1px solid var(--ca-border)' }}>
                {([
                    { key: 'all', label: `All (${userCount + aiCount})` },
                    { key: 'user', label: `User (${userCount})` },
                    { key: 'ai', label: `AI (${aiCount})` },
                ] as const).map(({ key, label }) => (
                    <button
                        key={key}
                        onClick={() => setSourceFilter(key)}
                        style={{
                            padding: '6px 12px', cursor: 'pointer',
                            background: 'transparent', border: 'none',
                            color: sourceFilter === key ? 'var(--ca-text)' : 'var(--ca-text-dim, #9ca0a8)',
                            borderBottom: sourceFilter === key ? '2px solid var(--ca-accent, #6c72cb)' : '2px solid transparent',
                            fontWeight: sourceFilter === key ? 600 : 400,
                        }}
                    >{label}</button>
                ))}
            </div>

            {/* Empty state */}
            {comments.length === 0 && (
                <div style={{ padding: 16, color: 'var(--ca-text-muted)', fontSize: 12, textAlign: 'center' }}>
                    No comments yet. Right-click any node to add one.
                </div>
            )}

            {/* Open comments grouped by layer */}
            <div style={{ overflowY: 'auto', flex: 1 }}>
                {Object.entries(grouped).map(([layer, items]) => (
                    <div key={layer}>
                        <div style={groupHeaderStyle}>{layer} ({items.length})</div>
                        {items.map(c => (
                            <div
                                key={c.id}
                                style={commentItemStyle}
                                onClick={() => onNavigate(c)}
                                title="Click to navigate to this node"
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--ca-text)' }}>
                                        {c.anchor?.symbol ?? c.targetId}
                                    </span>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onResolve(c.id); }}
                                        style={resolveBtnStyle}
                                        title="Mark as resolved"
                                    >
                                        Resolve
                                    </button>
                                </div>
                                <div style={{ fontSize: 10, color: 'var(--ca-text-muted)', marginTop: 2 }}>
                                    {c.anchor?.filePath?.split('/').pop()}
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--ca-text)', marginTop: 4, lineHeight: 1.4 }}>
                                    {c.body}
                                </div>
                                <div style={{ fontSize: 9, color: 'var(--ca-text-muted)', marginTop: 4 }}>
                                    {c.author} — {c.createdAt.split('T')[0]}
                                </div>
                            </div>
                        ))}
                    </div>
                ))}

                {/* Resolved comments (collapsed) */}
                {resolvedComments.length > 0 && (
                    <div>
                        <div style={{ ...groupHeaderStyle, color: 'var(--ca-text-muted)' }}>
                            Resolved ({resolvedComments.length})
                        </div>
                        {resolvedComments.map(c => (
                            <div key={c.id} style={{ ...commentItemStyle, opacity: 0.5 }}>
                                <div style={{ fontSize: 11, textDecoration: 'line-through', color: 'var(--ca-text-muted)' }}>
                                    {c.anchor?.symbol ?? c.targetId}: {c.body.slice(0, 50)}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

const panelStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0, right: 0, bottom: 0,
    width: 320,
    background: 'var(--ca-surface)',
    borderLeft: '1px solid var(--ca-border)',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 25,
    boxShadow: 'var(--ca-shadow-lg)',
};

const headerStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 14px',
    borderBottom: '1px solid var(--ca-border)',
    color: 'var(--ca-text)',
};

const closeBtnStyle: React.CSSProperties = {
    background: 'none', border: 'none', color: 'var(--ca-text-muted)',
    cursor: 'pointer', fontSize: 14, padding: '2px 6px',
};

const groupHeaderStyle: React.CSSProperties = {
    padding: '8px 14px 4px',
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--ca-accent)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
};

const commentItemStyle: React.CSSProperties = {
    padding: '8px 14px',
    borderBottom: '1px solid var(--ca-border)',
    cursor: 'pointer',
    transition: 'background 0.1s',
};

const resolveBtnStyle: React.CSSProperties = {
    background: 'var(--ca-success)',
    border: 'none', borderRadius: 4,
    color: '#fff', fontSize: 9, fontWeight: 600,
    padding: '2px 6px', cursor: 'pointer',
};
