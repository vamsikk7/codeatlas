/**
 * navigationHandlers.ts
 *
 * Issues #173, #174, #194: Navigation message handlers extracted from extension.ts.
 * Handles openSource, openFileDiagram, openFunctionFlow, openFeatureDiagram,
 * openFeatureForService, openMicroserviceDiagram, openApiListForCluster,
 * openSequenceForApi, and navigateHome.
 *
 * Also exports the builder/helper functions used by VS Code command registrations
 * in extension.ts (e.g. openFileDiagramForPath, revealApiInSidebar, etc.).
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { HandlerContext, MessageHandler } from './handlerContext';
import { withErrorHandling } from './handlerContext';
import { resolveStoreForPath } from './resolveStoreForPath';
import { safeResolve } from '../core/navigation/pathValidator';
import { resolveUnderRoot } from '../core/navigation/pathUtils';
import { buildFileGraph, buildFileGraphFromAnalysis, recomputeFileGraphDiffFromAuthoritativeSymbols, type BaselineSymbols } from '../core/graph/fileGraphBuilder';
import { buildFlowGraph, buildFlowGraphFromNode, buildFlowGraphFromBody } from '../core/graph/flowGraphBuilder';
import { resolveFlowGraphId } from '../core/graph/flowGraphResolve';
import { buildFeatureGraph } from '../core/graph/featureGraphBuilder';
import { buildMicroserviceGraph } from '../core/graph/microserviceGraphBuilder';
import { markMultiRepoL1Diff } from '../core/sync/multiRepoL1Diff';
import { buildMapGraph } from '../core/graph/mapGraphBuilder';
import { collectTopLevelEntities } from '../core/parser/symbolExtractor';
import { detectLanguage } from '../core/parser/treeSitterParser';
import { extractFileSymbolsMultiLang } from '../core/parser/treeSitterExtractor';
import { findAnonymousRouteBody } from '../core/parser/anonRouteFinder';
import { buildApiListGraph } from '../core/graph/apiListGraphBuilder';
import { entryPointsNounForGraph } from '../core/graph/entryPointLabel';
import type { DiagramGraph } from '../core/graph/graphTypes';

// ─── Sidebar reveal helpers ─────────────────────────────────────────────────

/**
 * Reveal an API leaf item in the API Explorer sidebar.
 * Called when opening a sequence diagram for a specific API.
 */
export function revealApiInSidebar(ctx: HandlerContext, apiId: string): void {
    const item = ctx.apiExplorerProvider!.findItemByApiId(apiId);
    if (item) {
        ctx.apiTreeView!.reveal(item, { select: true, focus: false, expand: true }).then(
            undefined,
            () => { /* tree item may not be populated yet — ignore */ }
        );
    }
}

/**
 * Reveal a service node in the Microservice sidebar tree.
 * Called when opening a Feature diagram scoped to a service.
 */
export function revealServiceInSidebar(ctx: HandlerContext, serviceId?: string): void {
    if (!serviceId) return;
    ctx.microserviceExplorerProvider!.setActiveService(serviceId);
    const item = ctx.microserviceExplorerProvider!.findItemByServiceId(serviceId);
    if (item) {
        ctx.microserviceTreeView!.reveal(item, { select: true, focus: false, expand: true }).then(
            undefined,
            () => { /* tree item may not be visible yet — ignore */ }
        );
    }
}

/**
 * Reveal a cluster node in the Feature sidebar tree.
 * Called when opening an API list for a cluster.
 */
export function revealClusterInSidebar(ctx: HandlerContext, clusterId?: string): void {
    if (!clusterId) return;
    ctx.featureExplorerProvider!.setActiveCluster(clusterId);
    const item = ctx.featureExplorerProvider!.findItemByClusterId(clusterId);
    if (item) {
        ctx.featureTreeView!.reveal(item, { select: true, focus: false, expand: true }).then(
            undefined,
            () => { /* tree item may not be visible yet — ignore */ }
        );
    }
}

// ─── Git diff context helper ────────────────────────────────────────────────

/**
 * Send setGitDiffContext to a specific panel by its panelId (graph id).
 * Used when opening a new panel in git diff mode.
 */
export function sendGitDiffContextToPanel(ctx: HandlerContext, panelId: string, scope?: string): void {
    const gitDiffState = ctx.getGitDiffState!(scope);
    if (!gitDiffState) return;
    ctx.panelManager!.sendToPanel(panelId, {
        type: 'setGitDiffContext',
        baseHash: gitDiffState.baseHash,
        headHash: gitDiffState.headHash,
        baseLabel: gitDiffState.baseLabel,
        headLabel: gitDiffState.headLabel,
    });
}

// ─── Service prefix helper ──────────────────────────────────────────────────

/**
 * Issue 108: Resolve the service name for a file path in multi-service workspaces.
 * Returns "serviceName > " prefix when 2+ services detected, empty string otherwise.
 */
export function servicePrefix(ctx: HandlerContext, filePath: string): string {
    const services = ctx.snapshotStore.getWorkingServices();
    const serviceList = Object.values(services);
    if (serviceList.length < 2) return '';
    for (const svc of serviceList) {
        if (filePath.startsWith(svc.rootPath + '/') || filePath.startsWith(svc.rootPath)) {
            return `${svc.name} > `;
        }
    }
    return '';
}

// ─── File diagram builders ──────────────────────────────────────────────────

/**
 * Pure (no vscode coupling) async rebuild for an L4 file graph.
 * Dispatches by file extension: JS/TS via Babel, others via tree-sitter.
 * Production callers delegate here through `buildFileGraphForPath`.
 * The T3 cross-handler parity test calls this directly with an explicit
 * `workspaceRoot` so it doesn't need to mock `vscode.workspace.workspaceFolders`.
 *
 * Issue #396: prior to this refactor the function called `buildFileGraph`
 * (Babel) on every file. Non-JS files threw inside the catch and silently
 * fell back to the cached graph — masking real rebuild failures for
 * Java/Python/Go users navigating L3 → L4.
 */
export async function rebuildFileGraphForPathPure(opts: {
    workspaceRoot: string;
    relativePath: string;
    store: HandlerContext['snapshotStore'];
}): Promise<DiagramGraph | undefined> {
    const { workspaceRoot, relativePath, store } = opts;
    const graphId = `file:${relativePath}`;
    const fullPath = resolveUnderRoot(workspaceRoot, relativePath);
    try {
        // Defensive: a stale ApiRecord or tour drill-down can occasionally
        // carry a directory path instead of a file path. `fs.readFileSync`
        // throws EISDIR with a useless stack; surface a clearer signal and
        // fall back to the cached graph if any.
        let stat: import('fs').Stats | undefined;
        try { stat = fs.statSync(fullPath); } catch { /* missing — let the read below produce ENOENT */ }
        if (stat?.isDirectory()) {
            const cached = store.getWorking().graphs[graphId];
            if (cached) return cached;
            throw new Error(`path is a directory, not a file: ${relativePath}`);
        }
        const code = fs.readFileSync(fullPath, 'utf-8');
        const baselineFile = store.getBaseline().files[relativePath];
        // FileRecord.content is dropped post-save (lazy-content); fall through
        // to the SQLite-backed accessor.
        const oldCode = baselineFile
            ? store.getFileContent('baseline', relativePath)
            : undefined;

        const isJs = /\.(?:[jt]sx?|mjs|cjs)$/.test(relativePath);
        let graph: DiagramGraph;

        if (isJs) {
            // JS/TS — Babel pipeline.
            graph = buildFileGraph(code, relativePath, oldCode);
            if (baselineFile) {
                const workingAnalysis = collectTopLevelEntities(code, relativePath);
                recomputeFileGraphDiffFromAuthoritativeSymbols(graph, baselineFile, workingAnalysis);
            }
        } else {
            // Non-JS — tree-sitter pipeline (Issue #396).
            const language = detectLanguage(fullPath);
            if (!language) {
                // Unknown language — fall back to cached graph if present.
                const cached = store.getWorking().graphs[graphId];
                return cached;
            }
            const analysis = await extractFileSymbolsMultiLang(code, relativePath, language);
            const baselineSymbols: BaselineSymbols | undefined = baselineFile ? {
                functions: (baselineFile.symbols.functions ?? []).map(f => ({
                    name: f.name,
                    signature: f.signature,
                    bodyText: f.bodyText,
                    stableKey: f.stableKey || `function:${f.name}`,
                })),
                variables: (baselineFile.symbols.variables ?? []).map(v => ({
                    name: v.name,
                    bodyText: v.bodyText,
                    stableKey: v.stableKey || `variable:${v.name}`,
                })),
                imports: (baselineFile.symbols.imports ?? []).map(i => ({
                    source: i.source,
                    stableKey: i.stableKey || `import:${i.source}`,
                })),
            } : undefined;
            graph = buildFileGraphFromAnalysis(analysis, relativePath, baselineSymbols);
            if (baselineFile) {
                recomputeFileGraphDiffFromAuthoritativeSymbols(graph, baselineFile, analysis as any);
            }
        }
        store.updateWorkingGraph(graph.graphId, graph);
        return graph;
    } catch {
        // Fallback to cached graph on any read/parse failure.
        return store.getWorking().graphs[graphId];
    }
}

export async function buildFileGraphForPath(ctx: HandlerContext, filePath: string): Promise<DiagramGraph | undefined> {
    const graphId = `file:${filePath}`;
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const root = workspaceFolders?.[0]?.uri.fsPath || ctx.workspaceRoot;
        // ADR-034 Phase B (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) — route through the per-repo store when
        // multi-repo. Falls back to ctx.snapshotStore in single-repo + tests.
        const resolved = resolveStoreForPath(
            filePath,
            root,
            ctx.snapshotStore,
            ctx.repoStoreRegistry,
            ctx.aggregatorStore,
        );
        const graph = await rebuildFileGraphForPathPure({
            workspaceRoot: root,
            relativePath: filePath,
            store: resolved.store as any,
        });
        if (graph) return graph;
        // No graph returned — surface error.
        throw new Error(`Failed to rebuild file graph for ${filePath}`);
    } catch (err: any) {
        // Fallback to cached graph if rebuild fails.
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ctx.workspaceRoot;
        const resolved = resolveStoreForPath(filePath, root, ctx.snapshotStore, ctx.repoStoreRegistry, ctx.aggregatorStore);
        const cached = (resolved.store as any).getWorking().graphs[graphId] ?? ctx.snapshotStore.getWorking().graphs[graphId];
        if (cached) return cached;
        const msg = err?.message ?? String(err);
        ctx.log(`[openFileDiagram] Failed to build for ${filePath}: ${msg}`);
        // Defensive: minimal vscode mocks in tests may not define
        // showErrorMessage. The handler's job is to surface the error
        // when possible, not crash on a missing helper.
        if (typeof vscode.window?.showErrorMessage === 'function') {
            vscode.window.showErrorMessage(`CodeAtlas: Failed to build file diagram: ${msg}`);
        }
        ctx.notifyBrowser('error', `Failed to build file diagram for ${filePath}: ${msg}`);
        return undefined;
    }
}

export async function openFileDiagramForPath(ctx: HandlerContext, filePath: string): Promise<void> {
    const graph = await buildFileGraphForPath(ctx, filePath);
    if (!graph) return;
    const label = filePath.split('/').pop() ?? filePath;
    const graphId = `file:${filePath}`;
    if (!ctx.panelManager!.navigateActive(graphId, 'file', graph, label)) {
        ctx.panelManager!.openPanel(graphId, `File: ${label}`, 'file', graph, label);
    }
}

export async function openFileDiagramInPanel(ctx: HandlerContext, filePath: string, sourcePanelId: string): Promise<void> {
    const graph = await buildFileGraphForPath(ctx, filePath);
    if (!graph) return;
    const label = servicePrefix(ctx, filePath) + (filePath.split('/').pop() ?? filePath);
    ctx.panelManager!.navigatePanel(sourcePanelId, `file:${filePath}`, 'file', graph, label);
}

// ─── Flow graph builders ────────────────────────────────────────────────────

export function buildFlowGraphForPath(ctx: HandlerContext, filePath: string, functionName: string): DiagramGraph | undefined {
    const graphId = `flow:${filePath}:${functionName}`;
    // ADR-034 Phase B (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) — route through the per-repo store when
    // multi-repo. Single-repo workspaces use the workspace store unchanged.
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ctx.workspaceRoot;
    const resolved = resolveStoreForPath(
        filePath, root, ctx.snapshotStore, ctx.repoStoreRegistry, ctx.aggregatorStore,
    );
    const flowStore: any = resolved.store;
    let graph = flowStore.getWorking().graphs[graphId];
    if (!graph) {
        // TICKET-UI-3 (VSIX side) — an L3 sequence-edge anchor carries the
        // CLASS-QUALIFIED symbol (`ArticleService.findComments`) while init
        // stores the flow graph under the BARE method name (`flow:…:findComments`).
        // The exact lookup above misses, and the rebuild below would then slice
        // out bare method syntax (`findComments(…){…}`) and hand it to
        // parseFirstFunction → "Unexpected token" (methods aren't valid
        // standalone functions). Resolve the pre-built graph FIRST (bare↔class-
        // prefixed, both directions) so we reuse it instead of a parse-fragile
        // rebuild — and reach parity with the MCP standalone edgeClicked path.
        const resolvedId = resolveFlowGraphId(Object.keys(flowStore.getWorking().graphs ?? {}), graphId);
        if (resolvedId) graph = flowStore.getWorking().graphs[resolvedId];
    }
    if (!graph) {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const root = workspaceFolders?.[0]?.uri.fsPath || '';
            const fullPath = resolveUnderRoot(root, filePath);
            const code = fs.readFileSync(fullPath, 'utf-8');
            const analysis = collectTopLevelEntities(code, filePath);
            let fn = analysis.funcs.get(functionName);

            // Issue 253: Handle anonymous route handlers (e.g., anonymous@GET:/articles)
            // These are arrow functions passed to router.get/post/etc — not in analysis.funcs
            if (!fn && functionName.startsWith('anonymous@')) {
                const routeMatch = functionName.match(/^anonymous@(\w+):(.+)$/);
                if (routeMatch) {
                    const [, method, route] = routeMatch;
                    const routePattern = new RegExp(
                        `\\.${method.toLowerCase()}\\s*\\(\\s*['"\`]${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]\\s*,`,
                        'i'
                    );
                    const routeIdx = code.search(routePattern);
                    if (routeIdx >= 0) {
                        const afterRoute = code.slice(routeIdx);
                        // Match: skip middleware args, capture the full function expression including body
                        const cbMatch = afterRoute.match(/,\s*(?:[\w.]+\s*,\s*)*((?:async\s+)?(?:\([^)]*\)\s*=>|function\s*\([^)]*\))\s*\{)/);
                        if (cbMatch) {
                            // Find the opening brace of the function body
                            const bodyBraceIdx = routeIdx + (cbMatch.index ?? 0) + cbMatch[0].length - 1;
                            // Count only braces {} for the body (not parens)
                            let depth = 1, bodyEnd = bodyBraceIdx + 1;
                            for (let i = bodyEnd; i < code.length; i++) {
                                if (code[i] === '{') depth++;
                                else if (code[i] === '}') { depth--; if (depth === 0) { bodyEnd = i + 1; break; } }
                            }
                            // Capture from the function expression start (async/arrow), not just body
                            const fnExprStart = routeIdx + (cbMatch.index ?? 0) + cbMatch[0].length - cbMatch[1].length;
                            if (bodyEnd > fnExprStart) {
                                const rawFn = code.slice(fnExprStart, bodyEnd);
                                const wrappedFn = `const __handler = ${rawFn}`;
                                graph = buildFlowGraph(wrappedFn, filePath, functionName, undefined, undefined, fnExprStart);
                                ctx.snapshotStore.updateWorkingGraph(graph.graphId, graph);
                                fn = { node: { start: fnExprStart, end: bodyEnd } } as any;
                            }
                        }
                    }
                }
            }

            if (fn?.node && !graph) {
                const fnCode = code.slice(fn.node.start, fn.node.end);
                const baselineFile = ctx.snapshotStore.getBaseline().files[filePath];
                const baselineFn = baselineFile?.symbols?.functions?.find(
                    f => f.name === functionName
                );
                const baselineContent = baselineFile
                    ? ctx.snapshotStore.getFileContent('baseline', filePath)
                    : undefined;
                const oldFnCode = baselineFn
                    ? (baselineContent && baselineFn.span.start < baselineFn.span.end
                        ? baselineContent.slice(baselineFn.span.start, baselineFn.span.end)
                        : `${baselineFn.signature} {\n${baselineFn.bodyText}\n}`)
                    : undefined;
                graph = buildFlowGraph(fnCode, filePath, functionName, oldFnCode, undefined, fn.node.start ?? 0);
                ctx.snapshotStore.updateWorkingGraph(graph.graphId, graph);
            } else if (!graph) {
                vscode.window.showWarningMessage(`CodeAtlas: Function "${functionName}" not found in ${filePath}.`);
                ctx.notifyBrowser('warning', `Function "${functionName}" not found in ${filePath}.`);
                return undefined;
            }
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            ctx.log(`[openFunctionFlow] Failed to build for ${functionName} in ${filePath}: ${msg}`);
            vscode.window.showErrorMessage(`CodeAtlas: Failed to build flow for "${functionName}": ${msg}`);
            ctx.notifyBrowser('error', `Failed to build flow for "${functionName}": ${msg}`);
            return undefined;
        }
    }
    return graph;
}

/**
 * Build a flow graph for a non-JS function using tree-sitter, then navigate to it.
 * This is async because tree-sitter parsing is async.
 */
async function buildAndNavigateNonJsFlow(ctx: HandlerContext, filePath: string, functionName: string, sourcePanelId: string): Promise<void> {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const root = workspaceFolders?.[0]?.uri.fsPath || '';
        const fullPath = resolveUnderRoot(root, filePath);
        const language = detectLanguage(fullPath);
        if (!language) {
            // Case C: don't silently swallow the drill — the target file isn't a
            // supported source language, so there's no L5 flow to open.
            ctx.notifyBrowser('info', `No flow view for "${functionName}" — ${filePath} isn't a supported source language.`);
            return;
        }

        const code = fs.readFileSync(fullPath, 'utf-8');
        const analysis = await extractFileSymbolsMultiLang(code, filePath, language);
        const fn = analysis.funcs.get(functionName);

        // Issue 253: Handle anonymous route handlers via tree-sitter AST traversal.
        // Go: r.GET("/path", func(c *gin.Context) {...})
        // Kotlin: get("/path") { call -> ... }
        // Rust: .route("/path", get(|| async {...}))
        // Ruby: get '/path' do ... end
        // PHP: Route::get('/path', function () {...})
        if (!fn && functionName.startsWith('anonymous@')) {
            const routeMatch = functionName.match(/^anonymous@(\w+):(.+)$/);
            if (routeMatch) {
                const [, method, route] = routeMatch;
                const bodyNode = await findAnonymousRouteBody(code, language, method, route);
                if (bodyNode) {
                    const graph = buildFlowGraphFromBody(bodyNode, code, filePath, functionName);
                    ctx.snapshotStore.updateWorkingGraph(graph.graphId, graph);
                    const label = `Flow: ${functionName}`;
                    ctx.panelManager!.navigatePanel(sourcePanelId, graph.graphId, 'flow', graph, label);
                    return;
                }
            }
        }

        if (!fn?.node) {
            vscode.window.showWarningMessage(`CodeAtlas: Function "${functionName}" not found in ${filePath}.`);
            ctx.notifyBrowser('warning', `Function "${functionName}" not found in ${filePath}.`);
            return;
        }

        const baselineFile = ctx.snapshotStore.getBaseline().files[filePath];
        const baselineFn = baselineFile?.symbols?.functions?.find(f => f.name === functionName);
        const graph = buildFlowGraphFromNode(fn.node, code, filePath, functionName, baselineFn?.bodyText);
        ctx.snapshotStore.updateWorkingGraph(graph.graphId, graph);
        const label = `Flow: ${functionName}`;
        ctx.panelManager!.navigatePanel(sourcePanelId, graph.graphId, 'flow', graph, label);
    } catch (err: any) {
        ctx.log(`[openFunctionFlow] Non-JS failed for ${functionName} in ${filePath}: ${err?.message ?? err}`);
        vscode.window.showErrorMessage(`CodeAtlas: Failed to build flow for "${functionName}": ${err?.message ?? err}`);
        ctx.notifyBrowser('error', `Failed to build flow for "${functionName}": ${err?.message ?? err}`);
    }
}

export function openFunctionFlowForPath(ctx: HandlerContext, filePath: string, functionName: string): void {
    // Check cache first
    const cached = ctx.snapshotStore.getWorking().graphs[`flow:${filePath}:${functionName}`];
    if (cached) {
        const label = `Flow: ${functionName}`;
        if (!ctx.panelManager!.navigateActive(cached.graphId, 'flow', cached, label)) {
            ctx.panelManager!.openPanel(cached.graphId, label, 'flow', cached, label);
        }
        return;
    }

    // Non-JS/TS: async tree-sitter build then open in active/new panel
    // Issue 253: JS/TS files use Babel via buildFlowGraphForPath (supports anonymous handlers)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath || '';
    const fullPath = resolveUnderRoot(root, filePath);
    const lang = detectLanguage(fullPath);
    if (lang && lang !== 'javascript' && lang !== 'typescript') {
        (async () => {
            try {
                const language = detectLanguage(fullPath)!;
                const code = fs.readFileSync(fullPath, 'utf-8');
                const analysis = await extractFileSymbolsMultiLang(code, filePath, language);
                const fn = analysis.funcs.get(functionName);

                // Issue 253: Anonymous route handlers via tree-sitter AST traversal
                if (!fn && functionName.startsWith('anonymous@')) {
                    const routeMatch = functionName.match(/^anonymous@(\w+):(.+)$/);
                    if (routeMatch) {
                        const [, method, route] = routeMatch;
                        const bodyNode = await findAnonymousRouteBody(code, language, method, route);
                        if (bodyNode) {
                            const g = buildFlowGraphFromBody(bodyNode, code, filePath, functionName);
                            ctx.snapshotStore.updateWorkingGraph(g.graphId, g);
                            const label = `Flow: ${functionName}`;
                            if (!ctx.panelManager!.navigateActive(g.graphId, 'flow', g, label)) {
                                ctx.panelManager!.openPanel(g.graphId, label, 'flow', g, label);
                            }
                            return;
                        }
                    }
                }

                if (!fn?.node) {
                    vscode.window.showWarningMessage(`CodeAtlas: Function "${functionName}" not found.`);
                    ctx.notifyBrowser('warning', `Function "${functionName}" not found.`);
                    return;
                }
                const baselineFn = ctx.snapshotStore.getBaseline().files[filePath]?.symbols?.functions?.find(f => f.name === functionName);
                const g = buildFlowGraphFromNode(fn.node, code, filePath, functionName, baselineFn?.bodyText);
                ctx.snapshotStore.updateWorkingGraph(g.graphId, g);
                const label = `Flow: ${functionName}`;
                if (!ctx.panelManager!.navigateActive(g.graphId, 'flow', g, label)) {
                    ctx.panelManager!.openPanel(g.graphId, label, 'flow', g, label);
                }
            } catch (err: any) {
                ctx.log(`[openFunctionFlow] ${err?.message ?? err}`);
            }
        })();
        return;
    }

    const graph = buildFlowGraphForPath(ctx, filePath, functionName);
    if (!graph) return;
    const label = `Flow: ${functionName}`;
    const graphId = `flow:${filePath}:${functionName}`;
    if (!ctx.panelManager!.navigateActive(graphId, 'flow', graph, label)) {
        ctx.panelManager!.openPanel(graphId, label, 'flow', graph, label);
    }
}

export function openFunctionFlowInPanel(ctx: HandlerContext, filePath: string, functionName: string, sourcePanelId: string): void {
    // Check the snapshot cache first — avoids re-parsing. TICKET-UI-3/UI-5:
    // resolve BEFORE the JS/non-JS branch below, LANGUAGE-AGNOSTICALLY. An L3
    // sequence-edge anchor names the handler by its CLASS-qualified symbol
    // (`ArticleService.findComments`) or, for a Python/Java class-based view,
    // by the bare CLASS name (`ArticlesFeedAPIView`) — but init keys the flow
    // graph by the bare method (`findComments`) / `Class.method`
    // (`ArticlesFeedAPIView.list`). An exact lookup misses and falls through to
    // a language-specific rebuild that then fails to parse a class/method as a
    // standalone function. resolveFlowGraphId bridges bare↔class-prefixed AND
    // class→primary-method, so a pre-built flow is always reused when present.
    const graphs = ctx.snapshotStore.getWorking().graphs;
    const exactId = `flow:${filePath}:${functionName}`;
    const resolvedId = graphs[exactId] ? exactId : resolveFlowGraphId(Object.keys(graphs), exactId);
    const cached = resolvedId ? graphs[resolvedId] : undefined;
    if (cached) {
        const resolvedName = cached.graphId.slice(cached.graphId.lastIndexOf(':') + 1);
        const label = servicePrefix(ctx, filePath) + `Flow: ${resolvedName}`;
        ctx.panelManager!.navigatePanel(sourcePanelId, cached.graphId, 'flow', cached, label);
        return;
    }

    // Detect language: non-JS/TS files need tree-sitter (async)
    // Issue 253: JS/TS files use Babel via buildFlowGraphForPath (supports anonymous handlers)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath || '';
    const fullPath = resolveUnderRoot(root, filePath);
    const lang = detectLanguage(fullPath);
    if (lang && lang !== 'javascript' && lang !== 'typescript') {
        buildAndNavigateNonJsFlow(ctx, filePath, functionName, sourcePanelId);
        return;
    }

    const graph = buildFlowGraphForPath(ctx, filePath, functionName);
    if (!graph) return;
    const label = `Flow: ${functionName}`;
    ctx.panelManager!.navigatePanel(sourcePanelId, `flow:${filePath}:${functionName}`, 'flow', graph, label);
}

// ─── Feature diagram builders ───────────────────────────────────────────────

export function buildFeatureGraphForService(ctx: HandlerContext, serviceId?: string): DiagramGraph | undefined {
    try {
        // Bug 2: run the cascade FIRST so api-list `apis[].diff` is current,
        // then build the feature graph (which reads cluster.diff from the
        // shared snapshot), then upgrade the freshly-built feature graph's
        // cluster nodes to `modified` based on cascaded api-list state.
        ctx.syncOrchestrator!.applyDiffCascadeToLiveGraphs();
        const working = ctx.snapshotStore.getWorking();
        const baseline = ctx.snapshotStore.getBaseline();
        const graph = buildFeatureGraph(working, baseline, serviceId);
        ctx.snapshotStore.updateWorkingGraph(graph.graphId, graph);
        // PERF (2026-07-20): the second pass here only needs to annotate the
        // JUST-BUILT feature graph's cluster nodes with the `modified` badge
        // derived from the api-list state the FIRST cascade already computed.
        // The old full re-cascade re-walked all sequences + rebuilt Map +
        // re-clustered domains — fixed-cost waste on every L2a open. Swap it for
        // the LIGHT composition-only cluster/service annotation upgrade, which
        // reads the current api-list diffs and bubbles them onto the fresh
        // feature graph WITHOUT the sequence/Map/Domain rework.
        ctx.syncOrchestrator!.upgradeClusterServiceAnnotationsLight?.();
        return ctx.snapshotStore.getWorking().graphs[graph.graphId] ?? graph;
    } catch (err: any) {
        const graphId = serviceId ? `feature:${serviceId}` : 'feature:workspace';
        ctx.log(`[openFeatureDiagram] Build failed for ${graphId}: ${err?.message ?? err}`);
        vscode.window.showErrorMessage(`CodeAtlas: Failed to build feature diagram. See Output > CodeAtlas.`);
        ctx.notifyBrowser('error', `Failed to build feature diagram for ${graphId}: ${err?.message ?? err}`);
        return undefined;
    }
}

export function openFeatureDiagram(ctx: HandlerContext, serviceId?: string): void {
    const graph = buildFeatureGraphForService(ctx, serviceId);
    if (!graph) return;
    const label = serviceId ? `Features: ${serviceId.replace('service:', '')}` : 'Feature Clusters';
    const graphId = serviceId ? `feature:${serviceId}` : 'feature:workspace';
    if (!ctx.panelManager!.navigateActive(graphId, 'feature', graph, label)) {
        ctx.panelManager!.openPanel(graphId, label, 'feature', graph, label);
    }
}

export function openFeatureDiagramInPanel(ctx: HandlerContext, serviceId: string | undefined, sourcePanelId: string): void {
    const graph = buildFeatureGraphForService(ctx, serviceId);
    if (!graph) return;
    const label = serviceId ? `Features: ${serviceId.replace('service:', '')}` : 'Feature Clusters';
    const graphId = serviceId ? `feature:${serviceId}` : 'feature:workspace';
    ctx.panelManager!.navigatePanel(sourcePanelId, graphId, 'feature', graph, label);
}

// ─── API list builders ──────────────────────────────────────────────────────

// `buildApiListGraph` lives in `core/graph/apiListGraphBuilder.ts` (Issue 261 — API-list graph (`api-list:<clusterId>`) not built during workspace init
// extraction) so SyncOrchestrator can build api-list graphs eagerly at init.
// Re-exported here for back-compat with extension.ts and handler call sites.
export { buildApiListGraph };

export function buildApiListGraphForCluster(ctx: HandlerContext, clusterId: string, subClusterFiles?: string[]): DiagramGraph | undefined {
    const graphId = `api-list:${clusterId}`;
    const working = ctx.snapshotStore.getWorking();
    let cluster = working.clusters?.[clusterId];
    // If subClusterFiles provided (sub-cluster click), build a synthetic cluster scoped to those files
    if (!cluster && subClusterFiles) {
        for (const c of Object.values(working.clusters ?? {})) {
            if (c.subClusters?.[clusterId]) {
                cluster = c.subClusters[clusterId];
                break;
            }
        }
    }
    if (!cluster) {
        // Fall back to whatever was last cached if cluster lookup fails (e.g.
        // navigation race after a cluster id was renamed).
        const cached = working.graphs[graphId];
        if (cached) return cached;
        vscode.window.showWarningMessage(`CodeAtlas: Cluster "${clusterId}" not found.`);
        ctx.notifyBrowser('warning', `Cluster "${clusterId}" not found.`);
        return undefined;
    }
    // Bug 5 (stale state): always rebuild on navigation rather than serving
    // a cached api-list graph. Cached graphs go stale when the user edits a
    // file, the orchestrator's cascade updates the entry, but the webview
    // panel is not currently active so it never receives the updateGraph
    // message — then on next navigation the previously-cached stale graph
    // is what renders. Rebuilding here is cheap (single cluster, no AST
    // work) and guarantees diff annotations match the live snapshot.
    // Bug 2: run sequence-cascade first so apis[].diff is current.
    ctx.syncOrchestrator!.applyDiffCascadeToLiveGraphs();
    const liveWorking = ctx.snapshotStore.getWorking();
    const graph = buildApiListGraph(cluster, liveWorking, ctx.snapshotStore.getBaseline());
    ctx.snapshotStore.updateWorkingGraph(graph.graphId, graph);
    return graph;
}

export function openApiListPanel(ctx: HandlerContext, clusterId: string, _serviceId: string, subClusterFiles?: string[]): void {
    const graph = buildApiListGraphForCluster(ctx, clusterId, subClusterFiles);
    if (!graph) return;
    const label = `${entryPointsNounForGraph(graph)}: ${(graph.meta?.clusterLabel as string) || clusterId}`;
    const graphId = graph.graphId;
    if (!ctx.panelManager!.navigateActive(graphId, 'api-list', graph, label)) {
        ctx.panelManager!.openPanel(graphId, label, 'api-list', graph, label);
    }
}

export function openApiListPanelInPanel(ctx: HandlerContext, clusterId: string, _serviceId: string, sourcePanelId: string, subClusterFiles?: string[]): void {
    const graph = buildApiListGraphForCluster(ctx, clusterId, subClusterFiles);
    if (!graph) return;
    const label = `${entryPointsNounForGraph(graph)}: ${(graph.meta?.clusterLabel as string) || clusterId}`;
    ctx.panelManager!.navigatePanel(sourcePanelId, graph.graphId, 'api-list', graph, label);
}

// ─── Microservice diagram builders ──────────────────────────────────────────

/**
 * Build (or rebuild) the Microservice / System Design diagram.
 * Always rebuilds fresh — never uses the stale snapshot-cached graph, because
 * service detection reads the filesystem and the snapshot's `services` field
 * may be from an older detection pass.
 */
/**
 * #852 — workspace-relative changed files across the multi-repo workspace.
 * Each per-repo store keys files relative to its OWN root; prefix with the
 * repo's rootPath so the L1 service-node mapping can match by rootPath. Uses
 * the synchronous `getRepoStore` (already-loaded stores return instantly;
 * unloaded ones are best-effort skipped). Also folds in the primary store
 * (workspace-rooted, already workspace-relative).
 */
function collectChangedFilesAcrossRepos(
    ctx: HandlerContext,
    repos: ReadonlyArray<{ repoId: string; rootPath?: string }>,
): Set<string> {
    const changed = new Set<string>();
    const diff = (working: any, baseline: any, prefix: string) => {
        const w = working?.files ?? {}; const b = baseline?.files ?? {};
        for (const [fp, rec] of Object.entries(w)) {
            if (!b[fp] || (b[fp] as any).hash !== (rec as any).hash) changed.add(prefix ? `${prefix}/${fp}` : fp);
        }
        for (const fp of Object.keys(b)) if (!w[fp]) changed.add(prefix ? `${prefix}/${fp}` : fp);
    };
    try { diff(ctx.snapshotStore.getWorking(), ctx.snapshotStore.getBaseline(), ''); } catch { /* skip */ }
    if (ctx.repoStoreRegistry) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        for (const r of repos) {
            if (!r.rootPath) continue;
            try {
                const abs = root ? `${root}/${r.rootPath}` : r.rootPath;
                const store = ctx.repoStoreRegistry.getRepoStore(abs);
                diff(store.getWorking?.(), store.getBaseline?.(), r.rootPath);
            } catch { /* unloaded / unavailable — best effort */ }
        }
    }
    return changed;
}

export function buildMicroserviceGraphCached(ctx: HandlerContext): DiagramGraph {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath || '';

    // Issue UX-17 (2026-06-03 v2) — multi-repo regression follow-up.
    // After UX-5's main-thread skip, the workspace-level `snapshotStore`
    // is empty in multi-repo mode so `buildMicroserviceGraph` would
    // produce zero nodes. The aggregator's `microservice:workspace`
    // graph is already pre-built by `WorkspaceOrchestrator.writeSkeletalL1`
    // and refreshed on every per-repo finish — serve THAT graph instead.
    // Same pattern as `buildMapGraphCached` at line 669.
    if (ctx.aggregatorStore && ctx.repoStoreRegistry) {
        try {
            const repos = ctx.aggregatorStore.listRepos();
            const isMultiRepo = repos.length >= 2 && repos.some((r) => !!r.rootPath);
            if (isMultiRepo) {
                const cached = ctx.aggregatorStore.getWorkingGraph?.('microservice:workspace');
                if (cached && (cached as DiagramGraph).nodes?.length) {
                    // #852 — the aggregator L1 carries no per-repo diff. Mark
                    // each service node modified when its sub-repo has changed
                    // files (working-vs-baseline), mapped by rootPath. Same
                    // helper + file-mapping the standalone uses (parity).
                    const changed = collectChangedFilesAcrossRepos(ctx, repos);
                    return markMultiRepoL1Diff(cached as DiagramGraph, (repoId) => {
                        const r = repos.find((x) => x.repoId === repoId);
                        const root = r?.rootPath ?? '';
                        if (root === '') return false;
                        for (const f of changed) if (f === root || f.startsWith(root + '/')) return true;
                        return false;
                    });
                }
            }
        } catch (err: any) {
            ctx.log(`[buildMicroserviceGraphCached] multi-repo path failed (${err?.message ?? err}); falling back to per-repo`);
        }
    }

    const working = ctx.snapshotStore.getWorking();
    const baseline = ctx.snapshotStore.getBaseline();
    // FileRecord.content is dropped from RAM after each save (#354 — Body-finder gap closure for kotlin-ktor / rust-actix / rust-axum / rust-rocket), so feed
    // serviceDetector a DB-backed lazy fetcher — otherwise post-save L1 rebuilds
    // detect zero DB / cache / queue indicators in code and the infra layer
    // disappears from the diagram.
    const getWorking = (fp: string) => ctx.snapshotStore.getFileContent('working', fp);
    const getBaseline = (fp: string) => ctx.snapshotStore.getFileContent('baseline', fp);
    const graph = buildMicroserviceGraph(root, working, baseline, getWorking, getBaseline);
    ctx.snapshotStore.updateWorkingGraph(graph.graphId, graph);
    return graph;
}

// UX-20 (2026-06-03 v2) — when `meta.repoName` is missing (skeletal
// multi-repo L1) or equals the layer's own title we previously emitted
// `System Design: System Design` because the defaulting fallback was the
// literal layer name. Now we only suffix the repo name when it adds
// information; bare "System Design" otherwise.
export function microserviceLabel(graph: DiagramGraph): string {
    const repoName = (graph.meta?.repoName as string | undefined)?.trim();
    if (!repoName) return 'System Design';
    if (repoName.toLowerCase() === 'system design') return 'System Design';
    return `System Design: ${repoName}`;
}

export function openMicroserviceDiagram(ctx: HandlerContext): void {
    const graph = buildMicroserviceGraphCached(ctx);
    const label = microserviceLabel(graph);
    if (!ctx.panelManager!.navigateActive('microservice:workspace', 'microservice', graph, label)) {
        ctx.panelManager!.openPanel('microservice:workspace', label, 'microservice', graph, label);
    }
}

export function openMicroserviceDiagramInPanel(ctx: HandlerContext, sourcePanelId: string): void {
    const graph = buildMicroserviceGraphCached(ctx);
    ctx.panelManager!.navigatePanel(sourcePanelId, 'microservice:workspace', 'microservice', graph, microserviceLabel(graph));
}

// ─── Knowledge Map diagram builders (Issue #700 / #731) ────────────────────

/**
 * Build (or rebuild) the Knowledge Map diagram. Always rebuilds fresh —
 * same rationale as `buildMicroserviceGraphCached` since Map composition
 * reads the snapshot's services + clusters + APIs, all of which may have
 * shifted between panel opens. Composition-only (no AST pass), so cheap.
 */
export function buildMapGraphCached(ctx: HandlerContext): DiagramGraph {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath || ctx.workspaceRoot;

    // ADR-034 Phase F (#791 — Phase F: Knowledge Map per-repo split (ADR-034)) — workspace map in multi-repo mode is built
    // from the aggregator's cross-repo tables, not from any per-repo
    // state.db. The aggregator's repos table holds >= 2 rows with a
    // non-empty rootPath when multi-repo is active; that's our gate.
    if (ctx.aggregatorStore && ctx.repoStoreRegistry) {
        try {
            const repos = ctx.aggregatorStore.listRepos();
            const isMultiRepo = repos.length >= 2 && repos.some((r) => !!r.rootPath);
            if (isMultiRepo) {
                const { buildWorkspaceMapGraph } = require('../core/graph/mapGraphBuilder');
                const graph = buildWorkspaceMapGraph(ctx.aggregatorStore, root);
                ctx.aggregatorStore.updateWorkingGraph(graph.graphId, graph);
                return graph;
            }
        } catch (err: any) {
            ctx.log(`[buildMapGraphCached] workspace-map path failed (${err?.message ?? err}); falling back to per-repo`);
        }
    }

    // Single-repo path (today's behavior).
    const working = ctx.snapshotStore.getWorking();
    const baseline = ctx.snapshotStore.getBaseline();
    // #842 — while initialize() is repopulating in-memory state, the
    // snapshot is half-built (live repro: the Map rendered 1 of 6
    // clusters when requested mid-init). Serve the cached copy when one
    // survives; otherwise build progressively but DON'T persist the
    // partial graph (a persisted partial map would shadow the complete
    // rebuild) and stamp it so the UI can hint.
    if (ctx.syncOrchestrator?.initInFlight) {
        const cached = working.graphs?.['map:workspace'] as DiagramGraph | undefined;
        if (cached && Array.isArray(cached.nodes) && cached.nodes.length > 0) {
            ctx.log('[buildMapGraphCached] init in flight — serving cached map:workspace instead of rebuilding from a partial snapshot');
            return cached;
        }
        const getPartialContent = (fp: string) => ctx.snapshotStore.getFileContent('working', fp);
        const partial = buildMapGraph(working, baseline, {
            workspaceRoot: root,
            contentProvider: getPartialContent,
        });
        ctx.log('[buildMapGraphCached] init in flight + no cached copy — serving UNPERSISTED partial map');
        return { ...partial, meta: { ...(partial.meta ?? {}), partialInit: true } };
    }
    const getContent = (fp: string) => ctx.snapshotStore.getFileContent('working', fp);
    const graph = buildMapGraph(working, baseline, {
        workspaceRoot: root,
        contentProvider: getContent,
    });
    ctx.snapshotStore.updateWorkingGraph(graph.graphId, graph);
    return graph;
}

export function openMapDiagram(ctx: HandlerContext): void {
    const graph = buildMapGraphCached(ctx);
    const label = 'Knowledge Map';
    if (!ctx.panelManager!.navigateActive('map:workspace', 'map', graph, label)) {
        ctx.panelManager!.openPanel('map:workspace', label, 'map', graph, label);
    }
}

export function openMapDiagramInPanel(ctx: HandlerContext, sourcePanelId: string): void {
    const graph = buildMapGraphCached(ctx);
    ctx.panelManager!.navigatePanel(sourcePanelId, 'map:workspace', 'map', graph, 'Knowledge Map');
}

/**
 * Issue #743 — Domain graph: same on-demand rebuild + open pattern as Map.
 * Always rebuilds from the current snapshot's clusters + apiIndex so a
 * body-only edit that flipped routes in L2b shows up immediately.
 */
export function buildDomainGraphCached(ctx: HandlerContext): DiagramGraph {
    const { buildDomainGraph } = require('../core/graph/domainGraphBuilder');
    const { detectDomains } = require('../core/analysis/domainAnalyzer');
    const working = ctx.snapshotStore.getWorking();
    const heuristic = detectDomains(working);
    ctx.snapshotStore.updateWorkingDomains(heuristic);
    const graph = buildDomainGraph(heuristic, working);
    ctx.snapshotStore.updateWorkingGraph(graph.graphId, graph);
    return graph;
}

export function openDomainDiagram(ctx: HandlerContext): void {
    const graph = buildDomainGraphCached(ctx);
    const label = 'Domain Map';
    if (!ctx.panelManager!.navigateActive('domain:workspace', 'domain', graph, label)) {
        ctx.panelManager!.openPanel('domain:workspace', label, 'domain', graph, label);
    }
}

export function openDomainDiagramInPanel(ctx: HandlerContext, sourcePanelId: string): void {
    const graph = buildDomainGraphCached(ctx);
    ctx.panelManager!.navigatePanel(sourcePanelId, 'domain:workspace', 'domain', graph, 'Domain Map');
}

// ─── Handler registration ───────────────────────────────────────────────────

/**
 * Register all navigation-related message handlers with the message router.
 *
 * @param register - Function to register a (messageType, handler, module) triple
 * @param ctx - Shared handler context
 */
export function registerNavigationHandlers(
    register: (messageType: string, handler: MessageHandler, module: string) => void,
    ctx: HandlerContext,
): void {
    const MODULE = 'NavigationHandlers';
    // #547: navigation handlers extensively use `ctx.panelManager.navigatePanel`
    // and VS Code-specific sidebar reveal APIs. Standalone implements the
    // same intents (openFileDiagram/openFeatureDiagram/openMicroserviceDiagram/
    // openSource/...) via its own switch and broadcasts `navigateTo` events.
    // Skip registration off-extension so the standalone's switch stays
    // authoritative for these messages.
    if (!ctx.context) return;

    // ── openSource ──────────────────────────────────────────────────────────
    register('openSource', (message, sourcePanelId) => {
        if (!message.filePath) return;
        withErrorHandling(ctx, 'openSource', async () => {
            ctx.log(`[openSource] filePath=${message.filePath} charOffset=${message.charOffset} line=${message.line} from=${sourcePanelId}`);
            const resolved = safeResolve(ctx.workspaceRoot, message.filePath);
            if (!resolved) {
                vscode.window.showWarningMessage('CodeAtlas: File path is outside the workspace.');
                ctx.notifyBrowser('warning', 'File path is outside the workspace — open ignored.');
                return;
            }
            const uri = vscode.Uri.file(resolved);
            // Focus the editor window (brings VS Code/Cursor to foreground from browser)
            vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            try {
                const editor = await vscode.window.showTextDocument(uri, { preview: false });
                let line = message.line;
                if (!line && message.charOffset != null) {
                    const offset = message.charOffset;
                    const text = editor.document.getText();
                    if (offset >= 0 && offset < text.length) {
                        const pos = editor.document.positionAt(offset);
                        line = pos.line + 1;
                    }
                }
                ctx.log(`[openSource] resolved line=${line} charOffset=${message.charOffset}`);
                if (line) {
                    const pos = new vscode.Position(line - 1, message.column || 0);
                    editor.selection = new vscode.Selection(pos, pos);
                    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                }
                // Confirmation toast back in the browser. With the URI-handler
                // path the editor is already in front, but the toast still
                // confirms "yes, we navigated to this file/line" so the user
                // sees the action register when they switch back to the
                // browser tab. The 'uri-handler' source skips the toast since
                // it would land in the (now-backgrounded) browser tab without
                // a visible reason — the editor focus IS the feedback.
                if (sourcePanelId.startsWith('ws:')) {
                    const fileName = message.filePath.split('/').pop() ?? message.filePath;
                    ctx.notifyBrowser('info', `Opened ${fileName}${line ? ` at line ${line}` : ''} in editor.`);
                }
            } catch (err: any) {
                ctx.log(`[openSource] Failed to open ${message.filePath}: ${err?.message ?? err}`);
                vscode.window.showWarningMessage(`CodeAtlas: Could not open file "${message.filePath}".`);
                ctx.notifyBrowser('warning', `Could not open file "${message.filePath}".`);
            }
        });
    }, MODULE);

    // ── openFileDiagram ─────────────────────────────────────────────────────
    register('openFileDiagram', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'openFileDiagram', async () => {
            const parentCtx = ctx.panelManager!.getPanelContext(sourcePanelId);
            const gitDiffState = ctx.getGitDiffState!(message?.repoId);
            if (gitDiffState) {
                const gd = gitDiffState.diffedGraphs[`file:${message.filePath}`];
                if (gd) {
                    const lbl = message.filePath.split('/').pop() ?? message.filePath;
                    if (message.newWindow) {
                        ctx.panelManager!.openPanel(gd.graphId, `File: ${lbl}`, 'file', gd, lbl, parentCtx);
                        sendGitDiffContextToPanel(ctx, gd.graphId);
                    } else {
                        ctx.panelManager!.navigatePanel(sourcePanelId, gd.graphId, 'file', gd, lbl);
                    }
                }
            } else if (message.newWindow) {
                await openFileDiagramForPath(ctx, message.filePath);
            } else {
                openFileDiagramInPanel(ctx, message.filePath, sourcePanelId);
            }
        });
    }, MODULE);

    // ── openFunctionFlow ────────────────────────────────────────────────────
    register('openFunctionFlow', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'openFunctionFlow', async () => {
            const parentCtx = ctx.panelManager!.getPanelContext(sourcePanelId);
            const gitDiffState = ctx.getGitDiffState!(message?.repoId);
            if (gitDiffState) {
                const gd = gitDiffState.diffedGraphs[`flow:${message.filePath}:${message.functionName}`];
                if (gd) {
                    const lbl = `Flow: ${message.functionName}`;
                    if (message.newWindow) {
                        ctx.panelManager!.openPanel(gd.graphId, lbl, 'flow', gd, lbl, parentCtx);
                        sendGitDiffContextToPanel(ctx, gd.graphId);
                    } else {
                        ctx.panelManager!.navigatePanel(sourcePanelId, gd.graphId, 'flow', gd, lbl);
                    }
                }
            } else if (message.newWindow) {
                openFunctionFlowForPath(ctx, message.filePath, message.functionName);
            } else {
                openFunctionFlowInPanel(ctx, message.filePath, message.functionName, sourcePanelId);
            }
        });
    }, MODULE);

    // ── openFeatureDiagram / openFeatureForService ──────────────────────────
    register('openFeatureDiagram', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'openFeatureDiagram', async () => {
            const parentCtx = ctx.panelManager!.getPanelContext(sourcePanelId);
            const gitDiffState = ctx.getGitDiffState!(message?.repoId);
            const featureGraphId = message.serviceId ? `feature:${message.serviceId}` : 'feature:workspace';
            if (gitDiffState) {
                const gd = gitDiffState.diffedGraphs[featureGraphId];
                const lbl = message.serviceId ? `Features: ${message.serviceId.replace('service:', '')}` : 'Feature Clusters';
                if (gd) {
                    if (message.newWindow) {
                        ctx.panelManager!.openPanel(featureGraphId, lbl, 'feature', gd, lbl, parentCtx);
                        sendGitDiffContextToPanel(ctx, featureGraphId);
                    } else {
                        ctx.panelManager!.navigatePanel(sourcePanelId, featureGraphId, 'feature', gd, lbl);
                    }
                }
            } else if (message.newWindow) {
                openFeatureDiagram(ctx, message.serviceId);
            } else {
                openFeatureDiagramInPanel(ctx, message.serviceId, sourcePanelId);
            }
            revealServiceInSidebar(ctx, message.serviceId);
        });
    }, MODULE);

    register('openFeatureForService', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'openFeatureForService', async () => {
            const parentCtx = ctx.panelManager!.getPanelContext(sourcePanelId);
            const gitDiffState = ctx.getGitDiffState!(message?.repoId);

            // UX-18 part 2 (2026-06-03 v2) — Multi-repo L1 cards carry
            // `meta.repoId = <hex>`. When the click sends that hex as
            // serviceId, the legacy branch below tries `feature:<hex>`
            // against the aggregator (which has no per-repo cluster data)
            // and the user lands on an empty Feature Clusters page.
            // Resolve the repoId via the aggregator, then route to that
            // repo's per-repo `feature:workspace` graph.
            // Issue #790 #3 follow-on — drop `!gitDiffState` gate; see
            // openApiListForCluster for full rationale. surfaceLiveWorkingDiff()
            // sets a synthesized gitDiffState whenever working ≠ baseline by
            // hash, which inherits empty workspace placeholders for non-owning
            // sub-repos. Per-repo lookup recovers the real graph.
            if (
                ctx.aggregatorStore &&
                ctx.repoStoreRegistry &&
                message.serviceId
            ) {
                try {
                    const repos = ctx.aggregatorStore.listRepos();
                    const isMultiRepo = repos.length >= 2 && repos.some((r: any) => !!r.rootPath);
                    if (isMultiRepo) {
                        // UX-51 (2026-06-06) — the click can carry one of
                        // two forms in `serviceId`:
                        //   1. A repo's `repoId` (hex) — when the click
                        //      originates from an L1 service node whose
                        //      `meta.repoId` was set by the multi-repo
                        //      L1 builder (UX-18 part 2 path).
                        //   2. A service id (`service:<rootPath>` / `service:<name>`)
                        //      when the click originates from the home
                        //      page's UX-50 scope picker, which dispatches
                        //      the action recorded in `explorerData` —
                        //      that action's `serviceId` is the actual
                        //      Service.id, not a repoId.
                        // Try both. The picker shape (form 2) is the
                        // common case in practice, so check it first.
                        let matched: any = undefined;
                        const rawSid = String(message.serviceId);
                        const sidNoPrefix = rawSid.replace(/^service:/, '');
                        // #836B — when the click carries an explicit repo
                        // hint (the SPA threads the `#/system-design/<repo>`
                        // scope through `message.repoId`), it wins outright.
                        // Without it, a bare `service:main` falls into the
                        // store-scan fallback below, which resolves the
                        // FIRST repo exposing that id — the wrong repo's
                        // features on any workspace where sub-repos share
                        // the default service id. See ADR-038.
                        if (message.repoId) {
                            const hint = String(message.repoId);
                            for (const r of repos) {
                                const candidates = [r.repoId, r.name, r.rootPath].filter(Boolean) as string[];
                                if (candidates.includes(hint) || candidates.some((c) => c.endsWith('/' + hint))) {
                                    matched = r;
                                    break;
                                }
                            }
                        }
                        if (!matched) for (const r of repos) {
                            const candidates = [r.repoId, r.name, r.rootPath].filter(Boolean) as string[];
                            if (candidates.includes(rawSid) || candidates.includes(sidNoPrefix)) {
                                matched = r;
                                break;
                            }
                        }
                        // Fallback: search every per-repo store for a
                        // Service whose id matches; use the owning repo.
                        if (!matched) {
                            for (const r of repos) {
                                if (!r.rootPath) continue;
                                try {
                                    const absPath = path.join(ctx.workspaceRoot, r.rootPath);
                                    // Issue #790: must use Loaded variant —
                                    // the lazy `new SnapshotStore(repoRoot)`
                                    // returned by `getRepoStore` has an
                                    // empty in-memory state until `load()`
                                    // resolves, so the services lookup below
                                    // silently misses every service the
                                    // disk-resident `state.db` actually has.
                                    const repoStore = await ctx.repoStoreRegistry.getRepoStoreLoaded(absPath);
                                    const services = repoStore?.getWorking().services ?? {};
                                    if (services[rawSid] || services[`service:${sidNoPrefix}`]) {
                                        matched = r;
                                        break;
                                    }
                                } catch { /* ignore */ }
                            }
                        }
                        if (matched && matched.rootPath) {
                            const absPath = path.join(ctx.workspaceRoot, matched.rootPath);
                            // Issue #790 — same lazy-load fix as above.
                            const repoStore = await ctx.repoStoreRegistry.getRepoStoreLoaded(absPath);
                            const repoName = (matched as any).name ?? matched.rootPath;
                            // Per-repo stores hold `feature:service:<repoName>`
                            // (not `feature:workspace` — that one is empty in
                            // multi-repo mode because clustering runs per-repo).
                            // Fall back to plain `feature:workspace` for older
                            // repos that still emit it.
                            const perRepoGraphs = repoStore?.getWorking().graphs ?? {};
                            // UX-51 — try every plausible per-repo feature key.
                            // Stores may emit `feature:workspace`,
                            // `feature:service:<repoName>`, or
                            // `feature:service:<rootPath>`. Pick the first
                            // non-empty graph from the candidate set.
                            const candidates = [
                                `feature:service:${repoName}`,
                                `feature:service:${matched.rootPath}`,
                                'feature:workspace',
                                // Any feature:* graph if all of the above miss.
                                ...Object.keys(perRepoGraphs).filter(k => k.startsWith('feature:')),
                            ];
                            let featureGraph: DiagramGraph | undefined;
                            for (const k of candidates) {
                                const g = perRepoGraphs[k] as DiagramGraph | undefined;
                                if (g && (g.nodes?.length ?? 0) > 0) { featureGraph = g; break; }
                            }
                            if (!featureGraph) {
                                // 2026-06-09 — user-reported: L1 → L2a click on FIRST LAUNCH
                                // sometimes lands on nothing until a manual re-init. Cause: the
                                // per-repo store's lazy `feature:*` graphs are missing in this
                                // matched repo's snapshot (slow build path / cascade hadn't
                                // reached them yet / one specific service id never had its
                                // cluster pre-rendered). The pre-fix handler just logged and
                                // fell through to the workspace `buildFeatureGraphForService`,
                                // which reads from `ctx.snapshotStore` (the WORKSPACE store —
                                // empty in multi-repo mode) and produced a 0-cluster graph.
                                // Defensive on-demand build: build the per-repo feature graph
                                // straight from the per-repo snapshot here. Cheap (one
                                // detectCommunities pass over this sub-repo) and writes
                                // back so subsequent clicks hit the cached path.
                                try {
                                    const liveWorking = repoStore?.getWorking();
                                    if (liveWorking) {
                                        const baseline = repoStore?.getBaseline();
                                        const built = buildFeatureGraph(liveWorking, baseline, message.serviceId);
                                        if (built && (built.nodes?.length ?? 0) > 0) {
                                            repoStore!.updateWorkingGraph(built.graphId, built);
                                            featureGraph = built;
                                            ctx.log(`[openFeatureForService] multi-repo: on-demand build for ${repoName} → ${built.graphId} (${built.nodes.length} clusters)`);
                                        }
                                    }
                                } catch (err: any) {
                                    ctx.log(`[openFeatureForService] on-demand build failed for ${repoName}: ${err?.message ?? err}`);
                                }
                            }
                            if (featureGraph) {
                                const lbl = `Features: ${repoName}`;
                                // #845 — stamp the repo scope so the SPA's
                                // hash sync keeps `#/features/<repo>` instead
                                // of collapsing to bare `#/features` (served
                                // copy only; the stored graph stays pristine).
                                const scoped = {
                                    ...featureGraph,
                                    meta: { ...(featureGraph.meta ?? {}), scopedRepo: repoName },
                                };
                                if (message.newWindow) {
                                    ctx.panelManager!.openPanel(featureGraph.graphId, lbl, 'feature', scoped, lbl, parentCtx);
                                } else {
                                    ctx.panelManager!.navigatePanel(sourcePanelId, featureGraph.graphId, 'feature', scoped, lbl);
                                }
                                ctx.log(`[openFeatureForService] multi-repo: routed ${message.serviceId} → ${featureGraph.graphId} (${featureGraph.nodes?.length ?? 0} clusters)`);
                                return;
                            }
                            ctx.log(`[openFeatureForService] multi-repo: matched repo ${repoName} but no non-empty feature graph in ${absPath} (keys=${Object.keys(perRepoGraphs).filter(k=>k.startsWith('feature:')).join(',')})`);
                        }
                    }
                } catch (err: any) {
                    ctx.log(`[openFeatureForService] multi-repo branch failed (${err?.message ?? err}); falling back to single-repo`);
                }
            }

            const featureGraphId = message.serviceId ? `feature:${message.serviceId}` : 'feature:workspace';
            if (gitDiffState) {
                const gd = gitDiffState.diffedGraphs[featureGraphId];
                const lbl = message.serviceId ? `Features: ${message.serviceId.replace('service:', '')}` : 'Feature Clusters';
                if (gd) {
                    if (message.newWindow) {
                        ctx.panelManager!.openPanel(featureGraphId, lbl, 'feature', gd, lbl, parentCtx);
                        sendGitDiffContextToPanel(ctx, featureGraphId);
                    } else {
                        ctx.panelManager!.navigatePanel(sourcePanelId, featureGraphId, 'feature', gd, lbl);
                    }
                }
            } else if (message.newWindow) {
                openFeatureDiagram(ctx, message.serviceId);
            } else {
                openFeatureDiagramInPanel(ctx, message.serviceId, sourcePanelId);
            }
            revealServiceInSidebar(ctx, message.serviceId);
        });
    }, MODULE);

    // ── openMicroserviceDiagram ─────────────────────────────────────────────
    register('openMicroserviceDiagram', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'openMicroserviceDiagram', async () => {
            const parentCtx = ctx.panelManager!.getPanelContext(sourcePanelId);
            const gitDiffState = ctx.getGitDiffState!(message?.repoId);
            if (gitDiffState) {
                const gd = gitDiffState.diffedGraphs['microservice:workspace'];
                if (gd) {
                    if (message.newWindow) {
                        ctx.panelManager!.openPanel('microservice:workspace', 'System Design', 'microservice', gd, 'System Design', parentCtx);
                        sendGitDiffContextToPanel(ctx, 'microservice:workspace');
                    } else {
                        ctx.panelManager!.navigatePanel(sourcePanelId, 'microservice:workspace', 'microservice', gd, 'System Design');
                    }
                }
            } else if (message.newWindow) {
                openMicroserviceDiagram(ctx);
            } else {
                openMicroserviceDiagramInPanel(ctx, sourcePanelId);
            }
            vscode.commands.executeCommand('codeatlas.microserviceExplorer.focus');
        });
    }, MODULE);

    // ── openMapDiagram (Issue #700 / #731) ─────────────────────────────────
    register('openMapDiagram', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'openMapDiagram', async () => {
            const parentCtx = ctx.panelManager!.getPanelContext(sourcePanelId);
            const gitDiffState = ctx.getGitDiffState!(message?.repoId);
            if (gitDiffState) {
                const gd = gitDiffState.diffedGraphs['map:workspace'];
                if (gd) {
                    if (message.newWindow) {
                        ctx.panelManager!.openPanel('map:workspace', 'Knowledge Map', 'map', gd, 'Knowledge Map', parentCtx);
                        sendGitDiffContextToPanel(ctx, 'map:workspace');
                    } else {
                        ctx.panelManager!.navigatePanel(sourcePanelId, 'map:workspace', 'map', gd, 'Knowledge Map');
                    }
                    return;
                }
                // Fall through if the git-diff state hasn't pre-built the
                // map graph — better to show fresh working state than a
                // "diagram not found" toast.
            }
            if (message.newWindow) {
                openMapDiagram(ctx);
            } else {
                openMapDiagramInPanel(ctx, sourcePanelId);
            }
        });
    }, MODULE);

    // ── openDomainDiagram (Issue #701 / #743) ──────────────────────────────
    register('openDomainDiagram', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'openDomainDiagram', async () => {
            const parentCtx = ctx.panelManager!.getPanelContext(sourcePanelId);
            const gitDiffState = ctx.getGitDiffState!(message?.repoId);
            if (gitDiffState) {
                const gd = gitDiffState.diffedGraphs['domain:workspace'];
                if (gd) {
                    if (message.newWindow) {
                        ctx.panelManager!.openPanel('domain:workspace', 'Domain Map', 'domain', gd, 'Domain Map', parentCtx);
                        sendGitDiffContextToPanel(ctx, 'domain:workspace');
                    } else {
                        ctx.panelManager!.navigatePanel(sourcePanelId, 'domain:workspace', 'domain', gd, 'Domain Map');
                    }
                    return;
                }
            }
            if (message.newWindow) {
                openDomainDiagram(ctx);
            } else {
                openDomainDiagramInPanel(ctx, sourcePanelId);
            }
        });
    }, MODULE);

    // ── openApiListForCluster ───────────────────────────────────────────────
    register('openApiListForCluster', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'openApiListForCluster', async () => {
            const parentCtx = ctx.panelManager!.getPanelContext(sourcePanelId);
            const gitDiffState = ctx.getGitDiffState!(message?.repoId);
            const apiListGraphId = `api-list:${message.clusterId}`;

            // 2026-06-04 (UX-24 follow-up) — multi-repo: route to per-repo
            // store's api-list graph so SAM-derived routes surface.
            // Issue #790 #3 follow-on — removed the `!gitDiffState` gate
            // because `surfaceLiveWorkingDiff()` can synthesize a non-null
            // gitDiffState from any baseline-vs-working hash drift, and the
            // diff entry inherits empty workspace placeholders for non-
            // owning sub-repos. Per-repo lookup recovers the real data; the
            // gitDiffState branch below still applies the diff overlay if
            // a meaningful per-cluster entry exists in `diffedGraphs`.
            if (ctx.aggregatorStore && ctx.repoStoreRegistry && message.clusterId) {
                try {
                    const repos = ctx.aggregatorStore.listRepos();
                    const isMultiRepo = repos.length >= 2 && repos.some((r: any) => !!r.rootPath);
                    if (isMultiRepo) {
                        // First pass — accept a pre-built non-empty per-repo
                        // api-list graph if any sub-repo has one.
                        for (const r of repos) {
                            if (!r.rootPath) continue;
                            const absPath = path.join(ctx.workspaceRoot, r.rootPath);
                            const repoStore = await ctx.repoStoreRegistry.getRepoStoreLoaded(absPath);
                            const graph: any = repoStore?.getWorking().graphs[apiListGraphId];
                            if (graph && (graph.nodes?.length ?? graph.meta?.apis?.length ?? 0) > 0) {
                                const lbl = `${entryPointsNounForGraph(graph)}: ${String(message.clusterId).replace(/^cluster:/, '')}`;
                                if (message.newWindow) {
                                    ctx.panelManager!.openPanel(apiListGraphId, lbl, 'api-list', graph, lbl, parentCtx);
                                } else {
                                    ctx.panelManager!.navigatePanel(sourcePanelId, apiListGraphId, 'api-list', graph, lbl);
                                }
                                ctx.log(`[openApiListForCluster] multi-repo: routed ${apiListGraphId} from ${r.name ?? r.repoId}`);
                                return;
                            }
                        }
                        // 2026-06-09 fallback — every `api-list:cluster:*` row
                        // in workspace + per-repo stores ships empty because
                        // cluster.apisInCluster is never populated during
                        // the per-repo build pass. Synthesize the L2b list
                        // by joining the workspace cluster's `files` with
                        // the owning per-repo `apiIndex`.
                        // 2026-06-09 — clusterId collisions across sub-repos
                        // (e.g. every repo has a generic `cluster:model`) mean
                        // the workspace store keeps only one. Prefer the
                        // per-repo cluster identified by `message.serviceId`
                        // (which the L2a click attaches) before falling back
                        // to the workspace's clusters map.
                        const msgServiceId = String(message.serviceId ?? '').replace(/^service:/, '');
                        let wcluster: any = null;
                        let repoCtx: { rootPath: string; absPath: string } | null = null;
                        if (msgServiceId) {
                            const m = repos.find((r: any) => r.name === msgServiceId || r.rootPath === msgServiceId || r.repoId === msgServiceId);
                            if (m?.rootPath) {
                                const absPath = path.join(ctx.workspaceRoot, m.rootPath);
                                const repoStore = await ctx.repoStoreRegistry.getRepoStoreLoaded(absPath);
                                const candidate: any = repoStore?.getWorking().clusters?.[message.clusterId];
                                if (candidate) { wcluster = candidate; repoCtx = { rootPath: m.rootPath, absPath }; }
                            }
                        }
                        if (!wcluster) {
                            wcluster = ctx.snapshotStore!.getWorking().clusters?.[message.clusterId];
                        }
                        if (wcluster) {
                            const repoName = repoCtx ? repoCtx.rootPath : String(wcluster.serviceId ?? '').replace(/^service:/, '');
                            const matched = repoCtx
                                ? { rootPath: repoCtx.rootPath, absPath: repoCtx.absPath }
                                : (() => {
                                    const m = repos.find((r: any) => r.name === repoName || r.rootPath === repoName || r.repoId === repoName);
                                    return m?.rootPath ? { rootPath: m.rootPath, absPath: path.join(ctx.workspaceRoot, m.rootPath) } : null;
                                })();
                            if (matched?.rootPath) {
                                const absPath = matched.absPath;
                                const repoStore = await ctx.repoStoreRegistry.getRepoStoreLoaded(absPath);
                                const repoWorking: any = repoStore?.getWorking();
                                const apiIndex: any = repoWorking?.apiIndex ?? {};
                                const fileSet = new Set<string>((wcluster.files ?? []) as string[]);
                                const apis: any[] = [];
                                for (const a of Object.values(apiIndex) as any[]) {
                                    if (!a) continue;
                                    if (fileSet.size > 0 && a.filePath && !fileSet.has(a.filePath)) continue;
                                    apis.push(a);
                                }
                                if (apis.length > 0) {
                                    const isUiKind = (m: string) => ['SCREEN', 'NAV_ROUTE', 'NETWORK', 'DI_BINDING'].includes(m);
                                    const synth = {
                                        graphId: apiListGraphId,
                                        type: 'api-list',
                                        nodes: [],
                                        edges: [],
                                        anchors: {},
                                        meta: {
                                            clusterId: wcluster.id,
                                            clusterLabel: wcluster.label ?? wcluster.name ?? wcluster.id,
                                            serviceId: wcluster.serviceId,
                                            apis: apis.filter((a: any) => !isUiKind(a.method)),
                                            screens: apis.filter((a: any) => a.method === 'SCREEN'),
                                            navRoutes: apis.filter((a: any) => a.method === 'NAV_ROUTE'),
                                            networkCalls: apis.filter((a: any) => a.method === 'NETWORK'),
                                            diBindings: apis.filter((a: any) => a.method === 'DI_BINDING'),
                                            files: wcluster.files ?? [],
                                            entryPoints: wcluster.entryPoints ?? [],
                                            subsystems: [],
                                            excludedApiCount: 0,
                                            synthesizedFromPerRepoApiIndex: true,
                                        },
                                    } as any;
                                    const lbl = `${entryPointsNounForGraph(synth)}: ${String(message.clusterId).replace(/^cluster:/, '')}`;
                                    if (message.newWindow) {
                                        ctx.panelManager!.openPanel(apiListGraphId, lbl, 'api-list', synth, lbl, parentCtx);
                                    } else {
                                        ctx.panelManager!.navigatePanel(sourcePanelId, apiListGraphId, 'api-list', synth, lbl);
                                    }
                                    ctx.log(`[openApiListForCluster] multi-repo: synthesized ${apiListGraphId} from per-repo apiIndex (${apis.length} apis)`);
                                    return;
                                }
                            }
                        }
                    }
                } catch (err: any) {
                    ctx.log(`[openApiListForCluster] multi-repo branch failed: ${err?.message ?? err}`);
                }
            }

            if (gitDiffState) {
                const gd = gitDiffState.diffedGraphs[apiListGraphId];
                const lbl = `${entryPointsNounForGraph(gd)}: ${message.clusterId}`;
                if (gd) {
                    if (message.newWindow) {
                        ctx.panelManager!.openPanel(apiListGraphId, lbl, 'api-list', gd, lbl, parentCtx);
                        sendGitDiffContextToPanel(ctx, apiListGraphId);
                    } else {
                        ctx.panelManager!.navigatePanel(sourcePanelId, apiListGraphId, 'api-list', gd, lbl);
                    }
                }
            } else if (message.newWindow) {
                openApiListPanel(ctx, message.clusterId, message.serviceId, message.subClusterFiles);
            } else {
                openApiListPanelInPanel(ctx, message.clusterId, message.serviceId, sourcePanelId, message.subClusterFiles);
            }
            revealClusterInSidebar(ctx, message.clusterId);
        });
    }, MODULE);

    // ── openSequenceForApi ──────────────────────────────────────────────────
    register('openSequenceForApi', (message, sourcePanelId) => {
        withErrorHandling(ctx, 'openSequenceForApi', async () => {
            // Bug 3: ensure live sequence-graph annotations reflect the
            // latest L4/L5 inline diffs before serving the panel. Without
            // this, message arrows and labels for changed handlers stay
            // black (`unchanged`) even though the function body itself is
            // marked modified in the flow graph.
            ctx.syncOrchestrator!.applyDiffCascadeToLiveGraphs();
            const parentCtx = ctx.panelManager!.getPanelContext(sourcePanelId);
            const gitDiffState = ctx.getGitDiffState!(message?.repoId);
            // Issue 405 root cause (2026-05-13): `gitDiffState.apiIndex` is a
            // SEPARATE object captured at the time `replayWorkingDiff` ran
            // — it's not a live view onto the working snapshot. After init
            // repopulates `state.working.apiIndex`, the captured copy in
            // `gitDiffState.apiIndex` can still be empty (built from
            // baseline + working at a moment when one or both were empty,
            // e.g. mid-init race) even though the live snapshot is full.
            // Fall back to `store.getWorking().apiIndex` when the captured
            // copy is empty AND we're in live-diff mode (baselineHash=
            // 'baseline', headHash='working') — that's the live cascade,
            // not a frozen commit diff.
            let apiIndex = gitDiffState
                ? gitDiffState.apiIndex
                : ctx.snapshotStore.getWorking().apiIndex;
            if (
                gitDiffState &&
                Object.keys(apiIndex).length === 0 &&
                gitDiffState.baseHash === 'baseline' &&
                gitDiffState.headHash === 'working'
            ) {
                apiIndex = ctx.snapshotStore.getWorking().apiIndex;
                ctx.log(`[openSequenceForApi] gitDiffState.apiIndex empty; falling back to live store. live size=${Object.keys(apiIndex).length}`);
            }
            const graphs = gitDiffState
                ? gitDiffState.diffedGraphs
                : ctx.snapshotStore.getWorking().graphs;
            // Issue 405: O(1) direct-key lookup first — apiIndex is keyed
            // by apiId so this is the contract-correct access. Fall back to
            // a scan of `.apiId` fields only when the direct key misses,
            // covering legacy records whose key drifted from their .apiId.
            // Final defensive fallback: scan cluster.apisInCluster — when
            // apiIndex has been clobbered (still investigating which write
            // path is at fault), the cluster snapshot's parallel copy of
            // the api records is the most reliable source.
            let api: import('../core/graph/graphTypes').ApiRecord | undefined =
                apiIndex[message.apiId]
                ?? Object.values(apiIndex).find((a) => a.apiId === message.apiId);
            // 2026-06-09 — multi-repo apiId collision. The workspace
            // apiIndex deduplicates `sls:deleteUser:...` to one record
            // (last-write-wins), so a user drilling from the
            // aws-node-http-api-mongodb L2b lands in the
            // aws-node-rest-api-mongodb handler. Prefer the per-repo
            // store whose owning serviceId matches `message.serviceId`;
            // pass the canonical per-repo api record (correct filePath
            // and sequence graph) through to the panel builder.
            if (ctx.aggregatorStore && ctx.repoStoreRegistry) {
                const msgService = String(message.serviceId ?? '').replace(/^service:/, '');
                const wsApiFilePath = api?.filePath ?? '';
                const repos = ctx.aggregatorStore.listRepos();
                const isMultiRepo = repos.length >= 2 && repos.some((r: any) => !!r.rootPath);
                if (isMultiRepo) {
                    const ambiguous = !!api && msgService && !wsApiFilePath.startsWith(msgService + '/');
                    if (!api || ambiguous) {
                        const ordered = msgService
                            ? [...repos.filter((r: any) => r.name === msgService || r.rootPath === msgService || r.repoId === msgService), ...repos.filter((r: any) => r.name !== msgService && r.rootPath !== msgService && r.repoId !== msgService)]
                            : repos;
                        for (const r of ordered) {
                            if (!r.rootPath) continue;
                            const absPath = path.join(ctx.workspaceRoot, r.rootPath);
                            const repoStore = await ctx.repoStoreRegistry.getRepoStoreLoaded(absPath);
                            const repoWorking: any = repoStore?.getWorking();
                            const candidate = repoWorking?.apiIndex?.[message.apiId]
                                ?? Object.values(repoWorking?.apiIndex ?? {}).find((a: any) => a?.apiId === message.apiId);
                            if (candidate) {
                                api = candidate as import('../core/graph/graphTypes').ApiRecord;
                                const candidateGraphId = `sequence:${(candidate as any).filePath}:${(candidate as any).handlerName}`;
                                const repoGraph = repoWorking?.graphs?.[candidateGraphId];
                                if (repoGraph) (graphs as any)[candidateGraphId] = repoGraph;
                                ctx.log(`[openSequenceForApi] multi-repo: routed apiId=${message.apiId} → ${(candidate as any).filePath} from ${r.name ?? r.repoId}`);
                                break;
                            }
                        }
                    }
                }
            }
            if (!api) {
                const w = ctx.snapshotStore.getWorking();
                for (const c of Object.values(w.clusters ?? {})) {
                    const arr = (c as any).apisInCluster as Array<import('../core/graph/graphTypes').ApiRecord> | undefined;
                    if (!Array.isArray(arr)) continue;
                    const hit = arr.find((a) => a.apiId === message.apiId);
                    if (hit) {
                        api = hit;
                        ctx.log(`[openSequenceForApi] recovered from cluster.apisInCluster for ${message.apiId}`);
                        break;
                    }
                }
            }
            if (api) {
                const graphId = `sequence:${api.filePath}:${api.handlerName}`;
                const seqLabel = `${api.method} ${api.route}`;
                let graph: any = graphs[graphId];
                // 2026-06-09 — fallback to L5 flowchart when the sequence
                // is empty. Terminal handlers (most Serverless Lambdas, single-
                // function CLI commands, simple webhook receivers) have no
                // intra-service call chain, so the sequence graph has 0 nodes
                // and the user lands on a dead "no participants" placeholder.
                // The control-flow chart for the same handler is the most
                // useful next-best view: shows entry → branches → calls →
                // return. Stamp meta.fallbackFromSequence so SPA can show
                // "Showing flow chart for <handler> — no call chain detected."
                const empty = !graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0;
                if (empty) {
                    const flowGraphId = `flow:${api.filePath}:${api.handlerName}`;
                    let flowGraph: any = graphs[flowGraphId];
                    // Multi-repo: also try per-repo store for the flow graph.
                    if (!flowGraph || (Array.isArray(flowGraph.nodes) && flowGraph.nodes.length === 0)) {
                        if (ctx.aggregatorStore && ctx.repoStoreRegistry) {
                            try {
                                const repos = ctx.aggregatorStore.listRepos();
                                for (const r of repos) {
                                    if (!r.rootPath) continue;
                                    const absPath = path.join(ctx.workspaceRoot, r.rootPath);
                                    const repoStore = await ctx.repoStoreRegistry.getRepoStoreLoaded(absPath);
                                    const cand: any = repoStore?.getWorking().graphs?.[flowGraphId];
                                    if (cand && Array.isArray(cand.nodes) && cand.nodes.length > 0) { flowGraph = cand; break; }
                                }
                            } catch (err: any) {
                                ctx.log(`[openSequenceForApi] flow fallback per-repo lookup failed: ${err?.message ?? err}`);
                            }
                        }
                    }
                    if (flowGraph && Array.isArray(flowGraph.nodes) && flowGraph.nodes.length > 0) {
                        const fallbackGraph = {
                            ...flowGraph,
                            meta: {
                                ...(flowGraph.meta ?? {}),
                                fallbackFromSequence: true,
                                originalApi: { method: api.method, route: api.route, handler: api.handlerName, apiId: api.apiId },
                            },
                        };
                        const flowLabel = `Flow: ${api.handlerName}`;
                        if (message.newWindow) {
                            ctx.panelManager!.openPanel(flowGraphId, flowLabel, 'flow', fallbackGraph, flowLabel, parentCtx);
                        } else {
                            ctx.panelManager!.navigatePanel(sourcePanelId, flowGraphId, 'flow', fallbackGraph, flowLabel);
                        }
                        ctx.log(`[openSequenceForApi] empty sequence — fell back to flow chart for ${api.handlerName} (${flowGraph.nodes.length} nodes)`);
                        revealApiInSidebar(ctx, api.apiId);
                        return;
                    }
                }
                // #839 (2026-06-11) — no sequence graph AND no flow fallback
                // (IaC routes whose handler the sequence builder skipped —
                // the .NET Serverless case live). Navigating with an
                // undefined graph left the SPA on "Loading…" forever. Fall
                // back to the L4 file diagram (built for every parsed file),
                // and NEVER dispatch an undefined graph; see ADR-039.
                if (!graph) {
                    const fileGraphId = `file:${api.filePath}`;
                    let fileGraph: any = graphs[fileGraphId];
                    if ((!fileGraph || !fileGraph.nodes?.length) && ctx.aggregatorStore && ctx.repoStoreRegistry) {
                        try {
                            for (const r of ctx.aggregatorStore.listRepos()) {
                                if (!r.rootPath) continue;
                                const absPath = path.join(ctx.workspaceRoot, r.rootPath);
                                const repoStore = await ctx.repoStoreRegistry.getRepoStoreLoaded(absPath);
                                const cand: any = repoStore?.getWorking().graphs?.[fileGraphId];
                                if (cand && Array.isArray(cand.nodes) && cand.nodes.length > 0) { fileGraph = cand; break; }
                            }
                        } catch (err: any) {
                            ctx.log(`[openSequenceForApi] file fallback per-repo lookup failed: ${err?.message ?? err}`);
                        }
                    }
                    if (fileGraph && Array.isArray(fileGraph.nodes) && fileGraph.nodes.length > 0) {
                        const fbGraph = {
                            ...fileGraph,
                            meta: {
                                ...(fileGraph.meta ?? {}),
                                fallbackFromSequence: true,
                                originalApi: { method: api.method, route: api.route, handler: api.handlerName, apiId: api.apiId },
                            },
                        };
                        const fbLabel = `File: ${api.filePath.split('/').pop()}`;
                        if (message.newWindow) {
                            ctx.panelManager!.openPanel(fileGraphId, fbLabel, 'file', fbGraph, fbLabel, parentCtx);
                        } else {
                            ctx.panelManager!.navigatePanel(sourcePanelId, fileGraphId, 'file', fbGraph, fbLabel);
                        }
                        ctx.notifyBrowser('info', `No sequence diagram for ${api.method} ${api.route} — showing the handler's file diagram.`);
                        ctx.log(`[openSequenceForApi] no sequence/flow graph — fell back to file diagram for ${api.filePath}`);
                        revealApiInSidebar(ctx, api.apiId);
                        return;
                    }
                    ctx.log(`[openSequenceForApi] no sequence/flow/file graph for ${api.apiId} — not navigating`);
                    ctx.notifyBrowser('warning', `No diagram available yet for ${api.method} ${api.route}.`);
                    return;
                }
                if (message.newWindow) {
                    ctx.panelManager!.openPanel(graphId, `Sequence: ${seqLabel}`, 'sequence', graph, seqLabel, parentCtx);
                    if (gitDiffState) sendGitDiffContextToPanel(ctx, graphId);
                } else {
                    ctx.panelManager!.navigatePanel(sourcePanelId, graphId, 'sequence', graph, seqLabel);
                }
                revealApiInSidebar(ctx, api.apiId);
            } else {
                ctx.log(`[openSequenceForApi] miss for ${message.apiId} — apiIndex size=${Object.keys(apiIndex).length}`);
                vscode.window.showWarningMessage(`CodeAtlas: API "${message.apiId}" not found.`);
                // Issue 406: was duplicated — emit once.
                ctx.notifyBrowser('warning', `API "${message.apiId}" not found.`);
            }
        });
    }, MODULE);

    // ── navigateHome (Issue 111 — No "Home/L1" reset button from deep layers) ────────────────────────────────────────────
    register('navigateHome', (_message, sourcePanelId) => {
        withErrorHandling(ctx, 'navigateHome', async () => {
            // #838 follow-up (2026-06-11, user repro via the Tour breadcrumb):
            // serving the workspace store's RAW copy here bypassed the
            // ADR-037 ownership rule — on multi-repo monorepos the raw copy
            // is the polluted 133-service wall, not the bucketed view.
            // `buildMicroserviceGraphCached` prefers the aggregator's
            // skeletal/bucketed L1 in multi-repo and behaves identically to
            // the old read in single-repo mode.
            const l1Graph = buildMicroserviceGraphCached(ctx);
            if (l1Graph) {
                // UX-20: use the same label heuristic as openMicroserviceDiagram so
                // the breadcrumb doesn't churn between "System Design: <repo>" here
                // and the cached path elsewhere.
                ctx.panelManager!.navigatePanel(sourcePanelId, 'microservice:workspace', 'microservice', l1Graph, microserviceLabel(l1Graph as DiagramGraph));
            }
        });
    }, MODULE);
}
