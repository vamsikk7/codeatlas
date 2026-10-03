/**
 * exportHandlers.ts — Issue #358 Row 5 (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * two API-collection format-converters that ship with the API Testing
 * workbench:
 *
 *   - exportApiCollection  → Postman / Hoppscotch / Insomnia (#604)
 *   - importApiCollection  → OpenAPI / Postman / Insomnia (#745)
 *
 * Despite the file name, the wider archive-format export (markdown
 * architecture docs, comments markdown, etc.) lives behind dedicated
 * commands registered through `registerCommands`, NOT through the
 * message router — so it stays where it is. This module is specifically
 * about the webview's "Import / Export" buttons in the API Testing panel.
 *
 * Mechanical extraction — NO behavior change.
 */

import type { OutputChannel } from 'vscode';
import type { PanelManager } from '../views/webview/panelManager';
import type { WsBridge } from '../server/wsBridge';
import type { SnapshotStore } from '../core/storage/snapshotStore';
import type { MessageRouter } from './oauth2Handlers';

export interface ExportHandlerDeps {
    panelManager: PanelManager;
    wsBridge: WsBridge | undefined;
    outputChannel: OutputChannel;
    snapshotStore: SnapshotStore;
}

const MODULE = 'ApiTestingHandlers';

export function registerExportHandlers(router: MessageRouter, deps: ExportHandlerDeps): void {
    const { panelManager, wsBridge, outputChannel, snapshotStore } = deps;

    const replyFor = (sourcePanelId: string) => (payload: any): void => {
        if (sourcePanelId.startsWith('ws:') && wsBridge) wsBridge.sendTo(sourcePanelId.slice(3), payload);
        else panelManager.sendToPanel(sourcePanelId, payload);
    };

    // #604 (2026-06-06) — collection exporter. Webview posts a format;
    // server formats the in-memory `ApiTestingPayload` and ships back
    // the spec body + suggested filename so the webview can trigger a
    // download via blob URL.
    router.register('exportApiCollection', (message, sourcePanelId) => {
        const requestId = ((message as any).requestId as string | undefined) ?? `export-${Date.now()}`;
        const format = (message as any).format as 'postman' | 'hoppscotch' | 'insomnia';
        const reply = replyFor(sourcePanelId);
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { buildApiTestingPayload } = require('../core/apiTesting/buildFromApiRecord');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { exportApiCollection } = require('../core/apiTesting/exporters');
            const apiPayload = buildApiTestingPayload(snapshotStore.getWorking());
            const result = exportApiCollection(apiPayload, format);
            reply({ type: 'exportApiCollectionResult', requestId, ...result });
        } catch (err: any) {
            outputChannel.appendLine(`[exportApiCollection] failed: ${err?.message ?? err}`);
            reply({ type: 'exportApiCollectionResult', requestId, error: err?.message ?? String(err) });
        }
    }, MODULE);

    // #745 (2026-06-05) — API collection importer (OpenAPI / Postman /
    // Insomnia). Webview posts the raw spec (parsed JSON or raw text);
    // server detects format + dispatches to the relevant importer; reply
    // ships back an `ApiTestingPayload` chunk the webview merges into the
    // existing collection list.
    router.register('importApiCollection', (message, sourcePanelId) => {
        const requestId = ((message as any).requestId as string | undefined) ?? `import-${Date.now()}`;
        const reply = replyFor(sourcePanelId);
        try {
            const raw = (message as any).spec ?? (message as any).specText;
            let parsed: unknown = raw;
            if (typeof raw === 'string') {
                try { parsed = JSON.parse(raw); }
                catch (e: any) {
                    reply({ type: 'importApiCollectionResult', requestId, error: `Spec is not valid JSON: ${e?.message ?? e}` });
                    return;
                }
            }
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { importApiCollection } = require('../core/apiTesting/importers');
            const result = importApiCollection(parsed);
            if (!result) {
                reply({ type: 'importApiCollectionResult', requestId, error: 'Spec format not recognised. Expected OpenAPI 3.x / Swagger 2.0 / Postman v2.1 / Insomnia v4.' });
                return;
            }
            reply({ type: 'importApiCollectionResult', requestId, payload: result.payload, format: result.format });
        } catch (err: any) {
            outputChannel.appendLine(`[importApiCollection] failed: ${err?.message ?? err}`);
            reply({ type: 'importApiCollectionResult', requestId, error: err?.message ?? String(err) });
        }
    }, MODULE);
}
