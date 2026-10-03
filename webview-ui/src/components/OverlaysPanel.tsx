/**
 * OverlaysPanel.tsx — #826 R2b (2026-06-11).
 *
 * The "what gets painted on the canvas" control surface. One row per
 * registered overlay with a show/hide toggle; empty-state hints render
 * inline (not a dead toggle); a soft "canvas may get busy" hint appears
 * past 2 simultaneous paints instead of a hard block.
 */

export interface OverlayRowState {
    id: string;
    displayName: string;
    enabled: boolean;
    paint: string;
    emptyHint?: string;
    renderManaged: boolean;
    /** Filled after a data fetch — true when the source had no points. */
    knownEmpty?: boolean;
}

export function OverlaysPanel({
    overlays,
    onToggle,
    onClose,
}: {
    overlays: OverlayRowState[];
    onToggle: (id: string, enabled: boolean) => void;
    onClose: () => void;
}) {
    const enabledCount = overlays.filter((o) => o.enabled).length;
    return (
        <div
            role="dialog"
            aria-label="Overlays"
            data-testid="ca-overlays-panel"
            style={{
                position: 'fixed', inset: 0, zIndex: 1000,
                background: 'rgba(0,0,0,0.45)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            onClick={onClose}
        >
            <div
                style={{
                    width: 'min(460px, 92vw)', maxHeight: '80vh', overflowY: 'auto',
                    background: 'var(--ca-surface, #1e1e1e)', color: 'var(--ca-text, #ddd)',
                    border: '1px solid var(--ca-border, #444)', borderRadius: 10,
                    padding: '16px 20px', boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <h2 style={{ margin: 0, fontSize: 16 }}>🎛 Overlays</h2>
                    <button
                        type="button" aria-label="Close" data-testid="ca-overlays-close"
                        onClick={onClose}
                        style={{ background: 'none', border: 'none', color: 'inherit', fontSize: 16, cursor: 'pointer' }}
                    >✕</button>
                </div>
                <p style={{ fontSize: 12, color: 'var(--ca-text-muted, #999)', margin: '0 0 12px 0' }}>
                    Layers are the canvas, overlays are the lens — choose what gets painted on the nodes.
                </p>
                {enabledCount > 2 && (
                    <div
                        data-testid="ca-overlays-busy-hint"
                        style={{ fontSize: 11.5, color: '#eab308', marginBottom: 10 }}
                    >
                        ⚠ {enabledCount} overlays active — the canvas may get busy.
                    </div>
                )}
                {overlays.map((o) => (
                    <div
                        key={o.id}
                        data-testid={`ca-overlay-row-${o.id}`}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '8px 6px', borderBottom: '1px solid var(--ca-border, #333)',
                        }}
                    >
                        <label style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                data-testid={`ca-overlay-toggle-${o.id}`}
                                checked={o.enabled}
                                onChange={(e) => onToggle(o.id, e.target.checked)}
                            />
                            <span style={{ flex: 1 }}>
                                <span style={{ fontSize: 13 }}>{o.displayName}</span>
                                {o.knownEmpty && o.emptyHint && (
                                    <span
                                        data-testid={`ca-overlay-empty-${o.id}`}
                                        style={{ display: 'block', fontSize: 11, color: 'var(--ca-text-muted, #888)' }}
                                    >
                                        {o.emptyHint}
                                    </span>
                                )}
                            </span>
                        </label>
                        <span style={{
                            fontSize: 10, padding: '1px 7px', borderRadius: 9,
                            background: 'rgba(127,127,127,0.18)', color: 'var(--ca-text-muted, #aaa)',
                        }}>
                            {o.renderManaged ? 'built-in' : o.paint}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
