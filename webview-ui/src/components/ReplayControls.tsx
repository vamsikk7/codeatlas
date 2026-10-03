import { useState } from 'react';

interface CommitReplayStep {
    commitHash: string;
    commitSubject: string;
    commitIndex: number;
    totalCommits: number;
    graphId: string;
    mode: string;
    label: string;
    layer: string;
    changedEntity: string;
    globalIndex: number;
    totalSteps: number;
    // #818 — cross-repo coda annotations (present on coda frames only).
    replayKind?: 'cross-repo-coda';
    codaProducer?: string;
    codaConsumer?: string;
}

interface ReplayControlsProps {
    step: CommitReplayStep | null;
    commitInfo: { index: number; total: number; hash: string; subject: string } | null;
    paused: boolean;
    onControl: (action: 'pause' | 'resume' | 'stop' | 'skipCommit' | 'next' | 'prev') => void;
    onSpeedChange: (ms: number) => void;
}

export default function ReplayControls({ step, commitInfo, paused, onControl, onSpeedChange }: ReplayControlsProps) {
    const [speed, setSpeed] = useState(2000);

    if (!commitInfo) return null;

    const handleSpeed = (newSpeed: number) => {
        setSpeed(newSpeed);
        onSpeedChange(newSpeed);
    };

    const stepIndex = step?.globalIndex ?? 0;
    const totalSteps = step?.totalSteps ?? 0;
    const atStart = stepIndex <= 0;
    const atEnd = totalSteps > 0 && stepIndex >= totalSteps - 1;

    return (
        <div style={containerStyle}>
            {/* Commit info */}
            <div style={headerStyle}>
                <span style={{ fontFamily: 'var(--ca-font-mono)', fontSize: 11, color: 'var(--ca-accent)' }}>
                    Commit {commitInfo.index + 1}/{commitInfo.total}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ca-text)' }}>
                    {commitInfo.subject.length > 40 ? commitInfo.subject.slice(0, 40) + '...' : commitInfo.subject}
                </span>
            </div>

            {/* Current step */}
            {step && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--ca-text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        {/* #818 R4 — cross-repo coda chip with the producer→consumer arrow. */}
                        {step.replayKind === 'cross-repo-coda' && (
                            <span
                                data-testid="ca-replay-coda-chip"
                                title={`Cross-repo impact: ${step.codaProducer} → ${step.codaConsumer}`}
                                style={{
                                    fontSize: 10, padding: '1px 7px', borderRadius: 9, whiteSpace: 'nowrap',
                                    background: 'rgba(59, 130, 246, 0.18)', color: 'var(--ca-accent)',
                                    border: '1px solid var(--ca-accent)',
                                }}
                            >
                                🔗 cross-repo {step.codaProducer} → {step.codaConsumer}
                            </span>
                        )}
                        <span>{step.layer} — {step.changedEntity}</span>
                    </span>
                    {totalSteps > 0 && (
                        <span style={{ fontSize: 10, color: 'var(--ca-text-muted)', fontFamily: 'var(--ca-font-mono)' }}>
                            Step {stepIndex + 1}/{totalSteps}
                        </span>
                    )}
                </div>
            )}
            {/* #818 R4 — once the coda starts, offer a one-click exit. The
                coda frames are always the replay's tail, so skipping them
                is equivalent to ending the replay. */}
            {step?.replayKind === 'cross-repo-coda' && (
                <button
                    data-testid="ca-replay-skip-coda"
                    onClick={() => onControl('stop')}
                    style={{
                        ...btnStyle, background: 'transparent',
                        border: '1px solid var(--ca-border)', color: 'var(--ca-text-muted)',
                        marginBottom: 8, width: '100%', fontSize: 11,
                    }}
                    title="End the replay without walking the remaining cross-repo consumers"
                >
                    Skip coda ⏏
                </button>
            )}

            {/* Controls */}
            <div style={controlsStyle}>
                {/* Prev / Play-Pause / Next — primary group */}
                <button
                    onClick={() => onControl('prev')}
                    disabled={atStart}
                    style={{ ...navBtnStyle, opacity: atStart ? 0.4 : 1 }}
                    title="Previous step"
                    aria-label="Previous step"
                >
                    ‹
                </button>
                <button onClick={() => onControl(paused ? 'resume' : 'pause')} style={btnStyle} title={paused ? 'Resume' : 'Pause'}>
                    {paused ? '▶' : '⏸'}
                </button>
                <button
                    onClick={() => onControl('next')}
                    disabled={atEnd}
                    style={{ ...navBtnStyle, opacity: atEnd ? 0.4 : 1 }}
                    title="Next step"
                    aria-label="Next step"
                >
                    ›
                </button>

                {/* Skip commit + Stop */}
                <div style={{ width: 1, height: 16, background: 'var(--ca-border)', margin: '0 2px' }} />
                <button onClick={() => onControl('skipCommit')} style={btnStyle} title="Skip to next commit">
                    ⏭
                </button>
                <button onClick={() => onControl('stop')} style={{ ...btnStyle, background: 'var(--ca-danger)' }} title="Stop replay">
                    ■
                </button>

                {/* Speed slider */}
                <div style={speedStyle}>
                    <span style={{ fontSize: 9, color: 'var(--ca-text-muted)' }}>Speed</span>
                    <input
                        type="range"
                        min={500}
                        max={5000}
                        step={250}
                        value={speed}
                        onChange={e => handleSpeed(Number(e.target.value))}
                        style={{ width: 60, accentColor: 'var(--ca-accent)' }}
                        aria-label="Replay speed"
                    />
                    <span style={{ fontSize: 9, color: 'var(--ca-text-muted)', minWidth: 28 }}>{(speed / 1000).toFixed(1)}s</span>
                </div>
            </div>

            {/* Commit dots */}
            {commitInfo.total > 1 && (
                <div style={dotsStyle}>
                    {Array.from({ length: commitInfo.total }, (_, i) => (
                        <span
                            key={i}
                            style={{
                                width: 8, height: 8, borderRadius: '50%',
                                background: i === commitInfo.index ? 'var(--ca-accent)' : i < commitInfo.index ? 'var(--ca-success)' : 'var(--ca-border)',
                                transition: 'background 0.2s',
                            }}
                            title={`Commit ${i + 1}`}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

const containerStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: 50,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'var(--ca-surface)',
    border: '1px solid var(--ca-accent)',
    borderRadius: 'var(--ca-radius-lg)',
    padding: '12px 18px',
    zIndex: 30,
    boxShadow: 'var(--ca-shadow-lg)',
    minWidth: 280,
    maxWidth: 400,
};

const headerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    marginBottom: 6,
};

const controlsStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
};

const btnStyle: React.CSSProperties = {
    background: 'var(--ca-accent)',
    border: 'none',
    borderRadius: 'var(--ca-radius-sm)',
    color: '#fff',
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 12,
};

const navBtnStyle: React.CSSProperties = {
    background: 'var(--ca-accent)',
    border: 'none',
    borderRadius: 'var(--ca-radius-sm)',
    color: '#fff',
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: 16,
    fontWeight: 700,
    lineHeight: 1,
};

const speedStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
};

const dotsStyle: React.CSSProperties = {
    display: 'flex',
    gap: 4,
    marginTop: 8,
    justifyContent: 'center',
};
