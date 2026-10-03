/**
 * Shared diff color constants used across all diagram layers.
 * Uses CSS custom properties so dark/light theme switching works automatically.
 * Single source of truth — import from here instead of defining locally.
 */

export const EDGE_DIFF_COLORS: Record<string, string> = {
    added: 'var(--ca-success)',
    deleted: 'var(--ca-danger)',
    modified: 'var(--ca-warning)',
    unchanged: 'var(--ca-edge-unchanged)',
};

export const NODE_DIFF_COLORS: Record<string, { bg: string; border: string; glow: string; text: string }> = {
    added:    { bg: 'var(--ca-added-bg)',    border: 'var(--ca-added-border)',    glow: 'var(--ca-added-glow)',    text: 'var(--ca-added-text)'    },
    deleted:  { bg: 'var(--ca-deleted-bg)',  border: 'var(--ca-deleted-border)',  glow: 'var(--ca-deleted-glow)',  text: 'var(--ca-deleted-text)'  },
    modified: { bg: 'var(--ca-modified-bg)', border: 'var(--ca-modified-border)', glow: 'var(--ca-modified-glow)', text: 'var(--ca-modified-text)' },
    unchanged:{ bg: 'var(--ca-node-bg)',     border: 'var(--ca-edge-unchanged)',  glow: 'transparent',             text: 'var(--ca-accent)'        },
};

/**
 * Colorblind-safe diff symbols — displayed alongside color badges so status
 * is distinguishable without relying on color alone (WCAG 1.4.1).
 */
export const DIFF_SYMBOLS: Record<string, string> = {
    added: '+',
    deleted: '−',
    modified: '~',
    unchanged: '',
};

/**
 * Border style per diff status — provides a secondary visual channel
 * beyond color (solid = added, dashed = deleted, dotted = modified).
 */
export const DIFF_BORDER_STYLES: Record<string, string> = {
    added: 'solid',
    deleted: 'dashed',
    modified: 'dotted',
    unchanged: 'solid',
};
