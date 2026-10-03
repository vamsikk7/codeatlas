import React, { memo, useState, CSSProperties } from 'react';
import { Handle, Position } from 'reactflow';
import { NODE_DIFF_COLORS, DIFF_SYMBOLS, DIFF_BORDER_STYLES } from '../diffColors';

/**
 * Width-aware truncation (#249). Counts CJK / wide glyphs as 2 columns and
 * Latin / narrow glyphs as 1, so the visible width matches the layout's
 * fixed-width budget. Fallback to `.length` when `Intl.Segmenter` is missing
 * (older browsers) — the diff is small for ASCII-only labels.
 */
function visualWidth(s: string): number {
    let w = 0;
    for (const ch of s) {
        const code = ch.codePointAt(0) ?? 0;
        // Approximate East-Asian-Width: CJK Unified Ideographs, Hangul, Hiragana,
        // Katakana, fullwidth forms, emoji ranges → 2 columns.
        if (
            (code >= 0x1100 && code <= 0x115F) ||  // Hangul Jamo
            (code >= 0x2E80 && code <= 0x303E) ||  // CJK radicals
            (code >= 0x3041 && code <= 0x33FF) ||  // Hiragana/Katakana/CJK symbols
            (code >= 0x3400 && code <= 0x4DBF) ||  // CJK extension A
            (code >= 0x4E00 && code <= 0x9FFF) ||  // CJK unified
            (code >= 0xA000 && code <= 0xA4CF) ||  // Yi
            (code >= 0xAC00 && code <= 0xD7A3) ||  // Hangul syllables
            (code >= 0xF900 && code <= 0xFAFF) ||  // CJK compat
            (code >= 0xFE30 && code <= 0xFE4F) ||  // CJK compat forms
            (code >= 0xFF00 && code <= 0xFF60) ||  // Fullwidth ASCII
            (code >= 0xFFE0 && code <= 0xFFE6) ||  // Fullwidth signs
            (code >= 0x20000 && code <= 0x2FFFD) || // CJK extension B-F
            (code >= 0x1F300 && code <= 0x1FAFF)    // emoji ranges
        ) {
            w += 2;
        } else {
            w += 1;
        }
    }
    return w;
}

function truncateByWidth(s: string, maxCols: number): string {
    if (visualWidth(s) <= maxCols) return s;
    let acc = '';
    let used = 0;
    for (const ch of s) {
        const cw = visualWidth(ch);
        if (used + cw > maxCols - 3) break;
        acc += ch;
        used += cw;
    }
    return acc + '...';
}

interface StatementLine {
    label: string;
    diff: string;
    diffDetail?: { deleted?: string; added?: string };
    span?: { start: number; end: number };
}

interface FlowNodeData {
    label: string;
    subtitle?: string;
    body?: string;
    type: string; // terminal | decision | loop | return | statement
    diff?: string;
    diffDetail?: { deleted?: string; added?: string };
    anchor?: any;
    meta?: { statements?: StatementLine[]; nodeKind?: string };
    width?: number;
    height?: number;
}

const typeIcons: Record<string, string> = {
    terminal: '⬤',
    decision: '◇',
    loop: '↻',
    return: '↩',
    statement: '▷',
};

const DIFF_LINE_COLORS: Record<string, string> = {
    added: 'var(--ca-added-border)',
    deleted: 'var(--ca-deleted-border)',
    modified: 'var(--ca-modified-border)',
};

/** Consolidated block with per-line tooltips on hover */
function FlowBlockNode({ statements, hasDiff, diff, colors, handleStyle }: {
    statements: StatementLine[];
    hasDiff: boolean;
    diff: string;
    colors: { bg: string; border: string; glow: string; text: string };
    handleStyle: CSSProperties;
}) {
    const [hoveredLine, setHoveredLine] = useState<number | null>(null);

    return (
        <div style={{ position: 'relative' }}>
            <Handle type="target" position={Position.Top} style={{ ...handleStyle, top: -4 }} />
            <div
                className="flow-node-statement"
                style={{
                    ...{ '--ca-node-border-color': colors.border, '--ca-node-shadow-color': colors.glow } as Record<string, string>,
                    background: colors.bg,
                    border: `1.5px ${DIFF_BORDER_STYLES[diff] || 'solid'} var(--ca-node-border-color)`,
                    borderRadius: 10,
                    minWidth: 180,
                    maxWidth: 340,
                    boxShadow: '0 2px 8px var(--ca-node-shadow-color), 0 1px 3px rgba(0,0,0,0.3)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    fontFamily: "'SF Mono', 'Fira Code', monospace",
                    overflow: 'visible',
                }}
            >
                {statements.map((stmt, i) => {
                    const lineDiff = stmt.diff || 'unchanged';
                    const lineColor = DIFF_LINE_COLORS[lineDiff];
                    const isLineDeleted = lineDiff === 'deleted';
                    const isLineAdded = lineDiff === 'added';
                    const isLineModified = lineDiff === 'modified';
                    const isTruncated = stmt.label.length > 60;
                    const tooltipText = stmt.diffDetail?.deleted
                        ? `Was: ${stmt.diffDetail.deleted}`
                        : isTruncated ? stmt.label : null;
                    return (
                        <div
                            key={i}
                            data-stmt-index={i}
                            onMouseEnter={() => tooltipText && setHoveredLine(i)}
                            onMouseLeave={() => setHoveredLine(null)}
                            style={{
                                padding: '4px 12px',
                                fontSize: 10,
                                lineHeight: 1.4,
                                color: isLineDeleted ? 'var(--ca-deleted-text)'
                                    : isLineAdded ? 'var(--ca-added-text)'
                                    : isLineModified ? 'var(--ca-modified-text)'
                                    : 'var(--ca-text)',
                                textDecoration: isLineDeleted ? 'line-through' : 'none',
                                fontWeight: isLineAdded ? 600 : 400,
                                opacity: isLineDeleted ? 0.6 : 1,
                                borderLeft: lineColor ? `3px solid ${lineColor}` : '3px solid transparent',
                                borderBottom: i < statements.length - 1 ? '1px solid var(--ca-border)' : 'none',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                position: 'relative',
                                background: hoveredLine === i ? 'var(--ca-surface-hover)' : 'transparent',
                            }}
                        >
                            {hasDiff && lineDiff !== 'unchanged' && (
                                <span style={{ fontWeight: 700, marginRight: 4, fontSize: 9 }}>
                                    {DIFF_SYMBOLS[lineDiff]}
                                </span>
                            )}
                            {truncate(stmt.label, 60)}
                            {hoveredLine === i && tooltipText && (
                                <div style={{
                                    position: 'absolute',
                                    left: 0,
                                    bottom: '100%',
                                    zIndex: 9999,
                                    padding: '6px 10px',
                                    background: 'var(--ca-surface)',
                                    border: '1px solid var(--ca-border)',
                                    borderRadius: 6,
                                    fontSize: 10,
                                    color: 'var(--ca-text)',
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    maxWidth: 420,
                                    boxShadow: 'var(--ca-shadow-lg)',
                                    pointerEvents: 'none',
                                    fontFamily: "'SF Mono', 'Fira Code', monospace",
                                    lineHeight: 1.4,
                                }}>
                                    {tooltipText}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            {diff !== 'unchanged' && (
                <span style={diffBadgeStyle(colors)}>
                    {DIFF_SYMBOLS[diff]} {diff}
                </span>
            )}
            <Handle type="source" position={Position.Bottom} style={{ ...handleStyle, bottom: -4 }} />
        </div>
    );
}

function FlowNode({ data }: { data: FlowNodeData }) {
    const diff = data.diff || 'unchanged';
    const colors = NODE_DIFF_COLORS[diff] || NODE_DIFF_COLORS.unchanged;
    const icon = typeIcons[data.type] || '▷';

    const isTerminal = data.type === 'terminal';
    const isReturn = data.type === 'return';
    const isDecision = data.type === 'decision';
    const isLoop = data.type === 'loop';
    const isDiamond = isDecision || isLoop;
    const isPill = isTerminal || isReturn;
    const isDeleted = diff === 'deleted';
    const statements = data.meta?.statements;
    const isConsolidated = statements && statements.length >= 2;

    const diamondSize = 160;

    const handleStyle: CSSProperties = {
        background: colors.border,
        width: 7,
        height: 7,
        border: '2px solid var(--ca-bg)',
        zIndex: 10,
    };

    if (isDiamond) {
        return (
            <div style={{ position: 'relative', width: diamondSize, height: diamondSize }}>
                <Handle type="target" position={Position.Top} style={{ ...handleStyle, top: -4 }} />
                <div
                    className="flow-node-diamond"
                    style={{
                        ...{ '--ca-node-border-color': colors.border, '--ca-node-shadow-color': colors.glow } as Record<string, string>,
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        width: diamondSize * 0.78,
                        height: diamondSize * 0.78,
                        transform: 'translate(-50%, -50%) rotate(45deg)',
                        background: colors.bg,
                        border: `1.5px ${DIFF_BORDER_STYLES[diff] || 'solid'} var(--ca-node-border-color)`,
                        borderRadius: 8,
                        boxShadow: '0 2px 12px var(--ca-node-shadow-color), 0 1px 3px rgba(0,0,0,0.4)',
                        overflow: 'hidden',
                        opacity: isDeleted ? 0.7 : 1,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                    }}
                >
                    <div
                        style={{
                            transform: 'rotate(-45deg)',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: '140%',
                            height: '100%',
                            marginLeft: '-20%',
                            padding: '4px',
                            textAlign: 'center',
                        }}
                    >
                        <span style={{ fontSize: 10, opacity: 0.5, marginBottom: 2 }}>
                            {isLoop ? '↻' : '◇'}
                        </span>
                        <span
                            title={data.label}
                            style={{
                                fontSize: 10,
                                fontWeight: 600,
                                color: isDeleted ? 'var(--ca-deleted-text)' : 'var(--ca-text)',
                                textDecoration: isDeleted ? 'line-through' : 'none',
                                lineHeight: 1.2,
                                wordBreak: 'break-word',
                                maxWidth: '90%',
                                overflow: 'hidden',
                                display: '-webkit-box',
                                WebkitLineClamp: 3,
                                WebkitBoxOrient: 'vertical',
                            }}
                        >
                            {truncateByWidth(data.label, 35)}
                        </span>
                    </div>
                </div>
                {diff !== 'unchanged' && (
                    <span style={diffBadgeStyle(colors)}>
                        {DIFF_SYMBOLS[diff]} {diff}
                    </span>
                )}
                <Handle type="source" position={Position.Bottom} style={{ ...handleStyle, bottom: -4 }} />
            </div>
        );
    }

    // ─── Consolidated block: render per-line with inline diff indicators ────
    if (isConsolidated) {
        const hasDiff = statements.some(s => s.diff !== 'unchanged');
        return (
            <div style={{ position: 'relative' }}>
                <FlowBlockNode
                    statements={statements}
                    hasDiff={hasDiff}
                    diff={diff}
                    colors={colors}
                    handleStyle={handleStyle}
                />
            </div>
        );
    }

    // ─── Single node: pill (terminal/return) or rectangle (statement) ───────
    const containerStyle: CSSProperties = {
        ...{ '--ca-node-border-color': colors.border, '--ca-node-shadow-color': colors.glow } as Record<string, string>,
        background: colors.bg,
        border: `1.5px ${DIFF_BORDER_STYLES[diff] || 'solid'} var(--ca-node-border-color)`,
        borderRadius: isPill ? 999 : 10,
        padding: data.diffDetail ? 0 : '10px 16px',
        minWidth: 160,
        maxWidth: 280,
        boxShadow: '0 2px 8px var(--ca-node-shadow-color), 0 1px 3px rgba(0,0,0,0.3)',
        opacity: isDeleted ? 0.7 : 1,
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        fontFamily: "'Inter', system-ui, sans-serif",
        overflow: 'hidden',
    };

    const labelStyle: CSSProperties = {
        fontSize: 11,
        fontWeight: isPill ? 700 : 500,
        color: isDeleted ? 'var(--ca-deleted-text)' : 'var(--ca-text)',
        textDecoration: isDeleted ? 'line-through' : 'none',
        lineHeight: 1.3,
        wordBreak: 'break-word',
        textAlign: 'center',
        whiteSpace: 'pre-wrap',
    };

    return (
        <div style={{ position: 'relative' }}>
            <Handle type="target" position={Position.Top} style={{ ...handleStyle, top: -4 }} />
            <div className={`flow-node-${data.type}`} style={containerStyle} title={data.label.length > 40 ? data.label : undefined}>
                {data.diffDetail ? (
                    <div>
                        <div style={{ padding: '8px 14px', textAlign: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                                <span style={{ fontSize: 12, opacity: 0.5 }}>{icon}</span>
                                <span style={labelStyle}>{data.label}</span>
                            </div>
                        </div>
                        {data.diffDetail.deleted && (
                            <div style={diffDetailRowStyle('deleted')}>
                                <span style={{ fontWeight: 700, marginRight: 4 }}>−</span>
                                <span style={{ textDecoration: 'line-through' }}>{truncate(data.diffDetail.deleted, 80)}</span>
                            </div>
                        )}
                        {data.diffDetail.added && (
                            <div style={diffDetailRowStyle('added')}>
                                <span style={{ fontWeight: 700, marginRight: 4 }}>+</span>
                                <strong>{truncate(data.diffDetail.added, 80)}</strong>
                            </div>
                        )}
                    </div>
                ) : (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                        <span style={{ fontSize: 12, opacity: 0.5 }}>{icon}</span>
                        <span style={labelStyle}>{data.label}</span>
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
                )}
            </div>
            {diff !== 'unchanged' && (
                <span style={diffBadgeStyle(colors)}>
                    {DIFF_SYMBOLS[diff]} {diff}
                </span>
            )}
            <Handle type="source" position={Position.Bottom} style={{ ...handleStyle, bottom: -4 }} />
        </div>
    );
}

function diffBadgeStyle(colors: { border: string }): CSSProperties {
    return {
        position: 'absolute',
        top: -6,
        right: -6,
        fontSize: 8,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 8,
        background: colors.border,
        color: 'var(--ca-bg)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        zIndex: 5,
    };
}

function diffDetailRowStyle(kind: 'added' | 'deleted'): CSSProperties {
    return {
        background: kind === 'deleted' ? 'var(--ca-deleted-bg)' : 'var(--ca-added-bg)',
        color: kind === 'deleted' ? 'var(--ca-deleted-text)' : 'var(--ca-added-text)',
        padding: '4px 10px',
        fontSize: 9,
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        borderTop: `1px solid ${kind === 'deleted' ? 'var(--ca-deleted-border)' : 'var(--ca-added-border)'}`,
        whiteSpace: 'pre-wrap',
        lineHeight: 1.4,
    };
}

function truncate(s: string, max: number): string {
    return s.length > max ? s.substring(0, max) + '...' : s;
}

export default memo(FlowNode);
