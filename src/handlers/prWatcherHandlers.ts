/**
 * prWatcherHandlers.ts — #851 (2026-06-12, ADR-045).
 *
 * Extension-side (VSIX) handlers for the PR watcher HomePage card — parity
 * with the standalone messageHandler cases. The watcher itself broadcasts
 * `prWatcherStatus` on every state change via its onStatus hook; these
 * cover the explicit status request and persist the toggle in
 * workspaceState so it survives reloads per repo.
 */
import type { HandlerContext, MessageHandler } from './handlerContext';
import { analytics } from '../analytics/mixpanelService';

export function registerPrWatcherHandlers(
    register: (messageType: string, handler: MessageHandler, module: string) => void,
    ctx: HandlerContext,
): void {
    const MODULE = 'PrWatcherHandlers';
    if (!ctx.context) return; // extension-only — standalone has its own cases

    const broadcast = (msg: any): void => ctx.platform.broadcast(msg);

    register('getPrWatcherStatus', () => {
        (async () => {
            const watcher = ctx.prWatcher?.();
            if (!watcher) { broadcast({ type: 'prWatcherStatus', status: null }); return; }
            broadcast({ type: 'prWatcherStatus', status: await watcher.refreshPrereqs() });
        })().catch(() => { /* status fetch is best-effort */ });
    }, MODULE);

    register('setPrWatcherEnabled', (message) => {
        (async () => {
            const watcher = ctx.prWatcher?.();
            if (!watcher) return;
            const desired = message.enabled === true;
            await ctx.context!.workspaceState.update('codeatlas.prWatcherEnabled', desired);
            if (desired) watcher.start(); else watcher.stop();
            broadcast({ type: 'prWatcherStatus', status: await watcher.refreshPrereqs() });
            broadcast({
                type: 'showNotification',
                level: 'info',
                message: desired
                    ? 'PR watcher ON — open PRs on this repo will be reviewed and commented automatically.'
                    : 'PR watcher OFF — no more automatic PR reviews.',
            });
            analytics.track('pr_watcher_toggled', { enabled: desired });
        })().catch((err: any) => {
            ctx.outputChannel?.appendLine(`[pr-watcher] toggle failed: ${err?.message ?? err}`);
        });
    }, MODULE);
}
