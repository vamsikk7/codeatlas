/**
 * RegressionScopePanel.tsx — #827 (2026-06-10).
 *
 * Renders the regression-scope composition from the shared core
 * (`core/analysis/regressionScope.ts`): changed entities, tests to run
 * (click-to-open), untested blast radius (the risk list), affected APIs,
 * cross-repo consumers, and a copy-pasteable runner command.
 *
 * Shown as a modal from the HomePage "Regression scope" banner, which
 * only appears when the working snapshot differs from the baseline.
 */

import { useState } from 'react';

export interface RegressionScopeData {
    changedEntities: Array<{ filePath: string; functionName?: string; changeKind: string }>;
    blastRadius: {
        direct: Array<{ filePath: string; functionName: string }>;
        transitive: Array<{ filePath: string; functionName: string }>;
        reviewRequired: Array<{ filePath: string; functionName: string }>;
    };
    testsToRun: Array<{ testFile: string; reason: string }>;
    untestedBlastRadius: Array<{ filePath: string; functionName: string }>;
    affectedApis: Array<{ apiId: string; method: string; route: string; surfaceChanged: boolean }>;
    crossRepoConsumers: Array<{ consumerRepo: string; method: string; route: string }>;
    testCommand: string | null;
    coverageAvailable: boolean;
}

const REASON_LABEL: Record<string, string> = {
    'covers-changed': 'reaches changed code',
    'covers-blast-radius': 'reaches blast radius',
    'path-convention': 'sibling by convention',
};

export function RegressionScopePanel({
    scope,
    onClose,
    onOpenFile,
}: {
    scope: RegressionScopeData;
    onClose: () => void;
    onOpenFile: (filePath: string) => void;
}) {
    const [copied, setCopied] = useState(false);
    const blastCount =
        scope.blastRadius.direct.length +
        scope.blastRadius.transitive.length +
        scope.blastRadius.reviewRequired.length;

    const copyCommand = () => {
        if (!scope.testCommand) return;
        try {
            void navigator.clipboard?.writeText(scope.testCommand);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable (no toast needed) */ }
    };

    return (
        <div
            role="dialog"
            aria-label="Regression scope"
            data-testid="ca-regression-scope-panel"
            style={{
                position: 'fixed', inset: 0, zIndex: 1000,
                background: 'rgba(0,0,0,0.45)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onClick={onClose}
        >
            <div
                style={{
                    width: 'min(720px, 92vw)', maxHeight: '84vh', overflowY: 'auto',
                    background: 'var(--ca-bg, #1e1e1e)', color: 'var(--ca-text, #ddd)',
                    border: '1px solid var(--ca-border, #444)', borderRadius: 10,
                    padding: '18px 22px', boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <h2 style={{ margin: 0, fontSize: 17 }}>🧪 Regression scope</h2>
                    <button
                        type="button"
                        aria-label="Close"
                        data-testid="ca-regression-scope-close"
                        onClick={onClose}
                        style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 18, cursor: 'pointer' }}
                    >✕</button>
                </div>

                <div style={{ fontSize: 12.5, color: 'var(--ca-text-muted, #999)', marginBottom: 14 }}>
                    {scope.changedEntities.length} changed · {blastCount} in blast radius ·{' '}
                    {scope.testsToRun.length} test file{scope.testsToRun.length === 1 ? '' : 's'} to run
                    {!scope.coverageAvailable && (
                        <span title="No LCOV / Istanbul coverage data found — the untested list is a call-graph heuristic.">
                            {' '}· coverage data not found
                        </span>
                    )}
                </div>

                {scope.testCommand && (
                    <div
                        data-testid="ca-regression-scope-command"
                        style={{
                            display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16,
                            background: 'rgba(127,127,127,0.12)', borderRadius: 6, padding: '8px 10px',
                        }}
                    >
                        <code style={{ flex: 1, fontSize: 12, overflowX: 'auto', whiteSpace: 'nowrap' }}>
                            {scope.testCommand}
                        </code>
                        <button
                            type="button"
                            data-testid="ca-regression-scope-copy"
                            onClick={copyCommand}
                            style={{
                                fontSize: 12, padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
                                border: '1px solid var(--ca-border, #555)', background: 'transparent', color: 'inherit',
                            }}
                        >{copied ? 'Copied ✓' : 'Copy'}</button>
                    </div>
                )}

                <Section title={`Tests to run (${scope.testsToRun.length})`}>
                    {scope.testsToRun.length === 0 && (
                        <Empty>No test files reach the changed code — consider adding one.</Empty>
                    )}
                    {scope.testsToRun.map((t) => (
                        <Row key={t.testFile} onClick={() => onOpenFile(t.testFile)}>
                            <span style={{ flex: 1 }}>{t.testFile}</span>
                            <Tag>{REASON_LABEL[t.reason] ?? t.reason}</Tag>
                        </Row>
                    ))}
                </Section>

                <Section title={`Untested blast radius (${scope.untestedBlastRadius.length})`}>
                    {scope.untestedBlastRadius.length === 0 && (
                        <Empty>Everything in the blast radius is reached by a known test. 🎉</Empty>
                    )}
                    {scope.untestedBlastRadius.map((f) => (
                        <Row key={`${f.filePath}::${f.functionName}`} onClick={() => onOpenFile(f.filePath)}>
                            <span style={{ flex: 1 }}>
                                {f.functionName}
                                <span style={{ color: 'var(--ca-text-muted, #888)' }}> — {f.filePath}</span>
                            </span>
                            <Tag tone="warn">{scope.coverageAvailable ? '0 hits' : 'no test found'}</Tag>
                        </Row>
                    ))}
                </Section>

                {scope.affectedApis.length > 0 && (
                    <Section title={`Affected endpoints (${scope.affectedApis.length})`}>
                        {scope.affectedApis.map((a) => (
                            <Row key={a.apiId}>
                                <span style={{ flex: 1 }}>
                                    <strong>{a.method}</strong> {a.route}
                                </span>
                                {a.surfaceChanged && <Tag tone="warn">surface changed</Tag>}
                            </Row>
                        ))}
                    </Section>
                )}

                {scope.crossRepoConsumers.length > 0 && (
                    <Section title={`Cross-repo consumers (${scope.crossRepoConsumers.length})`}>
                        {scope.crossRepoConsumers.map((c, i) => (
                            <Row key={`${c.consumerRepo}-${i}`}>
                                <span style={{ flex: 1 }}>
                                    <strong>{c.consumerRepo}</strong> calls {c.method} {c.route}
                                </span>
                            </Row>
                        ))}
                    </Section>
                )}
            </div>
        </div>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 13.5, margin: '0 0 6px 0', color: 'var(--ca-text, #ccc)' }}>{title}</h3>
            <div>{children}</div>
        </div>
    );
}

function Row({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
    return (
        <div
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
            onClick={onClick}
            onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
            style={{
                display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5,
                padding: '5px 8px', borderRadius: 5,
                cursor: onClick ? 'pointer' : 'default',
            }}
            onMouseEnter={onClick ? (e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(127,127,127,0.12)'; } : undefined}
            onMouseLeave={onClick ? (e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; } : undefined}
        >
            {children}
        </div>
    );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
    return (
        <span style={{
            fontSize: 10.5, padding: '2px 7px', borderRadius: 9, whiteSpace: 'nowrap',
            background: tone === 'warn' ? 'rgba(234,179,8,0.18)' : 'rgba(127,127,127,0.18)',
            color: tone === 'warn' ? '#eab308' : 'var(--ca-text-muted, #aaa)',
        }}>{children}</span>
    );
}

function Empty({ children }: { children: React.ReactNode }) {
    return <div style={{ fontSize: 12.5, color: 'var(--ca-text-muted, #888)', padding: '4px 8px' }}>{children}</div>;
}
