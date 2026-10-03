/**
 * LearnPanel.tsx — Issue #708 inline contextual explanations.
 *
 * Sliding side panel keyed by ViewMode. Each view's header gets a `?`
 * button that toggles the panel; the panel reads the entry from
 * `help.json` and renders summary + body + (when persona === 'power')
 * the extra implementation-detail paragraph.
 *
 * Backed by a plain JSON file (`data/help.json`) so adding a new view
 * means adding one entry — no schema migration, no rebuild ceremony.
 */

import React, { useEffect, useState, CSSProperties } from 'react';
import helpData from '../data/help.json';
import { usePersona } from '../state/personaStore';

interface HelpEntry {
    title: string;
    summary: string;
    body: string;
    powerExtra?: string;
}

type HelpMap = Record<string, HelpEntry>;

const HELP: HelpMap = helpData as unknown as HelpMap;

interface LearnPanelProps {
    /** Mode key — typically the current `ViewMode`. Looked up in `help.json`. */
    helpKey: string;
    /** Open / close state. Controlled by the parent (the `?` button toggles it). */
    open: boolean;
    /** Close handler — clicked the X or pressed Escape. */
    onClose: () => void;
}

export function LearnPanel({ helpKey, open, onClose }: LearnPanelProps) {
    const persona = usePersona();
    const entry = HELP[helpKey];

    // Escape closes the panel — global key listener mounted only while open.
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, onClose]);

    if (!open) return null;

    const containerStyle: CSSProperties = {
        position: 'absolute',
        top: 0,
        right: 0,
        width: 340,
        maxWidth: '90vw',
        height: '100%',
        background: 'var(--ca-panel-bg, rgba(20,20,28,0.96))',
        borderLeft: '1px solid var(--ca-border)',
        boxShadow: '-4px 0 14px rgba(0,0,0,0.25)',
        padding: '16px 20px',
        zIndex: 100,
        overflowY: 'auto',
        fontFamily: "'Inter', system-ui, sans-serif",
        color: 'var(--ca-text)',
    };

    const headerStyle: CSSProperties = {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 16,
    };

    const titleStyle: CSSProperties = {
        fontSize: 16,
        fontWeight: 700,
        margin: 0,
    };

    const summaryStyle: CSSProperties = {
        fontSize: 13,
        lineHeight: 1.5,
        color: 'var(--ca-text)',
        marginBottom: 12,
        fontStyle: 'italic',
    };

    const bodyStyle: CSSProperties = {
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--ca-text-muted)',
    };

    const powerExtraStyle: CSSProperties = {
        fontSize: 11,
        lineHeight: 1.5,
        color: 'var(--ca-text-muted)',
        marginTop: 16,
        padding: '10px 12px',
        background: 'var(--ca-bg)',
        border: '1px solid var(--ca-border)',
        borderRadius: 6,
        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
    };

    const closeBtnStyle: CSSProperties = {
        background: 'transparent',
        border: 'none',
        color: 'var(--ca-text-muted)',
        fontSize: 18,
        cursor: 'pointer',
        padding: 0,
        lineHeight: 1,
    };

    if (!entry) {
        return (
            <div style={containerStyle} role="dialog" aria-label="Learn panel" data-testid="learn-panel">
                <div style={headerStyle}>
                    <h2 style={titleStyle}>Learn</h2>
                    <button onClick={onClose} style={closeBtnStyle} aria-label="Close learn panel">×</button>
                </div>
                <p style={bodyStyle}>No help available for this view yet.</p>
            </div>
        );
    }

    return (
        <div
            style={containerStyle}
            role="dialog"
            aria-label={`Learn: ${entry.title}`}
            data-testid="learn-panel"
        >
            <div style={headerStyle}>
                <h2 style={titleStyle}>{entry.title}</h2>
                <button onClick={onClose} style={closeBtnStyle} aria-label="Close learn panel">×</button>
            </div>
            <p style={summaryStyle}>{entry.summary}</p>
            <p style={bodyStyle}>{entry.body}</p>
            {/* Issue #706 — persona-aware extra. Power persona sees the
                implementation-detail paragraph; Junior + PM see only the
                user-facing summary + body. */}
            {persona === 'power' && entry.powerExtra && (
                <div style={powerExtraStyle}>
                    <strong style={{ color: 'var(--ca-text)' }}>Under the hood:</strong> {entry.powerExtra}
                </div>
            )}
        </div>
    );
}

/**
 * `?` button — drop into any view header. Toggles the LearnPanel state
 * via the supplied onClick.
 */
export function LearnButton({ onClick, ariaLabel = 'Open learn panel' }: { onClick: () => void; ariaLabel?: string }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={ariaLabel}
            title="What is this view? (Esc to close)"
            data-testid="learn-button"
            style={{
                background: 'transparent',
                border: '1px solid var(--ca-border)',
                borderRadius: '50%',
                width: 22,
                height: 22,
                color: 'var(--ca-text-muted)',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                padding: 0,
                lineHeight: '20px',
            }}
        >
            ?
        </button>
    );
}

export default LearnPanel;
