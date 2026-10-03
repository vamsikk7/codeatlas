/**
 * CommandBar.tsx
 *
 * Fixed horizontal toolbar shown on all diagram views (hidden on home).
 * Icon-only buttons with tooltips; highlights the active diagram level.
 */

import React from 'react';
import { impactActionForGraphId } from '../lib/impactAction';
import { entryPointsNoun } from '../lib/entryPointLabel';

type ViewMode = 'sequence' | 'file' | 'flow' | 'feature' | 'microservice' | 'api-list' | 'health' | 'screen-content' | 'map' | 'domain' | 'tour';

interface CommandBarProps {
    activeMode: ViewMode;
    /** BUG-EXPLORE-7 — current graphId so Impact can run on the viewed file directly. */
    currentGraphId?: string | null;
    /**
     * Current scope's service category ('frontend'/'mobile'/'backend'). Drives
     * the L2b toolbar label: backend services expose "APIs", frontend/mobile
     * services expose "Entry Points" (screens/routes/deep-links/data calls).
     */
    currentCategory?: string;
    currentTheme?: 'dark' | 'light';
    explorerVisible?: boolean;
    onExplorerToggle?: () => void;
    onCommentsToggle?: () => void;
    commentCount?: number;
    /** #826 — opens the Overlays panel (R2b). */
    onOverlaysToggle?: () => void;
    /**
     * BUG-EXP-8 — true when served by the MCP standalone daemon (`@codeatlas/mcp`).
     * Some toolbar actions (Timeline Replay, PR Diff) always refuse in the daemon
     * and pop a "needs the VS Code extension" toast; we hide them here rather than
     * offer-then-refuse.
     */
    isStandalone?: boolean;
}

// Toolbar items that ALWAYS refuse in the standalone daemon (see
// src/standalone/messageHandler.ts `codeatlas.timelineReplay` / `openPrDiff`).
const STANDALONE_HIDDEN_IDS = new Set(['timeline', 'pr']);

interface ToolbarButton {
    id: string;
    icon: string;
    /** Long-form description for title + aria-label (kept descriptive for a11y). */
    label: string;
    /**
     * UX-14 (2026-06-04): short visible label rendered next to the icon
     * so new users don't see a wall of emojis. Kept ≤ 8 chars so the bar
     * stays compact. When omitted, only the icon is visible (used for
     * separators and the explorer toggle which has well-known iconography).
     */
    shortLabel?: string;
    matchMode?: ViewMode;
    action: () => void;
}

const post = (msg: any) => (window as any).vscodeApi?.postMessage(msg);

export default function CommandBar({ activeMode, currentGraphId, currentCategory, currentTheme, explorerVisible, onExplorerToggle, onCommentsToggle, commentCount, onOverlaysToggle, isStandalone }: CommandBarProps) {
    // L2b noun adapts to the current scope: "APIs" for backend, "Entry Points"
    // for frontend/mobile. Keep the label ≤ 8 chars? "Entry Points" is 12 but
    // the toolbar wraps gracefully; the semantic honesty is worth it.
    const l2bNoun = entryPointsNoun(currentCategory);
    const allButtons: ToolbarButton[] = [
        { id: 'explorer', icon: '☰', label: 'Explorer', shortLabel: 'Menu', action: () => onExplorerToggle?.() },
        { id: 'sep0', icon: '', label: '', action: () => {} },
        { id: 'l1', icon: '🏗', label: 'System Design (L1)', shortLabel: 'System', matchMode: 'microservice', action: () => post({ type: 'openMicroserviceDiagram' }) },
        { id: 'l2', icon: '🧩', label: 'Feature Areas (L2)', shortLabel: 'Features', matchMode: 'feature', action: () => post({ type: 'openFeatureDiagram', serviceId: '' }) },
        { id: 'apis', icon: '⚡', label: l2bNoun === 'APIs' ? 'API List' : 'Entry Points', shortLabel: l2bNoun, matchMode: 'api-list', action: () => post({ type: 'runCommand', command: 'codeatlas.openApiExplorer' }) },
        { id: 'health', icon: '💊', label: 'Health Report', shortLabel: 'Health', matchMode: 'health', action: () => post({ type: 'runCommand', command: 'codeatlas.showHealthReport' }) },
        { id: 'sep1', icon: '', label: '', action: () => {} },
        { id: 'diff', icon: '⎇', label: 'Compare Commits', shortLabel: 'Compare', action: () => post({ type: 'requestGitDiff' }) },
        { id: 'branch', icon: '🌿', label: 'Branch Diff', shortLabel: 'Branch', action: () => post({ type: 'requestBranchDiff' }) },
        { id: 'pr', icon: '⤵', label: 'PR Diff', shortLabel: 'PR', action: () => post({ type: 'runCommand', command: 'codeatlas.openPrDiff' }) },
        { id: 'impact', icon: '🎯', label: 'Impact Analysis', shortLabel: 'Impact', action: () => post(impactActionForGraphId(currentGraphId)) },
        { id: 'timeline', icon: '⏯', label: 'Timeline Replay', shortLabel: 'Replay', action: () => post({ type: 'runCommand', command: 'codeatlas.timelineReplay' }) },
        { id: 'export', icon: '📄', label: 'Export Docs', shortLabel: 'Export', action: () => post({ type: 'runCommand', command: 'codeatlas.exportArchitectureDocs' }) },
        { id: 'comments', icon: '💬', label: `Comments${commentCount ? ` (${commentCount})` : ''}`, shortLabel: commentCount ? `Comments (${commentCount})` : 'Comments', action: () => onCommentsToggle?.() },
        { id: 'overlays', icon: '🎛', label: 'Overlays — choose what gets painted on the nodes', shortLabel: 'Overlays', action: () => onOverlaysToggle?.() },
        { id: 'search', icon: '🔍', label: 'Search', shortLabel: 'Search', action: () => post({ type: 'runCommand', command: 'codeatlas.search' }) },
        { id: 'sync', icon: '🔄', label: 'Re-sync', shortLabel: 'Sync', action: () => post({ type: 'runCommand', command: 'codeatlas.resyncEverything' }) },
        { id: 'sep2', icon: '', label: '', action: () => {} },
        { id: 'theme', icon: currentTheme === 'dark' ? '☀' : '☾', label: currentTheme === 'dark' ? 'Light Mode' : 'Dark Mode', shortLabel: currentTheme === 'dark' ? 'Light' : 'Dark', action: () => post({ type: 'toggleTheme' }) },
    ];

    // BUG-EXP-8 — in the standalone daemon, drop items that always refuse
    // (Timeline Replay, PR Diff) so we don't offer-then-refuse.
    const buttons = isStandalone
        ? allButtons.filter(b => !STANDALONE_HIDDEN_IDS.has(b.id))
        : allButtons;

    return (
        <div className="ca-command-bar" role="toolbar" aria-label="Command toolbar">
            {buttons.map(btn => {
                if (btn.id.startsWith('sep')) {
                    return <span key={btn.id} className="ca-command-bar-sep" />;
                }
                const isActive = btn.id === 'explorer' ? !!explorerVisible : btn.matchMode === activeMode;
                return (
                    <button
                        key={btn.id}
                        className={`ca-command-bar-btn${isActive ? ' active' : ''}`}
                        title={btn.label}
                        aria-label={btn.label}
                        aria-pressed={isActive || undefined}
                        onClick={btn.action}
                    >
                        <span className="ca-command-bar-icon" aria-hidden="true">{btn.icon}</span>
                        {btn.shortLabel && (
                            <span className="ca-command-bar-label">{btn.shortLabel}</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
