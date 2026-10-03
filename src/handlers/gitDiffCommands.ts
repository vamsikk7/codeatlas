/**
 * gitDiffCommands.ts — Issue #358 Row 7g (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * three commands that enter / exit git-diff mode from the command
 * palette:
 *
 *   - codeatlas.openGitDiff   → open the commit / branch diff picker
 *   - codeatlas.clearGitDiff  → exit diff mode + restore live view
 *   - codeatlas.openPrDiff    → open the PR-diff picker
 *
 * Each command dispatches into an existing handler-style function
 * (`handleRequestGitDiff`, `handleClearGitDiff`, `handleRequestPrDiff`)
 * that lives elsewhere; the role of this module is to register the
 * three command entry points with consistent error logging. The
 * `activePanelId` lookup falls back to the canonical L1 graphId so the
 * command works even when no diagram panel is open yet.
 *
 * Mechanical extraction — NO behavior change.
 */

import * as vscode from 'vscode';
import type { OutputChannel } from 'vscode';
import type { PanelManager } from '../views/webview/panelManager';

export interface GitDiffCommandDeps {
    panelManager: PanelManager;
    outputChannel: OutputChannel;
    handleRequestGitDiff: (sourcePanelId: string) => Promise<void>;
    handleClearGitDiff: () => void;
    handleRequestPrDiff: (sourcePanelId: string) => Promise<void>;
}

export function registerGitDiffCommands(deps: GitDiffCommandDeps): vscode.Disposable[] {
    const {
        panelManager,
        outputChannel,
        handleRequestGitDiff,
        handleClearGitDiff,
        handleRequestPrDiff,
    } = deps;

    const resolveActivePanelId = (): string =>
        panelManager.getActivePanelId() ?? 'microservice:workspace';

    return [
        vscode.commands.registerCommand('codeatlas.openGitDiff', () => {
            const activePanelId = resolveActivePanelId();
            handleRequestGitDiff(activePanelId).catch(err =>
                outputChannel.appendLine(`[GitDiff] Error: ${err?.message ?? err}`),
            );
        }),

        vscode.commands.registerCommand('codeatlas.clearGitDiff', () => {
            handleClearGitDiff();
        }),

        vscode.commands.registerCommand('codeatlas.openPrDiff', () => {
            const activePanelId = resolveActivePanelId();
            handleRequestPrDiff(activePanelId).catch(err =>
                outputChannel.appendLine(`[PrDiff] Error: ${err?.message ?? err}`),
            );
        }),
    ];
}
