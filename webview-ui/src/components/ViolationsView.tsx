/**
 * ViolationsView.tsx — Issue #749 architecture-rule violations panel.
 *
 * Mounted at `#/violations`. Lists every rule that fired against the
 * working snapshot, severity-sorted (error → warning → info). Clicking
 * a violation drills into the offending location via the existing
 * navigation handlers (openSequenceForApi / openApiListForCluster /
 * openFileDiagram). The on-demand data refresh runs whenever the route
 * mounts (sees `requestViolations` round-trip) so users see fresh
 * results after every cascade.
 */

import React, { useEffect, useState } from 'react';

interface RuleViolation {
    rule: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    location?: { kind: 'route' | 'cluster' | 'file' | 'function'; id: string; filePath?: string };
}

interface ViolationsMessage {
    type: 'violations';
    rules: string[];
    violations: RuleViolation[];
}

interface ViolationsViewProps {
    postMessage: (msg: any) => void;
}

const SEVERITY_RANK: Record<RuleViolation['severity'], number> = {
    error: 0,
    warning: 1,
    info: 2,
};

const SEVERITY_COLOR: Record<RuleViolation['severity'], string> = {
    error: 'var(--ca-error, #ef4444)',
    warning: 'var(--ca-warning, #f59e0b)',
    info: 'var(--ca-info, #5b8def)',
};

const SEVERITY_ICON: Record<RuleViolation['severity'], string> = {
    error: '🔴',
    warning: '🟡',
    info: '🔵',
};

export default function ViolationsView({ postMessage }: ViolationsViewProps) {
    const [rules, setRules] = useState<string[]>([]);
    const [violations, setViolations] = useState<RuleViolation[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // Trigger the build on mount. The extension responds with a
        // `violations` message that the handler below catches.
        postMessage({ type: 'requestRoute', route: 'violations' });

        const handler = (e: MessageEvent) => {
            const msg = e.data as ViolationsMessage;
            if (msg?.type !== 'violations') return;
            setRules(msg.rules ?? []);
            setViolations(msg.violations ?? []);
            setLoading(false);
        };
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [postMessage]);

    const sorted = [...violations].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    const counts = violations.reduce((acc, v) => {
        acc[v.severity] = (acc[v.severity] ?? 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    const onClick = (loc: RuleViolation['location']) => {
        if (!loc) return;
        if (loc.kind === 'route') {
            postMessage({ type: 'openSequenceForApi', apiId: loc.id });
        } else if (loc.kind === 'cluster') {
            postMessage({ type: 'openApiListForCluster', clusterId: loc.id });
        } else if ((loc.kind === 'file' || loc.kind === 'function') && loc.filePath) {
            postMessage({ type: 'openFileDiagram', filePath: loc.filePath });
        }
    };

    return (
        <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto', overflow: 'auto', height: '100%' }}>
            <header style={{ marginBottom: 20 }}>
                <h1 style={{ fontSize: 20, marginBottom: 8 }}>⚠ Architecture Violations</h1>
                <div style={{ fontSize: 13, color: 'var(--ca-text-muted)' }}>
                    {rules.length} rules evaluated · {violations.length} violation{violations.length === 1 ? '' : 's'} found
                    {counts.error ? `  ·  ${counts.error} error` : ''}
                    {counts.warning ? `  ·  ${counts.warning} warning` : ''}
                    {counts.info ? `  ·  ${counts.info} info` : ''}
                </div>
            </header>

            {loading && <div>Loading violations…</div>}

            {!loading && violations.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--ca-text-muted)' }}>
                    No violations found. All rules pass against the current working snapshot.
                </div>
            )}

            {!loading && violations.length > 0 && (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {sorted.map((v, i) => (
                        <li
                            key={`${v.rule}:${i}`}
                            onClick={() => onClick(v.location)}
                            style={{
                                padding: '12px 16px',
                                marginBottom: 8,
                                borderRadius: 6,
                                background: 'var(--ca-row-bg, rgba(120,140,180,0.06))',
                                borderLeft: `4px solid ${SEVERITY_COLOR[v.severity]}`,
                                cursor: v.location ? 'pointer' : 'default',
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 12,
                            }}
                            title={v.location ? `Open ${v.location.kind}: ${v.location.id}` : undefined}
                        >
                            <span style={{ fontSize: 14, lineHeight: '20px' }}>{SEVERITY_ICON[v.severity]}</span>
                            <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{v.rule}</div>
                                <div style={{ fontSize: 13 }}>{v.message}</div>
                                {v.location && (
                                    <div style={{ fontSize: 11, color: 'var(--ca-text-muted)', marginTop: 4 }}>
                                        {v.location.kind}: {v.location.id}
                                        {v.location.filePath ? ` · ${v.location.filePath}` : ''}
                                    </div>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
