import { useState } from 'react';

interface TourPlaybackControlsProps {
    stepIndex: number;
    totalSteps: number;
    stepLabel: string;
    msgIndex: number;
    totalMsgs: number;
    activeMessageLabel: string;
    paused: boolean;
    onControl: (action: 'pause' | 'resume' | 'stop' | 'skipStep' | 'next' | 'prev') => void;
    onSpeedChange: (ms: number) => void;
}

export default function TourPlaybackControls({
    stepIndex,
    totalSteps,
    stepLabel,
    msgIndex,
    totalMsgs,
    activeMessageLabel,
    paused,
    onControl,
    onSpeedChange,
}: TourPlaybackControlsProps) {
    const [speed, setSpeed] = useState(2000);

    const handleSpeed = (newSpeed: number) => {
        setSpeed(newSpeed);
        onSpeedChange(newSpeed);
    };

    const atFirstMsg = msgIndex <= 0;
    const atLastMsg = totalMsgs === 0 || msgIndex >= totalMsgs - 1;

    return (
        <div style={containerStyle}>
            <div style={headerStyle}>
                <span style={{ fontFamily: 'var(--ca-font-mono)', fontSize: 11, color: 'var(--ca-accent)' }}>
                    Tour Step {stepIndex + 1}/{totalSteps}
                </span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ca-text)' }}>
                    {stepLabel.length > 48 ? stepLabel.slice(0, 48) + '…' : stepLabel}
                </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--ca-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 240 }}>
                    {activeMessageLabel || '—'}
                </span>
                {totalMsgs > 0 && (
                    <span style={{ fontSize: 10, color: 'var(--ca-text-muted)', fontFamily: 'var(--ca-font-mono)' }}>
                        Msg {msgIndex + 1}/{totalMsgs}
                    </span>
                )}
            </div>

            <div style={controlsStyle}>
                <button
                    onClick={() => onControl('prev')}
                    disabled={atFirstMsg}
                    style={{ ...navBtnStyle, opacity: atFirstMsg ? 0.4 : 1 }}
                    title="Previous message"
                    aria-label="Previous message"
                >
                    ‹
                </button>
                <button onClick={() => onControl(paused ? 'resume' : 'pause')} style={btnStyle} title={paused ? 'Resume' : 'Pause'} aria-label={paused ? 'Resume playback' : 'Pause playback'}>
                    {paused ? '▶' : '⏸'}
                </button>
                <button
                    onClick={() => onControl('next')}
                    disabled={atLastMsg}
                    style={{ ...navBtnStyle, opacity: atLastMsg ? 0.4 : 1 }}
                    title="Next message"
                    aria-label="Next message"
                >
                    ›
                </button>

                <div style={{ width: 1, height: 16, background: 'var(--ca-border)', margin: '0 2px' }} />
                <button
                    onClick={() => onControl('skipStep')}
                    disabled={stepIndex >= totalSteps - 1}
                    style={{ ...btnStyle, opacity: stepIndex >= totalSteps - 1 ? 0.4 : 1 }}
                    title="Skip to next tour step"
                    aria-label="Skip to next tour step"
                >
                    ⏭
                </button>
                <button onClick={() => onControl('stop')} style={{ ...btnStyle, background: 'var(--ca-danger)' }} title="Stop playback" aria-label="Stop playback">
                    ■
                </button>

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
                        aria-label="Playback speed"
                    />
                    <span style={{ fontSize: 9, color: 'var(--ca-text-muted)', minWidth: 28 }}>{(speed / 1000).toFixed(1)}s</span>
                </div>
            </div>

            {totalSteps > 1 && (
                <div style={dotsStyle}>
                    {Array.from({ length: totalSteps }, (_, i) => (
                        <span
                            key={i}
                            style={{
                                width: 8, height: 8, borderRadius: '50%',
                                background: i === stepIndex ? 'var(--ca-accent)' : i < stepIndex ? 'var(--ca-success)' : 'var(--ca-border)',
                                transition: 'background 0.2s',
                            }}
                            title={`Step ${i + 1}`}
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
    minWidth: 320,
    maxWidth: 440,
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
