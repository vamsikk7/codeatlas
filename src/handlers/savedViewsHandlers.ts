/**
 * savedViewsHandlers.ts — Issue #358 Row 4 (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * three saved-filter-view router-handler blocks shipped under #750
 * (2026-06-06):
 *
 *   - requestSavedFilterViews  → reply with the current list
 *   - saveFilterView           → upsert + broadcast the refreshed list
 *   - deleteFilterView         → remove + broadcast the refreshed list
 *
 * Mechanical extraction — NO behavior change. Same router registration
 * shape, same reply / broadcast routing convention, same error-handling
 * pattern, same single-source-of-truth file
 * (`.codeatlas/saved-filter-views.json`).
 *
 * Wire by calling `registerSavedViewsHandlers(router, deps)` from
 * `extension.ts::activate`.
 */

import type { OutputChannel } from 'vscode';
import type { PanelManager } from '../views/webview/panelManager';
import type { WsBridge } from '../server/wsBridge';
import type { MessageRouter } from './oauth2Handlers';

export interface SavedViewsHandlerDeps {
    panelManager: PanelManager;
    wsBridge: WsBridge | undefined;
    outputChannel: OutputChannel;
    workspaceRoot: string;
}

const MODULE = 'SavedViewsHandlers';

export function registerSavedViewsHandlers(router: MessageRouter, deps: SavedViewsHandlerDeps): void {
    const { panelManager, wsBridge, outputChannel, workspaceRoot } = deps;

    // #750 (2026-06-06) — saved filter views. Three handlers wrap the
    // pure `filterViews.ts` storage layer: list, save, delete. Every
    // mutation broadcasts the refreshed list so other tabs stay in sync.
    // Single source of truth: `.codeatlas/saved-filter-views.json`.
    router.register('requestSavedFilterViews', (_message, sourcePanelId) => {
        const reply = (payload: any): void => {
            if (sourcePanelId.startsWith('ws:') && wsBridge) wsBridge.sendTo(sourcePanelId.slice(3), payload);
            else panelManager.sendToPanel(sourcePanelId, payload);
        };
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { loadSavedFilterViews } = require('../core/savedViews/filterViews');
            reply({ type: 'savedFilterViewsResult', views: loadSavedFilterViews(workspaceRoot) });
        } catch (err: any) {
            outputChannel.appendLine(`[requestSavedFilterViews] failed: ${err?.message ?? err}`);
            reply({ type: 'savedFilterViewsResult', views: [] });
        }
    }, MODULE);

    router.register('saveFilterView', (message, _sourcePanelId) => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { saveFilterView, loadSavedFilterViews } = require('../core/savedViews/filterViews');
            saveFilterView(workspaceRoot, (message as any).view);
            const views = loadSavedFilterViews(workspaceRoot);
            if (wsBridge) wsBridge.broadcast({ type: 'savedFilterViewsResult', views });
        } catch (err: any) {
            outputChannel.appendLine(`[saveFilterView] failed: ${err?.message ?? err}`);
        }
    }, MODULE);

    router.register('deleteFilterView', (message, _sourcePanelId) => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { deleteFilterView, loadSavedFilterViews } = require('../core/savedViews/filterViews');
            deleteFilterView(workspaceRoot, (message as any).id);
            const views = loadSavedFilterViews(workspaceRoot);
            if (wsBridge) wsBridge.broadcast({ type: 'savedFilterViewsResult', views });
        } catch (err: any) {
            outputChannel.appendLine(`[deleteFilterView] failed: ${err?.message ?? err}`);
        }
    }, MODULE);
}
