/**
 * toolHandlers.ts
 *
 * Issues #173, #174, #194: Tool/utility message handlers extracted from extension.ts.
 * Handles requestImpact, fileSelectedForImpact, edgeClicked, toggleTheme,
 * setLlmConfig, and runCommand (browser-mode VS Code command router).
 *
 * runCommand is the largest handler — it routes allowed VS Code commands from
 * browser clients, with special-case intercepts for commands that need
 * browser-native alternatives (search picker, function picker, file downloads, etc.).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { HandlerContext, MessageHandler } from './handlerContext';
import { withErrorHandling } from './handlerContext';
import { safeResolve } from '../core/navigation/pathValidator';
import { analyzeImpact } from '../core/analysis/impactAnalyzer';
import { exportArchitectureDocs } from '../core/export/markdownExporter';
import { buildWorkspaceApiListGraph } from '../core/graph/workspaceApiListBuilder';
import { openFunctionFlowInPanel } from './navigationHandlers';
import { analytics } from '../analytics/mixpanelService';
import { probeLlmConnection } from './llmConnectionProbe';
import { listCommits, listBranches, mergeBase } from '../core/git/gitReader';

/**
 * Register all tool/utility message handlers with the message router.
 *
 * @param register - Function to register a (messageType, handler, module) triple
 * @param ctx - Shared handler context
 */
export function registerToolHandlers(
    register: (messageType: string, handler: MessageHandler, module: string) => void,
    ctx: HandlerContext,
): void {
    const MODULE = 'ToolHandlers';
    // #547: every handler here uses VS Code-only surfaces — `vscode.commands`,
    // `vscode.window`, `ctx.panelManager.sendToPanel`, `ctx.context.secrets`,
    // SourceNavigator. The standalone implements parity for these via its
    // own switch (`runCommand`, `setLlmConfig`, `fileSelectedForImpact`,
    // etc.). Skip registration off-extension so we don't crash trying to
    // call missing VS Code APIs.
    if (!ctx.context) return;

    /** Broadcast via the cross-runtime platform adapter. */
    function broadcast(msg: any): void {
        ctx.platform.broadcast(msg);
    }

    /**
     * #912 — resolve the per-repo store for a `repoId` hint (registry id or
     * name), falling back to the workspace store. Mirrors the per-repo
     * resolution in requestRegressionScope so Impact + Export scope to the
     * picked sub-repo in multi-repo workspaces (parity with the standalone
     * messageHandler's resolveRepoStore by construction).
     */
    function resolveRepoStore(repoId?: unknown): { store: any; repoName: string } {
        let store: any = ctx.snapshotStore;
        let repoName = path.basename(ctx.workspaceRoot);
        const hint = repoId == null ? '' : String(repoId);
        if (hint && ctx.aggregatorStore && ctx.repoStoreRegistry) {
            const row = [...ctx.aggregatorStore.listRepos()].find(
                (r: any) => r.name === hint || r.repoId === hint,
            );
            if (row) {
                const abs = path.isAbsolute(row.rootPath) ? row.rootPath : path.join(ctx.workspaceRoot, row.rootPath);
                store = ctx.repoStoreRegistry.getRepoStore(abs) ?? ctx.snapshotStore;
                repoName = row.name;
            }
        }
        return { store, repoName };
    }

    // ── requestImpact ─────────────────────────────────────────────────────────
    register('requestImpact', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'requestImpact', async () => {
            // #912 — scope to the picked sub-repo's store when `repoId` is set.
            const working = resolveRepoStore((message as any).repoId).store.getWorking();
            const impact = analyzeImpact([message.filePath], working);
            analytics.track('impact_analysis_requested', {
                source: 'context_menu',
                file_path: String(message.filePath ?? '').slice(0, 200),
                impacted_count: impact.impactedFunctions?.length ?? 0,
            });
            // Clear previous highlights across all panels before sending new ones
            broadcast({ type: 'clearHighlights' });
            // Send full result to the panel containing the right-clicked node
            // (home-card path supplies no nodeId — it's a browser WS client and
            // gets the result via the ws: branch below).
            if (message.nodeId) ctx.panelManager!.sendToPanel(message.nodeId, { type: 'showImpact', impact });
            // For browser clients, send impact directly via wsBridge
            if (sourcePanelId.startsWith('ws:') && ctx.wsBridge) {
                ctx.wsBridge.sendTo(sourcePanelId.slice(3), { type: 'showImpact', impact });
            }
            // Broadcast node highlights to all open panels + browser
            const highlights = impact.impactedFunctions.map((f) => ({
                filePath: f.filePath,
                functionName: f.functionName,
                impactKind: f.impactKind,
            }));
            broadcast({ type: 'highlightNodes', highlights });
        });
    }, MODULE);

    // ── fileSelectedForImpact ─────────────────────────────────────────────────
    register('fileSelectedForImpact', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'fileSelectedForImpact', async () => {
            // #912 — per-repo scope when `repoId` present (multi-repo).
            const working = resolveRepoStore((message as any).repoId).store.getWorking();
            const impact = analyzeImpact([message.filePath], working);
            analytics.track('impact_analysis_requested', {
                source: 'file_picker',
                file_path: String(message.filePath ?? '').slice(0, 200),
                impacted_count: impact.impactedFunctions?.length ?? 0,
            });
            broadcast({ type: 'clearHighlights' });
            ctx.panelManager!.sendToPanel(sourcePanelId, { type: 'showImpact', impact });
            const highlights = impact.impactedFunctions.map((f: any) => ({
                filePath: f.filePath,
                functionName: f.functionName,
                impactKind: f.impactKind,
            }));
            broadcast({ type: 'highlightNodes', highlights });
            if (ctx.wsBridge?.hasClients()) {
                ctx.wsBridge.broadcast({ type: 'showImpact', impact });
            }
        });
    }, MODULE);

    // ── requestArchitectureExport (#912) ──────────────────────────────────────
    // Per-repo Markdown + Mermaid export for the browser surface. The home
    // "Export Docs" card (multi-repo) posts this with the picked repoId; we
    // resolve that sub-repo's store and deliver via the shared `downloadFile`
    // path. (Single-repo keeps the runCommand → exportArchitectureDocs path.)
    register('requestArchitectureExport', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'requestArchitectureExport', async () => {
            if (!sourcePanelId.startsWith('ws:') || !ctx.wsBridge) return;
            const { store, repoName } = resolveRepoStore((message as any).repoId);
            const md = exportArchitectureDocs(store.getWorking(), store.getBaseline(), repoName);
            const safeName = repoName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'architecture';
            ctx.wsBridge.sendTo(sourcePanelId.slice(3), {
                type: 'downloadFile',
                filename: `${safeName}-architecture.md`,
                content: md,
                mimeType: 'text/markdown',
            });
            analytics.track('architecture_docs_exported', { scope: (message as any).repoId ? 'per_repo' : 'workspace' });
        });
    }, MODULE);

    // ── #826 — overlay contract (state + data) ────────────────────────────────
    // One OverlayService per workspace; shared payload shapes with the
    // standalone messageHandler + MCP tools by construction.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OverlayService } = require('../core/overlays/overlayService');
    const overlayService = new OverlayService({
        workspaceRoot: ctx.workspaceRoot,
        getWorking: () => ctx.snapshotStore.getWorking(),
        getBaseline: () => ctx.snapshotStore.getBaseline(),
        getFileContent: (fp: string) => ctx.snapshotStore.getFileContent('working', fp),
        log: (m: string) => ctx.log(m),
    });
    /** Resolve a graph for overlay joining: workspace store first, then a
     *  bounded per-repo scan (multi-repo graphs live in per-repo stores). */
    const resolveGraphForOverlay = (graphId: string): any => {
        const direct = ctx.snapshotStore.getWorking().graphs?.[graphId];
        if (direct) return direct;
        if (ctx.aggregatorStore && ctx.repoStoreRegistry) {
            for (const r of [...ctx.aggregatorStore.listRepos()].slice(0, 20)) {
                try {
                    const store: any = ctx.repoStoreRegistry.getRepoStore(path.join(ctx.workspaceRoot, r.rootPath));
                    const g = store?.getWorking?.().graphs?.[graphId];
                    if (g) return g;
                } catch { /* skip repo */ }
            }
        }
        return undefined;
    };
    register('requestOverlayState', (_message, sourcePanelId) => {
        withErrorHandling(ctx, 'requestOverlayState', async () => {
            const msg = overlayService.stateMessage();
            ctx.panelManager!.sendToPanel(sourcePanelId, msg);
            if (sourcePanelId.startsWith('ws:') && ctx.wsBridge) ctx.wsBridge.sendTo(sourcePanelId.slice(3), msg);
        });
    }, MODULE);
    register('setOverlayEnabled', (message) => {
        withErrorHandling(ctx, 'setOverlayEnabled', async () => {
            const msg = overlayService.setEnabled(String(message.overlayId ?? ''), !!message.enabled);
            // Broadcast — chips/panels in every tab mirror the same rows (R2b).
            broadcast(msg);
            if (ctx.wsBridge?.hasClients()) ctx.wsBridge.broadcast(msg);
        });
    }, MODULE);
    register('requestOverlayData', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'requestOverlayData', async () => {
            const overlayId = String(message.overlayId ?? '');
            const graphId = String(message.graphId ?? '');
            const graph = resolveGraphForOverlay(graphId);
            const msg = await overlayService.dataMessage(overlayId, graphId, graph);
            ctx.panelManager!.sendToPanel(sourcePanelId, msg);
            if (sourcePanelId.startsWith('ws:') && ctx.wsBridge) ctx.wsBridge.sendTo(sourcePanelId.slice(3), msg);
        });
    }, MODULE);

    // ── requestRegressionScope (#827) ─────────────────────────────────────────
    // "What should I re-test?" — composes changed entities + blast radius +
    // tests-to-run + untested risk list via the shared core (parity with the
    // standalone handler + MCP get_regression_scope by construction).
    register('requestRegressionScope', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'requestRegressionScope', async () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { computeRegressionScope } = require('../core/analysis/regressionScope');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { loadCoverageData } = require('../core/analysis/coverageReader');
            const repo = typeof message.repo === 'string' && message.repo ? message.repo : undefined;
            let store: any = ctx.snapshotStore;
            let rootForCoverage = ctx.workspaceRoot;
            let repoName = repo;
            if (repo && ctx.aggregatorStore && ctx.repoStoreRegistry) {
                const row = [...ctx.aggregatorStore.listRepos()].find(
                    (r: any) => r.name === repo || r.repoId === repo,
                );
                if (row) {
                    const abs = path.isAbsolute(row.rootPath)
                        ? row.rootPath
                        : path.join(ctx.workspaceRoot, row.rootPath);
                    store = ctx.repoStoreRegistry.getRepoStore(abs);
                    rootForCoverage = abs;
                    repoName = row.name;
                }
            }
            let coverage = null;
            try { coverage = loadCoverageData(rootForCoverage); } catch { /* optional */ }
            // #817.1 — consumer edges via the shared producer-edge helper
            // (pre-filtered + name-resolved; raw rows carry registry ids).
            let crossRepoEdges: any[] = [];
            if (ctx.aggregatorStore && repoName) {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { listCrossRepoEdgesForProducer } = require('../core/analysis/crossRepoHttpAnalyzer');
                    crossRepoEdges = listCrossRepoEdgesForProducer(ctx.aggregatorStore, repoName)
                        .map((e: any) => ({ sourceRepo: e.consumerRepoName, targetRepo: repoName, method: e.method, route: e.route }));
                } catch { /* aggregator optional */ }
            }
            const scope = computeRegressionScope({
                working: store.getWorking(),
                baseline: store.getBaseline(),
                coverage, crossRepoEdges, repoName,
            });
            analytics.track('regression_scope_requested', {
                changed_count: scope.changedEntities.length,
                tests_count: scope.testsToRun.length,
                coverage_available: scope.coverageAvailable,
            });
            const reply = { type: 'regressionScopeData', scope, repo: repo ?? null };
            ctx.panelManager!.sendToPanel(sourcePanelId, reply);
            if (sourcePanelId.startsWith('ws:') && ctx.wsBridge) {
                ctx.wsBridge.sendTo(sourcePanelId.slice(3), reply);
            }
        });
    }, MODULE);

    // ── findCallPath (Issue #707) ─────────────────────────────────────────────
    register('findCallPath', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'findCallPath', async () => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { traceCallPath } = require('../mcp/callPath');
            const fromFile = String(message.fromFile ?? '');
            const fromFn = String(message.fromFn ?? '');
            const toFile = String(message.toFile ?? '');
            const toFn = String(message.toFn ?? '');
            const maxDepth = Math.max(1, Math.min(20, Number(message.maxDepth) || 8));
            if (!fromFile || !fromFn || !toFile || !toFn) return;
            const working = ctx.snapshotStore.getWorking();
            const result = traceCallPath(working, fromFile, fromFn, toFile, toFn, maxDepth);
            analytics.track('path_finder_query', {
                from_file: fromFile.slice(0, 200),
                to_file: toFile.slice(0, 200),
                max_depth: maxDepth,
                path_length: result.path.length,
                visited: result.visited,
                truncated: result.truncated,
            });
            const reply = { type: 'callPathResult' as const, result };
            // Target the originating client when it's a browser WS so we
            // don't broadcast paths to every open tab. Fall back to panel
            // post for VS Code-driven calls.
            if (sourcePanelId.startsWith('ws:') && ctx.wsBridge) {
                ctx.wsBridge.sendTo(sourcePanelId.slice(3), reply);
            } else {
                ctx.panelManager!.sendToPanel(sourcePanelId, reply);
            }
        });
    }, MODULE);

    // ── edgeClicked ───────────────────────────────────────────────────────────
    register('edgeClicked', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'edgeClicked', async () => {
            const anchor = message.anchor;
            if (anchor?.filePath) {
                if (anchor.symbol) {
                    // Navigate to function flow for the called method
                    openFunctionFlowInPanel(ctx, anchor.filePath, anchor.symbol, sourcePanelId);
                } else {
                    // Open the file
                    const resolvedAnchor = safeResolve(ctx.workspaceRoot, anchor.filePath);
                    if (resolvedAnchor) {
                        vscode.window.showTextDocument(vscode.Uri.file(resolvedAnchor));
                    } else {
                        // BUG-L5-UNCLICKABLE: anchor path present but outside the
                        // workspace boundary — don't silently swallow the click.
                        ctx.notifyBrowser('warning', `Can't open ${anchor.filePath} — outside the workspace.`);
                    }
                }
            } else {
                // BUG-L5-UNCLICKABLE: the message/edge carries no resolvable anchor
                // (the callee's module couldn't be mapped to a workspace file), so a
                // drill-to-flow click would otherwise be a silent no-op. Give the
                // user explicit feedback instead of appearing broken.
                ctx.notifyBrowser('info', 'No source location for this message — its target could not be resolved to a file.');
            }
        });
    }, MODULE);

    // ── webview → extension analytics bridge ──────────────────────────────────
    // INVARIANT (ADR-030): the webview never speaks to Amplitude directly.
    // It posts a `webviewAnalytics` message; the extension validates and
    // stamps shared properties (editor context, user_id, machine_id) before
    // calling `analytics.track`. This keeps event attribution consistent
    // and prevents the webview from spoofing user-level fields.
    register('webviewAnalytics', (message) => {
        try {
            const eventName = String(message.event ?? '').slice(0, 60);
            if (!eventName) return;
            // Whitelist namespace prefix so the webview can't fire
            // arbitrary backend-style events. All client events should
            // be prefixed `webview.` for filterability.
            if (!eventName.startsWith('webview.')) return;
            const props = (message.properties && typeof message.properties === 'object') ? message.properties : {};
            // Cap the property payload to keep frame size bounded.
            const safeProps: Record<string, unknown> = {};
            let count = 0;
            for (const [k, v] of Object.entries(props)) {
                if (count++ >= 12) break;
                if (typeof v === 'string') safeProps[k] = v.slice(0, 200);
                else if (typeof v === 'number' || typeof v === 'boolean') safeProps[k] = v;
                // skip nested objects / arrays — keep payload flat.
            }
            analytics.track(eventName, safeProps);
        } catch (err: any) {
            ctx.log(`[${MODULE}] webviewAnalytics error: ${err?.message ?? err}`);
        }
    }, MODULE);

    // ── toggleTheme ───────────────────────────────────────────────────────────
    register('toggleTheme', () => {
        try {
            const current = ctx.context!.globalState.get<'dark' | 'light'>('codeatlas.theme', 'dark');
            const next = current === 'dark' ? 'light' : 'dark';
            ctx.context!.globalState.update('codeatlas.theme', next);
            ctx.panelManager!.setTheme(next);
            if (ctx.wsBridge?.hasClients()) {
                ctx.wsBridge.broadcast({ type: 'setTheme', theme: next });
            }
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            ctx.log(`[${MODULE}] toggleTheme error: ${msg}`);
            ctx.notifyBrowser('error', `toggleTheme failed: ${msg.slice(0, 150)}`);
        }
    }, MODULE);

    // ── setLlmConfig ──────────────────────────────────────────────────────────
    register('setLlmConfig', (message) => {
        (async () => {
            try {
                const wsConfig = vscode.workspace.getConfiguration('codeatlas');
                analytics.track('llm_config_set', {
                    has_api_key: !!message.apiKey,
                    provider: message.provider ?? null,
                    model: message.model ?? null,
                    has_endpoint: message.endpoint !== undefined,
                });
                if (message.apiKey) {
                    await ctx.context!.secrets.store('codeatlas.openRouterApiKey', message.apiKey);
                }
                if (message.provider) {
                    await wsConfig.update('llmProvider', message.provider, vscode.ConfigurationTarget.Global);
                }
                if (message.model) {
                    await wsConfig.update('llmModel', message.model, vscode.ConfigurationTarget.Global);
                }
                if (message.endpoint !== undefined) {
                    await wsConfig.update('llmEndpoint', message.endpoint, vscode.ConfigurationTarget.Global);
                }
                const effectiveKey = message.apiKey ?? (await ctx.context!.secrets.get('codeatlas.openRouterApiKey')) ?? '';
                const effectiveProvider = message.provider ?? wsConfig.get<string>('llmProvider', 'openrouter');
                const effectiveModel = message.model ?? wsConfig.get<string>('llmModel', 'openrouter/free');
                ctx.llmNamingService.configure(effectiveKey, effectiveModel, effectiveProvider);
                const msg = {
                    type: 'showNotification' as const,
                    level: 'info' as const,
                    message: 'LLM configuration saved.',
                };
                broadcast(msg);
                if (ctx.wsBridge?.hasClients()) {
                    // Refresh home screen with updated LLM config
                    ctx.wsBridge.broadcast(ctx.buildWorkspaceInfo!());
                }
            } catch (err: any) {
                const errMsg = err?.message ?? String(err);
                ctx.log(`[${MODULE}] setLlmConfig error: ${errMsg}`);
                ctx.notifyBrowser('error', `setLlmConfig failed: ${errMsg.slice(0, 150)}`);
            }
        })();
    }, MODULE);

    // ── testLlmConnection ──────────────────────────────────────────────────
    // Probe the configured LLM endpoint with a free / read-only request
    // and broadcast `llmConnectionTestResult` so the home-page "Test
    // Connection" button can render success/failure with latency before
    // the user clicks Start review (UX-22 prevention).
    register('testLlmConnection', () => {
        (async () => {
            try {
                const wsConfig = vscode.workspace.getConfiguration('codeatlas');
                const provider = wsConfig.get<string>('llmProvider', 'openrouter');
                const endpoint = wsConfig.get<string>('llmEndpoint', '') || '';
                const apiKey = (await ctx.context!.secrets.get('codeatlas.openRouterApiKey')) ?? '';
                const result = await probeLlmConnection({ provider, endpoint, apiKey });
                broadcast({ type: 'llmConnectionTestResult', ...result });
                analytics.track('llm_connection_test', {
                    provider,
                    ok: result.ok,
                    latency_ms: result.latencyMs ?? null,
                });
            } catch (err: any) {
                const errMsg = err?.message ?? String(err);
                ctx.log(`[${MODULE}] testLlmConnection error: ${errMsg}`);
                broadcast({ type: 'llmConnectionTestResult', ok: false, message: `Probe crashed: ${errMsg.slice(0, 200)}` });
            }
        })();
    }, MODULE);

    // ── runCommand ────────────────────────────────────────────────────────────
    // Browser mode: run VS Code commands triggered from the browser UI
    register('runCommand', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'runCommand', async () => {
            const allowedCommands = new Set([
                'codeatlas.initializeWorkspaceVisuals',
                'codeatlas.resyncEverything',
                'codeatlas.openGitDiff',
                'codeatlas.openPrDiff',
                'codeatlas.clearGitDiff',
                'codeatlas.login',
                'codeatlas.logout',
                'codeatlas.showHealthReport',
                'codeatlas.exportArchitectureDocs',
                'codeatlas.exportDiagramsJson',
                'codeatlas.loadCoverage',
                'codeatlas.analyzeImpact',
                'codeatlas.openMicroserviceDiagram',
                'codeatlas.openFeatureDiagram',
                'codeatlas.openApiExplorer',
                'codeatlas.openFileDiagram',
                'codeatlas.openFunctionFlow',
                'codeatlas.openSequenceForApi',
                'codeatlas.rebuildCurrentFile',
                'codeatlas.toggleAutoUpdate',
                'codeatlas.search',
                'codeatlas.searchApiExplorer',
                'codeatlas.openInBrowser',
                'codeatlas.timelineReplay',
                'codeatlas.lightMode',
                'codeatlas.darkMode',
            ]);
            if (!allowedCommands.has(message.command)) return;

            // Intercept commands that need browser-native alternatives
            const isBrowserCmd = sourcePanelId.startsWith('ws:');
            if (isBrowserCmd && ctx.wsBridge) {
                const clientId = sourcePanelId.slice(3);
                const bWorking = ctx.snapshotStore.getWorking();

                if (message.command === 'codeatlas.search') {
                    // Send searchable items to browser instead of VS Code quickPick
                    const items: Array<{ id: string; label: string; description: string; kind: string }> = [];
                    for (const api of Object.values(bWorking.apiIndex)) {
                        items.push({
                            id: api.apiId,
                            label: `${api.method} ${api.route}`,
                            description: api.filePath,
                            kind: 'API',
                        });
                    }
                    for (const fp of Object.keys(bWorking.files)) {
                        items.push({
                            id: fp,
                            label: fp.split('/').pop() ?? fp,
                            description: fp,
                            kind: 'File',
                        });
                    }
                    for (const cluster of Object.values(bWorking.clusters ?? {})) {
                        items.push({
                            id: cluster.id,
                            label: cluster.label,
                            description: `${cluster.files.length} files`,
                            kind: 'Cluster',
                        });
                    }
                    for (const svc of Object.values(bWorking.services ?? {})) {
                        items.push({
                            id: svc.id,
                            label: svc.name,
                            description: svc.technology,
                            kind: 'Service',
                        });
                    }
                    ctx.wsBridge.sendTo(clientId, { type: 'showSearchPicker', items });
                    return;
                }
                if (message.command === 'codeatlas.openFunctionFlow') {
                    // Send function list to browser instead of VS Code quickPick
                    const funcs: Array<{ name: string; filePath: string }> = [];
                    for (const gid of Object.keys(bWorking.graphs)) {
                        if (gid.startsWith('flow:')) {
                            const rest = gid.slice(5);
                            const lastColon = rest.lastIndexOf(':');
                            if (lastColon > 0) {
                                funcs.push({
                                    filePath: rest.slice(0, lastColon),
                                    name: rest.slice(lastColon + 1),
                                });
                            }
                        }
                    }
                    ctx.wsBridge.sendTo(clientId, { type: 'showFunctionPicker', functions: funcs });
                    return;
                }
                if (message.command === 'codeatlas.exportArchitectureDocs') {
                    // Send file content for download instead of opening VS Code editor
                    const baseline = ctx.snapshotStore.getBaseline();
                    const repoName = path.basename(ctx.workspaceRoot);
                    const md = exportArchitectureDocs(bWorking, baseline, repoName);
                    ctx.wsBridge.sendTo(clientId, {
                        type: 'downloadFile',
                        filename: 'architecture.md',
                        content: md,
                        mimeType: 'text/markdown',
                    });
                    return;
                }
                if (message.command === 'codeatlas.analyzeImpact') {
                    // Send file picker to browser instead of requiring active editor
                    const files = Object.keys(bWorking.files).map((fp) => ({
                        path: fp,
                        label: fp.split('/').pop() ?? fp,
                    }));
                    ctx.wsBridge.sendTo(clientId, { type: 'showFilePicker', files });
                    return;
                }
                if (message.command === 'codeatlas.openPrDiff') {
                    // Route through browser-aware handler instead of VS Code inputBox.
                    // UX-63d — forward optional repoId for per-repo PR diff.
                    await ctx.handleRequestPrDiff!(sourcePanelId, (message as any).repoId);
                    return;
                }
                if (message.command === 'codeatlas.timelineReplay') {
                    // UX-63f — per-repo Timeline Replay. When repoId is set,
                    // resolve sub-repo gitRoot and broadcast the commit-range
                    // picker against THAT path so the user picks commits
                    // from the right history.
                    const reqRepoId = String((message as any).repoId ?? '');
                    let gitRoot = ctx.workspaceRoot;
                    if (reqRepoId && ctx.aggregatorStore) {
                        try {
                            const repos = ctx.aggregatorStore.listRepos();
                            const matched = repos.find((r: any) => r.name === reqRepoId || r.repoId === reqRepoId || r.rootPath === reqRepoId);
                            if (matched?.rootPath) {
                                gitRoot = path.join(ctx.workspaceRoot, matched.rootPath);
                                ctx.log(`[${MODULE}] timelineReplay: scoped to per-repo gitRoot=${matched.rootPath}`);
                            }
                        } catch (err: any) {
                            ctx.log(`[${MODULE}] timelineReplay per-repo resolve failed: ${err?.message ?? err}`);
                        }
                    }
                    const commits = listCommits(gitRoot, 50);
                    if (commits.length < 2) {
                        ctx.notifyBrowser('warning', 'Need at least 2 commits for timeline replay.');
                        return;
                    }
                    const branches = listBranches(gitRoot);
                    const currentBranch = branches.find(b => b.isCurrent)?.name ?? 'HEAD';
                    const mainBranch = branches.find(b => b.name === 'main' || b.name === 'master')?.name;
                    const baselineHash = mainBranch && mainBranch !== currentBranch
                        ? (mergeBase(gitRoot, mainBranch, 'HEAD') ?? commits[commits.length - 1]?.hash)
                        : commits[commits.length - 1]?.hash;
                    ctx.wsBridge.sendTo(clientId, { type: 'showCommitRangePicker', commits, branches, currentBranch, baselineHash });
                    return;
                }
                if (message.command === 'codeatlas.openGitDiff') {
                    // Route through browser-aware handler instead of VS Code quickPick.
                    // UX-63b — forward optional repoId.
                    await ctx.handleRequestGitDiff!(sourcePanelId, (message as any).repoId);
                    return;
                }
                if (message.command === 'codeatlas.showHealthReport') {
                    // Build health graph inline and send to browser (not stored in working.graphs)
                    const health = bWorking.health;
                    if (!health) {
                        ctx.notifyBrowser('warning', 'No health data available. Run Initialize Visuals first.');
                        return;
                    }
                    const healthGraph = {
                        graphId: 'health:report',
                        type: 'health' as const,
                        nodes: [] as any[],
                        edges: [] as any[],
                        anchors: {} as Record<string, any>,
                        meta: { health },
                    };
                    ctx.wsBridge.sendTo(clientId, {
                        type: 'navigateTo',
                        graphId: 'health:report',
                        mode: 'health',
                        graph: healthGraph,
                        label: 'Health Report',
                    });
                    return;
                }
                if (message.command === 'codeatlas.searchApiExplorer') {
                    // Send search picker filtered to APIs only
                    const apiItems = Object.values(bWorking.apiIndex).map((api) => ({
                        id: api.apiId,
                        label: `${api.method} ${api.route}`,
                        description: api.filePath,
                        kind: 'API',
                    }));
                    ctx.wsBridge.sendTo(clientId, { type: 'showSearchPicker', items: apiItems });
                    return;
                }
                if (message.command === 'codeatlas.openApiExplorer') {
                    // TICKET-UI-1 — workspace-wide API list (ALL entry points),
                    // built via the SHARED core builder so this and the MCP
                    // standalone (`messageHandler.ts`) render an identical list.
                    const g = buildWorkspaceApiListGraph(bWorking.apiIndex);
                    if (g) {
                        ctx.wsBridge.sendTo(clientId, {
                            type: 'navigateTo',
                            graphId: g.graphId,
                            mode: 'api-list',
                            graph: g,
                            label: 'Workspace APIs',
                        });
                        return;
                    }
                    ctx.notifyBrowser('warning', 'No API data available. Run Initialize Visuals first.');
                    return;
                }
                if (message.command === 'codeatlas.loadCoverage') {
                    ctx.notifyBrowser(
                        'warning',
                        'Coverage loading requires the editor. Open VS Code/Cursor and run "CodeAtlas: Load Test Coverage" from the command palette.',
                    );
                    return;
                }
                if (message.command === 'codeatlas.resyncEverything') {
                    ctx.notifyBrowser('info', 'Re-syncing workspace...');
                    // Multi-repo-safe resync (falls back to the monolithic
                    // orchestrator resync only when the safe helper isn't wired,
                    // i.e. single-repo / standalone). The monolithic path
                    // hangs/OOMs on large multi-repo workspaces.
                    const doResync = ctx.resyncWorkspace
                        ? ctx.resyncWorkspace()
                        : ctx.syncOrchestrator!.resync();
                    doResync.then(
                        () => {
                            ctx.notifyBrowser('info', 'Re-sync complete. Diagrams updated.');
                        },
                        (err: any) => {
                            ctx.notifyBrowser('error', `Re-sync failed: ${err?.message ?? err}`);
                        },
                    );
                    return;
                }
                if (message.command === 'codeatlas.openInBrowser') {
                    // Already in browser — no-op
                    return;
                }
                if (message.command === 'codeatlas.exportDiagramsJson') {
                    // Send diagrams JSON as file download
                    const json = JSON.stringify(bWorking.graphs, null, 2);
                    ctx.wsBridge.sendTo(clientId, {
                        type: 'downloadFile',
                        filename: 'diagrams.json',
                        content: json,
                        mimeType: 'application/json',
                    });
                    return;
                }
                if (message.command === 'codeatlas.login') {
                    // Browser-mode sign-in: include the WS bridge port so the
                    // marketing site redirects back to the user's local CodeAtlas
                    // tab (http://localhost:<port>/auth/callback) instead of
                    // deep-linking into the editor.
                    const port = ctx.wsBridge.getPort();
                    const params = new URLSearchParams({
                        source: ctx.context!.extension.id,
                        scheme: vscode.env.uriScheme,
                        port: String(port),
                    });
                    const authUrl = `${ctx.clerkAuthPageUrl}?${params.toString()}`;
                    ctx.wsBridge.sendTo(clientId, { type: 'openUrl' as any, url: authUrl });
                    return;
                }
                if (message.command === 'codeatlas.logout') {
                    // Clear auth state and broadcast
                    vscode.commands.executeCommand('codeatlas.logout');
                    return;
                }
            }
            vscode.commands.executeCommand(message.command, ...(message.args ?? []));
        });
    }, MODULE);
}
