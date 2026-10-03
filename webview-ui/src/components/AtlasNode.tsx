import React, { memo, CSSProperties } from 'react';
import { Handle, Position } from 'reactflow';
import { NODE_DIFF_COLORS, DIFF_SYMBOLS, DIFF_BORDER_STYLES } from '../diffColors';

interface AtlasNodeData {
    label: string;
    subtitle?: string;
    body?: string;
    type: string;
    diff?: string;
    diffDetail?: { deleted?: string; added?: string };
    anchor?: any;
    width?: number;
    height?: number;
}

const typeIcons: Record<string, string> = {
    file: '📄', import: '📦', variable: '📌', function: 'ƒ',
    participant: '👤', statement: '▷', decision: '◇', loop: '↻',
    terminal: '⬤', return: '↩', section: '☰',
};

function AtlasNode({ data }: { data: AtlasNodeData }) {
    const diff = data.diff || 'unchanged';
    const colors = NODE_DIFF_COLORS[diff] || NODE_DIFF_COLORS.unchanged;
    const icon = typeIcons[data.type] || '•';
    const isDeleted = diff === 'deleted';
    const isUnused = (data as any).meta?.unused === true;

    const isSection = data.type === 'section';

    const containerStyle: CSSProperties = {
        background: isSection ? 'var(--ca-node-body-bg)' : colors.bg,
        border: `1.5px ${isSection ? 'solid' : (DIFF_BORDER_STYLES[diff] || 'solid')} ${isSection ? 'var(--ca-border)' : colors.border}`,
        borderRadius: isSection ? 6 : 10,
        padding: isSection ? '6px 12px' : '10px 14px',
        minWidth: isSection ? 220 : 160,
        maxWidth: 280,
        boxShadow: isSection ? 'none' : `0 2px 8px ${colors.glow}, 0 1px 3px rgba(0,0,0,0.3)`,
        opacity: isDeleted ? 0.7 : isUnused ? 0.45 : 1,
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        fontFamily: "'Inter', system-ui, sans-serif",
    };

    const labelStyle: CSSProperties = {
        fontSize: 12,
        fontWeight: 600,
        color: isDeleted ? 'var(--ca-deleted-text)' : 'var(--ca-text)',
        textDecoration: isDeleted ? 'line-through' : 'none',
        lineHeight: 1.3,
        wordBreak: 'break-word' as const,
    };

    const subtitleStyle: CSSProperties = {
        fontSize: 10,
        color: 'var(--ca-text-muted)',
        marginTop: 2,
        fontStyle: 'italic',
    };

    const bodyStyle: CSSProperties = {
        fontSize: 10,
        color: 'var(--ca-accent)',
        marginTop: 4,
        padding: '4px 6px',
        background: 'var(--ca-node-body-bg)',
        borderRadius: 4,
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' as const,
        maxWidth: 250,
    };

    const diffBadgeStyle: CSSProperties = {
        position: 'absolute' as const,
        top: -6,
        right: -6,
        fontSize: 8,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 8,
        background: colors.border,
        color: 'var(--ca-bg)',
        textTransform: 'uppercase' as const,
        letterSpacing: '0.5px',
    };

    const matchReason = (data as any).matchReason as string | undefined;

    const commentCount = (data as any).meta?.commentCount ?? 0;

    return (
        <div style={{ position: 'relative', overflow: 'visible' }} title={matchReason ?? undefined}>
            <Handle type="target" position={Position.Left} style={{ background: colors.border, width: 6, height: 6, border: 'none' }} />
            <div style={containerStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 14, opacity: 0.7 }}>{icon}</span>
                    <span style={labelStyle}>{data.label}</span>
                    {commentCount > 0 && (
                        // Issue 134: click opens the Comments Panel so the user can read text + resolve
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('codeatlas:open-comments')); }}
                            style={{
                                fontSize: 9, fontWeight: 700, padding: '1px 5px',
                                borderRadius: 8, background: 'var(--ca-accent)', color: '#fff',
                                flexShrink: 0, border: 'none', cursor: 'pointer',
                                opacity: isUnused ? 0.45 : 1, // Issue 246: match unused node opacity
                            }}
                            title={`${commentCount} comment${commentCount > 1 ? 's' : ''} — click to open Comments`}
                            aria-label={`Open ${commentCount} comment${commentCount > 1 ? 's' : ''}`}
                        >
                            💬{commentCount}
                        </button>
                    )}
                </div>
                {data.subtitle && <div style={subtitleStyle}>{data.subtitle}</div>}
                {data.body && <div style={bodyStyle} title={data.body}>{data.body}</div>}
                {data.diffDetail && (
                    <div style={{ marginTop: 4, fontSize: 9, lineHeight: 1.4 }}>
                        {data.diffDetail.deleted && (
                            <div style={{ color: 'var(--ca-deleted-text)' }}>- {truncate(data.diffDetail.deleted, 60)}</div>
                        )}
                        {data.diffDetail.added && (
                            <div style={{ color: 'var(--ca-added-text)' }}>+ {truncate(data.diffDetail.added, 60)}</div>
                        )}
                    </div>
                )}
            </div>
            {diff !== 'unchanged' && <span style={diffBadgeStyle}>{DIFF_SYMBOLS[diff]} {diff}</span>}
            {/* #826 R5 — the generic overlay render slot. Every contract
                overlay paints through this ONE chip row (coverage %, TODO
                counts, future Sentry/APM values); severity tints follow the
                colorblind-safe convention (symbol + color, never color
                alone). */}
            {Array.isArray((data as any).meta?.overlays) && (data as any).meta.overlays.length > 0 && (
                <div
                    data-testid="ca-overlay-chips"
                    style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}
                >
                    {((data as any).meta.overlays as Array<{ overlayId: string; value: number; severity?: string }>).map((ov) => (
                        <span
                            key={ov.overlayId}
                            data-testid={`ca-overlay-chip-${ov.overlayId}`}
                            title={`${ov.overlayId}: ${ov.value}`}
                            style={{
                                fontSize: 8.5, padding: '1px 5px', borderRadius: 7, whiteSpace: 'nowrap',
                                background: ov.severity === 'error' ? 'rgba(239,68,68,0.22)'
                                    : ov.severity === 'warn' ? 'rgba(234,179,8,0.22)'
                                    : 'rgba(59,130,246,0.18)',
                                color: ov.severity === 'error' ? '#ef4444'
                                    : ov.severity === 'warn' ? '#eab308'
                                    : 'var(--ca-accent)',
                                border: '1px solid currentColor',
                            }}
                        >
                            {ov.severity === 'error' ? '⛔' : ov.severity === 'warn' ? '⚠' : '◦'} {ov.overlayId === 'coverage' ? `${Math.round(ov.value)}%` : Math.round(ov.value)}
                        </span>
                    ))}
                </div>
            )}
            <Handle type="source" position={Position.Right} style={{ background: colors.border, width: 6, height: 6, border: 'none' }} />
        </div>
    );
}

function truncate(s: string, max: number): string {
    return s.length > max ? s.substring(0, max) + '...' : s;
}

export default memo(AtlasNode);
