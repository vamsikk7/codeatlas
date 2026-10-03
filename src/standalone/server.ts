/**
 * server.ts — `--browser` mode orchestrator for the standalone npm package.
 *
 * Called from `mcp-server.ts` when the user passes `--browser`. Owns:
 *   - WsBridge HTTP + WS server (serves webview-ui assets)
 *   - chokidar file watcher (feeds SyncOrchestrator.handleFileSave)
 *   - Standalone message handler (responds to browser → server messages)
 *
 * The standalone re-uses the same SnapshotStore + SyncOrchestrator the MCP
 * stdio side already built via WorkspaceBootstrap. We just hook the browser
 * UI to that state.
 *
 * INVARIANT: every log line goes to stderr so MCP's stdio JSON-RPC channel
 * on stdout stays clean.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WsBridge } from '../server/wsBridge';
import { CommentStore } from '../core/storage/commentStore';
import type { SnapshotStore } from '../core/storage/snapshotStore';
import { startStandaloneFileWatcher, type StandaloneFileWatcher } from './fileWatcher';
import { createStandaloneMessageHandler } from './messageHandler';
import { createSettingsResolver, type SettingsResolver } from './settings';
import { createSecretsStore, type SecretsStore } from './secrets';
import { StandaloneClerkAuth } from './clerkAuth';
import { workspaceAuthFields } from '../lib/browserAuthGate';

// Clerk publishable key + dashboard auth bridge — same values as the VS Code
// extension so the standalone browser view logs into the same account.
const CLERK_PUBLISHABLE_KEY = 'pk_live_Y2xlcmsuY29kZWF0bGFzLmxpdmUk';
import type { DiagramGraph } from '../core/graph/graphTypes';
import { isHeadlineApiRecord } from '../core/graph/entryPointCounts';
import { PrWatcher, createFileLedger, listOpenPrsGithub } from '../core/review/prWatcher';
import { reviewPrInClone } from '../core/review/prCloneRunner';
import { getGithubRemote } from '../core/git/githubReader';

export interface StandaloneServerOptions {
    workspaceRoot: string;
    snapshotStore: SnapshotStore;
    /**
     * `dist/` directory inside the installed npm package — the build script
     * copies webview-ui/dist/ to `<distDir>/webview-ui/dist/`, which is what
     * WsBridge serves. Pass `path.dirname(__filename)` from the entry point.
     */
    distDir: string;
    port?: number;
    /** Whether to attempt to auto-open the user's browser. Default false. */
    autoOpen?: boolean;
    /** Stderr logger. */
    log?: (msg: string) => void;
    /**
     * Optional `handleFileSave` callback for the file watcher. When the
     * caller passes a SyncOrchestrator, pass `(fp) => orchestrator.handleFileSave(fp)`.
     * When omitted, file changes are logged but no rebuild happens — useful
     * for tests + read-only mode.
     */
    handleFileSave?: (filePath: string) => void | Promise<unknown>;
    handleFileCreated?: (filePath: string) => void | Promise<unknown>;
    handleFileDeleted?: (filePath: string) => void | Promise<unknown>;
    handleGitRefChange?: () => void | Promise<unknown>;
    /**
     * Version string of the MCP standalone bundle (`mcp-package/package.json`).
     * Surfaced to the browser via the `workspaceInfo.mcpServerVersion`
     * broadcast so end users can see which standalone is serving them —
     * the webview-ui title shows the EXTENSION version (`webview-ui/vite.config.ts`
     * reads `../package.json` for its build defines), which is unrelated
     * to the MCP version. Set this from `mcp-server.ts` using the
     * `MCP_SERVER_VERSION` esbuild define. Optional — leave undefined when
     * starting the standalone from the VS Code extension host.
     */
    mcpServerVersion?: string;
    /**
     * #815 (2026-06-10) — multi-repo plumbing for MCP standalone.
     * When set, `WorkspaceBootstrap.openMultiRepo` has detected ≥2 sub-
     * repos and the messageHandler should set `wsInfo.isMultiRepo=true`
     * + iterate `perRepoStores` for explorerData aggregation + take the
     * per-sub-repo `buildMicroserviceGraph` / `map:workspace` rebuild
     * path inside `requestRoute`. Without these the MCP browser surface
     * stays in single-primary-repo mode regardless of the underlying
     * aggregator.
     */
    multiRepo?: {
        aggregator: unknown;
        perRepoStores: Map<string, SnapshotStore>;
        repos: ReadonlyArray<{ repoId: string; name: string; rootPath: string }>;
    };
}

export interface StandaloneServer {
    /** The actual port WsBridge bound to (may differ from `port` if it was busy). */
    port: number;
    /** Stop the server + watcher cleanly. Safe to call multiple times. */
    stop: () => Promise<void>;
    /** Settings resolver — exposed for `--print-config` debugging. */
    settings: SettingsResolver;
    /** Secrets store — exposed for `--set-api-key` subcommand. */
    secrets: SecretsStore;
    /**
     * Tell connected browser clients that the snapshot rebuilt after a file
     * change. The browser re-fetches the graphs it has open. Called by the
     * MCP-side file-watcher hook after `bootstrap.handleFileChange`.
     *
     * Currently broadcasts a single `workspaceInfo` (refreshed counts) +
     * `cascadeRefresh` ping with the changed file. The browser side reacts
     * by re-requesting whichever graph it's currently displaying.
     */
    notifyRefresh: (changedFilePath: string) => void;
    /**
     * #817 (2026-06-11) — raw broadcast to every connected browser client.
     * Used by the MCP entry point to wire the cross-repo push scheduler's
     * `crossRepoEdgeChanged` payloads onto the same wire the extension uses.
     */
    broadcast: (msg: unknown) => void;
}

/**
 * Start a standalone browser server. Returns a handle the entry point uses
 * on SIGINT / SIGTERM to shut down cleanly.
 */
export async function startStandaloneServer(opts: StandaloneServerOptions): Promise<StandaloneServer> {
    const log = opts.log ?? defaultStderrLogger;
    const settings = createSettingsResolver({ workspaceRoot: opts.workspaceRoot });
    const secrets = createSecretsStore({ log });

    const port = opts.port ?? settings.get<number>('codeatlas.browserPort');
    const ignore = settings.get<string[]>('codeatlas.ignore');

    // CommentStore is pure JS — owned by the standalone server, not the
    // extension. v1 doesn't persist (comments live in memory); v1.1 wires
    // the store to .codeatlas-sa/state.db like the extension does.
    const commentStore = new CommentStore();

    // Build the message handler before WsBridge so we can pass it as the
    // message callback. WsBridge calls back into handler.handle on every
    // browser-to-server WS frame.
    let wsBridge: WsBridge | undefined;
    // #851 — PR watcher, late-bound: constructed after wsBridge exists (its
    // onStatus hook broadcasts through it). The thunk lets the message
    // handler reach the eventual instance.
    let prWatcher: PrWatcher | undefined;
    const prWatcherThunk = () => prWatcher;
    // Clerk auth for the browser view: verifies the dashboard's /auth/callback
    // token and persists the session to ~/.codeatlas/session.json.
    const auth = new StandaloneClerkAuth(CLERK_PUBLISHABLE_KEY, log);
    // Re-verify the stored session once at startup (parity with the extension's
    // activation check) so a token that no longer verifies past the 24h cache
    // self-clears instead of showing "signed in" forever. Fire-and-forget: a
    // fresh standalone process connects its first tab seconds later.
    void auth.checkAuth();

    // Shared workspaceInfo builder — used by BOTH the file-save cascade AND the
    // /auth/callback success path, so the sign-in chip + home-screen counts stay
    // correct. Previously the cascade path hardcoded `isAuthenticated:false`,
    // flipping a signed-in user's chip back to "Sign in" on every file save; and
    // a successful login was never re-broadcast to already-open tabs.
    const buildWorkspaceInfoMsg = () => {
        const working = opts.snapshotStore.getWorking();
        const graphIds = Object.keys(working.graphs ?? {});
        const authUser = auth.getUser();
        return {
            type: 'workspaceInfo' as const,
            name: require('path').basename(opts.workspaceRoot),
            workspaceRoot: opts.workspaceRoot,
            fileCount: Object.keys(working.files ?? {}).length,
            apiCount: Object.values(working.apiIndex ?? {}).filter(isHeadlineApiRecord).length,
            serviceCount: Object.keys(working.services ?? {}).length,
            clusterCount: Object.keys(working.clusters ?? {}).length,
            screenCount: Object.keys(working.screens ?? {}).length,
            fileGraphCount: graphIds.filter((id) => id.startsWith('file:')).length,
            flowGraphCount: graphIds.filter((id) => id.startsWith('flow:')).length,
            sequenceGraphCount: graphIds.filter((id) => id.startsWith('sequence:')).length,
            initialized: true,
            ...workspaceAuthFields(authUser),
            hasGitRemote: false,
            gitHubConnected: false,
            editorUriScheme: 'vscode',
            extensionId: 'codeatlas.standalone',
            mcpServerVersion: opts.mcpServerVersion ?? null,
            llmProvider: settings.get<string>('codeatlas.llmProvider'),
            llmModel: settings.get<string>('codeatlas.llmModel'),
            llmEndpoint: settings.get<string>('codeatlas.llmEndpoint'),
        };
    };

    const handlerRef = createStandaloneMessageHandler({
        snapshotStore: opts.snapshotStore,
        commentStore,
        wsBridge: undefined as unknown as WsBridge, // patched below
        workspaceRoot: opts.workspaceRoot,
        log,
        settings,
        secrets,
        auth,
        mcpServerVersion: opts.mcpServerVersion,
        multiRepo: opts.multiRepo,
        prWatcher: prWatcherThunk,
    });

    wsBridge = new WsBridge({
        port,
        extensionPath: opts.distDir,
        messageHandler: (msg, clientId) => {
            void handlerRef.handle(msg, clientId);
        },
        getInitialData: () => pickInitialNavigationData(opts.snapshotStore),
        // Verify + persist the session when the dashboard redirects back here,
        // then re-broadcast workspaceInfo so ALL open tabs (not just the redirected
        // one) flip to the signed-in chip.
        onAuthCallback: async (payload) => {
            const ok = await auth.handleAuthCallback(payload);
            if (ok) { try { wsBridge?.broadcast(buildWorkspaceInfoMsg()); } catch { /* bridge down */ } }
            return ok;
        },
        log,
    });

    // Patch the handler's wsBridge ref now that the instance exists.
    (handlerRef as any).wsBridge = wsBridge;
    // Repoint the message handler's deps to the real wsBridge so broadcasts
    // reach connected clients. (The closure captured a stub above.)
    rebindHandlerWsBridge(handlerRef, wsBridge, opts.snapshotStore, commentStore, opts.workspaceRoot, log, settings, secrets, opts.mcpServerVersion, opts.multiRepo, prWatcherThunk, auth);

    const actualPort = await wsBridge.start();
    log(`[standalone] webview-ui served at http://localhost:${actualPort}`);

    // #851 — PR watcher (reviews open GitHub PRs in a tmp clone, posts the
    // ADR-044 review). OFF by default; the HomePage card toggles it and the
    // setting persists across restarts.
    prWatcher = new PrWatcher({
        repoSlug: () => {
            const r = getGithubRemote(opts.workspaceRoot);
            return r ? `${r.owner}/${r.repo}` : null;
        },
        getToken: () => secrets.get('codeatlas.githubToken'),
        hasLlmKey: async () => {
            const provider = settings.get<string>('codeatlas.llmProvider') || 'openrouter';
            if (provider === 'ollama' || provider === 'custom') return true;
            return Boolean(await secrets.get('codeatlas.openRouterApiKey'));
        },
        listOpenPrs: (slug, token) => listOpenPrsGithub(slug, token),
        reviewPr: (pr, ctx) => reviewPrInClone(pr, ctx, {
            repoPath: opts.workspaceRoot,
            log,
            // The clone has no `.codeatlas-sa/config.json` (unversioned), so
            // forward this workspace's LLM config + key as env overrides.
            reviewEnv: async () => ({
                OPENROUTER_API_KEY: (await secrets.get('codeatlas.openRouterApiKey')) || undefined,
                CODEATLAS_LLM_PROVIDER: settings.get<string>('codeatlas.llmProvider') || undefined,
                CODEATLAS_LLM_MODEL: settings.get<string>('codeatlas.llmModel') || undefined,
                CODEATLAS_LLM_ENDPOINT: settings.get<string>('codeatlas.llmEndpoint') || undefined,
            }),
            // #853 — guidelines live in this workspace's store; the clone's
            // store starts empty.
            guidelinesText: async () => {
                try { return opts.snapshotStore.getReviewGuidelines().text || undefined; } catch { return undefined; }
            },
        }),
        ledger: createFileLedger(path.join(opts.workspaceRoot, '.codeatlas-sa', 'pr-watcher.json')),
        intervalMs: (settings.get<number>('codeatlas.prWatcherIntervalMin') ?? 5) * 60_000,
        log,
        onStatus: (status) => {
            try { wsBridge?.broadcast({ type: 'prWatcherStatus', status }); } catch { /* bridge down */ }
        },
    });
    if (settings.get<boolean>('codeatlas.prWatcherEnabled') === true) {
        prWatcher.start();
    }

    // chokidar file watcher (skips ignored patterns the user configured)
    let watcher: StandaloneFileWatcher | undefined;
    const autoUpdate = settings.get<boolean>('codeatlas.autoUpdateOnSave');
    if (autoUpdate) {
        watcher = await startStandaloneFileWatcher({
            workspaceRoot: opts.workspaceRoot,
            ignore,
            callbacks: {
                handleFileSave: opts.handleFileSave,
                handleFileCreated: opts.handleFileCreated,
                handleFileDeleted: opts.handleFileDeleted,
                handleGitRefChange: opts.handleGitRefChange,
            },
            log,
        });
    } else {
        log('[standalone] codeatlas.autoUpdateOnSave is false — file watcher disabled');
    }

    if (opts.autoOpen) {
        tryOpenBrowser(`http://localhost:${actualPort}`, log);
    }

    let stopped = false;
    return {
        port: actualPort,
        settings,
        secrets,
        async stop() {
            if (stopped) return;
            stopped = true;
            try { prWatcher?.stop(); } catch { /* ignore */ }
            try { await watcher?.stop(); } catch { /* ignore */ }
            try { await wsBridge?.stop(); } catch { /* ignore */ }
            log('[standalone] server stopped');
        },
        broadcast(msg: unknown) {
            try { wsBridge?.broadcast(msg as any); } catch { /* bridge down */ }
        },
        notifyRefresh(changedFilePath: string) {
            // Re-broadcast workspaceInfo so home-screen counts + the saved LLM
            // config keep surfacing after a cascade — AND the signed-in chip stays
            // correct (the shared builder carries the real auth fields; this path
            // used to hardcode isAuthenticated:false, flipping a logged-in user's
            // chip to "Sign in" on every save).
            wsBridge?.broadcast(buildWorkspaceInfoMsg());
            // The cascade ping lets the browser refresh the currently-displayed
            // graph. The webview's hashchange handler will re-fetch.
            wsBridge?.broadcast({ type: 'cascadeRefresh', changedFilePath });
        },
    };
}

/**
 * Pick an initial graph for new browser tabs (mirrors WsBridge's
 * `getInitialData` callback contract). Order: microservice:workspace →
 * feature:workspace → any feature → any graph → null.
 */
function pickInitialNavigationData(
    store: SnapshotStore,
): { graphId: string; mode: string; graph: any; label: string } | null {
    const w = store.getWorking();
    const candidates: string[] = [
        'microservice:workspace',
        'feature:workspace',
    ];
    for (const id of candidates) {
        const g = (w.graphs as Record<string, DiagramGraph>)[id];
        if (g) return { graphId: id, mode: g.type, graph: g, label: id };
    }
    const first = Object.values(w.graphs).find(Boolean) as DiagramGraph | undefined;
    if (first) return { graphId: first.graphId, mode: first.type, graph: first, label: first.graphId };
    return null;
}

function defaultStderrLogger(msg: string): void {
    process.stderr.write(`${msg}\n`);
}

/**
 * Best-effort cross-platform browser launch. Resolves to `void` even on
 * failure — the URL is already in stderr, the user can open it manually.
 */
function tryOpenBrowser(url: string, log: (msg: string) => void): void {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const platform = os.platform();
    let cmd = 'xdg-open', args = [url];
    if (platform === 'darwin') { cmd = 'open'; args = [url]; }
    else if (platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
    try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.on('error', (err: any) => log(`[standalone] couldn't open browser via ${cmd}: ${err?.message ?? err}`));
        try { child.unref(); } catch { /* noop */ }
    } catch (err: any) {
        log(`[standalone] open-browser failed: ${err?.message ?? err}`);
    }
}

/**
 * The message handler captured `wsBridge: undefined` in its closure since
 * the bridge is constructed after the handler. Tear down + rebuild the
 * handler with the real bridge so broadcasts reach the wire. Returns
 * nothing; mutates `handler.handle` in place via a swap.
 */
function rebindHandlerWsBridge(
    handler: ReturnType<typeof createStandaloneMessageHandler>,
    wsBridge: WsBridge,
    snapshotStore: SnapshotStore,
    commentStore: CommentStore,
    workspaceRoot: string,
    log: (msg: string) => void,
    settings: SettingsResolver,
    secrets: SecretsStore,
    mcpServerVersion?: string,
    multiRepo?: StandaloneServerOptions['multiRepo'],
    prWatcher?: () => PrWatcher | undefined,
    auth?: StandaloneClerkAuth,
): void {
    const fresh = createStandaloneMessageHandler({
        snapshotStore, commentStore, wsBridge, workspaceRoot, log, settings, secrets, auth,
        mcpServerVersion, multiRepo, prWatcher,
    });
    (handler as any).handle = fresh.handle;
}

/**
 * Discover the install dir of the standalone package. Used to locate
 * `webview-ui/dist/` for WsBridge. Falls back to the dir containing the
 * caller's filename.
 *
 * @param callerFilename Pass `__filename` from your entry point.
 */
export function resolveDistDir(callerFilename: string, fileExists: (p: string) => boolean = fs.existsSync): string {
    // The packaged `mcp-server.js` lives at `<pkg>/dist/mcp-server.js` with the
    // webview assets copied to `<pkg>/dist/webview-ui/dist/`. WsBridge joins
    // `<extensionPath>/webview-ui/dist/`, so extensionPath must be the dir that
    // CONTAINS `webview-ui/dist/index.html`.
    const dir = path.dirname(callerFilename);
    const hasAssets = (d: string) => fileExists(path.join(d, 'webview-ui', 'dist', 'index.html'));
    // #860 — the raw in-repo build (`dist/mcp-server.js`) does NOT have the
    // webview copied next to it; the webview is built to `<repo>/webview-ui/dist`.
    // Without this fallback, `--browser` served the SPA shell but 404'd every
    // asset, leaving the page stuck on "Connecting to CodeAtlas…". Try the
    // co-located dir (packaged) first, then the repo root one level up.
    const candidates = [dir, path.dirname(dir)];
    for (const c of candidates) {
        if (hasAssets(c)) return c;
    }
    process.stderr.write(
        `[standalone] WARNING: webview-ui/dist/index.html not found near ${dir} ` +
        `(tried ${candidates.join(', ')}) — the browser surface will 404 its assets.\n`,
    );
    return dir;
}
