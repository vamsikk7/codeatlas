/**
 * themeCommands.ts — Issue #358 Row 7c (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * two theme-toggle command registrations. Each command persists the
 * choice into VS Code global state, flips the panel-manager + browser
 * theme through the WS bridge, and shows a confirmation toast.
 *
 *   - codeatlas.lightMode
 *   - codeatlas.darkMode
 *
 * Mechanical extraction — NO behavior change.
 */

import * as vscode from 'vscode';
import { analytics } from '../analytics/mixpanelService';
import type { PanelManager } from '../views/webview/panelManager';
import type { WsBridge } from '../server/wsBridge';

export interface ThemeCommandDeps {
    context: vscode.ExtensionContext;
    panelManager: PanelManager;
    wsBridge: WsBridge | undefined;
}

function registerTheme(theme: 'light' | 'dark', deps: ThemeCommandDeps): vscode.Disposable {
    const { context, panelManager, wsBridge } = deps;
    const command = theme === 'light' ? 'codeatlas.lightMode' : 'codeatlas.darkMode';
    const label = theme === 'light' ? 'Light' : 'Dark';
    return vscode.commands.registerCommand(command, () => {
        analytics.track('theme_changed', { theme });
        context.globalState.update('codeatlas.theme', theme);
        panelManager.setTheme(theme);
        if (wsBridge?.hasClients()) wsBridge.broadcast({ type: 'setTheme', theme });
        vscode.window.showInformationMessage(`CodeAtlas: ${label} mode enabled.`);
    });
}

export function registerThemeCommands(deps: ThemeCommandDeps): vscode.Disposable[] {
    return [
        registerTheme('light', deps),
        registerTheme('dark', deps),
    ];
}
