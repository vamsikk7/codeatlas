import { useRef, useEffect } from 'react';

interface ChangeLogEntry {
    id: string;
    timestamp: string;
    filePath: string;
    changedFunctions: string[];
    newFunctions: string[];
    deletedFunctions: string[];
    impactSummary: { directImpacts: number; transitiveImpacts: number; clustersAffected: number };
    primaryGraphId: string;
}

interface TimelineBarProps {
    entries: ChangeLogEntry[];
    onNavigate: (entryId: string) => void;
    onPlayPause: (action: 'play' | 'pause') => void;
    playing: boolean;
}

export default function TimelineBar({ entries, onNavigate, onPlayPause, playing }: TimelineBarProps) {
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to latest entry
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
        }
    }, [entries.length]);

    if (entries.length === 0) return null;

    const totalFns = entries.reduce((sum, e) => sum + e.changedFunctions.length + e.newFunctions.length, 0);
    const totalClusters = new Set(entries.flatMap(e => {
        // Count unique cluster impacts
        return Array(e.impactSummary.clustersAffected).fill(0);
    })).size || entries.reduce((max, e) => Math.max(max, e.impactSummary.clustersAffected), 0);

    return (
        <div style={containerStyle}>
            <div style={summaryStyle}>
                <span>{entries.length} change{entries.length !== 1 ? 's' : ''}</span>
                <span style={{ color: 'var(--ca-text-muted)' }}>{totalFns} function{totalFns !== 1 ? 's' : ''}</span>
                <button
                    onClick={() => onPlayPause(playing ? 'pause' : 'play')}
                    style={playButtonStyle}
                    title={playing ? 'Pause replay' : 'Play all changes'}
                    aria-label={playing ? 'Pause replay' : 'Play replay'}
                >
                    {playing ? '⏸' : '▶'}
                </button>
            </div>
            <div ref={scrollRef} style={scrollStyle}>
                {entries.map((entry, i) => {
                    const fnLabel = entry.changedFunctions[0] ?? entry.newFunctions[0] ?? entry.filePath.split('/').pop();
                    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    const isNew = entry.newFunctions.length > 0;
                    return (
                        <button
                            key={entry.id}
                            onClick={() => onNavigate(entry.id)}
                            style={dotStyle}
                            title={`${time} — ${fnLabel}\n${entry.changedFunctions.length} changed, ${entry.newFunctions.length} new\n${entry.impactSummary.directImpacts} direct impacts`}
                            aria-label={`Change ${i + 1}: ${fnLabel}`}
                        >
                            <span style={{
                                ...dotCircleStyle,
                                background: isNew ? 'var(--ca-success)' : 'var(--ca-warning)',
                            }} />
                            <span style={dotLabelStyle}>{fnLabel}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

const containerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 12px',
    background: 'var(--ca-surface)',
    borderTop: '1px solid var(--ca-border)',
    fontSize: 'var(--ca-font-caption)',
    color: 'var(--ca-text)',
    flexShrink: 0,
};

const summaryStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
    whiteSpace: 'nowrap',
};

const playButtonStyle: React.CSSProperties = {
    background: 'var(--ca-accent)',
    border: 'none',
    borderRadius: 'var(--ca-radius-sm)',
    color: '#fff',
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: 12,
};

const scrollStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    overflowX: 'auto',
    flex: 1,
    scrollBehavior: 'smooth',
};

const dotStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '2px 6px',
    borderRadius: 'var(--ca-radius-sm)',
    flexShrink: 0,
};

const dotCircleStyle: React.CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: '50%',
};

const dotLabelStyle: React.CSSProperties = {
    fontSize: 8,
    color: 'var(--ca-text-muted)',
    maxWidth: 60,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};
