/**
 * HealthDashboard.tsx
 *
 * Webview panel for displaying code health analysis results.
 * Shows dead code, god files, high coupling, cyclic dependencies, orphaned clusters.
 */

import React from 'react';

interface HealthReport {
    deadFunctions: string[];
    godFiles: string[];
    highCouplingFiles: string[];
    cyclicDependencies: string[][];
    orphanedClusters: string[];
}

interface HealthDashboardProps {
    health: HealthReport;
    onNavigate: (filePath: string) => void;
}

function HealthCard({ title, icon, count, color, children }: {
    title: string; icon: string; count: number; color: string; children: React.ReactNode;
}) {
    return (
        <div style={{
            background: 'var(--ca-surface)',
            border: '1px solid var(--ca-border)',
            borderLeft: count > 0 ? `3px solid ${color}` : '1px solid var(--ca-border)',
            borderRadius: 8,
            padding: 14,
            marginBottom: 10,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span>{icon}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ca-text)', flex: 1 }}>{title}</span>
                <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                    background: count > 0 ? `${color}22` : 'var(--ca-node-body-bg)',
                    color: count > 0 ? color : 'var(--ca-text-muted)',
                }}>{count}</span>
            </div>
            {children}
        </div>
    );
}

function ItemList({ items, max, onNavigate, color }: {
    items: string[] | undefined; max: number; onNavigate: (fp: string) => void; color: string;
}) {
    // Defensive: HealthDashboard receives `health` from a WS push which
    // may arrive before sub-arrays are populated. Treat undefined as empty.
    const safe = items ?? [];
    if (safe.length === 0) {
        return <div style={{ fontSize: 11, color: 'var(--ca-text-muted)', fontStyle: 'italic' }}>None found</div>;
    }
    return (
        <div>
            {safe.slice(0, max).map((item, i) => (
                <div
                    key={i}
                    onClick={() => onNavigate(item.split('::')[0])}
                    style={{
                        fontSize: 10, padding: '3px 6px', borderRadius: 4, cursor: 'pointer',
                        fontFamily: 'var(--ca-font-mono)', color,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--ca-node-body-bg)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    title={item}
                >
                    {item}
                </div>
            ))}
            {safe.length > max && (
                <div style={{ fontSize: 9, color: 'var(--ca-text-muted)', padding: '2px 6px' }}>
                    +{safe.length - max} more
                </div>
            )}
        </div>
    );
}

function HealthDashboard({ health, onNavigate }: HealthDashboardProps) {
    // Defensive: WS push can land with sub-arrays still undefined on the
    // very first render. Default everything so a partial payload doesn't
    // throw `Cannot read .length of undefined` and fall through to the
    // ErrorBoundary.
    const safeHealth = {
        deadFunctions: health?.deadFunctions ?? [],
        godFiles: health?.godFiles ?? [],
        highCouplingFiles: health?.highCouplingFiles ?? [],
        cyclicDependencies: health?.cyclicDependencies ?? [],
        orphanedClusters: health?.orphanedClusters ?? [],
    };
    const totalIssues = safeHealth.deadFunctions.length + safeHealth.godFiles.length +
        safeHealth.highCouplingFiles.length + safeHealth.cyclicDependencies.length + safeHealth.orphanedClusters.length;

    return (
        <div style={{
            padding: 16, maxWidth: 600, margin: '0 auto',
            fontFamily: 'var(--ca-font-sans)', color: 'var(--ca-text)',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                <span style={{ fontSize: 20 }}>🏥</span>
                <div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>Code Health Report</div>
                    <div style={{ fontSize: 11, color: 'var(--ca-text-muted)' }}>
                        {totalIssues === 0 ? 'No issues found' : `${totalIssues} issue${totalIssues !== 1 ? 's' : ''} detected`}
                    </div>
                </div>
            </div>

            {/* Sorted by severity: critical → warning → info */}
            <HealthCard title="Cyclic Dependencies" icon="🔄" count={safeHealth.cyclicDependencies.length} color="var(--ca-danger)">
                {safeHealth.cyclicDependencies.length === 0 ? (
                    <div style={{ fontSize: 11, color: 'var(--ca-text-muted)', fontStyle: 'italic' }}>None found</div>
                ) : (
                    [...safeHealth.cyclicDependencies].sort((a, b) => b.length - a.length).slice(0, 8).map((cycle, i) => (
                        <div key={i} style={{ fontSize: 10, padding: '3px 6px', fontFamily: 'var(--ca-font-mono)', color: 'var(--ca-danger)' }}>
                            {cycle.join(' → ')} → {cycle[0]}
                        </div>
                    ))
                )}
            </HealthCard>

            <HealthCard title="Dead Functions" icon="💀" count={safeHealth.deadFunctions.length} color="var(--ca-danger)">
                <ItemList items={safeHealth.deadFunctions} max={15} onNavigate={onNavigate} color="var(--ca-danger)" />
            </HealthCard>

            <HealthCard title="High Coupling" icon="🔗" count={safeHealth.highCouplingFiles.length} color="var(--ca-warning)">
                <ItemList items={safeHealth.highCouplingFiles} max={10} onNavigate={onNavigate} color="var(--ca-warning)" />
            </HealthCard>

            <HealthCard title="God Files" icon="📦" count={safeHealth.godFiles.length} color="var(--ca-warning)">
                <ItemList items={safeHealth.godFiles} max={10} onNavigate={onNavigate} color="var(--ca-warning)" />
            </HealthCard>

            <HealthCard title="Orphaned Clusters" icon="🏝️" count={safeHealth.orphanedClusters.length} color="var(--ca-text-muted)">
                <ItemList items={safeHealth.orphanedClusters} max={10} onNavigate={onNavigate} color="var(--ca-accent)" />
            </HealthCard>
        </div>
    );
}

export default HealthDashboard;
