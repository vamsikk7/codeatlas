/**
 * ImpactPanel.tsx
 *
 * Slide-in overlay showing blast-radius analysis results (GitNexus-style).
 *
 * Groups impacted functions into:
 *   - WILL BREAK (depth 1, direct callers)
 *   - LIKELY AFFECTED (depth 2+, transitive callers)
 *   - REVIEW REQUIRED (import-only dependents)
 *
 * Clicking any entry sends an openSource message back to the extension.
 */

import React, { useCallback, useEffect, useState, CSSProperties } from 'react';

interface ImpactedFunction {
    key: string;
    filePath: string;
    functionName: string;
    depth: number;
    impactKind: 'direct' | 'transitive' | 'review-required';
    edgeConfidence?: number;
    edgeKind?: string;
}

interface ImpactResult {
    changedFiles: string[];
    changedFunctionKeys: string[];
    impactedFunctions: ImpactedFunction[];
    affectedClusterIds: string[];
    affectedServiceIds: string[];
    summary: {
        directImpacts: number;
        transitiveImpacts: number;
        reviewRequired: number;
        clustersAffected: number;
        servicesAffected: number;
    };
    options: {
        maxDepth: number;
        minConfidence: number;
        relationTypes: string[];
    };
}

interface ImpactPanelProps {
    impact: ImpactResult;
    onClose: () => void;
    onNavigate: (filePath: string) => void;
}

const styles: Record<string, CSSProperties> = {
    overlay: {
        position: 'absolute',
        top: 0,
        right: 0,
        width: 360,
        height: '100%',
        background: 'var(--ca-bg)',
        borderLeft: '1px solid var(--ca-border)',
        boxShadow: '-4px 0 20px rgba(0,0,0,0.3)',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'Inter', system-ui, sans-serif",
        zIndex: 1000,
        overflowY: 'auto',
    },
    header: {
        padding: '14px 16px 10px',
        borderBottom: '1px solid var(--ca-border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
    },
    title: {
        fontSize: 13,
        fontWeight: 700,
        color: 'var(--ca-text)',
        flex: 1,
    },
    closeBtn: {
        background: 'none',
        border: 'none',
        color: 'var(--ca-text-muted)',
        cursor: 'pointer',
        fontSize: 16,
        padding: '2px 6px',
        borderRadius: 4,
        lineHeight: 1,
    },
    summaryRow: {
        display: 'flex',
        gap: 8,
        padding: '8px 16px',
        borderBottom: '1px solid var(--ca-border)',
        flexWrap: 'wrap',
        flexShrink: 0,
    },
    section: {
        padding: '10px 16px 4px',
    },
    sectionHeader: {
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase' as const,
        marginBottom: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
    },
    entry: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '5px 6px',
        borderRadius: 6,
        cursor: 'pointer',
        marginBottom: 2,
    },
    entryIcon: {
        fontSize: 10,
        marginTop: 2,
        flexShrink: 0,
    },
    entryBody: {
        flex: 1,
        minWidth: 0,
    },
    entryFn: {
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--ca-text)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' as const,
    },
    entryFile: {
        fontSize: 9,
        color: 'var(--ca-text-muted)',
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap' as const,
    },
    entryMeta: {
        fontSize: 9,
        flexShrink: 0,
        textAlign: 'right' as const,
    },
    empty: {
        fontSize: 11,
        color: 'var(--ca-text-muted)',
        padding: '6px 6px',
        fontStyle: 'italic',
    },
    changedSection: {
        padding: '8px 16px',
        borderBottom: '1px solid var(--ca-border)',
    },
    changedFile: {
        fontSize: 10,
        color: 'var(--ca-success)',
        fontFamily: "'SF Mono', 'Fira Code', monospace",
        padding: '1px 0',
    },
};

function badgeStyle(color: string): CSSProperties {
    return {
        fontSize: 10,
        padding: '2px 7px',
        borderRadius: 10,
        background: `${color}22`,
        color,
        border: `1px solid ${color}44`,
        fontWeight: 600,
    };
}

function FunctionEntry({
    fn,
    color,
    onNavigate,
}: {
    fn: ImpactedFunction;
    color: string;
    onNavigate: (filePath: string) => void;
}) {
    const shortFile = fn.filePath.split('/').slice(-2).join('/');
    const conf = fn.edgeConfidence != null ? `${Math.round(fn.edgeConfidence * 100)}%` : null;
    const kind = fn.edgeKind ?? 'calls';

    return (
        <div
            style={styles.entry}
            onClick={() => onNavigate(fn.filePath)}
            title={`${fn.key}\nDepth: ${fn.depth}${conf ? `\nConfidence: ${conf}` : ''}\nKind: ${kind}`}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--ca-surface)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
            <span style={{ ...styles.entryIcon, color }}>
                {fn.depth === 1 ? '●' : '○'}
            </span>
            <div style={styles.entryBody}>
                <div style={styles.entryFn}>{fn.functionName}</div>
                <div style={styles.entryFile}>{shortFile}</div>
            </div>
            <div style={{ ...styles.entryMeta, color: 'var(--ca-text-muted)' }}>
                {conf && <div style={{ color }}>{conf}</div>}
                <div>{kind}</div>
            </div>
        </div>
    );
}

function ImpactPanel({ impact, onClose, onNavigate }: ImpactPanelProps) {
    // Issue 242: Persist minimized state so panel doesn't reopen on every new analysis
    const [minimized, setMinimized] = useState(() => localStorage.getItem('ca-impact-minimized') === 'true');
    const direct = impact.impactedFunctions.filter((f) => f.impactKind === 'direct');
    const transitive = impact.impactedFunctions.filter((f) => f.impactKind === 'transitive' && f.depth > 1);
    const reviewRequired = impact.impactedFunctions.filter((f) => f.impactKind === 'review-required');

    // Close on Escape key
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
    }, [onClose]);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    const mainFile = impact.changedFiles[0]?.split('/').pop() ?? 'unknown';
    const { summary } = impact;

    const toggleMinimized = (val: boolean) => { setMinimized(val); localStorage.setItem('ca-impact-minimized', String(val)); };

    if (minimized) {
        return (
            <div style={{ ...styles.overlay, width: 40, cursor: 'pointer' }} onClick={() => toggleMinimized(false)} title="Expand blast radius panel">
                <div style={{ ...styles.header, justifyContent: 'center', padding: '14px 8px' }}>
                    <span style={{ fontSize: 14 }}>⚡</span>
                </div>
            </div>
        );
    }

    return (
        <div style={styles.overlay}>
            {/* Header */}
            <div style={styles.header}>
                <span style={{ fontSize: 14 }}>⚡</span>
                <span style={styles.title}>Blast Radius — {mainFile}</span>
                <button style={styles.closeBtn} onClick={() => toggleMinimized(true)} title="Minimize" aria-label="Minimize panel">─</button>
                <button style={styles.closeBtn} onClick={onClose} title="Close (Esc)" aria-label="Close impact panel">✕</button>
            </div>

            {/* Summary badges */}
            <div style={styles.summaryRow}>
                <span style={badgeStyle('var(--ca-danger)')}>{summary.directImpacts} changed</span>
                <span style={badgeStyle('var(--ca-warning)')}>{summary.transitiveImpacts} callers</span>
                {(summary.reviewRequired ?? 0) > 0 && (
                    <span style={badgeStyle('var(--ca-warning)')}>{summary.reviewRequired} review</span>
                )}
                {summary.clustersAffected > 0 && (
                    <span style={badgeStyle('var(--ca-accent)')}>{summary.clustersAffected} cluster{summary.clustersAffected !== 1 ? 's' : ''}</span>
                )}
                {summary.servicesAffected > 0 && (
                    <span style={badgeStyle('var(--ca-success)')}>{summary.servicesAffected} service{summary.servicesAffected !== 1 ? 's' : ''}</span>
                )}
            </div>

            {/* Changed files */}
            {impact.changedFiles.length > 0 && (
                <div style={styles.changedSection}>
                    <div style={{ ...styles.sectionHeader, color: 'var(--ca-text-muted)' }}>Changed</div>
                    {impact.changedFiles.map((f) => (
                        <div key={f} style={styles.changedFile} title={f}>
                            {f.split('/').slice(-2).join('/')}
                        </div>
                    ))}
                </div>
            )}

            {/* WILL BREAK — depth 1 */}
            <div style={styles.section}>
                <div style={{ ...styles.sectionHeader, color: 'var(--ca-danger)' }}>
                    <span>🔴</span> Will Break
                    <span style={{ color: 'var(--ca-text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                        ({direct.length})
                    </span>
                </div>
                {direct.length === 0
                    ? <div style={styles.empty}>No direct callers</div>
                    : direct.map((fn) => (
                        <FunctionEntry key={fn.key} fn={fn} color="var(--ca-danger)" onNavigate={onNavigate} />
                    ))
                }
            </div>

            {/* LIKELY AFFECTED — depth 2+ */}
            <div style={styles.section}>
                <div style={{ ...styles.sectionHeader, color: 'var(--ca-warning)' }}>
                    <span>🟡</span> Likely Affected
                    <span style={{ color: 'var(--ca-text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                        ({transitive.length})
                    </span>
                </div>
                {transitive.length === 0
                    ? <div style={styles.empty}>No transitive callers</div>
                    : transitive.map((fn) => (
                        <FunctionEntry key={fn.key} fn={fn} color="var(--ca-warning)" onNavigate={onNavigate} />
                    ))
                }
            </div>

            {/* REVIEW REQUIRED — import-only dependents */}
            {reviewRequired.length > 0 && (
                <div style={styles.section}>
                    <div style={{ ...styles.sectionHeader, color: 'var(--ca-warning)' }}>
                        <span>🟡</span> Review Required
                        <span style={{ color: 'var(--ca-text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                            ({reviewRequired.length})
                        </span>
                    </div>
                    {reviewRequired.map((fn) => (
                        <FunctionEntry key={fn.key} fn={fn} color="var(--ca-warning)" onNavigate={onNavigate} />
                    ))}
                </div>
            )}

            {/* Affected clusters + services */}
            {(impact.affectedClusterIds.length > 0 || impact.affectedServiceIds.length > 0) && (
                <div style={{ ...styles.section, paddingBottom: 16 }}>
                    <div style={{ ...styles.sectionHeader, color: 'var(--ca-accent)' }}>
                        Affected Domains
                    </div>
                    {impact.affectedClusterIds.map((id) => (
                        <div key={id} style={{ fontSize: 10, color: 'var(--ca-accent)', padding: '1px 0' }}>
                            ⬡ {id.replace('cluster:', '')}
                        </div>
                    ))}
                    {impact.affectedServiceIds.map((id) => (
                        <div key={id} style={{ fontSize: 10, color: 'var(--ca-success)', padding: '1px 0' }}>
                            ⬡ {id.replace('service:', '')} (service)
                        </div>
                    ))}
                </div>
            )}

            {/* Options footer */}
            <div style={{ marginTop: 'auto', padding: '8px 16px', borderTop: '1px solid var(--ca-border)', fontSize: 9, color: 'var(--ca-text-muted)', flexShrink: 0 }}>
                depth ≤ {impact.options?.maxDepth ?? 4}
                {(impact.options?.minConfidence ?? 0) > 0 && ` · conf ≥ ${Math.round((impact.options.minConfidence) * 100)}%`}
            </div>
        </div>
    );
}

export default ImpactPanel;
