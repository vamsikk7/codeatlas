import React, { memo, CSSProperties } from 'react';
import { Handle, Position } from 'reactflow';
import { NODE_DIFF_COLORS, DIFF_SYMBOLS, DIFF_BORDER_STYLES } from '../diffColors';

interface SequenceNodeData {
    label: string;
    subtitle?: string;
    body?: string;
    type: string;
    kind?: string;
    diff?: string;
    diffDetail?: { deleted?: string; added?: string };
    anchor?: any;
    isLifeline?: boolean;
    participantIndex?: number;
    lifelineHeight?: number;
    maxNodeWidth?: number;
}

const kindIcons: Record<string, string> = {
    client: '👤',
    actor: '👤',
    database: '🗄️',
    cache: '⚡',
    storage: '📦',
    service: '🌐',
    module: '📦',
    function: 'ƒ',
    file: '📄',
    // UX-30: middleware kinds. Synthesized participants between the
    // API Client and the handler.
    middleware: '🔗',
};

// UX-30: per-middleware-kind icon so the swimlane reads the role at a glance.
const middlewareKindIcons: Record<string, string> = {
    'auth-required': '🔒',
    'auth-optional': '🔓',
    'cors': '🛡',
    'rate-limit': '⏱',
    'cache': '⚡',
    'logging': '📋',
    'validator': '✓',
    'parser': '📥',
    'compression': '🗜',
    'session': '🍪',
    'csrf': '🛡',
    'security': '🛡',
    'transform': '🔄',
    'error-handler': '🚨',
    'other': '🔗',
};

/**
 * SequenceNode renders either:
 *  - A participant header box (top of a swimlane)
 *  - A lifeline node (dashed vertical line below the participant)
 */
function SequenceNode({ data }: { data: SequenceNodeData }) {
    if (data.isLifeline) {
        return <LifelineNode data={data} />;
    }
    return <ParticipantHeader data={data} />;
}

function ParticipantHeader({ data }: { data: SequenceNodeData }) {
    const diff = data.diff || 'unchanged';
    const colors = NODE_DIFF_COLORS[diff] || NODE_DIFF_COLORS.unchanged;
    const isDeleted = diff === 'deleted';

    // Determine kind from subtitle
    const kindStr = (data.subtitle || '').replace(/[«»]/g, '').toLowerCase().trim();
    // UX-30: pick the middleware-specific icon when the participant
    // was woven in from `meta.middlewares` (carries meta.middlewareKind).
    const mwKind = (data as any)?.meta?.middlewareKind as string | undefined;
    const icon = mwKind
        ? (middlewareKindIcons[mwKind] || middlewareKindIcons.other)
        : (kindIcons[kindStr] || kindIcons[data.kind || ''] || '•');

    // Defensive max-width cap from the parent layout so very dense diagrams
    // (10+ participants) never have overlapping headers. Defaults to the
    // historical 240 when no override is supplied.
    const dynMaxWidth = typeof data.maxNodeWidth === 'number' ? data.maxNodeWidth : 240;
    // #360: pass border + shadow color through CSS custom properties so
    // :hover rules can override them via the cascade — no `!important`
    // needed. Inline styles still set the geometry/layout values, but the
    // colors that change on hover live in CSS variables.
    const containerStyle: CSSProperties = {
        ...{ '--ca-node-border-color': colors.border, '--ca-node-shadow-color': colors.glow } as Record<string, string>,
        background: colors.bg,
        border: `2px ${DIFF_BORDER_STYLES[diff] || 'solid'} var(--ca-node-border-color)`,
        borderRadius: 12,
        padding: '12px 16px',
        minWidth: Math.min(180, dynMaxWidth),
        maxWidth: dynMaxWidth,
        textAlign: 'center',
        boxShadow: '0 4px 16px var(--ca-node-shadow-color), 0 2px 4px rgba(0,0,0,0.3)',
        opacity: isDeleted ? 0.7 : 1,
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        fontFamily: "'Inter', system-ui, sans-serif",
        position: 'relative',
    };

    const labelStyle: CSSProperties = {
        fontSize: 13,
        fontWeight: 700,
        color: isDeleted ? 'var(--ca-deleted-text)' : 'var(--ca-text)',
        textDecoration: isDeleted ? 'line-through' : 'none',
        lineHeight: 1.3,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: 200,
    };

    const subtitleStyle: CSSProperties = {
        fontSize: 10,
        color: 'var(--ca-accent)',
        marginTop: 2,
        letterSpacing: '0.5px',
        fontWeight: 500,
    };

    const bodyStyle: CSSProperties = {
        fontSize: 10,
        color: 'var(--ca-text-muted)',
        marginTop: 6,
        padding: '3px 6px',
        background: 'var(--ca-node-body-bg)',
        borderRadius: 4,
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' as const,
        maxWidth: 220,
    };

    const diffBadgeStyle: CSSProperties = {
        position: 'absolute' as const,
        top: -8,
        right: -8,
        fontSize: 8,
        fontWeight: 700,
        padding: '2px 7px',
        borderRadius: 10,
        background: colors.border,
        color: 'var(--ca-bg)',
        textTransform: 'uppercase' as const,
        letterSpacing: '0.5px',
    };

    return (
        <div style={{ position: 'relative' }}>
            <Handle
                type="target"
                position={Position.Top}
                style={{ background: colors.border, width: 6, height: 6, border: 'none', opacity: 0 }}
            />
            <div style={containerStyle} className="ca-seq-participant">
                <div style={{ fontSize: 20, marginBottom: 4, opacity: 0.7 }}>{icon}</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                    <div style={labelStyle} title={data.label}>{data.label}</div>
                    {(data as any).meta?.commentCount > 0 && (
                        // Issue 134: click opens the Comments Panel
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('codeatlas:open-comments')); }}
                            style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 8, background: 'var(--ca-accent)', color: '#fff', flexShrink: 0, border: 'none', cursor: 'pointer' }}
                            title={`${(data as any).meta.commentCount} comment${(data as any).meta.commentCount > 1 ? 's' : ''} — click to open Comments`}
                            aria-label={`Open ${(data as any).meta.commentCount} comment${(data as any).meta.commentCount > 1 ? 's' : ''}`}
                        >
                            💬{(data as any).meta.commentCount}
                        </button>
                    )}
                </div>
                {data.subtitle && <div style={subtitleStyle}>{data.subtitle}</div>}
                {data.body && !data.diffDetail && (
                    <div style={bodyStyle} title={data.body}>{data.body}</div>
                )}
                {data.diffDetail && (
                    <div style={{ marginTop: 4, fontSize: 9, lineHeight: 1.4, textAlign: 'left' }}>
                        {data.diffDetail.deleted && (
                            <div style={{ color: 'var(--ca-deleted-text)' }}>- {truncate(data.diffDetail.deleted, 40)}</div>
                        )}
                        {data.diffDetail.added && (
                            <div style={{ color: 'var(--ca-added-text)' }}>+ {truncate(data.diffDetail.added, 40)}</div>
                        )}
                    </div>
                )}
            </div>
            {diff !== 'unchanged' && <span style={diffBadgeStyle}>{DIFF_SYMBOLS[diff]} {diff}</span>}
            <Handle
                type="source"
                position={Position.Bottom}
                style={{ background: colors.border, width: 6, height: 6, border: 'none', opacity: 0 }}
            />
        </div>
    );
}

function LifelineNode({ data }: { data: SequenceNodeData }) {
    const height = data.lifelineHeight || 400;
    const diff = data.diff || 'unchanged';
    const colors = NODE_DIFF_COLORS[diff] || NODE_DIFF_COLORS.unchanged;
    // Use text-muted for unchanged lifelines — border is too faint in light mode
    const lineColor = diff === 'unchanged' ? 'var(--ca-text-muted)' : colors.border;

    return (
        <div style={{ position: 'relative', width: 2, height }}>
            <Handle
                type="target"
                position={Position.Top}
                style={{ background: 'transparent', width: 1, height: 1, border: 'none', top: 0 }}
            />
            <div
                style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: 2,
                    height: '100%',
                    background: `repeating-linear-gradient(to bottom, ${lineColor} 0px, ${lineColor} 6px, transparent 6px, transparent 12px)`,
                    opacity: 0.6,
                }}
            />
            <Handle
                type="source"
                position={Position.Bottom}
                style={{ background: 'transparent', width: 1, height: 1, border: 'none', bottom: 0 }}
            />
        </div>
    );
}

function truncate(s: string, max: number): string {
    return s.length > max ? s.substring(0, max) + '...' : s;
}

export default memo(SequenceNode);
