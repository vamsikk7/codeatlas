/**
 * wsSseHandlers.ts — Issue #358 Row 2 (2026-06-07).
 *
 * Extracted from `src/extension.ts` to shrink the god module. Owns the
 * two real-time client router-handler blocks shipped under #745
 * (2026-06-06):
 *
 *   - wsConnect    → connectWebSocket    (replies with wsConnectResult)
 *   - sseConnect   → streamSse           (replies with sseStreamResult)
 *
 * Mechanical extraction — NO behavior change. Same router registration
 * shape, same reply-routing convention (`ws:`-prefixed panel ids go
 * through `wsBridge.sendTo`, others through `panelManager.sendToPanel`),
 * same error-handling pattern.
 *
 * Wire by calling `registerWsSseHandlers(router, deps)` from
 * `extension.ts::activate`.
 */

import type { OutputChannel } from 'vscode';
import type { PanelManager } from '../views/webview/panelManager';
import type { WsBridge } from '../server/wsBridge';
import type { MessageRouter, Oauth2HandlerDeps } from './oauth2Handlers';

/** Re-use the same dependency bag shape — the two clients need the same routing surfaces. */
export type WsSseHandlerDeps = Oauth2HandlerDeps;

const MODULE = 'ApiTestingHandlers';

export function registerWsSseHandlers(router: MessageRouter, deps: WsSseHandlerDeps): void {
    const { panelManager, wsBridge, outputChannel } = deps;

    // #745 (2026-06-06) — WebSocket client. Dispatch to the
    // server-side `connectWebSocket`; reply with the captured frames
    // + end reason in `wsConnectResult`.
    router.register('wsConnect', async (message, sourcePanelId) => {
        const requestId = ((message as any).requestId as string | undefined) ?? `ws-${Date.now()}`;
        const reply = (payload: any): void => {
            if (sourcePanelId.startsWith('ws:') && wsBridge) wsBridge.sendTo(sourcePanelId.slice(3), payload);
            else panelManager.sendToPanel(sourcePanelId, payload);
        };
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { connectWebSocket } = require('../core/apiTesting/ws');
            const result = await connectWebSocket({
                url: (message as any).url,
                sendMessages: (message as any).sendMessages,
                maxMessages: (message as any).maxMessages,
                allowPrivateHosts: true, // #887 — user-initiated workbench connect
            });
            if (result.error) reply({ type: 'wsConnectResult', requestId, error: result.error });
            else reply({ type: 'wsConnectResult', requestId, result });
        } catch (err: any) {
            outputChannel.appendLine(`[wsConnect] failed: ${err?.message ?? err}`);
            reply({ type: 'wsConnectResult', requestId, error: err?.message ?? String(err) });
        }
    }, MODULE);

    // #745 (2026-06-06) — SSE stream. Dispatch to `streamSse`; reply
    // with the captured events + end reason in `sseStreamResult`.
    router.register('sseConnect', async (message, sourcePanelId) => {
        const requestId = ((message as any).requestId as string | undefined) ?? `sse-${Date.now()}`;
        const reply = (payload: any): void => {
            if (sourcePanelId.startsWith('ws:') && wsBridge) wsBridge.sendTo(sourcePanelId.slice(3), payload);
            else panelManager.sendToPanel(sourcePanelId, payload);
        };
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { streamSse } = require('../core/apiTesting/sse');
            const result = await streamSse({
                url: (message as any).url,
                bearerToken: (message as any).bearerToken,
                maxEvents: (message as any).maxEvents,
                allowPrivateHosts: true, // #887 — user-initiated workbench connect
            });
            if (result.error) reply({ type: 'sseStreamResult', requestId, error: result.error });
            else reply({ type: 'sseStreamResult', requestId, result });
        } catch (err: any) {
            outputChannel.appendLine(`[sseConnect] failed: ${err?.message ?? err}`);
            reply({ type: 'sseStreamResult', requestId, error: err?.message ?? String(err) });
        }
    }, MODULE);
}
