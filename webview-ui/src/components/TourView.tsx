/**
 * TourView.tsx — Issue #702 / #736 onboarding-tour walkthrough.
 *
 * Sequential step-by-step UI for the tour produced by
 * `core/analysis/tourBuilder.buildTour`. Pulls the step list from the
 * extension host via `requestTour`, paints one step at a time, and
 * routes drill-down clicks back through the standard navigation
 * messages (each step carries a `drillDownGraphId` populated by the
 * builder).
 *
 * Deliberately lean — no React Flow, no layout cache. The list comes
 * pre-ordered and pre-blurbed; the panel just chrome.
 */

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { tourEmptyMessage } from '../lib/tourMessages';

export interface TourStepLite {
    stepNumber: number;
    entryPointId: string;
    label: string;
    why: string;
    filePath: string;
    symbol?: string;
    fanIn: number;
    diff?: 'added' | 'deleted' | 'modified' | 'unchanged';
    drillDownGraphId: string;
}

type TourMode = 'codebase' | 'recent';

interface TourViewProps {
    /** postMessage adapter — handed down from App.tsx, same as Map/Feature. */
    postMessage: (msg: any) => void;
    /** Tour data delivered by the extension host via `tourSteps` message. */
    steps: TourStepLite[];
    /** Current mode — drives the "Codebase ↔ Recent" toggle label. */
    mode: TourMode;
    /** Whether a refresh is in flight after a mode change. */
    loading?: boolean;
    /**
     * Begin playback at this step. App.tsx handles the requestRoute + seeds
     * the message-walk state; the tour panel just signals intent. When
     * omitted, the "Play" button degrades to a plain drill-down.
     */
    onPlayStep?: (stepIndex: number, steps: TourStepLite[]) => void;
}

/**
 * ADR-034 Phase H Pass 3 (#793) — when the loaded tour is the workspace
 * meta-tour (one step per repo), every step's `drillDownGraphId` starts
 * with `tour:` and points at a per-repo tour. We use this to switch the
 * header copy + offer a "Drill into repo tour" action on the step card.
 */
function isWorkspaceMetaTour(steps: TourStepLite[]): boolean {
    if (steps.length === 0) return false;
    return steps.every((s) => s.drillDownGraphId.startsWith('tour:'));
}

function TourView({ postMessage, steps, mode, loading, onPlayStep }: TourViewProps) {
    // ── Step state ────────────────────────────────────────────────────────
    // The step number is 1-based to match the user-visible labels; we
    // store 0-based internally for array indexing.
    const [index, setIndex] = useState(0);

    // Reset to the first step when the tour data changes (mode swap, refresh).
    useEffect(() => { setIndex(0); }, [steps, mode]);

    const total = steps.length;
    const current: TourStepLite | undefined = steps[index];
    const isMeta = useMemo(() => isWorkspaceMetaTour(steps), [steps]);

    const prev = useCallback(() => {
        setIndex(i => Math.max(0, i - 1));
    }, []);
    const next = useCallback(() => {
        setIndex(i => Math.min(total - 1, i + 1));
    }, [total]);
    const jumpTo = useCallback((stepNumber: number) => {
        setIndex(Math.max(0, Math.min(total - 1, stepNumber - 1)));
    }, [total]);

    // Drill-down: dispatch the standard `navigateTo`-driving message. Mirrors
    // what MapView does on node click — the host server resolves the
    // graphId and broadcasts a navigateTo.
    const drillDown = useCallback(() => {
        if (!current) return;
        postMessage({ type: 'requestRoute', graphId: current.drillDownGraphId });
    }, [postMessage, current]);

    // Start guided playback: App.tsx handles the route + seeds the message
    // walk. Falls back to a plain drill-down if the parent didn't wire the
    // callback (keeps the panel functional on standalone routes that don't
    // support the message walker yet).
    const playStep = useCallback(() => {
        if (!current) return;
        if (onPlayStep) onPlayStep(index, steps);
        else postMessage({ type: 'requestRoute', graphId: current.drillDownGraphId });
    }, [onPlayStep, index, steps, postMessage, current]);

    const openSource = useCallback(() => {
        if (!current) return;
        postMessage({ type: 'openSource', filePath: current.filePath });
    }, [postMessage, current]);

    const switchMode = useCallback(() => {
        const nextMode: TourMode = mode === 'codebase' ? 'recent' : 'codebase';
        postMessage({ type: 'requestTour', mode: nextMode });
    }, [postMessage, mode]);

    // ── Empty state ────────────────────────────────────────────────────────
    if (total === 0) {
        return (
            <div className="ca-tour-view" style={containerStyle}>
                <Header
                    mode={mode}
                    onSwitchMode={switchMode}
                    stepNumber={0}
                    total={0}
                    onPrev={prev}
                    onNext={next}
                    onJumpTo={jumpTo}
                    canPrev={false}
                    canNext={false}
                    isMeta={false}
                />
                <div style={emptyStateStyle}>
                    {/* BUG-POLAR-26: mode-aware — the Recent-changes tour on a clean
                        (but initialized) workspace shouldn't tell the user to initialize. */}
                    {tourEmptyMessage(mode, !!loading)}
                </div>
            </div>
        );
    }

    return (
        <div className="ca-tour-view" style={containerStyle}>
            <Header
                mode={mode}
                onSwitchMode={switchMode}
                stepNumber={current!.stepNumber}
                total={total}
                onPrev={prev}
                onNext={next}
                onJumpTo={jumpTo}
                canPrev={index > 0}
                canNext={index < total - 1}
                isMeta={isMeta}
            />
            <StepCard step={current!} onDrillDown={drillDown} onPlayStep={playStep} onOpenSource={openSource} isMeta={isMeta} />
            <Footer current={index + 1} total={total} />
        </div>
    );
}

// ─── Header ──────────────────────────────────────────────────────────────

function Header({
    mode, onSwitchMode, stepNumber, total, onPrev, onNext, onJumpTo, canPrev, canNext, isMeta,
}: {
    mode: TourMode;
    onSwitchMode: () => void;
    stepNumber: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
    onJumpTo: (n: number) => void;
    canPrev: boolean;
    canNext: boolean;
    /** ADR-034 Phase H Pass 3 — workspace meta-tour state. */
    isMeta: boolean;
}) {
    const titleCopy = isMeta
        ? 'Workspace overview'
        : (mode === 'codebase' ? 'Codebase walkthrough' : 'Recent-change walkthrough');
    return (
        <div className="ca-header" style={{ alignItems: 'center' }}>
            <div className="ca-header-title">
                <span className="ca-header-badge">{isMeta ? 'Workspace' : 'Tour'}</span>
                <span>{titleCopy}</span>
            </div>
            <div className="ca-header-stats" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Mode toggle hidden in meta-tour — there is no "recent" view of
                    the workspace meta-tour; each meta-step's per-repo tour has
                    its own mode toggle when drilled into. */}
                {!isMeta && (
                    <button onClick={onSwitchMode} style={smallButtonStyle} title="Switch tour mode">
                        {mode === 'codebase' ? '→ Recent changes' : '→ Codebase'}
                    </button>
                )}
                <select
                    value={stepNumber}
                    onChange={(e) => onJumpTo(Number(e.target.value))}
                    disabled={total === 0}
                    style={selectStyle}
                    aria-label="Jump to step"
                >
                    {Array.from({ length: total }, (_, i) => i + 1).map(n => (
                        <option key={n} value={n}>Step {n}</option>
                    ))}
                </select>
                <button onClick={onPrev} disabled={!canPrev} style={smallButtonStyle} aria-label="Previous step">◀ Prev</button>
                <button onClick={onNext} disabled={!canNext} style={smallButtonStyle} aria-label="Next step">Next ▶</button>
            </div>
        </div>
    );
}

// ─── Step card ────────────────────────────────────────────────────────────

function StepCard({ step, onDrillDown, onPlayStep, onOpenSource, isMeta }: {
    step: TourStepLite;
    onDrillDown: () => void;
    onPlayStep: () => void;
    onOpenSource: () => void;
    /** ADR-034 Phase H Pass 3 — workspace meta-tour state. */
    isMeta: boolean;
}) {
    const diffBadge = step.diff && step.diff !== 'unchanged' ? (
        <span style={{
            ...badgeStyle,
            background: step.diff === 'added' ? 'var(--ca-added-bg, rgba(79,178,134,0.18))' : 'var(--ca-modified-bg, rgba(232,155,60,0.18))',
            color: step.diff === 'added' ? 'var(--ca-added-text, #4fb286)' : 'var(--ca-modified-text, #e89b3c)',
        }}>{step.diff}</span>
    ) : null;
    const fanInBadge = step.fanIn > 0 ? (
        <span style={badgeStyle} title={`Called by ${step.fanIn} other places`}>
            ← {step.fanIn}
        </span>
    ) : null;

    return (
        <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
                <span style={stepNumberStyle}>Step {step.stepNumber}</span>
                <span style={labelStyle}>{step.label}</span>
                {fanInBadge}
                {diffBadge}
            </div>
            <div style={whyStyle}>{step.why}</div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                {isMeta ? (
                    <button onClick={onDrillDown} style={primaryButtonStyle} title="Open this repo's per-handler tour">
                        ↳ Drill into repo tour
                    </button>
                ) : (
                    <>
                        <button onClick={onPlayStep} style={primaryButtonStyle} title="Play through this step's call flow message by message">
                            ▶ Play diagram
                        </button>
                        <button onClick={onDrillDown} style={smallButtonStyle} title="Open the diagram without playback">
                            Open diagram
                        </button>
                    </>
                )}
                <button onClick={onOpenSource} style={smallButtonStyle}>
                    Open source
                </button>
                <span style={{ flex: 1 }} />
                <span style={pathStyle} title={step.filePath}>
                    {/* Bug D (2026-06-04): the parser invents synthetic
                        handler symbols like `anonymous@GET:/` for inline
                        arrow-callback routes. Hide them from the path
                        footer — the route + verb in the step title
                        already conveys what's being navigated to. */}
                    {step.filePath}{step.symbol && !step.symbol.startsWith('anonymous@') ? ` :: ${step.symbol}` : ''}
                </span>
            </div>
        </div>
    );
}

function Footer({ current, total }: { current: number; total: number }) {
    const pct = total === 0 ? 0 : Math.round((current / total) * 100);
    return (
        <div style={footerStyle}>
            <div style={{ flex: 1, height: 4, background: 'var(--ca-border)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--ca-accent)', transition: 'width 0.2s ease' }} />
            </div>
            <span style={{ fontSize: 11, color: 'var(--ca-text-muted)' }}>{current} / {total}</span>
        </div>
    );
}

// ─── Styles ──────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: "'Inter', system-ui, sans-serif",
    color: 'var(--ca-text)',
    background: 'var(--ca-bg)',
    overflow: 'hidden',
};

const cardStyle: React.CSSProperties = {
    flex: 1,
    margin: 16,
    padding: 20,
    border: '1px solid var(--ca-border)',
    borderRadius: 12,
    background: 'var(--ca-node-body-bg)',
    overflow: 'auto',
};

const stepNumberStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: 'var(--ca-text-muted)',
};

const labelStyle: React.CSSProperties = {
    fontSize: 22,
    fontWeight: 700,
    flex: 1,
};

const whyStyle: React.CSSProperties = {
    fontSize: 14,
    lineHeight: 1.6,
    color: 'var(--ca-text)',
    background: 'var(--ca-bg)',
    padding: '10px 14px',
    borderRadius: 8,
    border: '1px solid var(--ca-border)',
};

const pathStyle: React.CSSProperties = {
    fontSize: 10,
    fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    color: 'var(--ca-text-muted)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '50%',
};

const badgeStyle: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 6,
    background: 'var(--ca-bg)',
    color: 'var(--ca-text-muted)',
    border: '1px solid var(--ca-border)',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
};

const smallButtonStyle: React.CSSProperties = {
    fontSize: 11,
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid var(--ca-border)',
    background: 'transparent',
    color: 'var(--ca-text)',
    cursor: 'pointer',
};

const primaryButtonStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    padding: '6px 14px',
    borderRadius: 6,
    border: 'none',
    background: 'var(--ca-accent)',
    color: '#fff',
    cursor: 'pointer',
};

const selectStyle: React.CSSProperties = {
    fontSize: 11,
    padding: '4px 6px',
    borderRadius: 6,
    border: '1px solid var(--ca-border)',
    background: 'var(--ca-bg)',
    color: 'var(--ca-text)',
};

const footerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 16px',
    borderTop: '1px solid var(--ca-border)',
};

const emptyStateStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    color: 'var(--ca-text-muted)',
    padding: 40,
    textAlign: 'center' as const,
};

export default memo(TourView);
