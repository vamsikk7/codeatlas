import React, { memo, CSSProperties } from 'react';
import { Handle, Position } from 'reactflow';
import { NODE_DIFF_COLORS } from '../diffColors';

interface ClassBlockItem {
    id: string; // Original node id
    label: string;
    subtitle?: string;
    body?: string;
    type: string;
    diff?: string;
    anchor?: any;
}

interface ClassBlockNodeData {
    label: string; // The category name e.g. "Functions" or "Imports"
    type: 'section';
    items: ClassBlockItem[];
    diff?: string;
}

const typeIcons: Record<string, string> = {
    file: '📄', import: '📦', variable: '📌', function: 'ƒ',
    participant: '👤', statement: '▷', decision: '◇', loop: '↻',
    terminal: '⬤', return: '↩', section: '☰', class: '◆'
};

function ClassBlockNode({ id, data }: { id: string, data: ClassBlockNodeData }) {
    const sectionDiff = data.diff || 'unchanged';
    const hasMultipleDiffs = data.items.some(i => i.diff && i.diff !== 'unchanged');
    
    // Determine overall block border color strategy
    let blockBorderColor = 'var(--ca-border)';
    if (data.items.length > 0 && data.items.every(i => i.diff === 'added') && data.items.length > 3) {
        blockBorderColor = NODE_DIFF_COLORS['added'].border; // Whole block is new
    }

    const containerStyle: CSSProperties = {
        background: 'var(--ca-node-body-bg)', // Darker background for the block container
        border: `1.5px solid ${blockBorderColor}`,
        borderRadius: 8,
        minWidth: 260,
        maxWidth: 380,
        boxShadow: `0 4px 12px rgba(0,0,0,0.5)`,
        fontFamily: "'Inter', system-ui, sans-serif",
        overflow: 'hidden',
    };

    const headerStyle: CSSProperties = {
        background: 'var(--ca-border)',
        padding: '6px 12px',
        fontSize: 12,
        fontWeight: 700,
        color: 'var(--ca-text)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
    };

    const listStyle: CSSProperties = {
        display: 'flex',
        flexDirection: 'column',
        padding: '4px',
        gap: '4px',
        maxHeight: 400, // Make scrolling possible if very large
        overflowY: 'auto',
    };

    // Item rendering
    const renderItem = (item: ClassBlockItem) => {
        const itemDiff = item.diff || 'unchanged';
        const colors = NODE_DIFF_COLORS[itemDiff] || NODE_DIFF_COLORS.unchanged;
        const isDeleted = itemDiff === 'deleted';
        const icon = typeIcons[item.type] || '•';

        const itemStyle: CSSProperties = {
            display: 'flex',
            flexDirection: 'column',
            padding: '6px 8px',
            background: colors.bg,
            borderLeft: `3px solid ${colors.border}`,
            borderRadius: 4,
            cursor: 'pointer',
            opacity: isDeleted ? 0.7 : 1,
            transition: 'background 0.15s ease',
        };

        const itemHeaderStyle: CSSProperties = {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            fontWeight: 600,
            color: isDeleted ? 'var(--ca-deleted-text)' : 'var(--ca-text)',
            textDecoration: isDeleted ? 'line-through' : 'none',
        };

        const bodyStyle: CSSProperties = {
            fontSize: 9,
            color: 'var(--ca-accent)',
            marginTop: 4,
            marginLeft: 18, // Indent past icon
            fontFamily: "'SF Mono', 'Fira Code', monospace",
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
        };

        const handleClick = (e: React.MouseEvent) => {
            e.stopPropagation();
            // Dispatch a bubbling custom event that DiagramView/App.tsx can catch
            const event = new CustomEvent('classBlockItemClick', {
                detail: {
                    nodeId: item.id,
                    nodeData: {
                        label: item.label,
                        type: item.type,
                        anchor: item.anchor
                    }
                },
                bubbles: true
            });
            e.currentTarget.dispatchEvent(event);
        };

        return (
            <div 
                key={item.id} 
                style={itemStyle} 
                onClick={handleClick}
                onMouseEnter={(e) => (e.currentTarget.style.background = `color-mix(in srgb, ${colors.bg} 85%, white)`)}
                onMouseLeave={(e) => (e.currentTarget.style.background = colors.bg)}
            >
                <div style={itemHeaderStyle}>
                    <span style={{ fontSize: 13, opacity: 0.8 }}>{icon}</span>
                    <span title={item.label}>{truncate(item.label, 40)}</span>
                    {itemDiff !== 'unchanged' && (
                        <span style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%', background: colors.border }} title={itemDiff} />
                    )}
                </div>
                {item.body && <div style={bodyStyle} title={item.body}>{truncate(item.body, 50)}</div>}
            </div>
        );
    };

    return (
        <div style={{ position: 'relative' }}>
            {/* Left and Right Handles for connecting to other blocks */}
            <Handle type="target" position={Position.Left} style={{ background: blockBorderColor, width: 8, height: 8 }} />
            
            <div style={containerStyle}>
                <div style={headerStyle}>
                    <span>{data.label}</span>
                    <span style={{ opacity: 0.6, fontSize: 10 }}>{data.items.length}</span>
                </div>
                
                <div style={listStyle} className="nodrag nowheel">
                    {data.items.map(renderItem)}
                </div>
            </div>

            <Handle type="source" position={Position.Right} style={{ background: blockBorderColor, width: 8, height: 8 }} />
        </div>
    );
}

function truncate(s: string, max: number): string {
    return s.length > max ? s.substring(0, max) + '...' : s;
}

export default memo(ClassBlockNode);
