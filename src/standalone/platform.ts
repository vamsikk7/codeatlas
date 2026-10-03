/**
 * platform.ts — standalone implementation of the shared `PlatformAdapter`.
 *
 * #547: handler modules under `src/handlers/` use `ctx.platform.*` so the
 * same code path serves both the VS Code extension (panelManager + VS Code
 * SecretStorage) and the standalone WS server (wsBridge + file-backed
 * SecretsStore). Reveal-in-sidebar methods are no-op on standalone since
 * there's no sidebar UI.
 */

import type { WsBridge } from '../server/wsBridge';
import type { PlatformAdapter } from '../handlers/handlerContext';
import type { SecretsStore } from './secrets';
import type { SettingsResolver } from './settings';

export interface StandalonePlatformDeps {
    wsBridge: WsBridge;
    secrets: SecretsStore;
    /**
     * Optional settings resolver. Required for handlers that need to read
     * or write `codeatlas.*` settings (evidence gate, LLM provider, etc.).
     * When omitted, `getSetting` always returns the supplied default and
     * `setSetting` is a no-op.
     */
    settings?: SettingsResolver;
    log?: (msg: string) => void;
}

/**
 * Build a `PlatformAdapter` backed by the standalone WS bridge + file
 * secrets store. Broadcasts target every connected browser tab; updates
 * to a single graph go through a typed `updateGraph` envelope the webview
 * already understands. Sidebar reveal is a no-op (no sidebar in the
 * browser SPA).
 */
export function createStandalonePlatform(deps: StandalonePlatformDeps): PlatformAdapter {
    const { wsBridge, secrets, settings } = deps;
    return {
        broadcast: (msg) => {
            if (wsBridge?.hasClients?.()) wsBridge.broadcast(msg);
        },
        updateGraph: (graphId, graph) => {
            if (wsBridge?.hasClients?.()) {
                wsBridge.broadcast({ type: 'updateGraph', graphId, graph });
            }
        },
        getSecret: (key) => secrets.get(key),
        setSecret: (key, value) => secrets.store(key, value),
        // #547 round 4: settings adapter. Routes through the standalone's
        // SettingsResolver (env override → file → default). When no
        // SettingsResolver is wired, returns the default unchanged.
        getSetting: <T,>(key: string, defaultValue?: T): T | undefined => {
            // Accept either the fully-qualified key ('codeatlas.foo') or
            // the bare suffix; the SettingsResolver works with the full key.
            const k = key.startsWith('codeatlas.') ? key : `codeatlas.${key}`;
            if (!settings) return defaultValue;
            const v = settings.get<T>(k);
            return v === undefined ? defaultValue : v;
        },
        setSetting: async <T,>(key: string, value: T): Promise<void> => {
            const k = key.startsWith('codeatlas.') ? key : `codeatlas.${key}`;
            if (!settings) return;
            settings.set(k, value);
        },
        // Sidebar reveals are extension-only; standalone has no sidebar UI.
        refreshSidebar: () => undefined,
        revealApi: () => undefined,
        revealService: () => undefined,
        revealCluster: () => undefined,
    };
}
