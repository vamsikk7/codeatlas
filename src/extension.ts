import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { isAllowedWhenSignedOut, workspaceAuthFields } from './lib/browserAuthGate';
import { SnapshotStore } from './core/storage/snapshotStore';
import { AggregatorStore } from './core/storage/aggregatorStore';
import { RepoStoreRegistry } from './core/storage/repoStoreRegistry';
import { aggregateMultiRepoCounts } from './core/storage/workspaceInfoAggregator';
import { mergeGraphsForView } from './core/storage/graphViewMerge';
import { isHeadlineApiRecord } from './core/graph/entryPointCounts';
import { pickerSubtitle, repoCategoryFromServices } from './core/graph/pickerLabels';
import { buildScopedSubRepoMapGraph, foldPerRepoMapGraphs } from './core/graph/scopedSubRepoView';
import { detectInfrastructureServices } from './core/analysis/serviceDetector';
import { WorkspaceOrchestrator, type RepoOrchestratorRunner } from './core/sync/workspaceOrchestrator';
import { WorkspaceWatcher } from './core/sync/workspaceWatcher';
import { vscodeFileSystemWatcherFactory } from './core/sync/vscodeFileSystemWatcherFactory';
import { registerDefaultCrossRepoAnalyzers } from './core/analysis/registerCrossRepoAnalyzers';
import { acquireWorkspaceLock, readLockOwner, watchPreemptRequest, watchLockReclaimable, clearPreemptRequest, readPreemptRequest, type AcquiredLock } from './core/storage/workspaceLock';
import { forEachGraph } from './core/storage/lazyGraphMap';
import { GitDiffStore, type PersistedGitDiffState } from './core/storage/gitDiffStore';
import { GitDiffStateRegistry } from './core/storage/gitDiffStateRegistry';
import { resolveRepoFromArg } from './handlers/resolveRepoFromArg';
import { PerRepoDebouncer } from './core/sync/perRepoDebouncer';
import { filterMicroserviceGraphForRepo } from './core/graph/scopedMicroserviceGraphFilter';
import { filterMapGraphForRepo } from './core/graph/scopedMapGraphFilter';
import { perRepoGitignoreToGlobs, type GitignoreSource } from './core/sync/perRepoGitignore';
import { CommentStore } from './core/storage/commentStore';
import { SyncOrchestrator } from './core/sync/syncOrchestrator';
import { multiRepoStoresPopulated } from './core/sync/multiRepoGuards';
import { resolvePerRepoGraph } from './core/sync/perRepoGraphResolver';
import { buildCrossRepoEdges } from './core/sync/skeletalL1';
import { SourceNavigator } from './core/navigation/sourceNavigator';
import { safeResolve } from './core/navigation/pathValidator';
import { resolveUnderRoot } from './core/navigation/pathUtils';
import { ApiExplorerProvider, ApiTreeItem } from './views/apiExplorerProvider';
import { FileExplorerProvider } from './views/fileExplorerProvider';
import { FunctionExplorerProvider } from './views/functionExplorerProvider';
import { ChangedItemsProvider } from './views/changedItemsProvider';
import { CommentsProvider } from './views/commentsProvider';
import { FeatureExplorerProvider, FeatureTreeItem } from './views/featureExplorerProvider';
import { MicroserviceExplorerProvider, ServiceTreeItem } from './views/microserviceExplorerProvider';
import { PanelManager } from './views/webview/panelManager';
import { WelcomeProvider } from './views/welcomeProvider';
import { openWelcomeWebview, setBrowserPort } from './views/welcomeWebview';
import { ClerkAuthService } from './auth/clerkAuthService';
import { buildFileGraph } from './core/graph/fileGraphBuilder';
import { buildFlowGraph, buildFlowGraphFromNode, buildFlowGraphFromBody } from './core/graph/flowGraphBuilder';
import { findAnonymousRouteBody } from './core/parser/anonRouteFinder';
import { buildFeatureGraph } from './core/graph/featureGraphBuilder';
import { buildMicroserviceGraph } from './core/graph/microserviceGraphBuilder';
import { buildMapGraph } from './core/graph/mapGraphBuilder';
import { collectTopLevelEntities } from './core/parser/symbolExtractor';
import { setGrammarsDir, detectLanguage, SUPPORTED_EXTENSIONS_GLOB, SUPPORTED_FILE_REGEX } from './core/parser/treeSitterParser';
import { extractFileSymbolsMultiLang } from './core/parser/treeSitterExtractor';
import type { ApiRecord, DiagramGraph, FeatureCluster, ServiceRecord, Snapshot } from './core/graph/graphTypes';
import { analyzeImpact } from './core/analysis/impactAnalyzer';
import { computeExtractionConfidence } from './core/analysis/extractionConfidence';
import { executeAiReview, clearReviewCache, estimateTokenUsage, isTimeoutError as isReviewTimeout } from './core/llm/aiReviewEngine';
import type { AiReviewResult } from './core/llm/aiReviewTypes';
import { computeApiDiff } from './core/diff/apiDiff';
import { getLspFallbackResolver, disposeLspFallbackResolver } from './core/lsp/lspFallbackResolver';
import type { DefinitionLocation } from './core/lsp/lspClient';
import { LlmNamingService } from './core/llm/llmNamingService';
import { exportArchitectureDocs } from './core/export/markdownExporter';
import { writeCommentsMd } from './core/export/commentsExporter';
import { ChangeLog, type ChangeDetail } from './core/replay/changeLog';
import { ImpactReplayOrchestrator } from './core/replay/impactReplayOrchestrator';
import { CommitTimelineReplay } from './core/replay/commitTimelineReplay';
import { loadCoverageData } from './core/analysis/coverageReader';
import type { HealthReport } from './core/graph/graphTypes';
import { listCommits, listBranches, resolveRef, mergeBase } from './core/git/gitReader';
import { buildCommitDiffGraphs, upgradeFileDiffAnnotations, upgradeSequenceDiffAnnotations, upgradeServiceClusterDiffAnnotations, buildApiListGraphsForSnapshots } from './core/git/commitDiffer';
import { diffGraphs } from './core/diff/graphDiff';
import { getGithubRemote, fetchGitHubPr, ensureCommitAvailable, listGitHubPrs } from './core/git/githubReader';
import { PrWatcher, createFileLedger, listOpenPrsGithub } from './core/review/prWatcher';
import { reviewPrInClone } from './core/review/prCloneRunner';
import { analytics } from './analytics/mixpanelService';
import { shouldRemindOpenSource } from './lib/ossReminder';
import { FeatureFlagClient } from './core/config/featureFlags';
import { WsBridge } from './server/wsBridge';
import type { HandlerContext } from './handlers/handlerContext';
import { createMessageRouter } from './handlers/messageRouter';
import { registerNavigationHandlers, buildMicroserviceGraphCached as buildMicroserviceGraphCachedHandler, microserviceLabel } from './handlers/navigationHandlers';
import { registerGitDiffHandlers } from './handlers/gitDiffHandlers';
import { registerReplayHandlers } from './handlers/replayHandlers';
import { registerAiReviewHandlers } from './handlers/aiReviewHandlers';
import { registerCommentHandlers } from './handlers/commentHandlers';
import { registerToolHandlers } from './handlers/toolHandlers';
import { registerPrWatcherHandlers } from './handlers/prWatcherHandlers';
import { registerOauth2Handlers } from './handlers/oauth2Handlers';
import { registerWsSseHandlers } from './handlers/wsSseHandlers';
import { registerAiGenerationHandlers } from './handlers/aiGenerationHandlers';
import { registerSavedViewsHandlers } from './handlers/savedViewsHandlers';
import { registerExportHandlers } from './handlers/exportHandlers';
import { registerReplayCommands } from './handlers/replayCommands';
import { registerCommentCommands } from './handlers/commentCommands';
import { registerThemeCommands } from './handlers/themeCommands';
import { registerOpenDiagramCommands } from './handlers/openDiagramCommands';
import { registerExplorerSearchCommands } from './handlers/explorerSearchCommands';
import { registerExportFileCommands } from './handlers/exportFileCommands';
import { registerGitDiffCommands } from './handlers/gitDiffCommands';
import { parseGraphId } from './core/graph/graphIdBuilder';

// Clerk publishable key — the frontend API host is derived from this automatically
const CLERK_PUBLISHABLE_KEY = 'pk_live_Y2xlcmsuY29kZWF0bGFzLmxpdmUk';
// URL of the hosted auth-page/index.html (deploy to GitHub Pages, Vercel, etc.)
const CLERK_AUTH_PAGE_URL = 'https://www.codeatlas.live/auth';
// Feature-flag JSON endpoint. ADR-023 / Issue 370 — fail-open: when this URL
// is unreachable or returns malformed JSON, every flag returns `true` and
// the product behaves as if no flag is set. The endpoint is provisioned
// out-of-band (operational task); until it exists, every flag is fail-open
// by default. Override via `CODEATLAS_FEATURE_FLAGS_URL` at build time.
const FEATURE_FLAGS_URL = process.env.CODEATLAS_FEATURE_FLAGS_URL || 'https://www.codeatlas.live/flags.json';

let syncOrchestrator: SyncOrchestrator;
let snapshotStore: SnapshotStore;
// Module-scope so every workspace-resync call site (incl. command handlers
// registered outside activate()'s lexical scope) can route through the
// multi-repo-safe resync helper below.
// Assigned at the top of every activate() pass, before any resync-capable
// handler can fire (definite-assignment: handlers only run post-activation).
let workspaceOrchestrator!: WorkspaceOrchestrator;

// Sticky multi-repo marker. `workspaceIsMulti` is reset to false at the top of
// every activate() pass and (in Tier-2) `perRepoOrchestrators` can be as small
// as 1 or momentarily empty, so neither is a reliable resync-time signal. Once
// init reports mode=multi we latch this true and never clear it, so EVERY
// resync path (git events / command / clear-diff) reliably avoids the
// monolithic single-store rebuild that hangs/OOMs on large workspaces.
let detectedMultiRepo = false;

/**
 * The ONE safe way to re-sync the whole workspace. For MULTI-repo, the
 * monolithic `syncOrchestrator.resync()` merges every repo into a single store
 * and HANGS in finalize/save on large workspaces (polar: ~19.6k graphs) — so
 * git events, the resyncEverything command, clear-diff and reset-baseline all
 * route here, and multi-repo takes the distributed per-repo path (each repo
 * rebuilds its own store, then the aggregator baseline rotates atomically).
 * Gate on the live `perRepoOrchestrators.size` signal, not the `workspaceIsMulti`
 * flag which is reset to false at the top of every activate() pass.
 */
async function resyncWorkspaceSafe(): Promise<void> {
    // Multi-repo ⇒ distributed per-repo resync (the monolithic single-store
    // path hangs/OOMs on large workspaces). Prefer the sticky `detectedMultiRepo`
    // latch; `workspaceIsMulti`/`perRepoOrchestrators.size` are timing-fragile.
    const multi = detectedMultiRepo || workspaceIsMulti || perRepoOrchestrators.size > 0;
    if (multi) {
        await workspaceOrchestrator.resync();
    } else {
        await syncOrchestrator.resync();
    }
    // PERF — a resync rebuilds every graph; drop the cached unified view.
    invalidateMergedGraphsView();
}
// Issue #790 #8 follow-up — hoisted from activate() so the module-scope
// `buildMicroserviceGraphCached` can read them and union per-repo data
// into the L1 graph in monorepo mode (without this, the multi-repo path
// can't reach `perRepoOrchestrators`).
let workspaceIsMulti = false;
const perRepoOrchestrators = new Map<string, SyncOrchestrator>();
// PERF (L1 open latency) — the multi-repo `system-design` route rebuilds a
// sub-repo's microservice graph FRESH on EVERY open (re-runs infra detection
// with a re-hydrated file-content scan, ~1.5s), even though the underlying
// data hasn't changed — so re-opening L1 felt like a 10-15s hang. Cache the
// enriched result keyed by the sub-repo's STORED `microservice:workspace`
// graph object: `updateWorkingGraph` REPLACES that object on every rebuild, so
// a WeakMap hit means "nothing changed → serve the cache", and a rebuild
// naturally invalidates it (old key GC'd). No manual invalidation needed.
const enrichedL1GraphCache = new WeakMap<object, any>();
// PERF (2026-07-19) — the scoped-L1 sub-repo currently being served. Guards the
// async infra-enrichment push so a slow background scan for repo A doesn't clobber
// the L1 view after the user has already navigated to repo B (both use the
// `microservice:workspace` graph id, differing only by `meta.scopedRepo`).
let lastScopedL1Repo = '';
// PERF (all multi-repo route latency) — every requestRoute rebuilt the unified
// `graphs` view by iterating EVERY per-repo graph map (polar's server repo alone
// has ~14k graphs) through `mergeGraphsForView` — ~700ms on EVERY navigation
// (L1/L2/L3 alike). The merge result only changes when a repo rebuilds, so we
// cache it and invalidate on file-save / rebuild. Not used while a git-diff
// (commit/branch/PR) comparison is active — that path has its own graph map.
let mergedGraphsViewCache: Record<string, any> | null = null;
function invalidateMergedGraphsView(): void { mergedGraphsViewCache = null; }
// UX-63b (2026-06-09) — module-scope handle for the aggregator so
// top-level diff/replay handlers (handleRequestGitDiff etc.) can
// resolve a `repoId` → `rootPath` without needing to be inside
// activate's scope.
let aggregatorRef: any = null;
let extensionWorkspaceLock: AcquiredLock | null = null;
let extensionPreemptUnwatch: (() => void) | null = null;
let extensionYieldedToMcp = false;
// #829 — active reclaim watcher while we're yielded; disposed on deactivate.
let extensionReclaimUnwatch: (() => void) | null = null;
// #851 — PR watcher instance (parity with MCP standalone; see ADR-045).
let extensionPrWatcher: PrWatcher | null = null;
let gitDiffStore: GitDiffStore;
// UX-64 (2026-06-09) — `GitDiffStateRegistry` replaces the single
// module-scope `gitDiffState` slot. The legacy `gitDiffState` symbol is
// kept as a TRANSITIONAL alias that mirrors the registry's
// workspace-or-fallback entry; every read site can keep using
// `gitDiffState` while Phase 2 incrementally rewires call sites to pass
// the active `repoId` scope. Writers updated to also call
// `gitDiffStates.set(scope, state)` so the per-repo map stays
// authoritative.
const gitDiffStates = new GitDiffStateRegistry();
function setGitDiffStateScoped(state: PersistedGitDiffState | null): void {
    // `scopedRepo` on the state determines the bucket. `null` clears the
    // workspace slot — callers that intend a per-repo clear use
    // `gitDiffStates.clear(scope)` directly.
    if (state === null) {
        gitDiffStates.clear('workspace');
        gitDiffState = null;
        return;
    }
    const scope = state.scopedRepo ?? 'workspace';
    gitDiffStates.set(scope, state);
    // Mirror into the legacy alias so existing readers keep working.
    // Prefer the workspace slot, fall back to whatever just got written.
    gitDiffState = gitDiffStates.get() ?? state;
}
let gitDiffState: PersistedGitDiffState | null = null;
let gitDiffSnapshots: { headSnapshot: Snapshot; baseSnapshot: Snapshot } | null = null;
let replayAfterDiff = false;
let commitTimelineReplay: CommitTimelineReplay;
let commentStore: CommentStore;
let panelManager: PanelManager;
let outputChannel: vscode.OutputChannel;
let featureFlags: FeatureFlagClient;
let apiExplorerProvider: ApiExplorerProvider;
let fileExplorerProvider: FileExplorerProvider;
let functionExplorerProvider: FunctionExplorerProvider;
let changedItemsProvider: ChangedItemsProvider;
let commentsProvider: CommentsProvider;
let featureExplorerProvider: FeatureExplorerProvider;
let microserviceExplorerProvider: MicroserviceExplorerProvider;
let featureTreeView: vscode.TreeView<FeatureTreeItem>;
let microserviceTreeView: vscode.TreeView<ServiceTreeItem>;
let apiTreeView: vscode.TreeView<ApiTreeItem>;
let sourceNavigator: SourceNavigator;
let authService: ClerkAuthService;
// Single periodic auth-expiry timer (never stacked across logins) + a
// once-per-expiry guard so the "session expired" prompt fires at most once.
let authExpiryTimer: ReturnType<typeof setInterval> | undefined;
let authExpiryNotified = false;
let authExpiryDisposeRegistered = false;
let welcomeProvider: WelcomeProvider;
// Issue 101: Track previous resources for disposal on reload
let previousSyncOrchestrator: SyncOrchestrator | undefined;
let wsBridge: WsBridge | undefined;
let extensionContext: vscode.ExtensionContext | null = null;
// Lifted to module scope so the L1 status-bar badge helpers (Issue 363 — `state.json` written non-atomically,
// trigger #7) can mutate it from outside `activate()`. Definite-assignment
// (`!:`) is safe because the badge helpers only fire as part of activate-time
// event handlers, after `activate()` has assigned this in the status-bar
// setup block at the top of the function.
let statusBarItem!: vscode.StatusBarItem;
// Last diagram a user (or browser) requested to view. Used by:
//   1. routeDiagramToWelcome — so when the user clicks "Open in Browser",
//      a fresh tab lands on the right diagram via wsBridge getInitialData.
//   2. wsBridge — restores the right diagram on browser refresh.
let lastBrowserNav: { graphId: string; mode: string; graph: any; label: string } | null = null;

/**
 * Per user directive: diagrams render ONLY at localhost:7742 in the user's
 * browser — never inside a VS Code webview panel. Every command path that
 * historically called `panelManager.openPanel(...)` routes here. We stash
 * the requested view in `lastBrowserNav` (so a fresh browser tab lands on
 * it) and surface the welcome webview, which contains the "Open in Browser"
 * CTA.
 */
function routeDiagramToWelcome(graphId: string, mode: string, graph: any, label: string): void {
    lastBrowserNav = { graphId, mode, graph, label };
    if (extensionContext) openWelcomeWebview(extensionContext);
    maybeNudgeWelcomeOpened(); // Issue 363 — trigger #8
}

/**
 * Guard for commands that need a connected browser tab to do anything visible
 * (e.g., timeline replay's commit-range picker, impact analysis's overlay —
 * both broadcast UI messages that have no consumer when no browser is open).
 *
 * Returns `true` when a browser client is connected and the caller can proceed.
 * Returns `false` after surfacing the welcome webview + a "open browser first"
 * notification, so the command should bail.
 *
 * Usage:
 *     if (!requireBrowserOrPromptWelcome('Timeline Replay')) return;
 */
function requireBrowserOrPromptWelcome(actionName: string): boolean {
    if (wsBridge?.hasClients()) return true;
    if (extensionContext) openWelcomeWebview(extensionContext);
    maybeNudgeWelcomeOpened(); // Issue 363 — trigger #8
    vscode.window.showInformationMessage(
        `CodeAtlas: Open the diagram in your browser first, then run "${actionName}" again.`,
    );
    notifyBrowser('warning', `Open CodeAtlas in your browser first to use ${actionName}.`);
    return false;
}
let aiReviewResult: AiReviewResult | null = null; // AI Review: cached review result for current diff
// GitHub auth state — proactively checked at activation for PR diff
let gitHubToken: string | undefined;
let gitHubUser: { login: string; avatar_url: string; html_url: string } | null = null;

/**
 * Fetch the authenticated GitHub user's profile so the browser UI can show
 * username + avatar after `Connect GitHub`. Returns null on any failure
 * (network, 401, parse) so callers can fall back to "connected, no details".
 * Called both at activation (if a silent session already exists) and from
 * the `connectGitHub` handler after interactive auth completes.
 */
async function fetchGitHubUser(token: string): Promise<{ login: string; avatar_url: string; html_url: string } | null> {
    try {
        const res = await fetch('https://api.github.com/user', {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github.v3+json',
                'User-Agent': 'CodeAtlas-Extension',
            },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const data = await res.json() as { login?: string; avatar_url?: string; html_url?: string };
        if (!data.login) return null;
        return {
            login: data.login,
            avatar_url: data.avatar_url ?? '',
            html_url: data.html_url ?? `https://github.com/${data.login}`,
        };
    } catch {
        return null;
    }
}

// Guard against double-fire when the browser opens a URI handler AND posts a
// WS message in parallel — the second call would just re-resolve to the same
// session, but logging it twice is noisy and confusing in the analytics.
let gitHubConnectInFlight = false;

/**
 * Module-level shim for activate-scoped broadcasting. Wired up inside
 * `activate()` once `buildWorkspaceInfo` is defined. Lets module-level helpers
 * (like `performGitHubConnect`, which is called from the URI handler) push a
 * fresh workspace-info snapshot to any connected browser tab without
 * threading a builder closure through every helper.
 */
let broadcastWorkspaceInfo: () => void = () => { /* no-op until activate() */ };

/**
 * Run the full GitHub connect lifecycle: kick off VS Code's auth provider,
 * fetch the user profile on success, and broadcast every state change to
 * any browser tab listening on the WS bridge.
 *
 * Reused by:
 *   - The `connectGitHub` WS handler in gitDiffHandlers.ts (when the
 *     browser sent a message but no URI redirect happened).
 *   - The URI handler at `${uriScheme}://${extensionId}/connect-github`,
 *     which is the entry point used by the browser's "Connect GitHub"
 *     button — opening that URL focuses the editor before the auth dialog
 *     appears, eliminating the "click does nothing" UX.
 */
async function performGitHubConnect(source: string, originClientId?: string): Promise<void> {
    if (gitHubConnectInFlight) return;
    gitHubConnectInFlight = true;
    analytics.track('github_connect_started', { source, has_origin: !!originClientId });

    /**
     * Send a message to the SAME browser tab that started the flow when
     * possible. Falls back to broadcast if the tab disconnected mid-flow
     * (e.g. user closed it while VS Code OAuth was open) or if no client id
     * was supplied (backwards-compatible WS-message entry path).
     */
    const sendBack = (msg: any) => {
        if (!wsBridge) return;
        if (originClientId && wsBridge.hasClient(originClientId)) {
            wsBridge.sendTo(originClientId, msg);
        } else if (wsBridge.hasClients()) {
            wsBridge.broadcast(msg);
        }
    };
    const tellUser = (level: 'info' | 'warning' | 'error', message: string) => {
        sendBack({ type: 'showNotification', level, message });
    };
    const finish = (status: 'success' | 'failure', detail: { user?: typeof gitHubUser; error?: string }) => {
        // Structured "you can move on now" message — the browser uses this
        // to render a banner that's clearer + more durable than a toast,
        // and to refocus itself if it was backgrounded during VS Code OAuth.
        sendBack({
            type: 'githubAuthCompleted',
            status,
            user: detail.user ?? null,
            error: detail.error,
        });
        // Bring the browser back to the foreground. openExternal on the
        // already-open localhost URL focuses the existing tab in most
        // browsers (Chrome, Safari, Edge); Firefox sometimes spawns a new
        // tab — acceptable degradation since the tab still gets the
        // structured message either way.
        if (wsBridge && wsBridge.hasClients()) {
            const port = wsBridge.getPort();
            if (port > 0) {
                vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
            }
        }
    };

    tellUser('info', 'Authorizing GitHub access — check the editor for a sign-in dialog.');
    try {
        const session = await vscode.authentication.getSession('github', ['repo'], { silent: false });
        if (session?.accessToken) {
            gitHubToken = session.accessToken;
            outputChannel.appendLine('[GitHub] Connected successfully');
            const user = await fetchGitHubUser(session.accessToken);
            gitHubUser = user;
            if (user) {
                outputChannel.appendLine(`[GitHub] Authenticated as @${user.login}`);
                analytics.track('github_connected', { has_profile: true, source });
                tellUser('info', `GitHub connected as @${user.login}`);
            } else {
                outputChannel.appendLine('[GitHub] Connected, profile fetch failed');
                analytics.track('github_connected', { has_profile: false, source });
                tellUser('info', 'GitHub connected. (Profile details unavailable.)');
            }
            broadcastWorkspaceInfo();
            finish('success', { user });
        } else {
            outputChannel.appendLine('[GitHub] Auth completed with no session');
            analytics.track('github_connect_no_session', { source });
            tellUser('warning', 'GitHub connection did not complete — no session was returned.');
            finish('failure', { error: 'no_session' });
        }
    } catch (err: any) {
        const errMsg = String(err?.message ?? err);
        outputChannel.appendLine(`[GitHub] Auth cancelled or failed: ${errMsg}`);
        analytics.track('github_connect_failed', { error: errMsg.slice(0, 200), source });
        tellUser('warning', 'GitHub connection cancelled or failed. Try again from your browser.');
        finish('failure', { error: errMsg.slice(0, 200) });
    } finally {
        gitHubConnectInFlight = false;
    }
}
let gitRemoteInfo: { owner: string; repo: string } | null = null;

/** Send a notification to all connected browser clients (mirrors VS Code's showMessage). */
function notifyBrowser(level: 'info' | 'warning' | 'error', message: string): void {
    if (wsBridge?.hasClients()) {
        wsBridge.broadcast({ type: 'showNotification', level, message });
    }
}

export async function activate(context: vscode.ExtensionContext) {
    // Issue #724 — initialise Sentry FIRST so any crash during activation
    // itself lands as a report. No-op when CODEATLAS_TELEMETRY=0 /
    // DO_NOT_TRACK=1, when no DSN is provisioned, or when @sentry/node
    // isn't installed yet. Identifies the workspace by anonymous device
    // hash (same SHA-256 Mixpanel uses) — no PII.
    try {
        const { initSentry } = await import('./errors/sentryNode');
        initSentry('extension');
    } catch { /* shim missing — should not happen */ }

    // Module-level context handle so routeDiagramToWelcome can find the
    // welcome webview without threading context through every helper.
    extensionContext = context;
    // Issue 101: Dispose previous sync orchestrator callbacks on reload
    previousSyncOrchestrator?.dispose();

    // Fire install / update / launch events to Amplitude on every activation
    // — runs BEFORE the no-workspace early return so launches in empty
    // windows (e.g. `code .` with no folder) are still attributed. Also
    // runs before sign-in, so it's keyed off device_id (vscode.env.machineId)
    // and joined to the user later when signed_in fires.
    analytics.initLifecycle(context);

    // INVARIANT (ADR-023): feature-flag client is fail-open. Endpoint may
    // not be provisioned yet — every flag returns `true` until the JSON
    // endpoint goes live. Logger writes to the same Output channel as
    // everything else so flag fetch failures are visible.
    featureFlags = new FeatureFlagClient(FEATURE_FLAGS_URL, vscode.env.machineId);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        analytics.track('activate_no_workspace');
        vscode.window.showWarningMessage('CodeAtlas: No workspace folder open.');
        return;
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    const config = vscode.workspace.getConfiguration('codeatlas');

    /** Resolve a relative or absolute filePath and verify it stays within the workspace. */
    function safeResolvePath(filePath: string): string | null {
        return safeResolve(workspaceRoot, filePath);
    }

    // Output channel for diagnostics
    outputChannel = vscode.window.createOutputChannel('CodeAtlas');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine(`[CodeAtlas] Activating in ${workspaceRoot}`);

    // Wire the feature-flag client's logger now that outputChannel is up.
    featureFlags.setLogger((m) => outputChannel.appendLine(m));
    // Fire an initial async fetch so subsequent `isEnabledSync` calls have
    // a populated cache. Fail-open: if the fetch errors, sync calls still
    // return `true` for unknown flags. Best-effort; never blocks activate().
    void featureFlags.isEnabled('__warmup__');

    // Set grammar directory early so tree-sitter can find the WASM files
    setGrammarsDir(path.join(context.extensionPath, 'grammars'));

    // Initialize stores (state loading deferred until auth is verified)
    // #351: opt-in in-memory storage mode skips the on-disk SQLite file
    // entirely; state rebuilds from source on every activation.
    const inMemoryOnly = vscode.workspace.getConfiguration('codeatlas').get<boolean>('storage.inMemoryOnly', false);
    snapshotStore = new SnapshotStore(workspaceRoot, { inMemoryOnly });
    snapshotStore.setLogger((msg) => outputChannel.appendLine(msg));

    // ADR-034 Phase A (#786 — Phase A: per-repo DB foundation (ADR-034)) — bring up the WorkspaceOrchestrator next to
    // the existing snapshotStore. Phase A is invisible to users: the
    // orchestrator creates `monorepo.db` next to `state.db`, registers one
    // `repos` row for the workspace, and that's it. The rest of activate()
    // continues to use `snapshotStore` directly; Phase B wires the
    // orchestrator into per-repo init fan-out.
    const repoStoreRegistry = RepoStoreRegistry.instance();
    repoStoreRegistry.setLogger((msg) => outputChannel.appendLine(msg));
    repoStoreRegistry.registerRepoStore(workspaceRoot, snapshotStore);
    const aggregator = new AggregatorStore(workspaceRoot, { inMemoryOnly });
    aggregatorRef = aggregator;
    aggregator.setLogger((msg) => outputChannel.appendLine(msg));
    repoStoreRegistry.registerAggregatorStore(workspaceRoot, aggregator);
    // ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — populate the default CrossRepoAnalyzer
    // registry. Idempotent — safe to call on every activation.
    registerDefaultCrossRepoAnalyzers();

    // ADR-034 Phase B (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) — production per-repo runner. When the
    // workspace is detected as multi-repo, the WorkspaceOrchestrator calls
    // this for each detected sibling. It constructs a fresh SnapshotStore +
    // SyncOrchestrator rooted at the repo's absolute path, registers them
    // in the registry, runs `initialize()` to populate the repo's own
    // `state.db`. The workspace-root `snapshotStore` continues to exist
    // (handlers reference it module-level) but receives no per-repo data
    // in multi-repo mode — Pass 4b migrates handlers to `resolveStoreFor`
    // so the right per-repo store is selected at read time.

    // ADR-034 Phase D Tier-1 (#789 — Phase D: parallel per-repo parse + per-repo watcher (ADR-034)) — per-repo SyncOrchestrator registry.
    // The WorkspaceWatcher uses this map to dispatch file change events
    // to the orchestrator that owns the changed repo, so a save in
    // svc-alpha only triggers svc-alpha's cascade.
    // Module-scope `perRepoOrchestrators` declared above so
    // `buildMicroserviceGraphCached` can union per-repo state in
    // monorepo mode. No local re-declaration here.
    const productionRepoRunner: RepoOrchestratorRunner = async ({ repoRoot, repoId, registry, log }) => {
        log(`[RepoOrchestratorRunner] starting ${repoId} at ${repoRoot}`);
        let perRepoStore: SnapshotStore;
        try {
            perRepoStore = new SnapshotStore(repoRoot, { inMemoryOnly });
            perRepoStore.setLogger((msg) => outputChannel.appendLine(msg));
            registry.registerRepoStore(repoRoot, perRepoStore);
        } catch (err: any) {
            log(`[RepoOrchestratorRunner] ${repoId} store construction failed: ${err?.message ?? err}`);
            throw err;
        }
        // Per-repo CommentStore — comments are repo-local in multi-repo mode.
        const perRepoCommentStore = new CommentStore([]);
        const perRepoOrch = new SyncOrchestrator(
            workspaceRoot,
            perRepoStore,
            perRepoCommentStore,
            undefined,                                 // ignorePatterns — pick up later via per-repo .gitignore
            undefined,                                 // maxFileSize — use default
            repoRoot,                                  // ADR-034 Phase B — distinct repo scope
        );
        perRepoOrch.setLogger((msg) => outputChannel.appendLine(msg));
        try {
            await perRepoStore.load();
            await perRepoOrch.initialize();
            // ADR-034 Phase D Tier-1 — keep the orchestrator alive after
            // init so the WorkspaceWatcher can route file events to it.
            perRepoOrchestrators.set(repoId, perRepoOrch);
            // ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — emit cross-repo summary so the
            // aggregator can union shared externals / schemas / HTTP edges
            // across the workspace.
            try {
                const summary = perRepoOrch.produceSummary(repoId);
                aggregator.applySummary(repoId, summary);
                log(`[RepoOrchestratorRunner] ${repoId} summary applied: ${summary.apis.length} apis, ${summary.sdks.length} sdks, ${summary.schemas.length} schemas, ${summary.httpClientPaths.length} httpClientPaths`);
            } catch (err: any) {
                log(`[RepoOrchestratorRunner] ${repoId} produceSummary/applySummary failed (non-fatal): ${err?.message ?? err}`);
            }
            log(`[RepoOrchestratorRunner] ${repoId} initialize complete`);
        } catch (err: any) {
            log(`[RepoOrchestratorRunner] ${repoId} initialize failed: ${err?.message ?? err}`);
            throw err;
        }
    };

    // ADR-034 Phase D — read the concurrency setting. Effective modes:
    //   - 'off'   : serial (Phase B passthrough)
    //   - 'tier1' : Promise.all over async runners (in-process)
    //   - 'tier2' : worker_threads pool (real CPU parallelism) — DEFAULT.
    //               If the pool fails to construct (WASM resolution error,
    //               worker_threads unavailable), we transparently fall back
    //               to tier1 so the user never sees a broken init.
    // ADR-034 Phase D Tier-2 (#789-D2) — one-shot migration for users
    // upgrading from a build where 'tier1' was the recommended setting.
    // Flip the setting once when (a) value is exactly 'tier1' AND (b) the
    // migration marker hasn't been set. Marker prevents re-flipping if the
    // user later sets it back to 'tier1' on purpose. Safe + reversible —
    // user keeps full control via VS Code settings UI.
    try {
        const cfg = vscode.workspace.getConfiguration('codeatlas');
        const currentValue = cfg.get<string>('cascadeParallelism');
        const migrated = cfg.get<boolean>('cascadeParallelismMigrated');
        if (currentValue === 'tier1' && !migrated) {
            await cfg.update('cascadeParallelism', 'tier2', vscode.ConfigurationTarget.Global);
            await cfg.update('cascadeParallelismMigrated', true, vscode.ConfigurationTarget.Global);
            outputChannel.appendLine('[cascadeParallelism migration] flipped tier1 → tier2 (one-shot, user can revert in VS Code settings)');
        }
    } catch (err: any) {
        outputChannel.appendLine(`[cascadeParallelism migration] skipped: ${err?.message ?? err}`);
    }
    const cascadeParallelism = vscode.workspace.getConfiguration('codeatlas').get<string>('cascadeParallelism', 'tier2');
    const concurrencyLimit = (cascadeParallelism === 'tier1' || cascadeParallelism === 'tier2')
        ? Math.min(8, require('os').cpus().length)
        : 1;

    // ADR-034 Phase D Tier-2 (#789-D2) — spin up a fresh worker pool. Returns
    // the ready pool, or undefined when tier2 is disabled / the worker bundle
    // is missing / the workers fail to boot (caller degrades to Tier-1
    // in-process). Reused by BOTH the startup init and the manual re-init: the
    // startup pool is closed after the initial burst to free V8 isolates, so
    // re-init MUST create its own live pool and attach it via setTier2Pool() —
    // reusing the closed pool fails every repo with "pool is closed".
    const makeTier2Pool = async (): Promise<import('./core/sync/workerPool').WorkerPool | undefined> => {
        if (cascadeParallelism !== 'tier2') return undefined;
        let pool: import('./core/sync/workerPool').WorkerPool | undefined;
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { WorkerPool } = require('./core/sync/workerPool') as typeof import('./core/sync/workerPool');
            const pathMod = require('path');
            const workerScriptPath = pathMod.join(__dirname, 'repo-worker.js');
            const fsMod = require('fs');
            if (!fsMod.existsSync(workerScriptPath)) {
                throw new Error(`worker bundle not found at ${workerScriptPath}`);
            }
            pool = new WorkerPool({
                workerScriptPath,
                size: concurrencyLimit,
                log: (msg: string) => outputChannel.appendLine(msg),
                // ADR-034 Phase D #TDD-1 (2026-06-03) — pass the grammars dir
                // explicitly. The worker bundle's `__dirname` auto-detection
                // resolves to `<vscode-extensions-dir>/grammars` in production
                // installs (one level too high), so every non-JS parse in the
                // worker fails with "Grammar file not found" and the per-repo
                // state.db ends up with apis=N but files=0 / graphs missing.
                grammarsDir: pathMod.join(context.extensionPath, 'grammars'),
            });
            // Verify the workers boot before we hand the pool off — any
            // WASM init failure shows up here and lets us fall back cleanly.
            await pool.ready();
            return pool;
        } catch (err: any) {
            outputChannel.appendLine(`[WorkspaceOrchestrator] tier2 worker pool unavailable (${err?.message ?? err}); falling back to tier1`);
            try { await pool?.close(); } catch { /* ignore */ }
            return undefined;
        }
    };

    let tier2Pool: import('./core/sync/workerPool').WorkerPool | undefined = await makeTier2Pool();
    let effectiveTier = cascadeParallelism;
    if (cascadeParallelism === 'tier2') {
        if (tier2Pool) {
            outputChannel.appendLine(`[WorkspaceOrchestrator] cascadeParallelism=tier2 — workerPoolSize=${concurrencyLimit}`);
        } else {
            effectiveTier = 'tier1';
        }
    }
    if (effectiveTier === 'tier1') {
        outputChannel.appendLine(`[WorkspaceOrchestrator] cascadeParallelism=tier1 — concurrencyLimit=${concurrencyLimit}`);
    }

    // Tier-2 post-init: runs on the main thread once a worker finishes its
    // repo. Opens the persisted state.db, registers the store, applies the
    // produced summary to the aggregator. Mirrors the in-process runner's
    // post-init bookkeeping so subsequent file events route the same way
    // regardless of which tier dispatched the init.
    const tier2PostInit = tier2Pool
        ? async (params: {
            workspaceRoot: string;
            repoRoot: string;
            repoId: string;
            registry: typeof repoStoreRegistry;
            log: (msg: string) => void;
            workerResult: import('./core/sync/repoWorker').WorkerResult;
        }) => {
            const perRepoStore = new SnapshotStore(params.repoRoot, { inMemoryOnly });
            perRepoStore.setLogger((msg) => outputChannel.appendLine(msg));
            await perRepoStore.load();
            params.registry.registerRepoStore(params.repoRoot, perRepoStore);

            const perRepoCommentStore = new CommentStore([]);
            const perRepoOrch = new SyncOrchestrator(
                params.workspaceRoot,
                perRepoStore,
                perRepoCommentStore,
                undefined, undefined, params.repoRoot,
            );
            perRepoOrch.setLogger((msg) => outputChannel.appendLine(msg));
            // NOTE: do NOT call perRepoOrch.initialize() — the worker already
            // ran it. Just keep the orchestrator alive so WorkspaceWatcher
            // can route file events.
            perRepoOrchestrators.set(params.repoId, perRepoOrch);

            if (params.workerResult.summary) {
                try {
                    aggregator.applySummary(params.repoId, params.workerResult.summary);
                    params.log(`[Tier2PostInit] ${params.repoId} summary applied: ${params.workerResult.summary.apis.length} apis (worker ms=${params.workerResult.durationMs})`);
                } catch (err: any) {
                    params.log(`[Tier2PostInit] ${params.repoId} applySummary failed (non-fatal): ${err?.message ?? err}`);
                }
            }
        }
        : undefined;

    workspaceOrchestrator = new WorkspaceOrchestrator(
        workspaceRoot,
        repoStoreRegistry,
        (msg) => outputChannel.appendLine(msg),
        productionRepoRunner,
        concurrencyLimit,
        tier2Pool,
        tier2PostInit,
    );
    let workspaceWatcher: WorkspaceWatcher | undefined;
    // ADR-034 Phase G follow-up — workspace-mode broadcast helper. Used by:
    //   1. post-`initialize` (below)
    //   2. `retryRepo` handler
    //   3. `resync` handler
    // Single-repo workspaces emit `{ mode: 'single', repos: [<single>] }` so
    // every webview consumer (AI Review scope picker, future per-repo views)
    // gets a uniform shape regardless of mode.
    const broadcastWorkspaceState = (modeHint?: 'single' | 'multi'): void => {
        try {
            if (!wsBridge?.hasClients()) return;
            const rows = aggregator.listRepos();
            const mode = modeHint ?? (rows.length > 1 ? 'multi' : 'single');
            wsBridge.broadcast({
                type: 'workspaceState',
                mode,
                repos: rows.map((r) => ({
                    repoId: r.repoId,
                    name: r.name,
                    rootPath: r.rootPath,
                    status: r.status,
                    diff: r.diff,
                })),
            });
            // UX-72 (2026-06-09) — multiRepoInitStats: aggregate status
            // counts the welcome banner / status bar can render as
            // "Init: 130/132 ready, 2 failed (click for details)".
            if (mode === 'multi') {
                let ready = 0, parsing = 0, failed = 0, stale = 0;
                const failures: Array<{ repoId: string; name?: string; rootPath?: string; errorMessage?: string }> = [];
                for (const r of rows) {
                    switch (r.status) {
                        case 'ready': ready++; break;
                        case 'parsing': parsing++; break;
                        case 'failed':
                            failed++;
                            failures.push({ repoId: r.repoId, name: r.name, rootPath: r.rootPath, errorMessage: (r as any).errorMessage });
                            break;
                        case 'stale': stale++; break;
                    }
                }
                wsBridge.broadcast({
                    type: 'multiRepoInitStats',
                    total: rows.length,
                    ready,
                    parsing,
                    failed,
                    stale,
                    failures,
                });
                outputChannel.appendLine(`[multiRepoInitStats] total=${rows.length} ready=${ready} parsing=${parsing} failed=${failed} stale=${stale}`);
            }
        } catch (err: any) {
            outputChannel.appendLine(`[workspaceState broadcast] failed: ${err?.message ?? err}`);
        }
    };

    // ADR-034 Phase D Tier-2 fix (#TDD-5 / 2026-06-03 multi-repo verify) —
    // captured AFTER workspaceOrchestrator.initialize() so the AutoInit
    // closure below can skip the redundant workspace-level scan when the
    // workspace is multi-repo. Workers have already populated every per-repo
    // state.db; the workspace-level snapshotStore stays empty in multi mode.
    // Module-scope `workspaceIsMulti` is declared at the top of the file;
    // we just reset it here at the start of each activate() pass.
    workspaceIsMulti = false;
    try {
        const wsInit = await workspaceOrchestrator.initialize();
        workspaceIsMulti = wsInit.mode === 'multi' && wsInit.repoCount > 1;
        if (workspaceIsMulti) detectedMultiRepo = true; // latch — never cleared
        outputChannel.appendLine(
            `[WorkspaceOrchestrator] init: mode=${wsInit.mode} repoCount=${wsInit.repoCount} ` +
            `aggregatorBytes=${wsInit.aggregatorSizeBytes} totalMs=${wsInit.totalDurationMs}`,
        );
        // Phase G follow-up — broadcast the registry once init completes.
        broadcastWorkspaceState(wsInit.mode);
        // ADR-034 Phase D Tier-2 — workers are only needed for the init
        // burst. Once initialize() returns, every per-repo orchestrator is
        // alive on the main thread and WorkspaceWatcher routes subsequent
        // edits there. Close the pool to free V8 isolates + ~3MB per worker.
        if (tier2Pool) {
            try { await tier2Pool.close(); } catch (err: any) {
                outputChannel.appendLine(`[WorkspaceOrchestrator] tier2 pool close failed: ${err?.message ?? err}`);
            }
            tier2Pool = undefined;
        }
        // ADR-034 Phase D Tier-1 — wire the WorkspaceWatcher in multi-repo
        // mode. A single chokidar instance routes file events to the
        // per-repo SyncOrchestrator that owns the changed file's repo.
        if (wsInit.mode === 'multi' && wsInit.detectedRepos.length > 0) {
            const repoRows = aggregator.listRepos();
            // Issue #790 #6 — VS Code-native file watcher factory.
            // Bundled chokidar (every variant we tested) silently drops
            // deep-tree events in the extension host environment;
            // `vscode.workspace.createFileSystemWatcher` uses the editor's
            // central watcher pool which handles 132-sub-repo monorepos
            // reliably. The MCP standalone surface keeps the chokidar
            // dynamic-import default in `defaultWatcherFactory` — chokidar
            // works fine in a fresh CLI Node process; the bug was specific
            // to the extension host runtime.
            // UX-71 (2026-06-09) — fold every sub-repo's `.gitignore`
            // into the watcher's ignore list so per-repo build outputs
            // (Rust `target/`, Java `target/`, Next.js `.next/`, etc.)
            // don't trigger spurious cascade rebuilds.
            const perRepoIgnoreSources: GitignoreSource[] = [];
            for (const r of repoRows) {
                if (!r.rootPath) continue;
                try {
                    const gitignorePath = path.join(workspaceRoot, r.rootPath, '.gitignore');
                    if (fs.existsSync(gitignorePath)) {
                        const text = fs.readFileSync(gitignorePath, 'utf8');
                        perRepoIgnoreSources.push({ rootPath: r.rootPath, text });
                    }
                } catch (err: any) {
                    outputChannel.appendLine(`[WorkspaceWatcher] failed reading .gitignore for ${r.rootPath}: ${err?.message ?? err}`);
                }
            }
            const perRepoIgnoreGlobs = perRepoGitignoreToGlobs(perRepoIgnoreSources);
            if (perRepoIgnoreGlobs.length > 0) {
                outputChannel.appendLine(`[WorkspaceWatcher] loaded ${perRepoIgnoreGlobs.length} per-repo .gitignore globs from ${perRepoIgnoreSources.length} sub-repos`);
            }
            workspaceWatcher = await WorkspaceWatcher.create(repoRows, {
                watcherFactory: vscodeFileSystemWatcherFactory(),
                workspaceRoot,
                ignore: [
                    '**/.git/**', '**/node_modules/**', '**/.codeatlas/**',
                    '**/.codeatlas-sa/**', '**/dist/**', '**/build/**',
                    '**/.next/**', '**/.dart_tool/**', '**/.gradle/**',
                    '**/target/**', '**/__pycache__/**', '**/.venv/**',
                    '**/coverage/**', '**/Pods/**', '**/vendor/**',
                    ...perRepoIgnoreGlobs,
                ],
                log: (msg) => outputChannel.appendLine(msg),
            });
            // UX-67 (2026-06-09) — debounced re-emit of the per-repo
            // RepoSummary so `cross_repo_http_edges` + shared_externals
            // refresh on save instead of going stale until the next
            // full re-init. A burst of saves in one sub-repo coalesces
            // to one summary emit (500ms quiet window); saves in
            // different sub-repos remain isolated.
            const summaryDebouncer = new PerRepoDebouncer(500);
            // #817 (2026-06-11) — cross-repo push. Wraps every summary
            // re-apply with edge-delta detection; when a consumer→producer
            // edge's diff transitions, consumers' open browser tabs get a
            // debounced `crossRepoEdgeChanged` broadcast instead of waiting
            // for the user to navigate away and back. Gated by the
            // `codeatlas.crossRepoPush` setting (default ON).
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { CrossRepoPushScheduler } = require('./core/sync/crossRepoPushScheduler');
            const crossRepoPush = new CrossRepoPushScheduler({
                broadcast: (payload: any) => { try { wsBridge?.broadcast(payload); } catch { /* bridge down */ } },
                enabled: () => vscode.workspace.getConfiguration('codeatlas').get<boolean>('crossRepoPush', true),
                log: (msg: string) => outputChannel.appendLine(msg),
                onPush: (payload: any) => {
                    analytics.track('cross_repo_push', {
                        edges: payload.edges.length,
                        consumers: new Set(payload.edges.map((e: any) => e.consumerRepoId)).size,
                    });
                },
            });
            context.subscriptions.push({ dispose: () => crossRepoPush.dispose() });
            const reemitSummary = (rid: string) => {
                const orch = perRepoOrchestrators.get(rid);
                if (!orch) return;
                try {
                    const summary = orch.produceSummary(rid);
                    // #817 — delta-gated apply: pushes `crossRepoEdgeChanged`
                    // to consumer tabs when edge diffs transition.
                    crossRepoPush.applyWithDelta(aggregator, rid, () => aggregator.applySummary(rid, summary));
                    outputChannel.appendLine(`[WorkspaceWatcher] ${rid} summary re-emitted (cross-repo edges refreshed)`);
                } catch (err: any) {
                    outputChannel.appendLine(`[WorkspaceWatcher] ${rid} produceSummary failed (non-fatal): ${err?.message ?? err}`);
                }
            };
            workspaceWatcher.on((repoId, filePath, kind) => {
                // PERF — a file change in any repo will rebuild graphs, so drop
                // the cached unified graph view; the next route re-merges fresh.
                invalidateMergedGraphsView();
                const orch = perRepoOrchestrators.get(repoId);
                if (!orch) {
                    outputChannel.appendLine(`[WorkspaceWatcher] no orchestrator for ${repoId} — skipping ${kind} on ${filePath}`);
                    return;
                }
                // Delegate to the same handleFileSave / rebuildFile entry
                // point the standalone watcher already uses. Cascade lands
                // in the per-repo state.db only — sibling repos untouched.
                // Issue #790 #6 — WorkspaceWatcher passes WORKSPACE-relative
                // paths but `rebuildFile` does `fs.statSync(filePath)` which
                // silently fails on relative paths when the extension host's
                // cwd is not the workspace root. Convert to absolute so the
                // stat call resolves; the orchestrator's own
                // `relativePath = filePath.replace(workspaceRoot, '')` step
                // then re-derives the sub-repo-relative key for state.db.
                const absoluteFilePath = path.join(workspaceRoot, filePath);
                if (kind === 'change' || kind === 'add') {
                    try { orch.handleFileSave(absoluteFilePath, undefined); }
                    catch (err: any) {
                        outputChannel.appendLine(`[WorkspaceWatcher] ${repoId} rebuild failed for ${filePath}: ${err?.message ?? err}`);
                    }
                    // UX-67 — schedule the debounced summary re-emit.
                    summaryDebouncer.schedule(repoId, reemitSummary);
                } else if (kind === 'unlink') {
                    // Phase D Tier-1: file deletions are best-effort logged.
                    // Phase E (#790 — Phase E: failure isolation UX + multi-repo cascade tests (ADR-034)) wires removeWorkingFile() into the
                    // per-repo cascade properly.
                    outputChannel.appendLine(`[WorkspaceWatcher] ${repoId} unlink ${filePath} (cascade for deletes is Phase E)`);
                }
            });
            outputChannel.appendLine(`[WorkspaceWatcher] active — watching ${repoRows.length} repos for live cascade isolation`);

            // 2026-06-09 — workspace apiIndex aggregation (#1). The
            // workspace `snapshotStore` is empty by design in multi-repo
            // mode; consumers that read `snapshotStore.getWorking().apiIndex`
            // directly (MCP tools, impact analyzer, api-testing, blast-radius)
            // therefore see ZERO endpoints across a 132-sub-repo workspace.
            // Walk every per-repo store, merge its apiIndex into the
            // workspace working snapshot. v56's apiId prefixing makes the
            // keys globally unique, so Object.assign no longer dedups
            // across sub-repos. Re-run on every per-repo cascade so changes
            // propagate. files/services/clusters stay per-repo for now —
            // apiIndex is the highest-leverage join key.
            const aggregateWorkspaceApiIndex = () => {
                try {
                    const wsWorking: any = snapshotStore.getWorking();
                    const mergedApiIndex: Record<string, any> = {};
                    let totalApis = 0;
                    for (const [, orch] of perRepoOrchestrators) {
                        try {
                            const w: any = orch.getStore().getWorking();
                            for (const [k, v] of Object.entries(w.apiIndex ?? {})) {
                                mergedApiIndex[k] = v;
                                totalApis++;
                            }
                        } catch (err: any) {
                            outputChannel.appendLine(`[aggregateWorkspaceApiIndex] per-repo read failed: ${err?.message ?? err}`);
                        }
                    }
                    wsWorking.apiIndex = mergedApiIndex;
                    outputChannel.appendLine(`[aggregateWorkspaceApiIndex] workspace apiIndex hydrated: ${Object.keys(mergedApiIndex).length} unique apis (${totalApis} raw across ${perRepoOrchestrators.size} per-repo stores)`);
                } catch (err: any) {
                    outputChannel.appendLine(`[aggregateWorkspaceApiIndex] failed: ${err?.message ?? err}`);
                }
            };
            aggregateWorkspaceApiIndex();
            workspaceWatcher.on(() => { aggregateWorkspaceApiIndex(); });

            // ADR-034 Phase C (#788 — Phase C: cross-repo summary + CrossRepoAnalyzer plug (ADR-034)) — second-pass reapply of summaries
            // in a stable order. Tier-1 parallel dispatch causes per-repo
            // applies to race: alpha's apply can fire before beta's
            // summary is persisted, missing cross_repo_http_edges. After
            // every per-repo runner has finished, walk all orchestrators
            // sequentially and reapply — the analyzers' sparse-update +
            // idempotency makes this cheap, and the second pass sees
            // every other repo's final summary so HTTP-edge matching
            // succeeds for everyone.
            try {
                let reapplied = 0;
                for (const [repoId, orch] of perRepoOrchestrators) {
                    try {
                        const summary = orch.produceSummary(repoId);
                        aggregator.applySummary(repoId, summary);
                        reapplied += 1;
                    } catch (err: any) {
                        outputChannel.appendLine(`[WorkspaceOrchestrator] second-pass apply failed for ${repoId}: ${err?.message ?? err}`);
                    }
                }
                // #817 (2026-06-11) — first-init baseline rotation. Without
                // a baseline, every cross-repo edge reads `added` forever
                // (rotation previously only happened on manual resync) and
                // the hash-staleness diff in recomputeDiffs has nothing to
                // compare against — so producer changes never flipped any
                // edge to `modified` and the cross-repo push never fired.
                // Rotate exactly once, when no baseline exists yet; later
                // activations and resyncs keep their own rotation rules.
                try {
                    if (reapplied > 0 && typeof (aggregator as any).hasBaseline === 'function' && !(aggregator as any).hasBaseline()) {
                        aggregator.rotateBaseline();
                        outputChannel.appendLine('[WorkspaceOrchestrator] first-init aggregator baseline rotated (#817)');
                    }
                } catch (err: any) {
                    outputChannel.appendLine(`[WorkspaceOrchestrator] first-init baseline rotation failed: ${err?.message ?? err}`);
                }
                // ADR-034 Phase F (#791 — Phase F: Knowledge Map per-repo split (ADR-034)) — after cross-repo data is final,
                // (re)build the workspace Knowledge Map graph + persist it
                // into the aggregator so `#/map` is ready when the user
                // opens it. Single-repo workspaces use the per-repo map
                // path (unchanged).
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { buildWorkspaceMapGraph } = require('./core/graph/mapGraphBuilder');
                    const mapGraph = buildWorkspaceMapGraph(aggregator, workspaceRoot);
                    aggregator.updateWorkingGraph(mapGraph.graphId, mapGraph);
                } catch (err: any) {
                    outputChannel.appendLine(`[WorkspaceOrchestrator] workspace map build failed: ${err?.message ?? err}`);
                }

                // ADR-034 Phase H (#793 — Phase H: Tours per repo + workspace meta-tour (ADR-034)) — workspace meta-tour: one step
                // per repo, topologically sorted by cross_repo_http_edges.
                // Persisted as graphId='tour:workspace' in the aggregator
                // so the existing TourView/TourPlaybackControls can pick
                // it up without any per-repo store access.
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { buildWorkspaceMetaTour } = require('./core/analysis/tourBuilder');
                    const steps = buildWorkspaceMetaTour(aggregator, workspaceRoot);
                    // Persist as a DiagramGraph for parity with map:workspace.
                    // Nodes encode each step; renderer reads steps from meta.
                    const tourGraph = {
                        graphId: 'tour:workspace',
                        type: 'map' as const,   // closest existing renderer hook; tour view reads meta.steps
                        nodes: [],
                        edges: [],
                        anchors: {},
                        meta: {
                            workspaceTour: true,
                            steps,
                            stepCount: steps.length,
                            workspaceRoot,
                            builtAt: Date.now(),
                        },
                    };
                    aggregator.updateWorkingGraph(tourGraph.graphId, tourGraph);
                    outputChannel.appendLine(`[WorkspaceOrchestrator] workspace meta-tour: ${steps.length} steps`);
                } catch (err: any) {
                    outputChannel.appendLine(`[WorkspaceOrchestrator] workspace meta-tour build failed: ${err?.message ?? err}`);
                }
                aggregator.save();
                outputChannel.appendLine(`[WorkspaceOrchestrator] cross-repo second-pass: ${reapplied}/${perRepoOrchestrators.size} repos reapplied`);
            } catch (err: any) {
                outputChannel.appendLine(`[WorkspaceOrchestrator] second-pass orchestration failed: ${err?.message ?? err}`);
            }
        }
        if (wsInit.failures.length) {
            for (const f of wsInit.failures) {
                outputChannel.appendLine(`[WorkspaceOrchestrator] failure on ${f.repoId}: ${f.error}`);
            }
        }
    } catch (err: any) {
        // Phase A/B: never let the orchestrator block extension activation.
        // The existing snapshotStore + cascade still work in single-repo
        // mode without monorepo.db; we just log and continue.
        outputChannel.appendLine(`[WorkspaceOrchestrator] initialize failed (non-blocking): ${err?.message ?? err}`);
    }

    gitDiffStore = new GitDiffStore(workspaceRoot, snapshotStore.getSqliteStore());
    gitDiffStore.setLogger((msg) => outputChannel.appendLine(msg));
    commentStore = new CommentStore([]);
    sourceNavigator = new SourceNavigator();

    // Workspace write-lock (introduced for MCP self-init compatibility).
    // The extension is the natural owner — when active, it holds the lock so
    // a standalone MCP process spawned on the same workspace falls back to
    // read-only and the two never race on SQLite writes. We log a status
    // message either way; the extension keeps functioning if another writer
    // is already there (e.g. a second VS Code window on the same workspace),
    // it just means our updates may race with theirs as before.
    // #829 (2026-06-10) — the yield/reclaim cycle is re-armable. Before
    // this fix, yielding was one-way: auto-update stayed off and the
    // in-memory snapshots froze for the rest of the session while the MCP
    // kept writing the DB — every in-memory read (graphs, #827 regression
    // scope) silently served stale data until a manual resync or restart.
    // Now: yield → watch the lock → when the MCP exits, re-acquire,
    // re-enable auto-update, resync (rehydrates from disk truth), and
    // re-arm the preempt watcher for the next MCP.
    const armPreemptWatcher = (): void => {
        // watchPreemptRequest fires once, so each yield re-arms via the
        // reclaim path below.
        extensionPreemptUnwatch = watchPreemptRequest(workspaceRoot, (req) => {
            outputChannel.appendLine(`[WorkspaceLock] Preempt request from pid ${req.pid} (${req.label ?? 'mcp'}) — yielding lock + disabling auto-update.`);
            if (extensionWorkspaceLock) {
                extensionWorkspaceLock.release();
                extensionWorkspaceLock = null;
            }
            extensionYieldedToMcp = true;
            try { syncOrchestrator?.setAutoUpdate(false); } catch { /* */ }
            try {
                vscode.window.showWarningMessage(
                    'CodeAtlas: MCP process took workspace write ownership. Auto-update paused until it exits.',
                );
            } catch { /* */ }
            armReclaimWatcher();
        });
    };
    const armReclaimWatcher = (): void => {
        extensionReclaimUnwatch?.();
        extensionReclaimUnwatch = watchLockReclaimable(workspaceRoot, () => {
            extensionReclaimUnwatch = null;
            // A stale preempt request (writer crashed before clearing it)
            // would instantly re-trigger the new preempt watcher — clear it
            // when its requester is gone.
            const pending = readPreemptRequest(workspaceRoot);
            if (pending) {
                try { process.kill(pending.pid, 0); } catch { clearPreemptRequest(workspaceRoot); }
            }
            const reclaimed = acquireWorkspaceLock(workspaceRoot, 'vscode-extension');
            if (!reclaimed) {
                // Raced another writer — keep watching.
                outputChannel.appendLine('[WorkspaceLock] Reclaim attempt lost a race — re-watching.');
                armReclaimWatcher();
                return;
            }
            extensionWorkspaceLock = reclaimed;
            extensionYieldedToMcp = false;
            outputChannel.appendLine(`[WorkspaceLock] MCP writer exited — reclaimed write lock (pid ${reclaimed.pid}). Re-enabling auto-update + resyncing.`);
            try { syncOrchestrator?.setAutoUpdate(config.get<boolean>('autoUpdateOnSave', true)); } catch { /* */ }
            // Rehydrate: the MCP wrote the DB while our in-memory state was
            // frozen. Resync re-scans the disk (source of truth), rebuilds
            // in-memory, and persists — closing the #829 staleness window.
            try {
                void vscode.commands.executeCommand('codeatlas.resyncEverything');
            } catch (err: any) {
                outputChannel.appendLine(`[WorkspaceLock] post-reclaim resync failed: ${err?.message ?? err}`);
            }
            armPreemptWatcher();
        });
    };

    extensionWorkspaceLock = acquireWorkspaceLock(workspaceRoot, 'vscode-extension');
    if (extensionWorkspaceLock) {
        outputChannel.appendLine(`[WorkspaceLock] Acquired write lock (pid ${extensionWorkspaceLock.pid}).`);
        // MCP-preferred protocol: watch the workspace's .mcp-preempt file.
        // When an MCP process writes one, yield by releasing the lock and
        // disabling auto-update until the MCP exits (#829 reclaim).
        armPreemptWatcher();
    } else {
        const owner = readLockOwner(workspaceRoot);
        outputChannel.appendLine(`[WorkspaceLock] Could not acquire — held by pid ${owner?.pid ?? 'unknown'} (${owner?.label ?? 'unlabeled'}). Extension stays read-only until that process exits (#829 auto-reclaim active).`);
        extensionYieldedToMcp = true;
        // #829 — start watching immediately so we reclaim when the current
        // holder exits (previously required a workspace restart).
        armReclaimWatcher();
    }

    // Initialize sync orchestrator
    const ignorePatterns = config.get<string[]>('ignore') || undefined;
    // Issue 195: configurable file-size cap. Default 5 MB; lower for slow machines, higher for repos with large generated files.
    const maxFileSize = config.get<number>('maxFileSize', 5 * 1024 * 1024);
    syncOrchestrator = new SyncOrchestrator(workspaceRoot, snapshotStore, commentStore, ignorePatterns, maxFileSize);
    previousSyncOrchestrator = syncOrchestrator; // Issue 101: track for disposal on reload
    // If we already yielded to / lost to an MCP process at activate time,
    // start the orchestrator with auto-update OFF so the user's saves don't
    // race the MCP for writes.
    syncOrchestrator.setAutoUpdate(extensionYieldedToMcp ? false : config.get<boolean>('autoUpdateOnSave', true));
    syncOrchestrator.setLogger((msg) => outputChannel.appendLine(msg));

    // Initialize LSP fallback resolver
    const lspResolver = getLspFallbackResolver();
    lspResolver.updateOptions({
        enabled: config.get<boolean>('lspFallback', false),
        timeout: config.get<number>('lspTimeout', 2000),
    });
    // Inject VS Code's built-in definition provider for TypeScript/JavaScript
    lspResolver.setDefinitionProvider(async (filePath: string, line: number, column: number): Promise<DefinitionLocation[] | null> => {
        try {
            const uri = vscode.Uri.file(filePath);
            const pos = new vscode.Position(line, column);
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider', uri, pos,
            );
            if (!locations || locations.length === 0) return null;
            return locations.map((loc) => ({
                filePath: vscode.workspace.asRelativePath(loc.uri, false),
                line: loc.range.start.line,
                column: loc.range.start.character,
            }));
        } catch {
            return null;
        }
    });
    syncOrchestrator.setLspFallbackResolver(lspResolver);

    // Initialize LLM naming service (opt-in)
    const llmNamingService = new LlmNamingService(workspaceRoot, snapshotStore.getSqliteStore());
    llmNamingService.setLogger((msg) => outputChannel.appendLine(msg));
    // Always configure the LLM service if credentials or a local provider are available
    // (needed for NL queries regardless of whether llmNaming is enabled)
    context.secrets.get('codeatlas.openRouterApiKey').then((storedKey) => {
        const provider = config.get<string>('llmProvider', 'openrouter');
        const keyOptional = provider === 'ollama' || provider === 'custom';
        if (storedKey || keyOptional) {
            llmNamingService.configure(storedKey ?? '', config.get<string>('llmModel'), provider);
        }
    });
    if (config.get<boolean>('llmNaming', false)) {
        // Show consent warning on first activation per workspace
        const llmConsentKey = 'codeatlas.llmConsentShown';
        const consentShown = context.workspaceState.get<boolean>(llmConsentKey, false);
        if (!consentShown) {
            analytics.notification('llm_consent_prompt', 'warning');
            vscode.window.showWarningMessage(
                'CodeAtlas LLM Naming is enabled. Code snippets (max 200 chars per file, up to 8 files per cluster) will be sent to OpenRouter API for semantic naming.',
                'OK, Continue', 'Disable'
            ).then((choice) => {
                analytics.notificationActionClicked('llm_consent_prompt', choice ?? 'dismissed');
                if (choice === 'Disable') {
                    analytics.track('llm_consent_denied');
                    vscode.workspace.getConfiguration('codeatlas').update('llmNaming', false, vscode.ConfigurationTarget.Workspace);
                } else {
                    analytics.track('llm_consent_granted');
                    context.workspaceState.update(llmConsentKey, true);
                }
            });
        }
    }
    syncOrchestrator.setLlmNamingService(llmNamingService);
    // The service is `configure()`d above whenever a provider is selected (for
    // on-demand NL queries), which makes it `isConfigured`. But the AUTOMATIC
    // cluster-naming pass must additionally respect the user's explicit
    // `codeatlas.llmNaming` opt-in (default false) — otherwise a globally
    // selected `ollama`/`custom` provider fires nameClusters on every init +
    // cascade (and spams `fetch failed` when the local endpoint is down).
    syncOrchestrator.setLlmNamingEnabled(config.get<boolean>('llmNaming', false));

    // Status bar indicator
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(symbol-structure) CodeAtlas';
    statusBarItem.tooltip = 'CodeAtlas — Click to open System Design diagram';
    statusBarItem.command = 'codeatlas.openMicroserviceDiagram';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Initialize view providers
    apiExplorerProvider = new ApiExplorerProvider();
    fileExplorerProvider = new FileExplorerProvider();
    functionExplorerProvider = new FunctionExplorerProvider();
    changedItemsProvider = new ChangedItemsProvider();
    commentsProvider = new CommentsProvider();
    featureExplorerProvider = new FeatureExplorerProvider();
    microserviceExplorerProvider = new MicroserviceExplorerProvider();

    // Use createTreeView so we can call .reveal() on all explorers
    apiTreeView = vscode.window.createTreeView('codeatlas.apiExplorer', { treeDataProvider: apiExplorerProvider });
    featureTreeView = vscode.window.createTreeView('codeatlas.featureExplorer', { treeDataProvider: featureExplorerProvider });
    microserviceTreeView = vscode.window.createTreeView('codeatlas.microserviceExplorer', { treeDataProvider: microserviceExplorerProvider });

    // Welcome view — visible until first initialization
    welcomeProvider = new WelcomeProvider();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('codeatlas.welcome', welcomeProvider),
    );

    context.subscriptions.push(
        apiTreeView,
        vscode.window.registerTreeDataProvider('codeatlas.fileExplorer', fileExplorerProvider),
        vscode.window.registerTreeDataProvider('codeatlas.functionExplorer', functionExplorerProvider),
        vscode.window.registerTreeDataProvider('codeatlas.changedItems', changedItemsProvider),
        vscode.window.registerTreeDataProvider('codeatlas.comments', commentsProvider),
        featureTreeView,
        microserviceTreeView,
    );

    // Initialize auth service. The Account sidebar tree, Sign In/Sign Out
    // commands, and welcome-panel sign-in step were all removed — sign-in is
    // not required to use any feature and is no longer surfaced in the UI
    // (3.3.3). The service is kept around because if a stored session exists
    // (legacy users) it still binds analytics to their account; new users
    // never see auth at all.
    authService = new ClerkAuthService(context, CLERK_PUBLISHABLE_KEY);
    authService.setLogger((msg) => outputChannel.appendLine(msg));

    await vscode.commands.executeCommand('setContext', 'codeatlas:authenticated', true);
    void loadStateAfterAuth();
    authService.checkAuth().then((isAuth) => {
        if (isAuth) {
            analytics.setUser(authService.getUser());
            analytics.track('signed_in', { source: 'restored_session' });
            startPeriodicAuthCheck(context);
        }
    });

    // Initialize panel manager
    panelManager = new PanelManager(context.extensionUri);

    // Register URI handler — receives {scheme}://{publisher}.{extName}/auth?token=...
    // after user signs in on the hosted auth page in the system browser.
    context.subscriptions.push(
        vscode.window.registerUriHandler({
            async handleUri(uri: vscode.Uri) {
                // /connect-github — invoked when the localhost browser opens
                // `${uriScheme}://${extensionId}/connect-github`. Opening the
                // URL focuses the editor before the auth dialog appears,
                // eliminating the "click does nothing" UX where the dialog
                // surfaced behind the browser window.
                if (uri.path === '/connect-github') {
                    // The browser passes its WebSocket clientId via `?cid=...`
                    // so we can route the success/failure response back to
                    // exactly that tab instead of broadcasting to every open
                    // browser tab connected to this extension.
                    const cid = new URLSearchParams(uri.query).get('cid') ?? undefined;
                    await performGitHubConnect('uri_handler', cid);
                    return;
                }
                if (uri.path === '/open-source') {
                    // Browser-side flow / file / sequence node click routes
                    // here so the OS focuses the editor BEFORE the file is
                    // opened (otherwise showTextDocument lands in a backgrounded
                    // editor and the user has to switch to it manually).
                    // We just translate query params back into the message
                    // shape and dispatch through the existing router so the
                    // openSource handler in navigationHandlers.ts does all
                    // the path resolution + cursor positioning work in one place.
                    const params = new URLSearchParams(uri.query);
                    const filePath = params.get('file');
                    if (!filePath) return;
                    const lineRaw = params.get('line');
                    const colRaw = params.get('col');
                    const offsetRaw = params.get('offset');
                    const cid = params.get('cid');
                    const message = {
                        type: 'openSource' as const,
                        filePath,
                        line: lineRaw ? parseInt(lineRaw, 10) : undefined,
                        column: colRaw ? parseInt(colRaw, 10) : undefined,
                        charOffset: offsetRaw ? parseInt(offsetRaw, 10) : undefined,
                    };
                    const sourcePanelId = cid ? `ws:${cid}` : 'uri-handler';
                    if (routerDispatch) {
                        routerDispatch(message, sourcePanelId);
                    } else {
                        outputChannel.appendLine('[uri /open-source] router not ready; dropping message');
                    }
                    return;
                }
                if (uri.path === '/oss-interest-registered') {
                    // The dashboard deep-links here after the user registers
                    // open-source interest, so the editor stops the daily reminder.
                    void extensionContext?.globalState.update('codeatlas.ossInterestRegistered', true);
                    analytics.track('oss_reminder_completed', { source: 'deep_link' });
                    void vscode.window.showInformationMessage('Thanks — your open-source interest is registered.');
                    return;
                }
                if (uri.path !== '/auth') return;
                const params = new URLSearchParams(uri.query);
                const token = params.get('token');
                const userId = params.get('userId');
                const email = params.get('email');
                const firstName = params.get('firstName') ?? undefined;
                const lastName = params.get('lastName') ?? undefined;
                const callbackState = params.get('state');
                if (!token || !userId || !email) {
                    analytics.track('auth_callback_invalid', { has_token: !!token, has_user_id: !!userId, has_email: !!email });
                    vscode.window.showErrorMessage('CodeAtlas: Invalid auth response — missing required fields.');
                    return;
                }
                // Issue 371 / ADR-021: verify the CSRF state matches what we
                // stashed at signin_started. Mismatch → abort. Stale (>10min)
                // → abort and clear. Single-use: clear after successful match.
                if (!verifyAndConsumeAuthState(context, callbackState)) {
                    analytics.track('auth_callback_state_mismatch', { has_state: !!callbackState });
                    vscode.window.showErrorMessage('CodeAtlas: Auth response failed verification. Please sign in again.');
                    return;
                }
                analytics.track('auth_callback_received', { source: 'uri_handler' });
                await handleLogin(token, userId, email, firstName, lastName, context);
            },
        })
    );

    // Issue #174: Message dispatch is handled by the router created below (after all
    // services are initialized). Register a forwarding callback now; the actual
    // dispatch function is assigned once the HandlerContext is ready.
    let routerDispatch: ((message: any, sourcePanelId: string) => void) | null = null;
    panelManager.onMessage((message, sourcePanelId) => {
        if (routerDispatch) routerDispatch(message, sourcePanelId);
    });

    // File system watcher — reacts to any on-disk change, not just VS Code saves
    const watcher = vscode.workspace.createFileSystemWatcher(SUPPORTED_EXTENSIONS_GLOB);

    // #821 (2026-06-10) — in multi-repo mode the WorkspaceWatcher routes
    // file events to the owning per-repo orchestrator. The legacy single-
    // repo subscriptions below double-processed the SAME save through the
    // workspace-level SyncOrchestrator, writing a SECOND copy of the
    // file/flow/sequence graphs into the workspace store whose diff was
    // computed against the workspace store's own (skeletal) baseline —
    // i.e. permanently `unchanged`. That stale shadow then won the
    // requestRoute merge and per-repo `~ modified` markers never reached
    // the UI (fragility pattern #8). Gate the legacy dispatch off when
    // multi-repo; `workspaceIsMulti` is module-scope and settles before
    // the first watcher event because activate() awaits orchestrator
    // initialize() ahead of user interaction.
    const legacyWatcherEnabled = () => !workspaceIsMulti;
    context.subscriptions.push(
        // Any file modified on disk (external editors, git, build tools, etc.)
        watcher.onDidChange((uri) => {
            if (uri.scheme === 'file' && legacyWatcherEnabled()) {
                syncOrchestrator.handleFileSave(uri.fsPath);
                maybeNudgeFirstSave(); // Issue 363 — trigger #6
            }
        }),
        // New file created
        watcher.onDidCreate((uri) => {
            if (uri.scheme === 'file' && legacyWatcherEnabled()) {
                syncOrchestrator.handleFileCreated(uri.fsPath);
            }
        }),
        // File deleted
        watcher.onDidDelete((uri) => {
            if (uri.scheme === 'file' && legacyWatcherEnabled()) {
                syncOrchestrator.handleFileDeleted(uri.fsPath);
            }
        }),
        // File renamed (VS Code rename in explorer or Rename Symbol)
        vscode.workspace.onDidRenameFiles((e) => {
            if (!legacyWatcherEnabled()) return;
            for (const { oldUri, newUri } of e.files) {
                if (oldUri.scheme === 'file' && newUri.scheme === 'file') {
                    syncOrchestrator.handleFileRenamed(oldUri.fsPath, newUri.fsPath);
                }
            }
        }),
        // Live in-editor sync — update open diagram panels as you type (debounced 500ms)
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (
                legacyWatcherEnabled() &&
                e.document.uri.scheme === 'file' &&
                e.contentChanges.length > 0 &&
                SUPPORTED_FILE_REGEX.test(e.document.uri.fsPath)
            ) {
                syncOrchestrator.handleFileSave(e.document.uri.fsPath, e.document.getText());
                maybeNudgeFirstSave(); // Issue 363 — trigger #6
            }
        }),
        watcher,
    );


    // Issue 114 (extended 2026-05-11 — Issue 371 — Auth URI handler has no replay / CSRF protection): Watch for git HEAD changes
    // (branch switch, pull, commit) → auto resync.
    //
    // `.git/HEAD` only changes on branch switch / detached checkout. A regular
    // `git commit` on the current branch leaves `.git/HEAD` untouched — only
    // `.git/refs/heads/<branch>` and `.git/logs/HEAD` get updated. Without
    // watching the reflog, commits made inside the workspace silently stop
    // refreshing the baseline, leaving the diff permanently "modified"
    // against pre-commit content even though `git status` shows clean.
    //
    // `.git/logs/HEAD` is appended on every ref-update (commit, checkout,
    // reset, pull, merge, cherry-pick, rebase step), so watching it gives
    // us a single stable signal for "user did something git-shaped".
    const gitHeadWatcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
    const gitReflogWatcher = vscode.workspace.createFileSystemWatcher('**/.git/logs/HEAD');
    let gitResyncTimer: ReturnType<typeof setTimeout> | null = null;
    const triggerResync = (reason: string) => {
        if (gitResyncTimer) clearTimeout(gitResyncTimer);
        gitResyncTimer = setTimeout(async () => {
            outputChannel.appendLine(`[Git] ${reason} — resyncing workspace...`);
            statusBarItem.text = '$(loading~spin) CodeAtlas: Resyncing...';
            try {
                // BUGFIX (init-path): git events (commit / pull / branch switch /
                // even a reflog touch on reopen) auto-fire this. The monolithic
                // resync HANGS for multi-repo, so routine git activity silently
                // wedged the workspace — route through the safe helper.
                await resyncWorkspaceSafe();
                const fileCount = Object.keys(snapshotStore.getWorking().files).length;
                statusBarItem.text = `$(symbol-structure) CodeAtlas: ${fileCount} files`;
            } catch (err: any) {
                outputChannel.appendLine(`[Git] Resync failed: ${err?.message ?? err}`);
                statusBarItem.text = '$(error) CodeAtlas: Resync failed';
            }
        }, 2000);
    };
    context.subscriptions.push(
        gitHeadWatcher.onDidChange(() => triggerResync('HEAD changed (branch switch / detached checkout)')),
        // Reflog is created on first commit; watch both create and change.
        gitReflogWatcher.onDidChange(() => triggerResync('reflog updated (commit / pull / reset / merge)')),
        gitReflogWatcher.onDidCreate(() => triggerResync('reflog initialised')),
        gitHeadWatcher,
        gitReflogWatcher,
        // ADR-034 Phase D Tier-1 — make the WorkspaceWatcher cleanup
        // part of context.subscriptions so VS Code disposes it on
        // deactivate. Wrap as a Disposable since it returns a Promise.
        { dispose: () => { if (workspaceWatcher) void workspaceWatcher.close(); } },
    );

    // Broadcast init progress to all webview panels
    syncOrchestrator.onProgress((phase, progress, message) => {
        panelManager.broadcastMessage({ type: 'initProgress', phase, progress, message });
        // Also broadcast to browser clients
        if (wsBridge?.hasClients()) {
            wsBridge.broadcast({ type: 'initProgress', phase, progress, message });
        }
    });

    // Listen for graph updates
    syncOrchestrator.onRefresh((graphIds) => {
        // While in git diff mode, panels are frozen — don't push live updates
        if (gitDiffState) return;
        for (const graphId of graphIds) {
            const graph = snapshotStore.getWorking().graphs[graphId];
            if (graph) {
                panelManager.updatePanel(graphId, graph);
            } else {
                panelManager.closePanel(graphId);
            }
        }

        // Rebuild api-list graphs for all clusters: their diff status depends on sequence
        // graph content which may have just changed (e.g. handler body modified).
        // updatePanel() is a safe no-op for panels that aren't open/ready.
        const working = snapshotStore.getWorking();
        for (const cluster of Object.values(working.clusters ?? {})) {
            const apiListGraph = buildApiListGraph(cluster, working, snapshotStore.getBaseline());
            snapshotStore.updateWorkingGraph(apiListGraph.graphId, apiListGraph);
            panelManager.updatePanel(apiListGraph.graphId, apiListGraph);
        }

        refreshViews();
    });

    // When a panel becomes ready, send git diff context if a session is active
    panelManager.onPanelReady((panelId) => {
        if (gitDiffState) {
            panelManager.broadcastMessage({
                type: 'setGitDiffContext',
                baseHash: gitDiffState.baseHash,
                headHash: gitDiffState.headHash,
                baseLabel: gitDiffState.baseLabel,
                headLabel: gitDiffState.headLabel,
            });
        }
    });

    // When user navigates back/forward in a panel, push the latest graph for the
    // newly-displayed diagram so diff state is always up to date.
    panelManager.onNavigated((_panelId, graphId) => {
        // In git diff mode, serve from the diffed graphs instead of live state
        if (gitDiffState) {
            const graph = gitDiffState.diffedGraphs[graphId];
            if (graph) panelManager.updatePanel(graphId, graph);
            return;
        }
        const graph = snapshotStore.getWorking().graphs[graphId];
        if (graph) {
            panelManager.updatePanel(graphId, graph);
        }
    });

    // ─── WebSocket Bridge: Standalone browser UI ─────────────────────────
    /** Build explorer data for browser sidebar from current snapshot.
     *  UX-50b (2026-06-06): every item carries `repoId` so the webview can
     *  group items by repo in multi-repo workspaces. Services already store
     *  `repoId` directly; clusters / APIs / files / functions inherit it
     *  from the owning service via the longest-rootPath-prefix match.
     *
     *  UX-50 multi-repo (2026-06-06): in multi-repo mode, the workspace
     *  store is empty by design — services / clusters / apis / files all
     *  live in per-repo stores. Aggregate across the perRepoOrchestrators
     *  map so the scope picker has items to show (and so the
     *  ExplorerSidebar can render per-repo grouping). */
    function buildExplorerData() {
        const workspaceWorking = snapshotStore.getWorking();
        // In multi-repo mode, fold every per-repo snapshot into a single
        // synthesised working snapshot so the rest of this function — which
        // walks services / clusters / apis / files — sees the aggregate.
        // Each per-repo store's `Service.repoId` is preserved verbatim so
        // the picker's repo column / sidebar grouping works downstream.
        let working: any;
        if (workspaceIsMulti && perRepoOrchestrators.size > 0) {
            // 2026-06-09 — re-key clusters during the per-repo merge with
            // `<clusterId>::<repoKey>` composite keys. Sub-repos sharing
            // identifiers (e.g. ~60 SLS demos all naming their cluster
            // `cluster:model` because every one bundles a `model/User.js`)
            // would otherwise collapse to one survivor via `Object.assign`.
            // Downstream readers of `working.clusters` here iterate
            // `Object.values(...)` (services + features pickers below), so
            // composite-key bookkeeping is invisible to them — they see
            // every cluster regardless of id reuse.
            const merged: any = {
                services: {}, clusters: {}, apiIndex: {}, files: {}, graphs: {},
            };
            for (const [orchKey, orch] of perRepoOrchestrators) {
                try {
                    const w: any = orch.getStore().getWorking();
                    Object.assign(merged.services, w.services ?? {});
                    for (const [cid, c] of Object.entries(w.clusters ?? {})) {
                        merged.clusters[`${cid}::${orchKey}`] = c;
                    }
                    Object.assign(merged.apiIndex, w.apiIndex ?? {});
                    Object.assign(merged.files, w.files ?? {});
                } catch (err: any) {
                    outputChannel.appendLine(`[buildExplorerData] per-repo merge failed: ${err?.message ?? err}`);
                }
            }
            working = merged;
        } else {
            working = workspaceWorking;
        }
        const allServices = Object.values(working.services ?? {});
        // UX-50 (2026-06-06) — translate per-repo `Service.repoId`
        // (rootPath-form, e.g. "api-service") to the aggregator's
        // hex-form repo id (e.g. "63529fb2695b5d06") so the picker's
        // grouping bucket key matches `repos[].repoId` from
        // `workspaceState`. Without this translation, every item lands
        // in the "Unassigned" tail bucket even when the repo IS known.
        let translateRepoId = (rid: string | undefined): string | undefined => rid;
        if (workspaceIsMulti) {
            try {
                const aggRepos: readonly any[] = aggregator?.listRepos() ?? [];
                const rootPathToHex = new Map<string, string>();
                for (const r of aggRepos) {
                    if (r.rootPath) rootPathToHex.set(r.rootPath, r.repoId);
                    if (r.name) rootPathToHex.set(r.name, r.repoId);
                }
                translateRepoId = (rid) => (rid ? (rootPathToHex.get(rid) ?? rid) : undefined);
            } catch (err: any) {
                outputChannel.appendLine(`[buildExplorerData] repoId translate setup failed: ${err?.message ?? err}`);
            }
        }
        // Sort by rootPath length descending so longer (more specific) roots
        // win when a file matches multiple service prefixes.
        //
        // #816 (2026-06-10) — in multi-repo workspaces prefer the
        // aggregator's repo registry over per-service rootPaths for path
        // → repoId resolution. After Phase 5 in syncOrchestrator,
        // per-repo services' rootPaths are scoped to the sub-repo's
        // INTERNAL layout (e.g. `src/DotNetServerless.Lambda`, NOT the
        // workspace-relative `aws-dotnet…/src/...`). The aggregator's
        // `r.rootPath` is the workspace-relative sub-repo dir, so prefix
        // matching against workspace-relative file paths works.
        const aggRepoRootEntries = workspaceIsMulti && aggregator
            ? aggregator.listRepos()
                .filter(r => r.rootPath)
                .map(r => ({ rootPath: r.rootPath, repoId: r.repoId }))
                .sort((a, b) => b.rootPath.length - a.rootPath.length)
            : [];
        const serviceRootEntries = aggRepoRootEntries.length > 0
            ? aggRepoRootEntries
            : allServices
                .filter((s: any) => s.repoId && s.rootPath)
                .map((s: any) => ({ rootPath: s.rootPath as string, repoId: translateRepoId(s.repoId) as string }))
                .sort((a, b) => b.rootPath.length - a.rootPath.length);
        const resolveRepoIdForPath = (fp: string): string | undefined => {
            const relFp = path.isAbsolute(fp) ? path.relative(workspaceRoot, fp) : fp;
            const norm = relFp.replace(/\\/g, '/').replace(/^\.\//, '');
            for (const e of serviceRootEntries) {
                const root = e.rootPath.replace(/\\/g, '/').replace(/^\.\//, '');
                if (root === '' || root === '.') continue;
                if (norm === root || norm.startsWith(root + '/')) return e.repoId;
            }
            return undefined;
        };
        // 2026-06-10 — #809 fix. In multi-repo init, per-repo `detectServices`
        // can land before per-repo apiIndex is fully populated, leaving
        // `service.exposedApiCount = 0` in the merged store even when the L1
        // microservice graph (built later) shows the correct route count.
        // Recompute the count here from the merged `working.apiIndex` so the
        // picker subtitle reflects ground truth. We use the same rootPath-
        // prefix match that `resolveRepoIdForPath` uses below.
        const NON_HTTP_METHODS = new Set([
            'SIGNAL', 'EVENT_LISTENER', 'EVENT_EMIT', 'AOP_ASPECT', 'AOP_AROUND',
            'AOP_BEFORE', 'AOP_AFTER', 'AOP_AFTERRETURNING', 'AOP_AFTERTHROWING',
            'DI_DEPENDENCY', 'MIDDLEWARE', 'SERVLET_FILTER', 'HANDLER_INTERCEPTOR',
            'DATA_FETCH', 'STATIC_PATHS', 'NETWORK',
            // TICKET-MOBILE-1 — UI navigation is not an "API" for the per-service
            // "N APIs" picker subtitle (screens are shown at L2a, not here).
            'SCREEN', 'NAV_ROUTE',
        ]);
        const apiCountByRootPath = new Map<string, number>();
        for (const a of Object.values(working.apiIndex ?? {}) as any[]) {
            if (!a || NON_HTTP_METHODS.has(a.method)) continue;
            const fp = a.filePath || '';
            const relFp = path.isAbsolute(fp) ? path.relative(workspaceRoot, fp) : fp;
            const norm = relFp.replace(/\\/g, '/').replace(/^\.\//, '');
            for (const e of serviceRootEntries) {
                const root = e.rootPath.replace(/\\/g, '/').replace(/^\.\//, '');
                if (root === '' || root === '.') continue;
                if (norm === root || norm.startsWith(root + '/')) {
                    apiCountByRootPath.set(e.rootPath, (apiCountByRootPath.get(e.rootPath) || 0) + 1);
                    break;
                }
            }
        }
        const services = allServices.map((s: any) => {
            const recomputed = apiCountByRootPath.get(s.rootPath) ?? 0;
            const effective = Math.max(s.exposedApiCount ?? 0, recomputed);
            return {
                id: s.id, label: s.name, subtitle: pickerSubtitle(s.category, s.technology, effective),
                diff: s.diff, action: { type: 'openFeatureForService', serviceId: s.id },
                repoId: translateRepoId(s.repoId),
            };
        });
        const serviceIdToRepoId = new Map<string, string | undefined>(
            allServices.map((s: any) => [s.id as string, translateRepoId(s.repoId)] as const),
        );
        const features = Object.values(working.clusters ?? {}).map((c: any) => ({
            id: c.id, label: c.name || c.label, subtitle: `${(c.files ?? []).length} files`,
            diff: c.diff, action: { type: 'openApiListForCluster', clusterId: c.id, serviceId: c.serviceId || '' },
            repoId: c.serviceId ? serviceIdToRepoId.get(c.serviceId) : undefined,
        }));
        const apis = Object.values(working.apiIndex).map((a: any) => ({
            id: a.apiId, label: `${a.method} ${a.route}`, subtitle: a.handlerName,
            diff: a.diff, action: { type: 'openSequenceForApi', apiId: a.apiId },
            repoId: resolveRepoIdForPath(a.filePath),
        }));
        // 2026-06-09 — multi-repo aggregation. In multi-repo mode the workspace
        // SnapshotStore's `working.clusters` / `working.apiIndex` are sparse:
        // clustering and API extraction run per-sub-repo so each sub-repo's
        // state.db holds its own data. Without this aggregation step the
        // home-page picker's two-step flow (Pick repo → Pick entity) shows
        // an empty step-2 list for any sub-repo whose data isn't in the
        // workspace store. Iterate every per-repo store, pull clusters +
        // apis, and merge with proper `repoId` stamping.
        if (workspaceIsMulti && perRepoOrchestrators.size > 0) {
            try {
                // 2026-06-09 — multi-repo aggregation via the already-loaded
                // perRepoOrchestrators (Phase B). Each orchestrator owns its
                // sub-repo's SnapshotStore, so `orch.getStore().getWorking()`
                // returns the per-repo clusters / apiIndex without any
                // additional `.load()` plumbing.
                //
                // The merge step earlier in this function uses Object.assign
                // which COLLAPSES key collisions across sub-repos — e.g.
                // 132 sub-repos all naming their cluster `cluster:model`
                // means only ONE survives in `merged.clusters`. We rebuild
                // the picker's features/apis lists here with proper
                // `(id, repoId)` dedup so every sub-repo contributes its
                // own entries.
                const aggRepos: readonly any[] = aggregator?.listRepos() ?? [];
                const rootPathToHex = new Map<string, string>();
                for (const r of aggRepos) {
                    if (r.rootPath) rootPathToHex.set(r.rootPath, r.repoId);
                    if (r.name) rootPathToHex.set(r.name, r.repoId);
                }
                const seenFeatureKeys = new Set(features.map(f => `${f.id}::${f.repoId ?? ''}`));
                const seenApiKeys = new Set(apis.map(a => `${a.id}::${a.repoId ?? ''}`));
                const repoIdSet = new Set(aggRepos.map((r: any) => r.repoId));
                for (const [repoKey, orch] of perRepoOrchestrators) {
                    try {
                        const repoWorking: any = orch.getStore().getWorking();
                        // #816 (2026-06-10) — `perRepoOrchestrators` is
                        // keyed by HEX repoId (see extension.ts:498), NOT
                        // by absolute path. The pre-#816 code ran
                        // `path.relative(workspaceRoot, repoKey)` over the
                        // hex which produced bogus repoIds like
                        // `../../../../<hex>` that downstream features +
                        // apis carried as their `repoId`. Step-2 of the
                        // home picker filters by `feature.repoId ===
                        // step1.repoId`; with the garbage prefix, 0
                        // matches ever surfaced. Detect a HEX key directly
                        // and use it; only when the key doesn't match an
                        // aggregator row do we fall back to the legacy
                        // path-derivation hack.
                        const repoHex = repoIdSet.has(repoKey)
                            ? repoKey
                            : (rootPathToHex.get(path.relative(workspaceRoot, repoKey).replace(/\\/g, '/'))
                                ?? rootPathToHex.get(path.basename(repoKey))
                                ?? repoKey);
                        for (const c of Object.values(repoWorking.clusters ?? {}) as any[]) {
                            const key = `${c.id}::${repoHex}`;
                            if (seenFeatureKeys.has(key)) continue;
                            seenFeatureKeys.add(key);
                            features.push({
                                id: c.id, label: c.name || c.label, subtitle: `${(c.files ?? []).length} files`,
                                diff: c.diff, action: { type: 'openApiListForCluster', clusterId: c.id, serviceId: c.serviceId || '' },
                                repoId: repoHex,
                            });
                        }
                        for (const a of Object.values(repoWorking.apiIndex ?? {}) as any[]) {
                            const key = `${a.apiId}::${repoHex}`;
                            if (seenApiKeys.has(key)) continue;
                            seenApiKeys.add(key);
                            apis.push({
                                id: a.apiId, label: `${a.method} ${a.route}`, subtitle: a.handlerName,
                                diff: a.diff, action: { type: 'openSequenceForApi', apiId: a.apiId },
                                repoId: repoHex,
                            });
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[buildExplorerData] per-orch aggregation failed for ${repoKey}: ${err?.message ?? err}`);
                    }
                }
            } catch (err: any) {
                outputChannel.appendLine(`[buildExplorerData] multi-repo aggregation failed: ${err?.message ?? err}`);
            }
        }
        // #816 (2026-06-10) — in multi-repo workspaces, rebuild the picker
        // step-1 `services` slice from `aggregator.listRepos()` (canonical
        // repo registry). Pre-#816 the slice came from `working.services`
        // which depended on each per-repo state.db carrying the full
        // workspace-services list (a leak from `detectServices(workspace
        // Root, …)` in syncOrchestrator). Sourcing from the aggregator
        // decouples picker step-1 from per-repo service detection so
        // Phase 5's `detectServices(this.repoRoot, …)` scoping can land
        // without regressing the picker.
        //
        // Each repo becomes ONE picker entry. API count is derived from
        // the now-complete `apis` array (rootPath-prefix match). The
        // primary technology comes from the per-repo store's first
        // detected service (works for both single-language repos and the
        // common multi-package monorepos).
        if (workspaceIsMulti) {
            try {
                const aggRepos: readonly any[] = aggregator?.listRepos() ?? [];
                if (aggRepos.length > 0) {
                    const apiCountByRepoPath = new Map<string, number>();
                    for (const a of apis) {
                        // `a.repoId` was stamped by the aggregation pass
                        // above using rootPath-prefix match; counts here
                        // are HTTP-method-filtered upstream.
                        if (!a.repoId) continue;
                        apiCountByRepoPath.set(a.repoId, (apiCountByRepoPath.get(a.repoId) || 0) + 1);
                    }
                    const newServices = aggRepos.map((r: any) => {
                        const apiCount = apiCountByRepoPath.get(r.repoId) ?? 0;
                        let technology = (r as any).technology || 'unknown';
                        let category: string | undefined = (r as any).category;
                        // Refine technology + category from the per-repo store's
                        // services — the aggregator repo row carries the bootstrap
                        // default 'unknown' technology and no category (BUG-CONNECT-4).
                        try {
                            const absPath = path.join(workspaceRoot, r.rootPath);
                            const orch = perRepoOrchestrators.get(r.repoId)
                                ?? Array.from(perRepoOrchestrators.values()).find(o => o.getWorkspaceRoot() === absPath || o.getRepoRoot?.() === absPath);
                            const subServices = Object.values(orch?.getStore().getWorking().services ?? {}) as any[];
                            if (technology === 'unknown' && subServices[0]?.technology) technology = subServices[0].technology;
                            category = repoCategoryFromServices(subServices) ?? category;
                        } catch { /* keep defaults */ }
                        return {
                            id: `service:${r.name}`,
                            label: r.name,
                            subtitle: pickerSubtitle(category, technology, apiCount),
                            diff: undefined,
                            action: { type: 'openFeatureForService', serviceId: `service:${r.name}` },
                            repoId: r.repoId,
                        };
                    });
                    // Replace the inner-service entries with the per-repo
                    // entries so the picker step-1 shows 132 sub-repos,
                    // not 200+ inner services.
                    services.length = 0;
                    services.push(...newServices);
                    outputChannel.appendLine(`[buildExplorerData] #816: picker step-1 rebuilt from aggregator.listRepos() — ${newServices.length} sub-repo entries`);
                }
            } catch (err: any) {
                outputChannel.appendLine(`[buildExplorerData] #816 picker rebuild failed: ${err?.message ?? err}`);
            }
        }
        const files = Object.keys(working.files).map(fp => {
            const relPath = path.isAbsolute(fp) ? path.relative(workspaceRoot, fp) : fp;
            return {
                id: fp, label: relPath.split('/').pop() || relPath, subtitle: relPath,
                action: { type: 'openFileDiagram', filePath: fp },
                repoId: resolveRepoIdForPath(fp),
            };
        });
        const functions: any[] = [];
        for (const [fp, rec] of Object.entries(working.files)) {
            const repoId = resolveRepoIdForPath(fp);
            for (const fn of (rec as any).symbols?.functions ?? []) {
                functions.push({
                    id: `${fp}:${fn.name}`, label: fn.name, subtitle: fp.split('/').pop(),
                    action: { type: 'openFunctionFlow', filePath: fp, functionName: fn.name },
                    repoId,
                });
            }
        }
        // 2026-06-09 — same multi-repo aggregation for files + functions
        // so the Flow Chart picker's step-2 list is non-empty for every
        // sub-repo.
        if (workspaceIsMulti) {
            try {
                const aggRepos: readonly any[] = aggregator?.listRepos() ?? [];
                const seenFileIds = new Set(files.map(f => f.id));
                const seenFunctionIds = new Set(functions.map(f => f.id));
                for (const r of aggRepos) {
                    if (!r.rootPath) continue;
                    try {
                        const absPath = path.join(workspaceRoot, r.rootPath);
                        const repoStore = repoStoreRegistry.getRepoStore(absPath);
                        if (!repoStore) continue;
                        const repoWorking: any = repoStore.getWorking();
                        for (const fp of Object.keys(repoWorking.files ?? {})) {
                            if (seenFileIds.has(fp)) continue;
                            seenFileIds.add(fp);
                            const relPath = path.isAbsolute(fp) ? path.relative(workspaceRoot, fp) : fp;
                            files.push({
                                id: fp, label: relPath.split('/').pop() || relPath, subtitle: relPath,
                                action: { type: 'openFileDiagram', filePath: fp },
                                repoId: r.repoId,
                            });
                            const rec: any = repoWorking.files[fp];
                            for (const fn of rec?.symbols?.functions ?? []) {
                                const fnId = `${fp}:${fn.name}`;
                                if (seenFunctionIds.has(fnId)) continue;
                                seenFunctionIds.add(fnId);
                                functions.push({
                                    id: fnId, label: fn.name, subtitle: fp.split('/').pop(),
                                    action: { type: 'openFunctionFlow', filePath: fp, functionName: fn.name },
                                    repoId: r.repoId,
                                });
                            }
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[buildExplorerData] per-repo files/functions aggregation failed for ${r.name ?? r.repoId}: ${err?.message ?? err}`);
                    }
                }
            } catch (err: any) {
                outputChannel.appendLine(`[buildExplorerData] multi-repo files/functions aggregation failed: ${err?.message ?? err}`);
            }
        }
        return { type: 'explorerData' as const, services, features, apis, files, functions };
    }

    // Wire the module-level broadcast shim so `performGitHubConnect` (and
    // any other module-level helper) can push fresh workspace info to the
    // browser without taking a builder closure as a parameter.
    broadcastWorkspaceInfo = () => {
        if (wsBridge?.hasClients()) wsBridge.broadcast(buildWorkspaceInfo());
    };

    /** Build workspace info for browser home screen */
    function buildWorkspaceInfo() {
        const working = snapshotStore.getWorking();
        // Read fresh config — the cached `config` snapshot may be stale after settings updates
        const freshConfig = vscode.workspace.getConfiguration('codeatlas');
        // Issue UX-17 (2026-06-03 v2) — multi-repo regression introduced
        // by UX-5's main-thread re-scan skip. In multi-repo mode the
        // workspace-level snapshotStore is empty by design; the per-repo
        // orchestrators hold the truth. Aggregate counts across them so
        // the home page surfaces real numbers instead of "—" placeholders.
        let fileCount: number;
        let apiCount: number;
        let serviceCount: number;
        let clusterCount: number;
        let screenCount: number;
        let fileGraphCount: number;
        let flowGraphCount: number;
        let sequenceGraphCount: number;
        // UX-21 (2026-06-03 v2) — track the aggregated services list so we
        // can ship it down in `services:` below; the previous code only
        // updated counts and the list field always read from the empty
        // workspace-level store.
        let aggregatedServices: Array<{ id: string; name: string; rootPath?: string }> = [];
        // #917 — full ServiceRecords (with technology + exposedApiCount) for the
        // extraction-confidence signal; the trimmed `aggregatedServices` above
        // drops those fields, so accumulate the real records here.
        let fullServiceRecords: any[] = [];
        if (workspaceIsMulti && perRepoOrchestrators.size > 0) {
            // UX-21 (2026-06-03 v2) — naive summation double-counted any
            // service that appeared as a stub in multiple per-repo stores
            // (8 repos × 8 stubs = "64 SERVICES" on the home page). Dedup
            // by service.id and exclude worker-stub services so the count
            // matches the L1 system-design diagram.
            const workings = [...perRepoOrchestrators.values()].map((orch) => {
                try {
                    return orch.getStore().getWorking();
                } catch (err: any) {
                    outputChannel.appendLine(`[buildWorkspaceInfo] per-repo aggregation failed: ${err?.message ?? err}`);
                    return null as any;
                }
            }).filter(Boolean);
            const agg = aggregateMultiRepoCounts(workings);
            fileCount = agg.fileCount;
            apiCount = agg.apiCount;
            serviceCount = agg.serviceCount;
            clusterCount = agg.clusterCount;
            screenCount = agg.screenCount;
            fileGraphCount = agg.fileGraphCount;
            flowGraphCount = agg.flowGraphCount;
            sequenceGraphCount = agg.sequenceGraphCount;
            aggregatedServices = agg.services;
            fullServiceRecords = workings.flatMap((w: any) => Object.values(w.services ?? {})); // #917
        } else {
            // Single-repo (or pre-init) — same shape as before.
            fullServiceRecords = Object.values(working.services ?? {}); // #917
            const graphIds = Object.keys(working.graphs ?? {});
            fileCount = Object.keys(working.files).length;
            // TICKET-MOBILE-1 — headline "APIs" excludes UI navigation
            // (SCREEN/NAV_ROUTE) so screens don't inflate the count.
            apiCount = Object.values(working.apiIndex).filter(isHeadlineApiRecord).length;
            serviceCount = Object.keys(working.services ?? {}).length;
            clusterCount = Object.keys(working.clusters ?? {}).length;
            screenCount = Object.keys(working.screens ?? {}).length;
            fileGraphCount = graphIds.filter((id) => id.startsWith('file:')).length;
            flowGraphCount = graphIds.filter((id) => id.startsWith('flow:')).length;
            sequenceGraphCount = graphIds.filter((id) => id.startsWith('sequence:')).length;
        }
        const initialized = fileCount > 0;
        // #917 — extraction-confidence signal (Home chip + GAP banner). Uses the
        // aggregated apiCount for the entry-point total (multi-repo-correct) and
        // the full service records for the detected-but-0-routes gap detection.
        const extractionConfidence = {
            ...computeExtractionConfidence({ apiIndex: {}, services: fullServiceRecords as any }),
            totalEntryPoints: apiCount,
        };
        return {
            type: 'workspaceInfo' as const,
            name: path.basename(workspaceRoot),
            // Issue #431: SPA uses this full path to detect a workspace
            // switch (extension restarted in a different folder while the
            // browser tab stayed open) and trigger a page reload.
            workspaceRoot,
            fileCount,
            apiCount,
            serviceCount,
            clusterCount,
            // v2 phase 3 #484 — FE/mobile L2a screen count. Zero on
            // pure-backend repos (the screen detector early-returns).
            screenCount,
            fileGraphCount,
            flowGraphCount,
            sequenceGraphCount,
            initialized,
            // Single source of truth for the browser view's auth state: the
            // presence of a stored Clerk session — the SAME value the diagram
            // gate reads (authService.getUser()). Previously this sent a
            // module-level flag hardcoded `true` at activation (a 3.3.3
            // "auth removed" leftover), so the browser view reported signed-in
            // (chip + enabled cards, no gate banner) while the server gate
            // treated the client as signed-out and blocked every diagram.
            ...workspaceAuthFields(authService.getUser()),
            hasGitRemote: !!gitRemoteInfo,
            gitHubConnected: !!gitHubToken,
            gitHubUser: gitHubUser ?? undefined,
            gitRemoteOwner: gitRemoteInfo?.owner,
            gitRemoteRepo: gitRemoteInfo?.repo,
            // Editor URI scheme + extension id — used by the browser's
            // "Connect GitHub" button to open ${editorUriScheme}://${extensionId}/connect-github,
            // which focuses the editor before the auth dialog appears.
            editorUriScheme: vscode.env.uriScheme,
            extensionId: 'codeatlaslive.codeatlas-live',
            // Issue #776: bundle id used by the SPA to detect a
            // mid-session VSIX upgrade (extension restarted with a new
            // build while the browser tab kept running the old JS).
            // The SPA compares this to its own compile-time
            // `__CODEATLAS_VERSION__.__CODEATLAS_BUILD__` and forces a
            // hard reload on mismatch — same shape as the workspace-
            // switch reload guard.
            extensionBundleId: `${context.extension.packageJSON.version}.${context.extension.packageJSON.buildNumber ?? 0}`,
            llmProvider: freshConfig.get<string>('llmProvider', 'openrouter'),
            llmModel: freshConfig.get<string>('llmModel', 'openrouter/free'),
            llmEndpoint: freshConfig.get<string>('llmEndpoint', ''),
            // Issue 108: service list drives service-name prefix in breadcrumbs.
            // UX-21: in multi-repo mode read from the deduped aggregate above
            // (workspace-level store is empty by design).
            services: (workspaceIsMulti && perRepoOrchestrators.size > 0)
                ? aggregatedServices
                : Object.values(working.services ?? {}).map((s: any) => ({
                    id: s.id,
                    name: s.name,
                    rootPath: s.rootPath,
                })),
            extractionConfidence, // #917
        };
    }

    // routeDiagramToWelcome + lastBrowserNav are now declared at module scope.
    // Defense-in-depth: any code path that calls panelManager.openPanel(...)
    // — including handlers driven by browser-side messages — gets routed
    // through routeDiagramToWelcome instead of creating a webview. This
    // covers the explicit call sites already replaced in this file plus the
    // ~15 sites in src/handlers/navigationHandlers.ts.
    panelManager.setOpenPanelInterceptor((graphId, mode, graph, label) => {
        routeDiagramToWelcome(graphId, mode, graph, label);
    });

    wsBridge = new WsBridge({
        port: config.get<number>('browserPort', 7742),
        extensionPath: context.extensionPath,
        messageHandler: (msg, clientId) => {
            // Auth gate (browser view :7742) — block diagram / git / tool messages
            // while signed out; only init/re-init/resync + sign-in are allowed.
            // Authoritative: enforced here regardless of what the webview renders.
            if (authService && !authService.getUser() && !isAllowedWhenSignedOut(msg)) {
                wsBridge?.sendTo(clientId, { type: 'signInRequired', action: msg.type === 'runCommand' ? msg.command : msg.type });
                wsBridge?.sendTo(clientId, { type: 'clientToast', level: 'info', message: 'Sign in to view diagrams and use the tools — you can still initialize / re-sync while signed out.' });
                return;
            }
            // Route browser messages through the same handler as webview panels.
            // Use ws: prefix so navigation responses route back via WsBridge.
            panelManager.routeMessage(msg, `ws:${clientId}`);
            // On 'ready' or explicit request, send workspace info + explorer data + theme
            if ((msg.type === 'ready' || msg.type === 'requestExplorerData') && wsBridge) {
                if (msg.type === 'ready') {
                    analytics.track('browser_client_ready', { has_active_diff: !!gitDiffState });
                    // A browser tab is actively viewing — clear the unread ●
                    // marker on the status bar (Issue 363 — `state.json` written non-atomically, trigger #7).
                    clearStatusBarBadge();
                    // Tell the client its WebSocket id so it can include it in
                    // outbound deep links (e.g. the connect-github URI handler
                    // uses this to target the originating tab back via sendTo).
                    wsBridge.sendTo(clientId, { type: 'clientId', clientId });
                }
                wsBridge.sendTo(clientId, buildWorkspaceInfo());
                wsBridge.sendTo(clientId, buildExplorerData());
                // UX-50 (2026-06-06) — replay workspaceState so the scope
                // picker + ExplorerSidebar grouping activate even when the
                // browser tab connected AFTER the post-init broadcast.
                // Without this, multi-repo workspaces silently render as
                // single-repo in the webview because the initial
                // broadcastWorkspaceState() call at activation skipped
                // (`!wsBridge.hasClients()`).
                try {
                    const rows = aggregator.listRepos();
                    const mode = rows.length > 1 ? 'multi' : 'single';
                    wsBridge.sendTo(clientId, {
                        type: 'workspaceState',
                        mode,
                        repos: rows.map((r) => ({
                            repoId: r.repoId,
                            name: r.name,
                            rootPath: r.rootPath,
                            status: r.status,
                            diff: r.diff,
                        })),
                    });
                } catch (err: any) {
                    outputChannel.appendLine(`[workspaceState replay] failed: ${err?.message ?? err}`);
                }
                // Send current theme so browser matches VS Code
                const currentTheme = context.globalState.get<'dark' | 'light'>('codeatlas.theme', 'dark');
                if (currentTheme !== 'dark') {
                    wsBridge.sendTo(clientId, { type: 'setTheme', theme: currentTheme });
                }
                // Bug (AI Review button hidden after browser reload): replay the
                // active diff context to a freshly-connected client so the AI
                // Review button + diff badge surface even when the diff session
                // pre-dates the WS connection.
                if (gitDiffState) {
                    wsBridge.sendTo(clientId, {
                        type: 'setGitDiffContext',
                        baseHash: gitDiffState.baseHash,
                        headHash: gitDiffState.headHash,
                        baseLabel: gitDiffState.baseLabel,
                        headLabel: gitDiffState.headLabel,
                    });
                }
            }
        },
        getInitialData: () => {
            // On refresh, restore the last diagram the browser was viewing.
            // The webview's hash routing will also send requestRoute, but this
            // ensures the diagram is available immediately (no timing race).
            if (lastBrowserNav) {
                // Re-fetch the graph from the current store (it may have been updated)
                const working = snapshotStore.getWorking();
                const graphs = gitDiffState ? gitDiffState.diffedGraphs : working.graphs;
                const freshGraph = graphs[lastBrowserNav.graphId];
                if (freshGraph) {
                    return { ...lastBrowserNav, graph: freshGraph };
                }
            }
            return null;
        },
        log: (msg) => outputChannel.appendLine(msg),
        onAuthCallback: async ({ token, userId, email, firstName, lastName }) => {
            // Browser-mode sign-in: marketing site posted the Clerk token to
            // /auth/callback. handleLogin verifies + stores the session;
            // returning true makes the bridge 302 the browser tab to `/`.
            analytics.track('auth_callback_received', { source: 'browser_callback' });
            try {
                return await handleLogin(token, userId, email, firstName, lastName, context);
            } catch (err: any) {
                outputChannel.appendLine(`[WsBridge] auth callback error: ${err?.message ?? err}`);
                return false;
            }
        },
    });
    const wsBridgeReady = wsBridge.start().then((port) => {
        setBrowserPort(port);

        // #822 (2026-06-10) — port-conflict surfacing. WsBridge auto-
        // increments past a busy port (another VS Code window's CodeAtlas
        // usually holds it), so this window binds e.g. 7743 while the
        // user's bookmarked tab on 7742 silently shows the OTHER
        // workspace's diagrams. Make the divergence visible: status-bar
        // warning naming both ports + a one-shot toast with an "Open"
        // action pointing at THIS workspace's actual port.
        const configuredPort = config.get<number>('browserPort', 7742);
        if (port !== configuredPort) {
            statusBarItem.text = `$(warning) CodeAtlas :${port}`;
            statusBarItem.tooltip = `Port ${configuredPort} is in use (likely another VS Code window's CodeAtlas). This workspace's diagrams are at http://localhost:${port} — browser tabs pointing at :${configuredPort} show a DIFFERENT workspace.`;
            outputChannel.appendLine(`[WsBridge] #822 — configured port ${configuredPort} busy; bound ${port} instead. Tabs on :${configuredPort} belong to another workspace.`);
            vscode.window.showWarningMessage(
                `CodeAtlas: port ${configuredPort} is in use by another window — this workspace is served at http://localhost:${port}.`,
                'Open in Browser',
            ).then((choice) => {
                if (choice === 'Open in Browser') {
                    vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}/`));
                }
            });
        }

        // Don't auto-open a new browser tab on every reload.
        // Existing browser tabs auto-reconnect via WebSocket.
        // Only open on first-ever activation (no tab has ever connected).
        const hasEverOpened = context.globalState.get<boolean>('codeatlas.browserOpened', false);
        if (!hasEverOpened) {
            // First activation — open browser tab and remember
            setTimeout(() => {
                if (!wsBridge?.hasClients()) {
                    vscode.commands.executeCommand('codeatlas.openInBrowser');
                    context.globalState.update('codeatlas.browserOpened', true);
                }
            }, 2000);
        } else {
            outputChannel.appendLine('[WsBridge] Browser tab opened previously — existing tabs will auto-reconnect');
        }
    }).catch((err: any) => {
        outputChannel.appendLine(`[WsBridge] Failed to start: ${err?.message ?? err}`);
        analytics.track('ws_bridge_start_failed', { error: String(err?.message ?? err).slice(0, 200) });
        analytics.notification('ws_bridge_start_failed', 'warning');
        vscode.window.showWarningMessage(
            `CodeAtlas: Browser server failed to start — ${err?.message ?? 'unknown error'}. The "Open in Browser" feature is unavailable.`
        );
    });

    // Issue 363: wire all browser-nudge time/event-based triggers (periodic
    // 6h timer, workspace-folder change, focus-after-idle).
    startBrowserNudgeTriggers(context);

    // Route navigation responses to browser clients when sourcePanelId starts with "ws:"
    panelManager.onExternalNavigate((sourcePanelId, graphId, mode, graph, label) => {
        if (sourcePanelId.startsWith('ws:') && wsBridge) {
            const clientId = sourcePanelId.slice(3); // strip "ws:" prefix
            wsBridge.sendTo(clientId, { type: 'navigateTo', graphId, mode, graph, label });
            // Track last browser navigation so refresh restores this view
            lastBrowserNav = { graphId, mode, graph: null, label }; // graph stored by ref, re-fetch on use
            return true;
        }
        return false;
    });

    // Bridge live graph updates + explorer data to browser clients
    syncOrchestrator.onRefresh((graphIds) => {
        if (!wsBridge?.hasClients()) return;
        for (const graphId of graphIds) {
            const graph = snapshotStore.getWorking().graphs[graphId];
            if (graph) wsBridge.broadcast({ type: 'updateGraph', graphId, graph });
        }
        // Update explorer sidebar with latest data
        wsBridge.broadcast(buildWorkspaceInfo());
        wsBridge.broadcast(buildExplorerData());
    });

    // UX-48 follow-up (2026-06-05) — always-on architecture-rule
    // evaluator. Recomputes violations after every cascade refresh and
    // broadcasts them, throttled by a stable signature so we don't ship
    // the same payload twice. The webview's ViolationsView already
    // handles the `violations` envelope; the new behavior is just that
    // it arrives proactively instead of when the user navigates to
    // `#/violations`.
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { makeViolationsBroadcaster } = require('./core/llm/violationsBroadcaster');
        makeViolationsBroadcaster({
            orchestrator: syncOrchestrator,
            store: snapshotStore,
            broadcast: (msg: any) => { if (wsBridge?.hasClients()) wsBridge.broadcast(msg); },
            workspaceRoot,
            log: (m: string) => outputChannel.appendLine(m),
        });
    } catch (err: any) {
        outputChannel.appendLine(`[violations broadcaster] install failed: ${err?.message ?? err}`);
    }

    // ─── Change Log + Live Impact Replay ──────────────────────────────────────
    const changeLog = new ChangeLog();
    changeLog.setSqlite(snapshotStore.getSqliteStore());
    changeLog.load(workspaceRoot);

    let liveReplayEnabled = config.get<boolean>('liveReplay', false);
    const replayOrchestrator = new ImpactReplayOrchestrator({
        navigate: (graphId, mode, graph, label) => {
            panelManager.navigateActive(graphId, mode, graph, label);
            if (wsBridge?.hasClients()) wsBridge.broadcast({ type: 'navigateTo', graphId, mode, graph, label });
        },
        onStepStart: (step, index, total) => {
            const msg = { type: 'replayStep' as const, step: { index, total, functionName: step.functionName, filePath: step.filePath, layer: step.layer } };
            panelManager.broadcastMessage(msg);
            if (wsBridge?.hasClients()) wsBridge.broadcast(msg);
        },
        onReplayStart: (totalSteps) => {
            const msg = { type: 'replayStarted' as const, totalSteps };
            panelManager.broadcastMessage(msg);
            if (wsBridge?.hasClients()) wsBridge.broadcast(msg);
        },
        onReplayStop: () => {
            const msg = { type: 'replayStopped' as const };
            panelManager.broadcastMessage(msg);
            if (wsBridge?.hasClients()) wsBridge.broadcast(msg);
        },
        getGraph: (graphId) => snapshotStore.getWorking().graphs[graphId],
    });

    syncOrchestrator.onChangeDetail((details: ChangeDetail[]) => {
        const working = snapshotStore.getWorking();
        // Record each change in the log
        for (const detail of details) {
            const impact = analyzeImpact([detail.filePath], working);
            const primaryFn = detail.changedFunctions[0] ?? detail.newFunctions[0];
            const entry = {
                id: `cl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                timestamp: new Date().toISOString(),
                filePath: detail.filePath,
                changedFunctions: detail.changedFunctions,
                newFunctions: detail.newFunctions,
                deletedFunctions: detail.deletedFunctions,
                impactSummary: {
                    directImpacts: impact.summary.directImpacts,
                    transitiveImpacts: impact.summary.transitiveImpacts,
                    clustersAffected: impact.summary.clustersAffected,
                    servicesAffected: impact.summary.servicesAffected,
                },
                primaryGraphId: primaryFn ? `flow:${detail.filePath}:${primaryFn}` : `file:${detail.filePath}`,
            };
            changeLog.add(entry);
            // Broadcast to webview + browser
            panelManager.broadcastMessage({ type: 'changeLogEntry', entry });
            if (wsBridge?.hasClients()) wsBridge.broadcast({ type: 'changeLogEntry', entry });
        }
        changeLog.save(workspaceRoot);

        // Live impact replay (if enabled)
        if (liveReplayEnabled) {
            replayOrchestrator.play(details, working).catch((err: any) => {
                outputChannel.appendLine(`[Replay] Error: ${err?.message ?? err}`);
            });
        }
    });

    // ─── Commit Timeline Replay ───────────────────────────────────────────────
    commitTimelineReplay = new CommitTimelineReplay(
        {
            navigate: (graphId, mode, graph, label) => {
                panelManager.navigateActive(graphId, mode, graph, label);
                if (wsBridge?.hasClients()) wsBridge.broadcast({ type: 'navigateTo', graphId, mode, graph, label });
            },
            setDiffContext: (baseHash, headHash, baseLabel, headLabel) => {
                const msg = { type: 'setGitDiffContext' as const, baseHash, headHash, baseLabel, headLabel };
                panelManager.broadcastMessage(msg);
                if (wsBridge?.hasClients()) wsBridge.broadcast(msg);
            },
            clearDiffContext: () => {
                panelManager.broadcastMessage({ type: 'clearGitDiffContext' });
                if (wsBridge?.hasClients()) wsBridge.broadcast({ type: 'clearGitDiffContext' });
            },
            onStepStart: (step) => {
                const msg = { type: 'timelineReplayStep' as const, step };
                panelManager.broadcastMessage(msg);
                if (wsBridge?.hasClients()) wsBridge.broadcast(msg);
            },
            onCommitStart: (index, total, hash, subject) => {
                vscode.commands.executeCommand('setContext', 'codeatlas:replayActive', true);
                const msg = { type: 'timelineReplayCommitStart' as const, index, total, hash, subject };
                panelManager.broadcastMessage(msg);
                if (wsBridge?.hasClients()) wsBridge.broadcast(msg);
            },
            onReplayEnd: () => {
                vscode.commands.executeCommand('setContext', 'codeatlas:replayActive', false);
                panelManager.broadcastMessage({ type: 'timelineReplayEnd' as const });
                if (wsBridge?.hasClients()) wsBridge.broadcast({ type: 'timelineReplayEnd' });
                // Push clean working graphs back so diff overlay is removed
                handleClearGitDiff();
            },
            onPaused: () => {
                panelManager.broadcastMessage({ type: 'timelineReplayPaused' as const });
                if (wsBridge?.hasClients()) wsBridge.broadcast({ type: 'timelineReplayPaused' });
            },
            onResumed: () => {
                panelManager.broadcastMessage({ type: 'timelineReplayResumed' as const });
                if (wsBridge?.hasClients()) wsBridge.broadcast({ type: 'timelineReplayResumed' });
            },
        },
        {
            buildDiff: (base, head) => buildCommitDiffGraphs(workspaceRoot, base, head, (msg: string) => outputChannel.appendLine(msg)),
        },
    );

    // ─── Issue #174: Wire extracted handler modules via message router ─────────
    // The HandlerContext must be created after all services (changeLog,
    // replayOrchestrator, commitTimelineReplay, etc.) are initialized.
    //
    // #547 PlatformAdapter — exposes the cross-runtime broadcast / secrets /
    // sidebar surface so handler modules can run on the standalone WS server
    // too. The extension's adapter routes through PanelManager + VS Code
    // SecretStorage; the standalone supplies its own adapter implementation.
    const handlerPlatform: import('./handlers/handlerContext').PlatformAdapter = {
        broadcast: (msg) => {
            panelManager.broadcastMessage(msg);
            if (wsBridge?.hasClients()) wsBridge.broadcast(msg);
        },
        updateGraph: (graphId, graph) => {
            panelManager.updatePanel(graphId, graph);
            if (wsBridge?.hasClients()) wsBridge.broadcast({ type: 'updateGraph', graphId, graph });
        },
        getSecret: (key) => Promise.resolve(context.secrets.get(key)),
        setSecret: (key, value) => Promise.resolve(context.secrets.store(key, value)).then(() => undefined),
        // #547 round 4: settings adapter. `codeatlas.evidenceGateEnabled`,
        // `codeatlas.llmProvider`, etc. round-trip through VS Code's
        // ConfigurationTarget.Workspace on the extension; standalone uses
        // its SettingsResolver (env → file → default).
        getSetting: <T,>(key: string, defaultValue?: T): T | undefined => {
            // Caller passes either a bare key ('evidenceGateEnabled') or a
            // fully-qualified one ('codeatlas.evidenceGateEnabled'). VS Code's
            // getConfiguration('codeatlas') expects the bare form, so strip
            // the leading 'codeatlas.' when present.
            const k = key.startsWith('codeatlas.') ? key.slice('codeatlas.'.length) : key;
            const v = vscode.workspace.getConfiguration('codeatlas').get<T>(k);
            return v === undefined ? defaultValue : v;
        },
        setSetting: async <T,>(key: string, value: T): Promise<void> => {
            const k = key.startsWith('codeatlas.') ? key.slice('codeatlas.'.length) : key;
            await vscode.workspace.getConfiguration('codeatlas').update(k, value, vscode.ConfigurationTarget.Workspace);
        },
        refreshSidebar: () => refreshViews(),
        revealApi: (apiId) => {
            try { (apiExplorerProvider as any).reveal?.(apiTreeView, apiId); } catch { /* ignore */ }
        },
        revealService: (serviceId) => {
            try { (microserviceExplorerProvider as any).reveal?.(microserviceTreeView, serviceId); } catch { /* ignore */ }
        },
        revealCluster: (clusterId) => {
            try { (featureExplorerProvider as any).reveal?.(featureTreeView, clusterId); } catch { /* ignore */ }
        },
    };

    // #851 — PR watcher (parity with the MCP standalone, see ADR-045).
    // Token: GITHUB_TOKEN env first, else the VS Code GitHub auth session.
    // Toggle persisted in workspaceState so it survives reloads per repo.
    extensionPrWatcher = new PrWatcher({
        repoSlug: () => {
            const r = getGithubRemote(workspaceRoot);
            return r ? `${r.owner}/${r.repo}` : null;
        },
        getToken: async () => {
            if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
            try {
                const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
                return session?.accessToken;
            } catch { return undefined; }
        },
        hasLlmKey: async () => {
            const provider = vscode.workspace.getConfiguration('codeatlas').get<string>('llmProvider') || 'openrouter';
            if (provider === 'ollama' || provider === 'custom') return true;
            return Boolean(await context.secrets.get('codeatlas.openRouterApiKey'));
        },
        listOpenPrs: (slug, token) => listOpenPrsGithub(slug, token),
        reviewPr: (pr, prCtx) => reviewPrInClone(pr, prCtx, {
            repoPath: workspaceRoot,
            log: (m) => outputChannel.appendLine(m),
            // The review runs in a tmp clone with the STANDALONE resolvers —
            // it can't see VS Code secrets/config. Forward them as the env
            // override names the standalone settings/secrets honor.
            reviewEnv: async () => {
                const cfg = vscode.workspace.getConfiguration('codeatlas');
                return {
                    OPENROUTER_API_KEY: (await context.secrets.get('codeatlas.openRouterApiKey')) || undefined,
                    CODEATLAS_LLM_PROVIDER: cfg.get<string>('llmProvider') || undefined,
                    CODEATLAS_LLM_MODEL: cfg.get<string>('llmModel') || undefined,
                    CODEATLAS_LLM_ENDPOINT: cfg.get<string>('llmEndpoint') || undefined,
                };
            },
            // #853 — guidelines live in the workspace store; the clone's
            // store starts empty.
            guidelinesText: async () => {
                try { return snapshotStore.getReviewGuidelines().text || undefined; } catch { return undefined; }
            },
        }),
        ledger: createFileLedger(path.join(workspaceRoot, '.codeatlas', 'pr-watcher.json')),
        log: (m) => outputChannel.appendLine(m),
        onStatus: (status) => {
            try { handlerPlatform.broadcast({ type: 'prWatcherStatus', status }); } catch { /* no clients */ }
        },
    });
    if (context.workspaceState.get<boolean>('codeatlas.prWatcherEnabled') === true) {
        extensionPrWatcher.start();
    }
    context.subscriptions.push({ dispose: () => { try { extensionPrWatcher?.stop(); } catch { /* */ } } });

    const handlerCtx: HandlerContext = {
        // VS Code services
        context,
        outputChannel,
        workspaceRoot,

        // #547: platform abstraction (used by handlers that target parity)
        platform: handlerPlatform,

        // Core services
        panelManager,
        snapshotStore,
        syncOrchestrator,
        // Multi-repo-safe resync used by the browser `resyncEverything` WS
        // handler (toolHandlers) so it never runs the monolithic single-store
        // resync that hangs/OOMs on large multi-repo workspaces.
        resyncWorkspace: resyncWorkspaceSafe,
        commentStore,
        sourceNavigator,
        gitDiffStore,

        // ADR-034 Phase B (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) — multi-repo routing entry points
        repoStoreRegistry,
        aggregatorStore: aggregator,

        // Optional services (browser mode)
        wsBridge,

        // Sidebar providers + tree views
        apiExplorerProvider,
        apiTreeView,
        featureExplorerProvider,
        featureTreeView,
        microserviceExplorerProvider,
        microserviceTreeView,

        // Comments
        commentsProvider,

        // LLM
        llmNamingService,
        clerkAuthPageUrl: CLERK_AUTH_PAGE_URL,

        // #851 — PR watcher (see ADR-045)
        prWatcher: () => extensionPrWatcher ?? undefined,

        // Replay
        commitTimelineReplay,
        changeLog,
        replayOrchestrator,

        // Mutable state accessors (closures over module-level let variables)
        // UX-64 Phase 2 — accept an optional scope so handlers that know
        // their `repoId` retrieve the per-repo session directly instead
        // of falling back to the workspace shim.
        getGitDiffState: (scope?: string) => gitDiffStates.get(scope) ?? gitDiffState,
        // UX-64: route through the scoped helper so per-repo writes
        // land in `gitDiffStates`, and the legacy alias stays in sync.
        setGitDiffState: (s) => { setGitDiffStateScoped(s); },
        getGitDiffSnapshots: () => gitDiffSnapshots,
        setGitDiffSnapshots: (s) => { gitDiffSnapshots = s; },
        getAiReviewResult: () => aiReviewResult,
        setAiReviewResult: (r) => { aiReviewResult = r; },
        getReplayAfterDiff: () => replayAfterDiff,
        setReplayAfterDiff: (v) => { replayAfterDiff = v; },
        getGitHubToken: () => gitHubToken,
        setGitHubToken: (token) => { gitHubToken = token; },
        getGitHubUser: () => gitHubUser,
        setGitHubUser: (user) => { gitHubUser = user; },
        fetchGitHubUser,
        performGitHubConnect,

        // Git diff operation callbacks (still defined later in extension.ts)
        handleRequestGitDiff: (sourcePanelId, repoId) => handleRequestGitDiff(sourcePanelId, repoId),
        handleCommitSelected: (sourcePanelId, baseHash, headHash, repoId) => handleCommitSelected(sourcePanelId, baseHash, headHash, repoId),
        handleBranchSelected: (sourcePanelId, branchName, repoId) => handleBranchSelected(sourcePanelId, branchName, repoId),
        handleRequestPrDiff: (sourcePanelId, repoId) => handleRequestPrDiff(sourcePanelId, repoId),
        handleRequestBranchDiff: (sourcePanelId, repoId) => handleRequestBranchDiff(sourcePanelId, repoId),
        handlePrSelected: (sourcePanelId, prNumber, repoId) => handlePrSelected(sourcePanelId, prNumber, repoId),
        handleClearGitDiff: () => handleClearGitDiff(),

        // Builder callback
        buildWorkspaceInfo: () => buildWorkspaceInfo(),

        // Helper functions
        notifyBrowser,
        refreshViews: () => refreshViews(),
        log: (msg) => outputChannel.appendLine(msg),

        // Routes any code path that historically opened a VS Code webview
        // panel to the welcome page instead. Used by panelManager's open
        // interceptor; exposed here so handler modules can call it directly
        // when they want to bypass the panelManager call entirely.
        routeDiagramToWelcome,
    };

    // Create the router and register all handler modules
    const router = createMessageRouter(handlerCtx);
    registerNavigationHandlers(router.register, handlerCtx);
    registerGitDiffHandlers(router.register, handlerCtx);
    registerReplayHandlers(router.register, handlerCtx);
    registerAiReviewHandlers(router.register, handlerCtx);
    registerCommentHandlers(router.register, handlerCtx);
    registerToolHandlers(router.register, handlerCtx);
    registerPrWatcherHandlers(router.register, handlerCtx);

    // ADR-034 Phase E (#790 — Phase E: failure isolation UX + multi-repo cascade tests (ADR-034)) — retry a failed repo's init in isolation.
    // L1 service node's "Retry" button sends `retryRepo` when status='failed'.
    // The orchestrator handles its own status broadcasts via skeletal L1
    // refreshes; we just route the message and log the outcome.
    router.register('retryRepo', async (message) => {
        const repoId = (message as any).repoId as string;
        if (!repoId) {
            outputChannel.appendLine(`[retryRepo] missing repoId — ignoring`);
            return;
        }
        const result = await workspaceOrchestrator.retryRepo(repoId);
        outputChannel.appendLine(`[retryRepo] ${repoId} → status=${result.status} ms=${result.durationMs}${result.error ? ' error=' + result.error : ''}`);
        // After retry, re-broadcast the workspace L1 graph so any open
        // panel picks up the fresh status. The aggregator already wrote
        // the skeletal L1 inside retryRepo; we just nudge subscribers.
        try {
            const aggregator = repoStoreRegistry.getAggregatorStore(workspaceRoot);
            const graph = aggregator.getWorkingGraph('microservice:workspace');
            if (graph) {
                panelManager.broadcastMessage({ type: 'updateGraph', graphId: 'microservice:workspace', graph, mode: 'microservice' });
                if (wsBridge?.hasClients()) {
                    wsBridge.broadcast({ type: 'updateGraph', graphId: 'microservice:workspace', graph, mode: 'microservice' });
                }
            }
        } catch (err: any) {
            outputChannel.appendLine(`[retryRepo] rebroadcast failed: ${err?.message ?? err}`);
        }
        // Phase G follow-up — workspace state changed (repo status flipped).
        broadcastWorkspaceState();
    }, 'retryRepo');

    // Issue #741/#742 — Tour card on HomePage sends `requestTour`; without
    // an extension-side registration the message is dropped and the card
    // click silently no-ops. Port the standalone implementation here so
    // both runtimes behave identically.
    // Issue #603 Phase 3 — chain runner. Runs N steps sequentially in
    // the extension host, returns the per-step results to the
    // originating client.
    router.register('runChain', (message, sourcePanelId) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { runChain } = require('./core/apiTesting/runChain');
        const runId = (message as any).runId ?? '';
        const args = {
            steps: (message as any).steps ?? [],
            initialEnv: (message as any).initialEnv ?? {},
            stopOnFirstFailure: Boolean((message as any).stopOnFirstFailure),
            allowPrivateHosts: true, // #887 — user-initiated workbench run (localhost dev targets allowed)
        };
        runChain(args)
            .then((result: unknown) => {
                const payload = { type: 'runChainResult', runId, result };
                if (sourcePanelId.startsWith('ws:') && wsBridge) {
                    wsBridge.sendTo(sourcePanelId.slice(3), payload);
                } else {
                    panelManager.sendToPanel(sourcePanelId, payload);
                }
            })
            .catch((err: any) => {
                outputChannel.appendLine(`[runChain] failed: ${err?.message ?? err}`);
                notifyBrowser('error', `Chain failed: ${(err?.message ?? err).slice(0, 200)}`);
            });
    }, 'ApiTestingHandlers');

    // Issue #602 Phase 2 — API Testing send-request relay. Runs the
    // request in the extension host and ships the response back to the
    // originating client only (not broadcast).
    router.register('sendRequest', (message, sourcePanelId) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { executeRequest } = require('./core/apiTesting/relay');
        const requestId = (message as any).requestId ?? '';
        const args = {
            method: (message as any).method,
            url: (message as any).url,
            headers: (message as any).headers,
            body: (message as any).body,
            env: (message as any).env,
            bearerToken: (message as any).bearerToken,
            apiKey: (message as any).apiKey,
            apiKeyHeader: (message as any).apiKeyHeader,
            timeoutMs: (message as any).timeoutMs,
            allowPrivateHosts: true, // #887 — user-initiated workbench Send (localhost dev targets allowed)
        };
        executeRequest(args)
            .then((response: unknown) => {
                const payload = { type: 'sendRequestResult', requestId, response };
                if (sourcePanelId.startsWith('ws:') && wsBridge) {
                    wsBridge.sendTo(sourcePanelId.slice(3), payload);
                } else {
                    panelManager.sendToPanel(sourcePanelId, payload);
                }
            })
            .catch((err: any) => {
                outputChannel.appendLine(`[sendRequest] failed: ${err?.message ?? err}`);
                notifyBrowser('error', `Request failed: ${(err?.message ?? err).slice(0, 200)}`);
            });
    }, 'ApiTestingHandlers');

    // #744 (Issue #358 Row 3, 2026-06-07): the three LLM-driven generator
    // handlers (generateRequestBody / generateChain / generateTestCases)
    // moved to `src/handlers/aiGenerationHandlers.ts`. Mechanical
    // extraction — behavior unchanged.
    registerAiGenerationHandlers(router, {
        panelManager,
        wsBridge,
        outputChannel,
        snapshotStore,
        getApiKey: async () => (await context.secrets.get('codeatlas.openRouterApiKey')) ?? '',
    });
    // #745 (2026-06-06) — OAuth2 (Issue #358 Row 1, 2026-06-07): all
    // three handlers (client credentials, build URL, exchange code)
    // moved to `src/handlers/oauth2Handlers.ts`. Mechanical
    // extraction — behavior unchanged.
    registerOauth2Handlers(router, { panelManager, wsBridge, outputChannel });

    // #745 (2026-06-06) — WS + SSE clients (Issue #358 Row 2,
    // 2026-06-07): moved to `src/handlers/wsSseHandlers.ts`.
    // Mechanical extraction — behavior unchanged.
    registerWsSseHandlers(router, { panelManager, wsBridge, outputChannel });

    // #750 (Issue #358 Row 4, 2026-06-07): saved filter view handlers
    // (request / save / delete) moved to
    // `src/handlers/savedViewsHandlers.ts`. Mechanical extraction —
    // behavior unchanged.
    registerSavedViewsHandlers(router, { panelManager, wsBridge, outputChannel, workspaceRoot });

    // #604 / #745 (Issue #358 Row 5, 2026-06-07): API collection
    // exporter (Postman / Hoppscotch / Insomnia) and importer (OpenAPI
    // / Postman / Insomnia) moved to `src/handlers/exportHandlers.ts`.
    // Mechanical extraction — behavior unchanged.
    registerExportHandlers(router, { panelManager, wsBridge, outputChannel, snapshotStore });

    router.register('requestTour', async (message, _sourcePanelId) => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { buildTour, buildWorkspaceMetaTour, toLiteSteps } = require('./core/analysis/tourBuilder');
            const mode = (message as any).mode === 'recent' ? 'recent' : 'codebase';
            // UX-52 (2026-06-06) — in multi-repo mode the workspace
            // snapshotStore is empty by design (services / clusters /
            // apiIndex live in per-repo stores). Use the meta-tour
            // builder Phase H shipped (#793 — Phase H: Tours per repo + workspace meta-tour (ADR-034)). Falls back to the
            // single-repo tour when only one repo is registered.
            let steps: any[] = [];
            // 2026-06-09 — per-repo tour via home-page picker. The user
            // picks a sub-repo; the message carries `repoId` (which may
            // actually be a repo NAME or rootPath since the picker uses
            // the service id). Build the tour against that single repo's
            // store rather than the merged workspace meta-tour.
            const tourRepoId = String((message as any).repoId ?? '').replace(/^service:/, '');
            if (workspaceIsMulti && tourRepoId && perRepoOrchestrators.size >= 1 && aggregator) {
                try {
                    const repos = aggregator.listRepos();
                    const matched = repos.find((r: any) => r.name === tourRepoId || r.repoId === tourRepoId || r.rootPath === tourRepoId);
                    if (matched?.rootPath) {
                        const absPath = path.join(workspaceRoot, matched.rootPath);
                        const repoStore = await repoStoreRegistry.getRepoStoreLoaded(absPath);
                        if (repoStore) {
                            const w = repoStore.getWorking();
                            const baseline = repoStore.getBaseline();
                            const baselineApiIds = mode === 'recent' ? new Set(Object.keys(baseline?.apiIndex ?? {})) : undefined;
                            steps = buildTour(w, mode, { maxSteps: (message as any).maxSteps, baselineApiIds });
                            outputChannel.appendLine(`[requestTour] per-repo tour for ${tourRepoId}: ${steps.length} steps`);
                        }
                    }
                } catch (err: any) {
                    outputChannel.appendLine(`[requestTour] per-repo branch failed: ${err?.message ?? err}`);
                }
            }
            if (steps.length === 0 && workspaceIsMulti && perRepoOrchestrators.size >= 2 && aggregator) {
                try {
                    steps = buildWorkspaceMetaTour(aggregator, workspaceRoot);
                } catch (err: any) {
                    outputChannel.appendLine(`[requestTour] meta-tour failed (${err?.message ?? err}); falling back to per-repo aggregation`);
                }
                // If the meta-tour returned nothing (e.g. summaries not
                // yet populated), fold per-repo tours together so the
                // user still gets something.
                if (steps.length === 0) {
                    for (const [, orch] of perRepoOrchestrators) {
                        try {
                            const repoW = orch.getStore().getWorking();
                            const repoBaseline = orch.getStore().getBaseline();
                            const baselineApiIds = mode === 'recent'
                                ? new Set(Object.keys(repoBaseline?.apiIndex ?? {}))
                                : undefined;
                            const repoSteps = buildTour(repoW, mode, {
                                maxSteps: (message as any).maxSteps,
                                baselineApiIds,
                            });
                            steps.push(...repoSteps);
                        } catch (err: any) {
                            outputChannel.appendLine(`[requestTour] per-repo step build failed: ${err?.message ?? err}`);
                        }
                    }
                }
            } else {
                const w = snapshotStore.getWorking();
                const baseline = snapshotStore.getBaseline();
                const baselineApiIds = mode === 'recent'
                    ? new Set(Object.keys(baseline?.apiIndex ?? {}))
                    : undefined;
                steps = buildTour(w, mode, {
                    maxSteps: (message as any).maxSteps,
                    baselineApiIds,
                });
            }
            const lite = toLiteSteps(steps);
            if (wsBridge?.hasClients()) {
                wsBridge.broadcast({ type: 'tourSteps', mode, steps: lite });
            }
        } catch (err: any) {
            outputChannel.appendLine(`[requestTour] build failed: ${err?.message ?? err}`);
            notifyBrowser('warning', `Tour build failed: ${(err?.message ?? err).slice(0, 200)}`);
        }
    }, 'NavigationHandlers');

    // Parse a CodeAtlas graphId prefix back to the {route, param, param2}
    // shape the requestRoute handler dispatches on. Mirrors the inverse of
    // `graphIdToHash` in webview-ui/src/App.tsx — keep them in sync. Returns
    // null when the prefix doesn't match a known view mode.
    function routeFromGraphId(graphId: string): { route: string; param?: string; param2?: string } | null {
        // Issue #362 Phase B (2026-06-07) — structured parse instead of
        // 8 string.startsWith/.slice pairs. The parser handles `flow:`
        // and `sequence:` route keys whose own colons used to confuse
        // the lastIndexOf split.
        if (graphId === 'microservice:workspace') return { route: 'system-design' };
        if (graphId === 'map:workspace') return { route: 'map' };
        if (graphId === 'domain:workspace') return { route: 'domain' };
        if (graphId === 'tour:workspace') return { route: 'tour' };
        if (graphId === 'feature:workspace') return { route: 'features' };
        if (graphId === 'health:report') return { route: 'health' };
        const parsed = parseGraphId(graphId);
        if (!parsed) return null;
        switch (parsed.type) {
            // ADR-034 Phase H Pass 3 (#793) — per-repo tour drill-in:
            // `tour:<repoId>` routes to the per-repo tour panel.
            case 'tour':       return { route: 'tour',     param: parsed.parts.join(':') };
            case 'feature':    return { route: 'features', param: parsed.parts.join(':') };
            case 'api-list':   return { route: 'apis',     param: parsed.parts.join(':') };
            case 'sequence':   return { route: 'sequence', param: parsed.parts.join(':') };
            case 'file':       return { route: 'file',     param: parsed.parts[0] };
            case 'flow':       return { route: 'flow',     param: parsed.parts[0], param2: parsed.parts[1] };
            case 'screen-content': return { route: 'screen-content', param: parsed.parts.join(':') };
            default:           return null;
        }
    }

    // Register requestRoute inline (not yet extracted to a handler module)
    router.register('requestRoute', async (message, sourcePanelId) => {
        // INVARIANT: cascade live diff annotations before serving so back-
        // button navigation always hits fresh-state graphs. See ADR-019.
        // ADR-023 / Issue 370 — gated behind `cascade_on_route` so a runtime
        // bug in the cascade can be remote-disabled without republishing.
        // Fail-open: if the flag is unset / endpoint unreachable, cascade
        // runs (the legacy behavior). Disable explicitly via JSON payload
        // `{flags: {cascade_on_route: {enabled: false}}}`.
        // PERF (2026-07-15): only re-cascade when the working state actually
        // changed since the last cascade. On a warm, unchanged snapshot this
        // full re-cascade (rebuild every api-list + Map + Domain graph, re-walk
        // all sequence/service graphs) is pure waste and added ~1s to EVERY
        // drill-down. `needsLiveGraphCascade` is set on any file save / resync
        // and cleared by the cascade, so read-only navigation now skips it.
        if (featureFlags.isEnabledSync('cascade_on_route') && syncOrchestrator.needsLiveGraphCascade) {
            try { syncOrchestrator.applyDiffCascadeToLiveGraphs(); }
            catch (err: any) {
                // Issue 357: track cascade failures rather than swallow silently.
                // Cascade is best-effort here (the served graph may render with
                // stale annotations for a moment) — but the failure itself is
                // a real signal we want to see.
                outputChannel.appendLine(`[requestRoute] cascade failed: ${err?.message ?? err}`);
                analytics.track('cascade_error', { source: 'requestRoute', error: String(err?.message ?? err).slice(0, 200) });
            }
        }
        const working = snapshotStore.getWorking();
        const gds = gitDiffState;
        // UX-53b/c/d (2026-06-06) — multi-repo workspaces keep `domain:`,
        // `health:`, `feature:workspace`, `map:workspace` graphs in per-repo
        // stores rather than the empty workspace store. Build a unified view
        // that prefers per-repo entries when the workspace one is missing.
        // Git-diff state (commit/branch/PR comparison) keeps its own
        // pre-diffed graph map and is the source of truth when active.
        let baseGraphs: Record<string, any> = gds ? gds.diffedGraphs : { ...working.graphs };
        // PERF — serve the cached unified graph view when nothing has rebuilt
        // since (invalidated in the file-save / rebuild handlers).
        if (!gds && workspaceIsMulti && perRepoOrchestrators.size > 0 && mergedGraphsViewCache) {
            baseGraphs = mergedGraphsViewCache;
        } else if (!gds && workspaceIsMulti && perRepoOrchestrators.size > 0) {
            // #821 (2026-06-10) — merge extracted to
            // `core/storage/graphViewMerge.ts` and the ownership contract
            // fixed: REPO-SCOPED ids (file:/flow:/sequence:/feature:<svc>/
            // api-list:) now REPLACE any workspace copy because the
            // per-repo store is the ADR-034 source of truth — the old
            // workspace-wins-when-non-empty rule let a stale init-time
            // workspace copy shadow the per-repo fresh copy, so per-repo
            // `diff:'modified'` markers never reached the UI. Workspace-
            // scoped overview keys keep first-wins + UX-56 empty-shell
            // fill; UX-53d's `feature:workspace` skip is preserved so the
            // `case 'features'` union fold still runs.
            try {
                const perRepoGraphMaps: Record<string, any>[] = [];
                for (const [, orch] of perRepoOrchestrators) {
                    try {
                        perRepoGraphMaps.push(orch.getStore().getWorking().graphs ?? {});
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute] per-repo graph read failed: ${err?.message ?? err}`);
                    }
                }
                // #819 follow-up — `map:workspace` is ALSO skipped: the
                // map route has its own scoped-rebuild + aggregator-
                // fallback + fold pipeline. Letting one per-repo map fill
                // the workspace slot here made a single repo's map
                // masquerade as the workspace view, so the bare-`#/map`
                // fold never triggered and only the first repo rendered.
                baseGraphs = mergeGraphsForView(baseGraphs, perRepoGraphMaps, {
                    workspaceRoot,
                    skipKeys: new Set<string>(['feature:workspace', 'map:workspace']),
                });
                // PERF — cache for subsequent routes until the next rebuild.
                mergedGraphsViewCache = baseGraphs;
            } catch (err: any) {
                outputChannel.appendLine(`[requestRoute] per-repo graph merge failed: ${err?.message ?? err}`);
            }
        }
        const graphs = baseGraphs;
        // #861 — Java/Kotlin class methods store their flow under a CLASS-
        // PREFIXED id (`flow:<file>:<Class>.<method>`) while routes / L2b /
        // bare deep-links reference the bare method name. Resolve a bare flow
        // graphId to the real stored id BEFORE any branch serves it, so direct
        // flow navigation (not just the L3→L5 sequence-fallback) drills to L5
        // instead of dead-ending on the file graph. Parity with the standalone
        // handleRequestRoute flow block.
        if (typeof message.graphId === 'string' && message.graphId.startsWith('flow:') && !graphs[message.graphId]) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { resolveFlowGraphId } = require('./core/graph/flowGraphResolve');
                const real = resolveFlowGraphId(Object.keys(graphs), message.graphId);
                if (real && graphs[real]?.nodes?.length) message.graphId = real;
            } catch { /* resolver unavailable — fall through */ }
        }
        const repoName = path.basename(workspaceRoot);
        // UX-53b/c/d (2026-06-06) — for browser (WS) clients,
        // `panelManager.navigatePanel` falls through silently because no
        // externalNavigateHandler is registered. Send over the wsBridge so
        // multi-repo merged graphs actually reach the browser.
        // #817 live-verify (2026-06-11) — respond ONLY to the requesting
        // client. The previous `broadcast` steered EVERY open tab to this
        // tab's route; with the cross-repo push fanning out soft refreshes,
        // one tab's `#/map` refresh yanked sibling tabs off
        // `#/system-design` mid-read.
        const navigateForBrowser = (graphId: string, mode: string, graph: any, label: string): boolean => {
            if (sourcePanelId.startsWith('ws:') && wsBridge?.hasClients()) {
                wsBridge.sendTo(sourcePanelId.slice(3), { type: 'navigateTo', graphId, mode, graph, label });
                return true;
            }
            return false;
        };
        // Issue: TourView's "Open diagram" + the `cascadeRefresh` re-fetch
        // send `{ graphId }` without a `route`. The standalone messageHandler
        // already accepts that shape; mirror it here by parsing the graphId
        // prefix into the canonical {route, param, param2} so the switch below
        // handles both call styles identically.
        if ((!message.route || message.route === undefined) && typeof message.graphId === 'string' && message.graphId.length > 0) {
            const derived = routeFromGraphId(message.graphId);
            if (derived) {
                message = { ...message, ...derived } as typeof message;
            }
        }
        // BUG-REPLAY-NO-CANCEL — if the user navigates to a view the commit
        // replay never steps through (health/map/domain/tour/api-testing), they've
        // left the replay: stop it so the background diff-build (BUG-REPLAY-SLOW-
        // UPFRONT lazy loop) aborts instead of pegging a core for the whole range.
        // The replay's OWN step navigation uses navigateActive (not requestRoute),
        // and the modes it DOES visit (system-design/features/apis/sequence/flow/
        // file) are excluded so an internal echo never self-stops it.
        if (commitTimelineReplay?.isPlaying && typeof message.route === 'string'
            && ['health', 'map', 'domain', 'tour', 'api-testing'].includes(message.route)) {
            commitTimelineReplay.stop();
        }
        switch (message.route) {
            case 'system-design': {
                // Issue #790 #8 follow-up (2026-06-09) — user direction:
                // "show one design at a time, rest is same as single repo."
                // For multi-repo: if `message.param` carries a repoId/name,
                // route to that repo's per-repo `microservice:workspace`
                // (built by the per-repo orchestrator exactly like a
                // single-repo workspace). Without a param, fall back to
                // the aggregator's skeletal overview so the user sees the
                // picker / repo list and can drill in.
                let g: any = graphs['microservice:workspace'];
                const sysSid = message.param ? String(message.param).replace(/^service:/, '') : '';
                let l1FreshlyRebuilt = false;
                // BUG-L1-CROSSREPO-EDGE (2026-07-19) — for the bare workspace L1
                // (no sub-repo param) in multi-repo, the primary store's
                // `graphs['microservice:workspace']` is an edge-less per-repo
                // build; the CROSS-REPO HTTP edges (clients→server etc.) live
                // only on the aggregator's skeletal copy (monorepo.db). The
                // initial post-init push (~L2599) serves the aggregator copy, but
                // re-navigation here dropped the edges. Prefer the aggregator copy
                // whenever it carries MORE edges than the primary. Mirrors the
                // standalone messageHandler path (messageHandler.ts ~L1608).
                if (workspaceIsMulti && !sysSid) {
                    try {
                        const aggCopy: any = aggregator.getWorkingGraph?.('microservice:workspace');
                        const aggEdges = Array.isArray(aggCopy?.edges) ? aggCopy.edges.length : 0;
                        const curEdges = Array.isArray(g?.edges) ? g.edges.length : 0;
                        if (aggCopy && Array.isArray(aggCopy.nodes) && aggCopy.nodes.length > 0 && aggEdges >= curEdges) {
                            g = aggCopy;
                        }
                        // BUG-L1-CROSSREPO-EDGE (2026-07-19) — the stored skeletal graph
                        // may have been written BEFORE the cross-repo edge pass populated
                        // `cross_repo_http_edges` (init-ordering fragility → clients→server
                        // edge missing on a fresh multi-repo init). INJECT the edges from
                        // the table at serve time so the L1 always draws them, regardless
                        // of when the skeletal was persisted.
                        if (g && Array.isArray(g.nodes) && g.nodes.length > 0) {
                            const httpEdges = aggregator.listCrossRepoHttpEdges?.() ?? [];
                            const existing = new Set((g.edges ?? []).map((e: any) => e.id));
                            const injected = buildCrossRepoEdges(g.nodes, httpEdges as any).filter((e) => !existing.has(e.id));
                            if (injected.length) {
                                g = { ...g, edges: [...(g.edges ?? []), ...injected] };
                                outputChannel.appendLine(`[requestRoute system-design] workspace L1: injected ${injected.length} cross-repo edge(s) from table (${g.nodes.length} nodes)`);
                            }
                        }
                    } catch { /* fall back to primary-store copy */ }
                }
                // #811 (2026-06-10) — when a sub-repo is picked, rebuild
                // the microservice graph FRESH from that sub-repo's snapshot
                // using `buildMicroserviceGraph(<subRepoAbsPath>, snapshot)`.
                // This re-runs infra detection per sub-repo so DynamoDB / S3
                // / SQS etc. surface as siblings of the picked service. The
                // pre-#811 path filtered the workspace overview to one
                // node + 0 infra; the user reported the missing DynamoDB
                // tile on `aws-dotnet-rest-api-with-dynamodb`. Falls back
                // to the legacy per-repo cached graph + scope filter if
                // the rebuild fails (e.g. snapshot not loaded yet).
                if (workspaceIsMulti && sysSid && !gds) {
                    try {
                        const resolved = resolveRepoFromArg(sysSid, workspaceRoot, aggregator);
                        const repoRoot = resolved?.rootPath ?? sysSid;
                        const subRepoAbs = path.join(workspaceRoot, repoRoot);
                        const repoStore = await repoStoreRegistry.getRepoStoreLoaded(subRepoAbs);
                        if (repoStore) {
                            const subSnap = repoStore.getWorking();
                            // PERF — serve the previously-built enriched graph when
                            // the sub-repo's stored microservice graph is unchanged
                            // (no rebuild since). Skips the ~1.5s infra content scan
                            // that made re-opening L1 feel like a hang.
                            const baseStored = subSnap.graphs?.['microservice:workspace'] as any;
                            const cachedEnriched = baseStored ? enrichedL1GraphCache.get(baseStored) : undefined;
                            // The per-repo cascade already builds this graph WITH a
                            // content provider (syncOrchestrator ~L1795), so the stored
                            // graph usually ALREADY carries infra tiles — in that case
                            // the requestRoute rebuild is pure redundant work. Serve the
                            // stored graph directly and only rebuild when it genuinely
                            // lacks infra (older snapshot / content-dropped build).
                            const storedHasInfra = !!(baseStored && Array.isArray(baseStored.nodes)
                                && baseStored.nodes.length > 0
                                && baseStored.nodes.some((n: any) => n?.meta?.infra === true));
                            if (cachedEnriched && Array.isArray(cachedEnriched.nodes) && cachedEnriched.nodes.length > 0) {
                                // Mirror the rebuild path: set g + flag, then fall
                                // through to navigatePanel (do NOT break — that would
                                // skip the render).
                                g = cachedEnriched;
                                l1FreshlyRebuilt = true;
                                outputChannel.appendLine(`[requestRoute system-design] served CACHED enriched L1 for ${repoRoot} (${g.nodes.length} nodes)`);
                            } else if (storedHasInfra) {
                                g = { ...baseStored, meta: { ...(baseStored.meta ?? {}), scopedRepo: sysSid } };
                                l1FreshlyRebuilt = true;
                                enrichedL1GraphCache.set(baseStored, g);
                                outputChannel.appendLine(`[requestRoute system-design] served STORED per-repo L1 (has infra) for ${repoRoot} (${g.nodes.length} nodes) — no rebuild`);
                            } else {
                            // #811 follow-up — file content is lazy-dropped
                            // from snapshot.files by the redactor (#354/#355),
                            // so detectInfrastructureServices' SDK-pattern
                            // scan returns 0 matches when reading
                            // `subSnap.files[fp].content`. Pass a content
                            // provider that re-hydrates from the per-repo
                            // SQLite store; without it the .NET / Go / Java
                            // infra patterns can never fire.
                            const getContent = (fp: string): string | undefined => {
                                try {
                                    return (repoStore as any).getFileContent?.('working', fp);
                                } catch { return undefined; }
                            };
                            const runInfraRebuild = (): any => {
                                const freshG: any = buildMicroserviceGraph(subRepoAbs, subSnap, undefined, getContent);
                                if (freshG && Array.isArray(freshG.nodes) && freshG.nodes.length > 0) {
                                    // #811 — stamp meta.scopedRepo so the frontend's hash
                                    // sync keeps the URL at `/system-design/<repo>`.
                                    freshG.meta = { ...(freshG.meta ?? {}), scopedRepo: sysSid };
                                    return freshG;
                                }
                                return undefined;
                            };
                            if (baseStored && Array.isArray(baseStored.nodes) && baseStored.nodes.length > 0) {
                                // PERF (2026-07-19, user-reported ~15s "hang") — the infra
                                // content scan re-hydrates every file from SQLite (polar
                                // server = 1,705 files) and previously ran SYNCHRONOUSLY
                                // here, blocking the L1 open so it felt hung / like it
                                // failed with no feedback. Serve the stored graph
                                // IMMEDIATELY (it already carries the full service topology;
                                // only the infra tiles are missing) and enrich infra in the
                                // BACKGROUND, pushing the result only if it added tiles and
                                // the user is still viewing THIS repo's L1.
                                g = { ...baseStored, meta: { ...(baseStored.meta ?? {}), scopedRepo: sysSid } };
                                l1FreshlyRebuilt = true;
                                lastScopedL1Repo = sysSid;
                                enrichedL1GraphCache.set(baseStored, g); // avoid a duplicate sync rebuild this session
                                const beforeCount = g.nodes.length;
                                setTimeout(() => {
                                    try {
                                        const freshG = runInfraRebuild();
                                        if (!freshG) return;
                                        enrichedL1GraphCache.set(baseStored, freshG);
                                        // Only push if enrichment ADDED nodes (infra tiles)
                                        // AND the user hasn't since opened another repo's L1.
                                        if (freshG.nodes.length > beforeCount && lastScopedL1Repo === sysSid) {
                                            panelManager.updatePanel('microservice:workspace', freshG);
                                            try { wsBridge?.broadcast({ type: 'updateGraph', graphId: 'microservice:workspace', graph: freshG, mode: 'microservice' }); } catch { /* no browser open */ }
                                        }
                                        outputChannel.appendLine(`[requestRoute system-design] async infra enrich for ${repoRoot}: ${beforeCount}->${freshG.nodes.length} nodes`);
                                    } catch (e: any) {
                                        outputChannel.appendLine(`[requestRoute system-design] async infra enrich failed for ${repoRoot}: ${e?.message ?? e}`);
                                    }
                                }, 0);
                                outputChannel.appendLine(`[requestRoute system-design] served STORED per-repo L1 for ${repoRoot} (${g.nodes.length} nodes) — infra enriching async`);
                            } else {
                                // No stored graph to serve fast — last-resort SYNC rebuild.
                                const freshG = runInfraRebuild();
                                if (freshG) {
                                    g = freshG;
                                    l1FreshlyRebuilt = true;
                                    if (baseStored) enrichedL1GraphCache.set(baseStored, freshG);
                                    outputChannel.appendLine(`[requestRoute system-design] sub-repo pick: fresh microservice graph for ${repoRoot} (${g.nodes.length} nodes / ${g.edges?.length ?? 0} edges incl infra)`);
                                }
                            }
                            } // end else (cache miss → serve-stored + async enrich)
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute system-design] per-sub-repo rebuild failed: ${err?.message ?? err}`);
                    }
                }
                if (workspaceIsMulti && sysSid && !gds && (!g || !Array.isArray(g.nodes) || g.nodes.length === 0)) {
                    try {
                        const repos = aggregator.listRepos();
                        for (const r of repos) {
                            if (!r.rootPath) continue;
                            const absPath = path.join(workspaceRoot, r.rootPath);
                            const repoStore = await repoStoreRegistry.getRepoStoreLoaded(absPath);
                            const candidate: any = repoStore?.getWorking().graphs?.['microservice:workspace'];
                            if (candidate && Array.isArray(candidate.nodes) && candidate.nodes.length > 0) {
                                g = candidate;
                                outputChannel.appendLine(`[requestRoute system-design] cache miss; reloaded microservice:workspace from ${r.name ?? r.repoId} (${g.nodes.length} nodes)`);
                                break;
                            }
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute system-design] cache-miss reload failed: ${err?.message ?? err}`);
                    }
                }
                if (workspaceIsMulti && sysSid && !gds && g && !l1FreshlyRebuilt) {
                    // UX-65 / UX-67-test-debt (2026-06-09) — the scoped
                    // filter + cross-repo neighbour walk lives in
                    // `core/graph/scopedMicroserviceGraphFilter.ts` so the
                    // ~100 lines of inline logic are unit-tested in
                    // isolation. Behaviour unchanged.
                    //
                    // #811 (2026-06-10) — skip the filter when we just
                    // rebuilt the microservice graph from the sub-repo's
                    // snapshot directly; that path produces a single-repo
                    // L1 with infra siblings already scoped to one repo.
                    try {
                        const resolved = resolveRepoFromArg(sysSid, workspaceRoot, aggregator);
                        const rootPath = resolved?.rootPath ?? sysSid;
                        const filtered = filterMicroserviceGraphForRepo(g, rootPath);
                        if (filtered) {
                            g = filtered;
                            outputChannel.appendLine(`[requestRoute system-design] multi-repo: scoped sid=${sysSid} → ${filtered.nodes!.length} nodes / ${filtered.edges!.length} edges (${filtered.crossRepoCount} cross-repo)`);
                        } else {
                            outputChannel.appendLine(`[requestRoute system-design] multi-repo: sid=${sysSid} matched 0 nodes; falling through to workspace graph`);
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute system-design] multi-repo scope failed: ${err?.message ?? err}`);
                    }
                }
                if (!g && !gds) {
                    try {
                        g = buildMicroserviceGraphCachedHandler(handlerCtx);
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute system-design] cached build failed: ${err?.message ?? err}`);
                    }
                }
                if (g) {
                    panelManager.navigatePanel(sourcePanelId, 'microservice:workspace', 'microservice', g, microserviceLabel(g));
                } else {
                    // Never silently do nothing (user-reported: "if it failed no
                    // notification for user"). Prefer the workspace skeletal L1 so the
                    // user lands SOMEWHERE; only warn if even that is unavailable.
                    let wsFallback: any;
                    try { wsFallback = aggregator.getWorkingGraph?.('microservice:workspace'); } catch { /* none */ }
                    if (wsFallback && Array.isArray(wsFallback.nodes) && wsFallback.nodes.length > 0) {
                        panelManager.navigatePanel(sourcePanelId, 'microservice:workspace', 'microservice', wsFallback, microserviceLabel(wsFallback));
                        outputChannel.appendLine(`[requestRoute system-design] scoped L1 unavailable for '${sysSid || 'workspace'}'; served workspace fallback`);
                    } else {
                        vscode.window.showWarningMessage(`CodeAtlas: couldn't open the system design${sysSid ? ` for '${sysSid}'` : ''} — it may still be indexing. Try again in a moment.`);
                        outputChannel.appendLine(`[requestRoute system-design] no graph to serve for '${sysSid || 'workspace'}' — warned user`);
                    }
                }
                break;
            }
            case 'features': {
                const sid = message.param || '';
                const gid = sid ? `feature:${sid}` : 'feature:workspace';
                const lbl = sid ? `Features: ${sid.replace('service:', '')}` : 'Feature Areas';
                let g = graphs[gid];
                // Issue #790 #3 regression — the workspace-merged `graphs[gid]`
                // can hold an empty cross-repo placeholder for a
                // `feature:service:<repo>` key when a non-owning repo's
                // shared-cluster index lists it first. Treat empty
                // (no nodes OR nodes.length === 0) as missing so the
                // per-repo branch below re-resolves through
                // `getRepoStoreLoaded` against the actual owning repo.
                // Also clear when `gitDiffState` is set with an empty
                // synthesized entry (surfaceLiveWorkingDiff inherits the
                // workspace-level placeholders) — falling through to the
                // per-repo branch still resolves real cluster data, and
                // the eventual `navigateForBrowser` payload keeps the
                // diff annotations intact via the panel's own state.
                if (g && (!g.nodes || g.nodes.length === 0) && sid) {
                    g = undefined as any;
                }

                // 2026-06-04 (UX-24 follow-up) - in multi-repo mode the
                // workspace-level snapshotStore is empty by design; the
                // per-repo store holds the real feature graph (and now
                // includes IaC-derived SAM / Serverless Framework routes
                // in cluster.apisInCluster). Mirror the openFeatureForService
                // multi-repo branch so cold deep-links like
                // `#/features/service:http-api` resolve to that repo's
                // `feature:service:<repoName>` graph instead of falling
                // through to the empty workspace graph.
                // Issue #790 #3 regression — multi-repo branch must run
                // even when `gitDiffState` is set, because the synthesized
                // diff inherits empty workspace placeholders for non-
                // owning services. Per-repo lookup recovers the real
                // graph and the panel's own diff overlay still applies.
                if (!g && sid) {
                    try {
                        const repos = aggregator.listRepos();
                        const isMultiRepo = repos.length >= 2 && repos.some((r: any) => !!r.rootPath);
                        if (isMultiRepo) {
                            const repoName = sid.replace(/^service:/, '');
                            const matched = repos.find((r: any) => r.name === repoName || r.repoId === repoName);
                            if (matched && matched.rootPath) {
                                const absPath = path.join(workspaceRoot, matched.rootPath);
                                const repoStore = await repoStoreRegistry.getRepoStoreLoaded(absPath);
                                const perRepoGraphs = repoStore?.getWorking().graphs ?? {};
                                // BUG-POLAR-1: the repo is addressed by NAME
                                // ("server") but its feature graph is keyed by the
                                // SERVICE name inside the repo (`feature:service:main`).
                                // Resolve the exact key, else per-repo `feature:workspace`,
                                // else ANY non-empty `feature:*` graph — so deep-links /
                                // reloads / breadcrumbs resolve like the L1 click does.
                                const candidate: any = resolvePerRepoGraph(perRepoGraphs as any, 'feature', matched.name ?? repoName);
                                if (candidate && (candidate.nodes?.length ?? 0) > 0) {
                                    g = candidate;
                                    outputChannel.appendLine(`[requestRoute features] multi-repo: routed sid=${sid} → ${candidate.graphId} (${candidate.nodes?.length} clusters)`);
                                }
                            }
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute features] multi-repo branch failed: ${err?.message ?? err}`);
                    }
                }

                if (!g && sid && !gitDiffState) {
                    // Use the local `buildFeatureGraphForService` wrapper (line ~3592)
                    // which is the simpler extension-side equivalent of the
                    // handler-module version (no syncOrchestrator cascade, just
                    // buildFeatureGraph + snapshot update + return).
                    try {
                        const built = buildFeatureGraphForService(sid);
                        outputChannel.appendLine(`[requestRoute features] on-demand build for ${sid}: ${built ? `${built.nodes?.length ?? 0} nodes` : 'undefined'}`);
                        if (built) g = built;
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute features] on-demand build failed for ${sid}: ${err?.message ?? err}`);
                    }
                }
                // UX-53d (2026-06-06) — bare `#/features` in multi-repo
                // mode: there's no service-scoped sid to dispatch, so
                // synthesise a workspace overview by unioning cluster
                // nodes from every per-repo `feature:workspace` graph.
                // Single-repo path falls through unchanged.
                if ((!g || (g.nodes?.length ?? 0) === 0) && !sid && workspaceIsMulti && perRepoOrchestrators.size > 0 && !gitDiffState) {
                    // UX-53d (refined 2026-06-06) — fold every per-repo
                    // `feature:service:<repoName>` graph into a single
                    // workspace overview. Dedupe by node id since per-repo
                    // stores share the cross-repo cluster index after the
                    // Phase J reapply pass (same node may appear in N
                    // stores). Track which repos contributed via
                    // `meta.repoContributors` so the panel header can
                    // show the right repo-count.
                    const nodesById = new Map<string, any>();
                    const edgeKeys = new Set<string>();
                    const edges: any[] = [];
                    const anchors: Record<string, any> = {};
                    const repoContributors = new Set<string>();
                    for (const [repoKey, orch] of perRepoOrchestrators) {
                        try {
                            const repoGraphs: any = orch.getStore().getWorking().graphs ?? {};
                            // Each per-repo store contains a feature graph
                            // keyed by its own repo name. Iterate all
                            // feature:* keys to be inclusive when the
                            // naming convention shifts (`feature:workspace`
                            // vs `feature:service:<n>` etc.).
                            const featureKeys = Object.keys(repoGraphs).filter(k => k.startsWith('feature:'));
                            let added = 0;
                            for (const fk of featureKeys) {
                                const candidate: any = repoGraphs[fk];
                                if (!candidate?.nodes?.length) continue;
                                for (const n of candidate.nodes) {
                                    if (!n?.id || nodesById.has(n.id)) continue;
                                    nodesById.set(n.id, n);
                                    added++;
                                }
                                if (Array.isArray(candidate.edges)) {
                                    for (const e of candidate.edges) {
                                        const k = `${e.source}→${e.target}:${e.label ?? ''}`;
                                        if (edgeKeys.has(k)) continue;
                                        edgeKeys.add(k);
                                        edges.push(e);
                                    }
                                }
                                Object.assign(anchors, candidate.anchors ?? {});
                                if (added > 0) repoContributors.add(repoKey);
                            }
                        } catch (err: any) {
                            outputChannel.appendLine(`[requestRoute features] per-repo overview merge failed: ${err?.message ?? err}`);
                        }
                    }
                    const nodes = [...nodesById.values()];
                    outputChannel.appendLine(`[requestRoute features] workspace overview fold: ${nodes.length} clusters across ${repoContributors.size} repo(s)`);
                    if (nodes.length > 0) {
                        g = {
                            graphId: 'feature:workspace', type: 'feature',
                            nodes, edges, anchors,
                            meta: { clusterCount: nodes.length, repoContributors: [...repoContributors] },
                        } as any;
                    }
                }

                if (g) {
                    if (!navigateForBrowser(gid, 'feature', g, lbl)) {
                        panelManager.navigatePanel(sourcePanelId, gid, 'feature', g, lbl);
                    }
                } else {
                    notifyBrowser('warning', `Feature graph not found: ${gid}`);
                    const fallback = graphs['microservice:workspace'];
                    if (fallback) {
                        if (!navigateForBrowser('microservice:workspace', 'microservice', fallback, `System Design: ${repoName}`)) {
                            panelManager.navigatePanel(sourcePanelId, 'microservice:workspace', 'microservice', fallback, `System Design: ${repoName}`);
                        }
                    }
                }
                break;
            }
            case 'apis': {
                const cid = message.param || '';
                const gid = `api-list:${cid}`;
                let g = graphs[gid];

                // 2026-06-04 (UX-24 follow-up) — multi-repo cold deep-link
                // to api-list. Workspace store is empty; per-repo store
                // holds the real graph including SAM-derived routes.
                // 2026-06-05 (UX-28 follow-up) — refactored to use shared
                // `findGraphInRepos` so sequence/file/flow can share the
                // same lookup. See `multiRepoGraphLookup.ts`.
                if (!g && cid && !gitDiffState) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { findGraphInRepos } = require('./core/storage/multiRepoGraphLookup');
                        const hit = await findGraphInRepos(
                            gid,
                            aggregator,
                            (absPath: string) => repoStoreRegistry.getRepoStoreLoaded(absPath),
                            workspaceRoot,
                            (m: string) => outputChannel.appendLine(`[requestRoute apis] ${m}`),
                        );
                        if (hit) g = hit.graph;
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute apis] multi-repo branch failed: ${err?.message ?? err}`);
                    }
                }

                if (g) {
                    panelManager.navigatePanel(sourcePanelId, gid, 'api-list', g, `APIs: ${cid}`);
                } else {
                    const fallback = graphs['microservice:workspace'];
                    if (fallback) panelManager.navigatePanel(sourcePanelId, 'microservice:workspace', 'microservice', fallback, `System Design: ${repoName}`);
                }
                break;
            }
            case 'sequence': {
                const seqId = message.param || '';
                const gid = `sequence:${seqId}`;
                let g = graphs[gid];

                // UX-28 follow-up (2026-06-05) — multi-repo cold deep-link
                // for sequence graphs. Same shape as `apis` above; the
                // graph lives in the per-repo state.db, not the workspace
                // monorepo.db.
                if (!g && seqId && !gitDiffState) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { findGraphInRepos } = require('./core/storage/multiRepoGraphLookup');
                        const hit = await findGraphInRepos(
                            gid,
                            aggregator,
                            (absPath: string) => repoStoreRegistry.getRepoStoreLoaded(absPath),
                            workspaceRoot,
                            (m: string) => outputChannel.appendLine(`[requestRoute sequence] ${m}`),
                        );
                        if (hit) g = hit.graph;
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute sequence] multi-repo branch failed: ${err?.message ?? err}`);
                    }
                }

                if (g) {
                    panelManager.navigatePanel(sourcePanelId, gid, 'sequence', g, seqId);
                    break;
                }
                // #843 — tour drills + deep links reach sequences via this
                // route. When the sequence graph doesn't exist (IaC handler
                // the sequence builder skipped), apply the ADR-039 chain:
                // flow → file substitutes with a toast. Pre-fix the L1
                // fallback below went undefined in multi-repo (ADR-037
                // never-fill) so the click silently no-opped.
                {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { deriveSequenceFallbackIds } = require('./core/graph/sequenceFallbackIds');
                    // #861 — Java class-method flows are class-prefixed; the
                    // derived flow candidates are bare. Resolve before lookup.
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { resolveFlowGraphId } = require('./core/graph/flowGraphResolve');
                    let navigated = false;
                    for (const cand of deriveSequenceFallbackIds(seqId)) {
                        const candGid = cand.gid.startsWith('flow:')
                            ? (resolveFlowGraphId(Object.keys(graphs), cand.gid) ?? cand.gid)
                            : cand.gid;
                        let cg: any = graphs[candGid];
                        if ((!cg || !cg.nodes?.length) && !gitDiffState) {
                            try {
                                // eslint-disable-next-line @typescript-eslint/no-require-imports
                                const { findGraphInRepos } = require('./core/storage/multiRepoGraphLookup');
                                const hit = await findGraphInRepos(
                                    cand.gid, aggregator,
                                    (absPath: string) => repoStoreRegistry.getRepoStoreLoaded(absPath),
                                    workspaceRoot,
                                    (m: string) => outputChannel.appendLine(`[requestRoute sequence-fallback] ${m}`),
                                );
                                if (hit) cg = hit.graph;
                            } catch { /* candidate miss — try the next */ }
                        }
                        if (cg && Array.isArray(cg.nodes) && cg.nodes.length > 0) {
                            const fb = { ...cg, meta: { ...(cg.meta ?? {}), fallbackFromSequence: true } };
                            panelManager.navigatePanel(sourcePanelId, candGid, cand.mode, fb, cand.label);
                            notifyBrowser('info', `No sequence diagram yet — showing ${cand.mode === 'flow' ? 'the flow chart' : 'the file diagram'} instead.`);
                            navigated = true;
                            break;
                        }
                    }
                    if (!navigated) {
                        const fallback = graphs['microservice:workspace'];
                        if (fallback) panelManager.navigatePanel(sourcePanelId, 'microservice:workspace', 'microservice', fallback, `System Design: ${repoName}`);
                        notifyBrowser('warning', `Sequence diagram not found: ${seqId}`);
                    }
                }
                break;
            }
            case 'screen-content': {
                // BUG-POLAR-7: a frontend screen row opens `screen-content:<screenId>`.
                // The screenId carries no repo path, so — unlike file/flow/sequence —
                // it can't be routed by prefix. Scan every per-repo store for the exact
                // graphId (findGraphInRepos) so multi-repo screen drill-down resolves.
                const scId = message.param || '';
                const gid = `screen-content:${scId}`;
                let g: any = graphs[gid];
                if (!g && scId && !gitDiffState) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { findGraphInRepos } = require('./core/storage/multiRepoGraphLookup');
                        const hit = await findGraphInRepos(
                            gid, aggregator,
                            (absPath: string) => repoStoreRegistry.getRepoStoreLoaded(absPath),
                            workspaceRoot,
                            (m: string) => outputChannel.appendLine(`[requestRoute screen-content] ${m}`),
                        );
                        if (hit) g = hit.graph;
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute screen-content] multi-repo branch failed: ${err?.message ?? err}`);
                    }
                }
                if (g) {
                    const scLbl = scId.split(/[:/]/).filter(Boolean).pop() ?? 'Screen';
                    panelManager.navigatePanel(sourcePanelId, gid, 'screen-content', g, scLbl);
                }
                break;
            }
            case 'file': {
                const fp = message.param || '';
                const gid = `file:${fp}`;
                let g = graphs[gid];
                const lbl = fp.split('/').pop() ?? fp;

                // UX-28 follow-up (2026-06-05) — multi-repo cold deep-link
                // for file diagrams. Same shape as `apis` / `sequence`.
                if (!g && fp && !gitDiffState) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { findGraphInRepos } = require('./core/storage/multiRepoGraphLookup');
                        const hit = await findGraphInRepos(
                            gid,
                            aggregator,
                            (absPath: string) => repoStoreRegistry.getRepoStoreLoaded(absPath),
                            workspaceRoot,
                            (m: string) => outputChannel.appendLine(`[requestRoute file] ${m}`),
                        );
                        if (hit) g = hit.graph;
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute file] multi-repo branch failed: ${err?.message ?? err}`);
                    }
                }

                if (g) {
                    panelManager.navigatePanel(sourcePanelId, gid, 'file', g, lbl);
                } else {
                    openFileDiagramInPanel(fp, sourcePanelId);
                }
                break;
            }
            case 'flow': {
                const fp = message.param || '';
                const fn = message.param2 || '';
                let gid = `flow:${fp}:${fn}`;
                // #863: a manual bare-name flow deep-link via the ROUTE shape
                // ({route:'flow', param:<file>, param2:<bareFn>}) builds
                // `flow:<file>:<bareFn>`, but class methods (Java/Kotlin) are
                // stored class-prefixed (`flow:<file>:Class.fn`). Resolve the
                // bare name to the stored class-prefixed id before lookup —
                // mirrors the graphId-shape resolve (#861-follow) so both
                // deep-link shapes land on the same flow. See ADR-050.
                if (!graphs[gid]) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { resolveFlowGraphId } = require('./core/graph/flowGraphResolve');
                        const real = resolveFlowGraphId(Object.keys(graphs), gid);
                        if (real && graphs[real]?.nodes?.length) gid = real;
                    } catch { /* fall through to existing lookup / multi-repo branch */ }
                }
                let g = graphs[gid];

                // UX-28 follow-up (2026-06-05) — multi-repo cold deep-link
                // for flow diagrams. Same shape as `apis` / `sequence` /
                // `file`.
                if (!g && fp && fn && !gitDiffState) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { findGraphInRepos } = require('./core/storage/multiRepoGraphLookup');
                        const hit = await findGraphInRepos(
                            gid,
                            aggregator,
                            (absPath: string) => repoStoreRegistry.getRepoStoreLoaded(absPath),
                            workspaceRoot,
                            (m: string) => outputChannel.appendLine(`[requestRoute flow] ${m}`),
                        );
                        if (hit) g = hit.graph;
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute flow] multi-repo branch failed: ${err?.message ?? err}`);
                    }
                }

                if (g) {
                    panelManager.navigatePanel(sourcePanelId, gid, 'flow', g, `Flow: ${fn}`);
                } else {
                    openFunctionFlowInPanel(fp, fn, sourcePanelId);
                }
                break;
            }
            case 'health': {
                // UX-69 (2026-06-09) — per-repo Health drill-in. When
                // `message.param` carries a repo identifier, surface
                // THAT sub-repo's health report instead of the merged
                // workspace view.
                const healthSid = message.param ? String(message.param).replace(/^service:/, '') : '';
                let g: any = graphs['health:report'];
                if (workspaceIsMulti && healthSid) {
                    try {
                        const resolved = resolveRepoFromArg(healthSid, workspaceRoot, aggregator);
                        if (resolved) {
                            const repoStore = await repoStoreRegistry.getRepoStoreLoaded(resolved.gitRoot);
                            const repoH: any = repoStore?.getWorking()?.health;
                            if (repoH) {
                                g = { graphId: 'health:report', type: 'health' as const, nodes: [] as any[], edges: [] as any[], anchors: {} as Record<string, any>, meta: { health: repoH, scopedRepo: resolved.scopedRepo } };
                                outputChannel.appendLine(`[requestRoute health] multi-repo: scoped to per-repo health ${resolved.scopedRepo}`);
                            }
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute health] per-repo scope failed: ${err?.message ?? err}`);
                    }
                }
                if (g) {
                    if (!navigateForBrowser('health:report', 'health', g, 'Health Report')) {
                        panelManager.navigatePanel(sourcePanelId, 'health:report', 'health', g, 'Health Report');
                    }
                } else {
                    const w = snapshotStore.getWorking();
                    let health: any = w.health;
                    // UX-53c (2026-06-06) — in multi-repo mode the
                    // workspace-level health is undefined; aggregate per-repo
                    // health into a unified report so the dashboard renders.
                    if (!health && workspaceIsMulti && perRepoOrchestrators.size > 0) {
                        // UX-53c (2026-06-06) — HealthReport interface
                        // requires deadFunctions / godFiles / highCouplingFiles
                        // / cyclicDependencies / orphanedClusters. Initialise
                        // ALL of these so the webview HealthDashboard never
                        // dereferences `.length` on undefined.
                        const merged = {
                            cyclicDependencies: [] as any[],
                            deadFunctions: [] as any[],
                            highCouplingFiles: [] as any[],
                            godFiles: [] as any[],
                            orphanedClusters: [] as any[],
                        };
                        for (const [, orch] of perRepoOrchestrators) {
                            try {
                                const repoH: any = orch.getStore().getWorking().health;
                                if (!repoH) continue;
                                if (Array.isArray(repoH.cyclicDependencies)) merged.cyclicDependencies.push(...repoH.cyclicDependencies);
                                if (Array.isArray(repoH.deadFunctions)) merged.deadFunctions.push(...repoH.deadFunctions);
                                if (Array.isArray(repoH.highCouplingFiles)) merged.highCouplingFiles.push(...repoH.highCouplingFiles);
                                if (Array.isArray(repoH.godFiles)) merged.godFiles.push(...repoH.godFiles);
                                if (Array.isArray(repoH.orphanedClusters)) merged.orphanedClusters.push(...repoH.orphanedClusters);
                            } catch (err: any) {
                                outputChannel.appendLine(`[requestRoute health] per-repo merge failed: ${err?.message ?? err}`);
                            }
                        }
                        health = merged;
                    }
                    if (health) {
                        const hGraph = { graphId: 'health:report', type: 'health' as const, nodes: [] as any[], edges: [] as any[], anchors: {} as Record<string, any>, meta: { health } };
                        if (!navigateForBrowser('health:report', 'health', hGraph, 'Health Report')) {
                            panelManager.navigatePanel(sourcePanelId, 'health:report', 'health', hGraph, 'Health Report');
                        }
                    } else {
                        notifyBrowser('warning', 'No health data available. Run Initialize Visuals first.');
                    }
                }
                break;
            }
            // Issue #742 / #743 — Map / Domain / Tour deep-link routes. The
            // graph already exists in working.graphs after init + cascade. For
            // Map we let the registered openMapDiagram handler do the rebuild;
            // here we fall back to the cached graph when present.
            case 'map': {
                let g: any = graphs['map:workspace'];
                // 2026-06-09 — in multi-repo workspaces prefer the
                // aggregator's `map:workspace` (built by
                // `buildWorkspaceMapGraph` from per-repo summaries: apis,
                // technology, status). The legacy `state.db` slot here
                // is whatever each sub-repo's SyncOrchestrator wrote last,
                // which lacks the cross-repo signal and surfaces every
                // sibling repo as `«unknown» · 0 apis` because the
                // workspace `apiIndex` is empty by design. Falls back to
                // the legacy slot when the aggregator hasn't run yet
                // (early init / single-repo workspaces).
                // 2026-06-09 pivot — when the user picks a sub-repo from
                // the home picker, `message.param` carries that repo's
                // name/id. Show only THAT repo's map:workspace (same
                // shape as single-repo mode) rather than a merged view.
                const mapSid = message.param ? String(message.param).replace(/^service:/, '') : '';
                // #819 (2026-06-10) — when a sub-repo IS picked, rebuild
                // its map FRESH from the per-repo snapshot via the shared
                // `scopedSubRepoView` module (also consumed by the MCP
                // standalone — parity by construction). The old approach
                // (load the per-repo CACHED map, then run the name-based
                // `filterMapGraphForRepo`) broke on Phase-5-scoped stores:
                // the cached map names its service by INNER name
                // (`node-app`, not `api-service`), the filter kept 0
                // nodes, fell through without `meta.scopedRepo` (hash
                // stripped), and the fold then rendered ANOTHER repo's
                // content (dev-walkthrough finding).
                let mapScopedFresh = false;
                if (workspaceIsMulti && mapSid && !gds) {
                    try {
                        const repos = aggregator.listRepos();
                        const matched = repos.find(r =>
                            (r.name && (r.name === mapSid || r.name.endsWith('/' + mapSid)))
                            || (r.rootPath && (r.rootPath === mapSid || r.rootPath.endsWith('/' + mapSid)))
                            || r.repoId === mapSid);
                        if (matched?.rootPath) {
                            const absPath = path.join(workspaceRoot, matched.rootPath);
                            const repoStore = await repoStoreRegistry.getRepoStoreLoaded(absPath);
                            if (repoStore) {
                                const scoped = buildScopedSubRepoMapGraph({
                                    matched: { repoId: matched.repoId, name: matched.name, rootPath: matched.rootPath },
                                    subSnapshot: repoStore.getWorking(),
                                    workspaceRoot,
                                    scopedRepo: mapSid,
                                    contentProvider: (fp) => (repoStore as any).getFileContent?.('working', fp),
                                    joinPath: (...parts) => path.join(...parts),
                                });
                                if (scoped) {
                                    g = scoped;
                                    mapScopedFresh = true;
                                    outputChannel.appendLine(`[requestRoute map] sub-repo pick: fresh scoped map for ${matched.name} (${(g as any).nodes.length} nodes)`);
                                }
                            }
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute map] scoped rebuild failed: ${err?.message ?? err}`);
                    }
                }
                if (workspaceIsMulti && !mapScopedFresh && (!g || !Array.isArray(g.nodes) || g.nodes.length === 0)) {
                    try {
                        const aggGraph: any = aggregator.getWorkingGraph('map:workspace');
                        if (aggGraph && Array.isArray(aggGraph.nodes) && aggGraph.nodes.length > 0) {
                            g = aggGraph;
                            outputChannel.appendLine(`[requestRoute map] fallback: using aggregator map:workspace (${g.nodes.length} nodes / ${g.edges?.length ?? 0} edges)`);
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute map] aggregator read failed: ${err?.message ?? err}`);
                    }
                }
                if (workspaceIsMulti && mapSid && !gds && g && !mapScopedFresh) {
                    // UX-65e (2026-06-09) — scope filter + cross-repo hop,
                    // see `core/graph/scopedMapGraphFilter.ts`. #819: this
                    // now runs ONLY when the fresh scoped rebuild above
                    // missed (e.g. per-repo store unavailable) and we're
                    // filtering the aggregator's workspace-overview graph,
                    // whose nodes DO carry `service:<repoName>` ids the
                    // filter can match.
                    try {
                        const filtered = filterMapGraphForRepo(g, mapSid);
                        if (filtered) {
                            // Preserve anchors block that the Knowledge Map view consumes.
                            g = { ...filtered, anchors: g.anchors ?? {} };
                            outputChannel.appendLine(`[requestRoute map] multi-repo: scoped sid=${mapSid} → ${filtered.nodes!.length} nodes / ${filtered.edges!.length} edges (${filtered.crossRepoCount} cross-repo)`);
                        } else {
                            outputChannel.appendLine(`[requestRoute map] multi-repo: sid=${mapSid} matched 0 nodes; falling through`);
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute map] multi-repo scope failed: ${err?.message ?? err}`);
                    }
                }
                // UX-57 (2026-06-06) — bare `#/map` in multi-repo: the
                // workspace-level map is a roll-up of service nodes only
                // (2 nodes for a 2-repo workspace). Users expect the
                // richer per-repo detail. Fold every per-repo
                // `map:workspace` (24-25 nodes each) into a single
                // workspace overview with id dedup. Single-repo and
                // non-empty workspace-level rich maps fall through.
                // UX-65e (2026-06-09) — DON'T fold when the user explicitly
                // scoped to a sub-repo. The scoped filter above sets
                // `g.meta.scopedRepo` exactly for this case, and the
                // rollup heuristic matches a 1-service scoped graph
                // (small, services-only). Without the guard the fold
                // overwrites the scoped view with the workspace rollup.
                // #848b — bare `#/map` on multi-repo: the user asked for a
                // per-repo scoped model ("all repos under one graph" was the
                // complaint). Serve the repo-card overview (one card per
                // sub-repo, click → `#/map/<repo>`); the 500-node fold is
                // demoted to a fallback when the aggregator can't build it.
                if (workspaceIsMulti && !mapSid && !gds) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { buildWorkspaceMapGraph } = require('./core/graph/mapGraphBuilder');
                        const cards: any = buildWorkspaceMapGraph(aggregator, workspaceRoot);
                        if (cards && Array.isArray(cards.nodes) && cards.nodes.length > 0) {
                            g = cards;
                            outputChannel.appendLine(`[requestRoute map] multi-repo bare map → repo-card overview (${cards.nodes.length} nodes)`);
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute map] repo-card overview failed (${err?.message ?? err}); falling back to fold`);
                    }
                }
                const alreadyScoped = !!(g?.meta?.scopedRepo);
                const isRepoCardOverview = !!(g && Array.isArray(g.nodes) && g.nodes.some((n: any) => n?.meta?.workspaceMap));
                const isRollupOnly = !alreadyScoped
                    && !isRepoCardOverview
                    && g
                    && Array.isArray(g.nodes)
                    && g.nodes.length > 0
                    && g.nodes.length <= 5
                    && g.nodes.every((n: any) => (n?.type ?? n?.kind) === 'service');
                if ((!g || isRollupOnly) && workspaceIsMulti && perRepoOrchestrators.size > 0 && !gds) {
                    // #819 (2026-06-10) — fold via the shared
                    // `foldPerRepoMapGraphs`, which namespaces node/edge/
                    // anchor ids by repo. The old raw-id dedup silently
                    // dropped every repo after the first because per-repo
                    // maps share generated ids (`map-1`, `map-2`, …) —
                    // the dev-walkthrough's `hasApiSvc:false` symptom.
                    try {
                        const perRepoMaps: Array<{ repoKey: string; graph: any }> = [];
                        for (const [repoKey, orch] of perRepoOrchestrators) {
                            try {
                                const candidate: any = (orch.getStore().getWorking().graphs ?? {})['map:workspace'];
                                if (candidate?.nodes?.length) perRepoMaps.push({ repoKey, graph: candidate });
                            } catch (err: any) {
                                outputChannel.appendLine(`[requestRoute map] per-repo overview read failed: ${err?.message ?? err}`);
                            }
                        }
                        const fold = foldPerRepoMapGraphs(perRepoMaps);
                        outputChannel.appendLine(`[requestRoute map] workspace overview fold: ${fold.nodes.length} nodes across ${fold.repoContributors.length} repo(s)`);
                        if (fold.nodes.length > 0) {
                            g = {
                                graphId: 'map:workspace', type: 'map',
                                nodes: fold.nodes, edges: fold.edges, anchors: fold.anchors,
                                meta: { nodeCount: fold.nodes.length, repoContributors: fold.repoContributors },
                            } as any;
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute map] per-repo overview fold failed: ${err?.message ?? err}`);
                    }
                }
                if (g) {
                    if (!navigateForBrowser('map:workspace', 'map', g, 'Knowledge Map')) {
                        panelManager.navigatePanel(sourcePanelId, 'map:workspace', 'map', g, 'Knowledge Map');
                    }
                } else {
                    notifyBrowser('warning', 'Knowledge Map not built yet — run Initialize Visuals first.');
                }
                break;
            }
            case 'domain': {
                let g: any = graphs['domain:workspace'];
                // 2026-06-09 — per-repo Domain Map. When `message.param`
                // names a sub-repo, swap in that repo's domain:workspace
                // (built by the per-repo orchestrator) so the user sees
                // ONE repo's domain clusters instead of the merged view.
                const domSid = message.param ? String(message.param).replace(/^service:/, '') : '';
                if (workspaceIsMulti && domSid && !gds) {
                    try {
                        const repos = aggregator.listRepos();
                        const matched = repos.find((r: any) => r.name === domSid || r.repoId === domSid || r.rootPath === domSid);
                        if (matched?.rootPath) {
                            const absPath = path.join(workspaceRoot, matched.rootPath);
                            const repoStore = await repoStoreRegistry.getRepoStoreLoaded(absPath);
                            const candidate: any = repoStore?.getWorking().graphs['domain:workspace'];
                            if (candidate && Array.isArray(candidate.nodes) && candidate.nodes.length > 0) {
                                g = { ...candidate, meta: { ...(candidate.meta ?? {}), scopedRepo: domSid } };
                                outputChannel.appendLine(`[requestRoute domain] multi-repo: routed sid=${domSid} → per-repo domain (${candidate.nodes.length} nodes)`);
                            }
                        }
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute domain] multi-repo branch failed: ${err?.message ?? err}`);
                    }
                }
                // #832 (2026-06-11) — bare `#/domain` on multi-repo hung
                // forever: no workspace-scope domain graph exists, the
                // merged view came back empty (stores past the registry
                // LRU cap aren't loaded), and the SPA's 5s fallback
                // bounced the route. Resolve like the MCP standalone
                // does — serve the first per-repo domain graph (existing
                // or built on demand), scoped to that repo.
                if (!g && workspaceIsMulti && !domSid && !gds) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { resolveBareDomainGraph } = require('./core/graph/domainRouteResolver');
                        const resolved = resolveBareDomainGraph({
                            mergedGraphs: graphs,
                            repos: aggregator.listRepos(),
                            getStore: (abs: string) => {
                                try { return repoStoreRegistry.getRepoStore(abs); } catch { return undefined; }
                            },
                            workspaceRoot,
                            joinPath: (a: string, b: string) => path.join(a, b),
                            log: (m: string) => outputChannel.appendLine(m),
                        });
                        if (resolved) g = resolved.graph;
                    } catch (err: any) {
                        outputChannel.appendLine(`[requestRoute domain] bare multi-repo resolver failed: ${err?.message ?? err}`);
                    }
                }
                if (g) {
                    if (!navigateForBrowser('domain:workspace', 'domain', g, 'Domain Map')) {
                        panelManager.navigatePanel(sourcePanelId, 'domain:workspace', 'domain', g, 'Domain Map');
                    }
                } else {
                    notifyBrowser('warning', 'Domain Map not built yet — run Initialize Visuals first.');
                }
                break;
            }
            case 'api-testing': {
                // Issue #601 — API Testing surface. Build payload on demand
                // (cheap: ~10ms for 1k endpoints) and broadcast it as
                // `apiTestingData` so the webview flips into the read-only
                // request browser.
                // UX-53a (2026-06-06) — multi-repo: walk per-repo stores
                // and merge collections so the workbench isn't empty.
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { buildApiTestingPayload } = require('./core/apiTesting/buildFromApiRecord');
                    let payload: any;
                    // UX-68 (2026-06-09) — per-repo API Testing scope.
                    // `message.param` carries the picked sub-repo's
                    // name/id. Build the payload from THAT sub-repo's
                    // store only; without a param we fold every per-repo
                    // store as before (UX-53a).
                    const apiTestingSid = message.param ? String(message.param).replace(/^service:/, '') : '';
                    if (workspaceIsMulti && apiTestingSid) {
                        try {
                            const resolved = resolveRepoFromArg(apiTestingSid, workspaceRoot, aggregator);
                            if (resolved) {
                                const repoStore = await repoStoreRegistry.getRepoStoreLoaded(resolved.gitRoot);
                                const repoW: any = repoStore?.getWorking();
                                if (repoW) {
                                    payload = buildApiTestingPayload(repoW);
                                    if (payload && typeof payload === 'object') (payload as any).scopedRepo = resolved.scopedRepo;
                                    outputChannel.appendLine(`[requestRoute api-testing] multi-repo: scoped sid=${apiTestingSid} → ${payload?.totalEndpoints ?? 0} endpoints`);
                                }
                            }
                        } catch (err: any) {
                            outputChannel.appendLine(`[requestRoute api-testing] per-repo scope failed: ${err?.message ?? err}`);
                        }
                    }
                    if (!payload && workspaceIsMulti && perRepoOrchestrators.size >= 2) {
                        const collections: any[] = [];
                        let totalEndpoints = 0;
                        for (const [, orch] of perRepoOrchestrators) {
                            try {
                                const repoW = orch.getStore().getWorking();
                                const repoP = buildApiTestingPayload(repoW);
                                for (const c of repoP.collections ?? []) collections.push(c);
                                totalEndpoints += repoP.totalEndpoints ?? 0;
                            } catch (err: any) {
                                outputChannel.appendLine(`[requestRoute api-testing] per-repo merge failed: ${err?.message ?? err}`);
                            }
                        }
                        payload = { totalEndpoints, collections };
                    } else if (!payload) {
                        const w = snapshotStore.getWorking();
                        payload = buildApiTestingPayload(w);
                    }
                    if (wsBridge?.hasClients()) {
                        wsBridge.broadcast({ type: 'apiTestingData', payload });
                    }
                } catch (err: any) {
                    outputChannel.appendLine(`[requestRoute api-testing] build failed: ${err?.message ?? err}`);
                    notifyBrowser('warning', `API Testing build failed: ${(err?.message ?? err).slice(0, 200)}`);
                }
                break;
            }
            case 'tour': {
                // Issue #742 — Tour has no cached graph; build steps on-demand
                // and broadcast `tourSteps` back so App.tsx pushes a synthetic
                // mode='tour' nav entry. Same builder as the standalone path.
                //
                // ADR-034 Phase H Pass 3 (#793 — Phase H: Tours per repo + workspace meta-tour (ADR-034)) — `message.param` may now be:
                //   • undefined / 'codebase' / 'recent' — codebase or recent
                //     walkthrough against the active store (single-repo path)
                //   • 'workspace' — the workspace meta-tour; resolved by
                //     reading the cached `tour:workspace` graph from the
                //     aggregator if present, otherwise falls through to the
                //     codebase tour for single-repo workspaces
                //   • any other value — treated as a repoId; the per-repo
                //     snapshot store is resolved via WorkspaceOrchestrator +
                //     RepoStoreRegistry and the tour is built against it
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { buildTour, toLiteSteps } = require('./core/analysis/tourBuilder');
                    const param = message.param;
                    let storeForTour = snapshotStore;
                    if (param && param !== 'recent' && param !== 'codebase' && param !== 'workspace') {
                        // Per-repo tour drill-in (workspace meta-tour → per-repo).
                        // Resolve repoId → repo root → IRepoStore. Single-repo
                        // workspaces will match the only repo and fall through
                        // to the same snapshotStore.
                        try {
                            const agg = repoStoreRegistry.getAggregatorStore(workspaceRoot);
                            const repos = agg?.listRepos?.() ?? [];
                            // 2026-06-09 — accept name / rootPath as well so
                            // the home-page picker can dispatch repo NAMES
                            // (which is what users actually pick); previously
                            // only the hex repoId worked.
                            const row = repos.find((r: any) => r.repoId === param || r.name === param || r.rootPath === param);
                            if (row) {
                                // eslint-disable-next-line @typescript-eslint/no-require-imports
                                const pathMod = require('path');
                                const absRoot = row.rootPath
                                    ? pathMod.resolve(workspaceRoot, row.rootPath)
                                    : workspaceRoot;
                                // #843 follow-up (2026-06-11) — must be the
                                // LOADED variant (Issue #790 class): the lazy
                                // `getRepoStore` handle has an empty in-memory
                                // snapshot until load(), so the per-repo tour
                                // built over it had 0 steps and the meta-tour
                                // "Open diagram" drill looked like a dead button.
                                const perRepoStore: any = await repoStoreRegistry.getRepoStoreLoaded(absRoot);
                                if (perRepoStore && typeof perRepoStore.getWorking === 'function') {
                                    storeForTour = perRepoStore;
                                }
                            }
                        } catch (lookupErr: any) {
                            outputChannel.appendLine(`[requestRoute tour] per-repo lookup failed (${param}): ${lookupErr?.message ?? lookupErr}`);
                        }
                    }
                    const w = storeForTour.getWorking();
                    const baseline = storeForTour.getBaseline();
                    const mode = (param === 'recent') ? 'recent' : 'codebase';
                    const baselineApiIds = mode === 'recent'
                        ? new Set(Object.keys(baseline?.apiIndex ?? {}))
                        : undefined;
                    const steps = buildTour(w, mode, { baselineApiIds });
                    const lite = toLiteSteps(steps);
                    if (wsBridge?.hasClients()) {
                        wsBridge.broadcast({ type: 'tourSteps', mode, steps: lite });
                    }
                } catch (err: any) {
                    outputChannel.appendLine(`[requestRoute tour] build failed: ${err?.message ?? err}`);
                    notifyBrowser('warning', `Tour build failed: ${(err?.message ?? err).slice(0, 200)}`);
                }
                break;
            }
            case 'violations': {
                // Issue #749 — `#/violations` route surfaces the
                // architecture-rule violations the MCP tool already
                // exposes. Compute on-demand against the working
                // snapshot, broadcast the rules + violations list so
                // ViolationsView can render it without an additional
                // round-trip.
                // UX-53f (2026-06-06) — multi-repo: run the evaluator
                // against each per-repo snapshot and merge violations.
                // Rules definitions are identical across repos so the
                // first rules slice is the canonical list.
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { listArchitectureViolations } = require('./mcp/tier2');
                    let rules: any[] = [];
                    let violations: any[] = [];
                    if (workspaceIsMulti && perRepoOrchestrators.size > 0) {
                        for (const [, orch] of perRepoOrchestrators) {
                            try {
                                const repoW = orch.getStore().getWorking();
                                const r = listArchitectureViolations(repoW, { workspaceRoot });
                                if (!rules.length && Array.isArray(r.rules)) rules = r.rules;
                                if (Array.isArray(r.violations)) violations.push(...r.violations);
                            } catch (err: any) {
                                outputChannel.appendLine(`[requestRoute violations] per-repo merge failed: ${err?.message ?? err}`);
                            }
                        }
                    } else {
                        const w = snapshotStore.getWorking();
                        const result = listArchitectureViolations(w, { workspaceRoot });
                        rules = result.rules;
                        violations = result.violations;
                    }
                    if (wsBridge?.hasClients()) {
                        wsBridge.broadcast({ type: 'violations', rules, violations });
                    }
                } catch (err: any) {
                    outputChannel.appendLine(`[requestRoute violations] failed: ${err?.message ?? err}`);
                    notifyBrowser('warning', `Violations build failed: ${(err?.message ?? err).slice(0, 200)}`);
                }
                break;
            }
        }
        if (gitDiffState) sendGitDiffContextToPanel(sourcePanelId);
    }, 'NavigationHandlers');

    // Activate the router — panelManager.onMessage was registered earlier with a
    // forwarding callback that calls routerDispatch once it's assigned.
    routerDispatch = router.dispatch;

    // Show welcome webview on activation — directs user to browser UI
    openWelcomeWebview(context);
    maybeNudgeWelcomeOpened(); // Issue 363 — trigger #8

    // Auto-initialize on every activation — no auth gate.
    // Auth only blocks VIEWING diagrams, never generating/initializing/syncing.
    // - No saved state: full initialize (scan workspace, build all diagrams)
    // - Saved state exists: load it, refresh views, then resync in background to pick up changes
    await snapshotStore.load();

    // Proactively check GitHub remote + auth for PR diff
    gitRemoteInfo = getGithubRemote(workspaceRoot);
    if (gitRemoteInfo) {
        vscode.authentication.getSession('github', ['repo'], { silent: true }).then(async session => {
            gitHubToken = session?.accessToken;
            outputChannel.appendLine(`[GitHub] Remote: ${gitRemoteInfo!.owner}/${gitRemoteInfo!.repo}, auth: ${gitHubToken ? 'yes' : 'no'}`);
            if (gitHubToken) {
                gitHubUser = await fetchGitHubUser(gitHubToken);
                outputChannel.appendLine(`[GitHub] User: ${gitHubUser ? '@' + gitHubUser.login : 'unknown'}`);
                // Re-broadcast workspace info so any already-connected browser
                // tab picks up the user details we just fetched.
                if (wsBridge?.hasClients()) wsBridge.broadcast(buildWorkspaceInfo());
            }
        }, () => {
            outputChannel.appendLine('[GitHub] Silent auth check failed');
        });
    }

    const savedFileCount = Object.keys(snapshotStore.getWorking().files).length;
    setTimeout(async () => {
        // ADR-034 Phase D #TDD-5 — in multi-repo mode the per-repo workers
        // already populated every per-repo state.db. Re-scanning the entire
        // workspace from the main thread duplicates that work, blocks the
        // wsBridge from binding (observed live: 42-repo workspace hung 20+
        // minutes iterating fixture files), and writes a redundant 412-file
        // workspace state.db that shadows the per-repo source of truth.
        // Skip the main-thread initialize() in multi-repo mode — handlers
        // route reads through `resolveStoreFor` to the per-repo store.
        if (workspaceIsMulti) {
            // BUGFIX (init-path): only take the "skip re-scan" fast-path when the
            // per-repo stores ACTUALLY hold content. An interrupted resync / a
            // VS Code kill mid-init can leave every per-repo store empty while
            // the workspace is still flagged multi-repo — skipping then
            // broadcasts a false "complete" and every graph request thrashes
            // on-demand main-thread rebuilds (runaway memory / OOM). Verify via
            // the same live per-repo stores the aggregator reads.
            const aggregatedApiCount = Object.keys(snapshotStore.getWorking().apiIndex ?? {}).length;
            const perRepoFileCounts = [...perRepoOrchestrators.values()].map((o) => {
                try { return Object.keys(o.getStore().getWorking().files).length; } catch { return 0; }
            });
            if (multiRepoStoresPopulated(aggregatedApiCount, perRepoFileCounts)) {
                outputChannel.appendLine(
                    `[AutoInit] multi-repo mode — skipping main-thread re-scan ` +
                    `(per-repo stores populated: ${aggregatedApiCount} apis / ${perRepoFileCounts.reduce((a, b) => a + b, 0)} files).`,
                );
                refreshViews();
                const liveCount = perRepoOrchestrators.size;
                statusBarItem.text = `$(symbol-structure) CodeAtlas: ${liveCount} repo${liveCount === 1 ? '' : 's'}`;
                if (wsBridge?.hasClients()) {
                    wsBridge.broadcast({ type: 'initProgress', phase: 'complete', progress: 1, message: '' });
                    wsBridge.broadcast(buildWorkspaceInfo());
                    wsBridge.broadcast(buildExplorerData());
                }
                panelManager.broadcastMessage({ type: 'initProgress', phase: 'complete', progress: 1, message: '' });
                return;
            }
            // Per-repo stores are empty — rebuild via the DISTRIBUTED workspace
            // orchestrator (per-repo runners + atomic baseline rotation), NOT the
            // monolithic single-store path that hangs on large workspaces.
            outputChannel.appendLine(
                `[AutoInit] multi-repo per-repo stores empty (interrupted init?) — rebuilding via workspace orchestrator`,
            );
            if (wsBridge?.hasClients()) {
                wsBridge.broadcast({ type: 'initProgress', phase: 'resync', progress: 0.05, message: 'Rebuilding workspace…' });
            }
            panelManager.broadcastMessage({ type: 'initProgress', phase: 'resync', progress: 0.05, message: 'Rebuilding workspace…' });
            try {
                await workspaceOrchestrator.resync();
            } catch (err: any) {
                outputChannel.appendLine(`[AutoInit] workspace rebuild failed: ${err?.message ?? err}`);
            }
            refreshViews();
            const rebuiltCount = perRepoOrchestrators.size;
            statusBarItem.text = `$(symbol-structure) CodeAtlas: ${rebuiltCount} repo${rebuiltCount === 1 ? '' : 's'}`;
            if (wsBridge?.hasClients()) {
                wsBridge.broadcast({ type: 'initProgress', phase: 'complete', progress: 1, message: '' });
                wsBridge.broadcast(buildWorkspaceInfo());
                wsBridge.broadcast(buildExplorerData());
            }
            panelManager.broadcastMessage({ type: 'initProgress', phase: 'complete', progress: 1, message: '' });
            return;
        }
        if (savedFileCount === 0) {
            outputChannel.appendLine('[AutoInit] No saved state — running full initialization');
            // Issue #772: announce that work is starting BEFORE the command
            // kicks off, so the home page shows the progress strip instead
            // of `—` placeholders during the gap between workspace-ready
            // and the first `emitProgress` from inside `initialize()`.
            // The complete/error events from the command handler clear
            // this overlay.
            if (wsBridge?.hasClients()) {
                wsBridge.broadcast({ type: 'initProgress', phase: 'starting', progress: 0.01, message: 'Starting initialization…' });
            }
            panelManager.broadcastMessage({ type: 'initProgress', phase: 'starting', progress: 0.01, message: 'Starting initialization…' });
            vscode.commands.executeCommand('codeatlas.initializeWorkspaceVisuals');
        } else {
            outputChannel.appendLine(`[AutoInit] Loaded ${savedFileCount} files from saved state — resyncing in background`);
            refreshViews();
            // Background resync: picks up any file changes since last session
            try {
                statusBarItem.text = '$(loading~spin) CodeAtlas: Syncing...';
                // Issue #772: also surface the resync as in-flight so users
                // who reopen a large workspace see progress instead of
                // stale counts during the resync window.
                if (wsBridge?.hasClients()) {
                    wsBridge.broadcast({ type: 'initProgress', phase: 'resync', progress: 0.05, message: 'Checking for changes…' });
                }
                panelManager.broadcastMessage({ type: 'initProgress', phase: 'resync', progress: 0.05, message: 'Checking for changes…' });
                await syncOrchestrator.initialize();
                refreshViews();
                const freshL1 = buildMicroserviceGraphCached();
                panelManager.updatePanel('microservice:workspace', freshL1);
                const newFileCount = Object.keys(snapshotStore.getWorking().files).length;
                statusBarItem.text = `$(symbol-structure) CodeAtlas: ${newFileCount} files`;
                outputChannel.appendLine(`[AutoInit] Background resync complete — ${newFileCount} files`);
                // Update browser clients if connected
                if (wsBridge?.hasClients()) {
                    // Issue #772: signal resync complete so the home page
                    // progress strip dismisses and the populated counts
                    // render in place of the `…` placeholders.
                    wsBridge.broadcast({ type: 'initProgress', phase: 'complete', progress: 1, message: '' });
                    wsBridge.broadcast(buildWorkspaceInfo());
                    wsBridge.broadcast(buildExplorerData());
                }
                panelManager.broadcastMessage({ type: 'initProgress', phase: 'complete', progress: 1, message: '' });
                // Issue 405 root cause (2026-05-13): if a live-diff session
                // was opened by `loadStateAfterAuth → surfaceLiveWorkingDiff`
                // BEFORE this AutoInit's `clearAllFiles` ran, the captured
                // `gitDiffState.apiIndex` is a frozen snapshot of a stale
                // (possibly empty) apiIndex. Re-capture it now so every
                // handler that reads `gitDiffState.apiIndex` sees the
                // freshly-rebuilt apis.
                if (gitDiffState && gitDiffState.baseHash === 'baseline' && gitDiffState.headHash === 'working') {
                    const liveBaseline = snapshotStore.getBaseline();
                    const liveWorking = snapshotStore.getWorking();
                    // UX-64: refresh the workspace slot via the scoped helper.
                    setGitDiffStateScoped({
                        ...gitDiffState,
                        apiIndex: { ...(liveBaseline.apiIndex ?? {}), ...(liveWorking.apiIndex ?? {}) },
                        diffedGraphs: liveWorking.graphs,
                    });
                    outputChannel.appendLine(`[AutoInit] refreshed live gitDiffState.apiIndex post-init: ${Object.keys(gitDiffState.apiIndex).length} entries`);
                }
            } catch (err: any) {
                outputChannel.appendLine(`[AutoInit] Background resync failed: ${err?.message ?? err}`);
                statusBarItem.text = `$(symbol-structure) CodeAtlas: ${savedFileCount} files`;
                // Issue #772: clear the progress overlay on failure so
                // the home page returns to its non-loading state instead
                // of staying stuck on "Checking for changes…".
                if (wsBridge?.hasClients()) {
                    wsBridge.broadcast({ type: 'initProgress', phase: 'error', progress: 0, message: '' });
                }
                panelManager.broadcastMessage({ type: 'initProgress', phase: 'error', progress: 0, message: '' });
            }
        }
    }, 500);

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('codeatlas.openWelcome', () => {
            openWelcomeWebview(context);
            maybeNudgeWelcomeOpened(); // Issue 363 — trigger #8
        }),

        // Open CodeAtlas UI in standalone browser tab
        vscode.commands.registerCommand('codeatlas.openInBrowser', async () => {
            if (wsBridge) {
                const port = wsBridge.getPort();
                if (port === 0) {
                    // Server hasn't finished starting yet — wait for it
                    await wsBridgeReady;
                }
                const url = `http://localhost:${wsBridge.getPort()}`;
                analytics.track('browser_opened', { port: wsBridge.getPort() });
                vscode.env.openExternal(vscode.Uri.parse(url));
                clearStatusBarBadge(); // Issue 363 — user is viewing; clear unread marker
                outputChannel.appendLine(`[WsBridge] Opening browser at ${url}`);
            } else {
                analytics.track('browser_open_failed', { reason: 'bridge_not_started' });
                analytics.notification('browser_not_started', 'warning');
                vscode.window.showWarningMessage('CodeAtlas: Browser server not started.');
            }
        }),

        vscode.commands.registerCommand('codeatlas.initializeWorkspaceVisuals', async () => {
            // No auth gate — initialization runs freely. Auth only required for viewing diagrams.
            analytics.track('workspace_initialized');
            vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'CodeAtlas: Initializing...', cancellable: false },
                async () => {
                    statusBarItem.text = '$(loading~spin) CodeAtlas: Initializing...';
                    statusBarItem.backgroundColor = undefined;
                    // Clean slate: clear all in-memory state from previous sessions
                    handleClearGitDiff();
                    aiReviewResult = null;
                    clearReviewCache();
                    commentStore.clear();
                    changeLog.clear();
                    // #353: unified clear path — single FK-cascade DELETE on SQLite
                    // plus legacy-file cleanup. No more `rm -rf .codeatlas/`.
                    snapshotStore.clearAllFiles();
                    outputChannel.appendLine('[Initialize] Cleared SQLite store + legacy files before reinit');
                    try {
                        // HANG/OOM FIX — the manual re-init used to call the MONOLITHIC
                        // `syncOrchestrator.initialize()` unconditionally, which builds
                        // EVERY file into one store (polar: 3323 files / 27466 diagrams /
                        // 511MB) on the main thread → pegged the event loop for minutes and
                        // climbed toward OOM. Route multi-repo re-init through the SAME
                        // distributed `workspaceOrchestrator` the auto-init + resync use,
                        // then adapt its result to the display shape the code below expects.
                        const reinitMulti = detectedMultiRepo || workspaceIsMulti || perRepoOrchestrators.size > 0;
                        let result: any;
                        if (reinitMulti) {
                            // POOL-CLOSED FIX — the startup worker pool was closed after
                            // the initial init burst (memory), so the pool the
                            // workspaceOrchestrator captured at construction is dead. Spin
                            // up a FRESH live pool, attach it, run the distributed init,
                            // then detach + close. Without this every repo fails with
                            // "[WorkerPool] pool is closed; runTask rejected" and the L1
                            // renders "Indexing failed" for all repos.
                            const reinitPool = await makeTier2Pool();
                            workspaceOrchestrator.setTier2Pool(reinitPool); // fresh pool, or undefined → in-process fallback (never the stale closed one)
                            let wsInit: Awaited<ReturnType<typeof workspaceOrchestrator.initialize>>;
                            try {
                                wsInit = await workspaceOrchestrator.initialize();
                            } finally {
                                if (reinitPool) {
                                    try { await reinitPool.close(); } catch (err: any) {
                                        outputChannel.appendLine(`[Initialize] reinit pool close failed: ${err?.message ?? err}`);
                                    }
                                }
                                workspaceOrchestrator.setTier2Pool(undefined);
                            }
                            workspaceIsMulti = wsInit.mode === 'multi' && wsInit.repoCount > 1;
                            if (workspaceIsMulti) detectedMultiRepo = true;
                            let fileCount = 0, apiCount = 0, graphCount = 0;
                            for (const [, orch] of perRepoOrchestrators) {
                                try {
                                    const w: any = orch.getStore().getWorking();
                                    fileCount += Object.keys(w.files ?? {}).length;
                                    apiCount += Object.keys(w.apiIndex ?? {}).length;
                                    graphCount += Object.keys(w.graphs ?? {}).length;
                                } catch { /* skip repo */ }
                            }
                            result = {
                                fileCount, apiCount, graphCount, truncated: false,
                                durations: { total_ms: wsInit.totalDurationMs, scan_ms: 0, parse_ms: 0, build_ms: 0 },
                                parseFailures: undefined,
                            };
                            outputChannel.appendLine(`[Initialize] multi-repo re-init via distributed workspaceOrchestrator (${wsInit.repoCount} repos, ${wsInit.totalDurationMs}ms)`);
                        } else {
                            result = await syncOrchestrator.initialize();
                        }
                        refreshViews();
                        // Bug 4: aggressively clear any lingering diff state on every webview.
                        // handleClearGitDiff() ran before init started, but the webview may
                        // have stale graphs cached client-side. Re-broadcast here so every
                        // panel drops its diff overlay before we push the rebuilt graphs.
                        panelManager.broadcastMessage({ type: 'clearGitDiffContext' });
                        if (wsBridge?.hasClients()) {
                            wsBridge.broadcast({ type: 'clearGitDiffContext' });
                        }
                        // Push fresh L1 + feature graphs to all open panels
                        try {
                            const freshL1 = buildMicroserviceGraphCached();
                            panelManager.updatePanel('microservice:workspace', freshL1);
                            // Refresh feature graphs for each service
                            const working = snapshotStore.getWorking();
                            for (const serviceId of Object.keys(working.services ?? {})) {
                                const featureGraphId = `feature:${serviceId}`;
                                const featureGraph = working.graphs[featureGraphId];
                                if (featureGraph) panelManager.updatePanel(featureGraphId, featureGraph);
                            }
                            const wsFeature = working.graphs['feature:workspace'];
                            if (wsFeature) panelManager.updatePanel('feature:workspace', wsFeature);
                            // Bug 4: also push every other graph (api-list, sequence, file,
                            // flow) so any stale diff annotations the webview cached from a
                            // prior session are overwritten with the unchanged graphs.
                            // #355: streamed to keep memory bound on huge workspaces.
                            if (wsBridge?.hasClients()) {
                                forEachGraph(working.graphs, (gid, graph) => {
                                    wsBridge!.broadcast({ type: 'updateGraph', graphId: gid, graph });
                                });
                            }
                        } catch { /* ignore — panel may not be open */ }
                        statusBarItem.text = `$(symbol-structure) CodeAtlas: ${result.fileCount} files`;
                        outputChannel.appendLine(`[Initialize] Complete: ${result.fileCount} files, ${result.apiCount} APIs, ${result.graphCount} diagrams`);
                        vscode.commands.executeCommand('setContext', 'codeatlas:initialized', true);
                        analytics.track('initialize_completed', {
                            file_count: result.fileCount,
                            api_count: result.apiCount,
                            graph_count: result.graphCount,
                            truncated: result.truncated,
                            // INVARIANT (ADR-030): every long-running operation
                            // emits per-phase timing. Lets us validate that perf
                            // work (AST cache, cascade locality, etc.) actually
                            // moves the needle.
                            total_ms: result.durations.total_ms,
                            scan_ms: result.durations.scan_ms,
                            parse_ms: result.durations.parse_ms,
                            build_ms: result.durations.build_ms,
                        });
                        analytics.notification('initialize_complete', 'info', { file_count: result.fileCount });
                        vscode.window.showInformationMessage(
                            `CodeAtlas: Initialized ${result.fileCount} files, ${result.apiCount} APIs, ${result.graphCount} diagrams.`,
                            'Open in Browser', 'Open System Design'
                        ).then((choice) => {
                            analytics.notificationActionClicked('initialize_complete', choice ?? 'dismissed');
                            if (choice === 'Open System Design') {
                                vscode.commands.executeCommand('codeatlas.openMicroserviceDiagram');
                            } else if (choice === 'Open in Browser') {
                                vscode.commands.executeCommand('codeatlas.openInBrowser');
                            }
                        });
                        // 3.3.2: also surface the once-per-day "Open in Browser"
                        // nudge after a fresh init so users discover the
                        // localhost:7742 view (separate counter from the
                        // immediate post-init banner above).
                        maybeNudgeOpenInBrowser(result.graphCount, 'initialize');
                        // Push updated data to browser clients and ask them to go home
                        if (wsBridge?.hasClients()) {
                            // Clear progress overlay — signal init is done
                            wsBridge.broadcast({ type: 'initProgress', phase: 'complete', progress: 1, message: '' });
                            wsBridge.broadcast(buildWorkspaceInfo());
                            wsBridge.broadcast(buildExplorerData());
                            notifyBrowser('info', `Initialized ${result.fileCount} files, ${result.apiCount} APIs, ${result.graphCount} diagrams.`);
                        }
                        // Issue 105: Show aggregated parse failure warnings
                        if (result.parseFailures) {
                            for (const [ext, count] of Object.entries(result.parseFailures as Record<string, number>)) {
                                if (count > 3) {
                                    analytics.track('parse_failures_warned', { extension: ext, count });
                                    analytics.notification('parse_failures', 'warning', { extension: ext, count });
                                    vscode.window.showWarningMessage(
                                        `CodeAtlas: ${count} .${ext} files failed to parse. Some diagrams may be incomplete.`
                                    );
                                    notifyBrowser('warning', `${count} .${ext} files failed to parse — some diagrams may be incomplete.`);
                                }
                            }
                        }
                    } catch (err: any) {
                        statusBarItem.text = '$(error) CodeAtlas: Error';
                        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                        const msg = err?.message ?? String(err);
                        outputChannel.appendLine(`[Initialize] Fatal error: ${msg}`);
                        analytics.track('initialize_failed', { error: msg.slice(0, 200) });
                        analytics.notification('initialize_failed', 'error');
                        vscode.window.showErrorMessage(`CodeAtlas: Initialization failed — ${msg}. See Output > CodeAtlas for details.`);
                        // Clear progress overlay with error state
                        if (wsBridge?.hasClients()) {
                            wsBridge.broadcast({ type: 'initProgress', phase: 'error', progress: 0, message: `Failed: ${msg.slice(0, 100)}` });
                        }
                        notifyBrowser('error', `Initialization failed — ${msg}`);
                    }
                },
            );
        }),

        vscode.commands.registerCommand('codeatlas.resyncEverything', () => {
            analytics.track('workspace_resynced');
            vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'CodeAtlas: Re-syncing...', cancellable: false },
                async () => {
                    statusBarItem.text = '$(loading~spin) CodeAtlas: Syncing...';
                    // Clean slate: clear all in-memory state before full rebuild
                    handleClearGitDiff();
                    aiReviewResult = null;
                    clearReviewCache();
                    commentStore.clear();
                    changeLog.clear();
                    try {
                        // BUGFIX (init-path): in MULTI-repo mode do NOT run the
                        // monolithic `syncOrchestrator.resync()` — it clears the
                        // workspace store and re-scans every repo into ONE store
                        // (polar: ~19.6k graphs), then hangs in finalize/save
                        // (`setBaselineFromWorking`/`save`) so the `await` never
                        // resolves and the webview watchdog shows "stuck or
                        // failed". The distributed `workspaceOrchestrator.resync()`
                        // rebuilds each repo's OWN store via workers and rotates
                        // the aggregator baseline atomically — the same path that
                        // makes cold startup work. Single-repo keeps the direct
                        // orchestrator resync (no aggregator involved).
                        //
                        // Gate on `perRepoOrchestrators.size` (a live, always-
                        // current signal) rather than the module-scope
                        // `workspaceIsMulti` flag — that flag is reset to false
                        // at the top of every activate() pass and was observed
                        // false here (a re-activation between init and this
                        // command), which let the monolithic path run and hang.
                        const isMultiRepoWorkspace = detectedMultiRepo || workspaceIsMulti || perRepoOrchestrators.size > 0;
                        outputChannel.appendLine(`[Resync] path gate: detectedMulti=${detectedMultiRepo} workspaceIsMulti=${workspaceIsMulti} perRepoSize=${perRepoOrchestrators.size} → ${isMultiRepoWorkspace ? 'distributed' : 'monolithic'}`);
                        if (!isMultiRepoWorkspace) {
                            await syncOrchestrator.resync();
                        }
                        // ADR-034 Phase J (#795 — Phase J: Cross-repo diff propagation + workspace re-sync (ADR-034)) — in multi-repo mode the
                        // workspace orchestrator owns the aggregator's
                        // baseline-rotation step. Resync iterates per repo
                        // again, then rotates baseline if all succeed.
                        try {
                            const wsResult = await workspaceOrchestrator.resync();
                            outputChannel.appendLine(
                                `[Resync] workspace fan-out: ${Object.keys(wsResult.perRepoResyncs).length} repos, ` +
                                `aggregatorRotated=${wsResult.aggregatorRotated}, ` +
                                `failures=${wsResult.failures.length}`,
                            );
                        } catch (wsErr: any) {
                            outputChannel.appendLine(`[Resync] workspaceOrchestrator.resync failed (non-blocking): ${wsErr?.message ?? wsErr}`);
                        }
                        // Phase G follow-up — workspace state may have changed
                        // (per-repo diff fields refreshed after baseline rotation).
                        broadcastWorkspaceState();
                        refreshViews();
                        // Push fresh L1 graph to any open microservice panel
                        const freshL1 = buildMicroserviceGraphCached();
                        panelManager.updatePanel('microservice:workspace', freshL1);
                        const fileCount = Object.keys(snapshotStore.getWorking().files).length;
                        statusBarItem.text = `$(symbol-structure) CodeAtlas: ${fileCount} files`;
                        outputChannel.appendLine('[Resync] Complete. Baseline updated.');
                        analytics.track('resync_completed', { file_count: fileCount });
                        analytics.notification('resync_complete', 'info');
                        vscode.window.showInformationMessage('CodeAtlas: Re-sync complete. Baseline updated.');
                        if (wsBridge?.hasClients()) {
                            // Clear progress overlay — signal resync is done
                            wsBridge.broadcast({ type: 'initProgress', phase: 'complete', progress: 1, message: '' });
                            wsBridge.broadcast(buildWorkspaceInfo());
                            wsBridge.broadcast(buildExplorerData());
                        }
                        notifyBrowser('info', `Re-sync complete — ${fileCount} files. Baseline updated.`);
                    } catch (err: any) {
                        statusBarItem.text = '$(error) CodeAtlas: Error';
                        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                        const msg = err?.message ?? String(err);
                        outputChannel.appendLine(`[Resync] Fatal error: ${msg}`);
                        analytics.track('resync_failed', { error: msg.slice(0, 200) });
                        analytics.notification('resync_failed', 'error');
                        vscode.window.showErrorMessage(`CodeAtlas: Re-sync failed — ${msg}. See Output > CodeAtlas for details.`);
                        if (wsBridge?.hasClients()) {
                            wsBridge.broadcast({ type: 'initProgress', phase: 'error', progress: 0, message: `Failed: ${msg.slice(0, 100)}` });
                        }
                        notifyBrowser('error', `Re-sync failed — ${msg}`);
                    }
                },
            );
        }),

        // Issue #358 Row 7d (2026-06-07): the ten open-diagram commands
        // moved to `src/handlers/openDiagramCommands.ts`. Mechanical
        // extraction — behavior unchanged. The `open*` helpers stay in
        // this module because they touch panelManager + cluster registry
        // state that activate() owns; they're passed as deps so each
        // command can dispatch through them.
        ...registerOpenDiagramCommands({
            snapshotStore,
            workspaceRoot,
            routeDiagramToWelcome,
            openFileDiagramForPath,
            openFunctionFlowForPath,
            openFeatureDiagram,
            openApiListPanel,
            openMicroserviceDiagram,
            openMapDiagram,
            revealApiInSidebar,
            revealServiceInSidebar,
            revealClusterInSidebar,
        }),

        // Issue #358 Row 7b (2026-06-07): comment CRUD commands moved to
        // `src/handlers/commentCommands.ts`. Mechanical extraction —
        // behavior unchanged.
        ...registerCommentCommands({ commentStore, commentsProvider, snapshotStore }),

        vscode.commands.registerCommand('codeatlas.rebuildCurrentFile', () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const filePath = activeEditor.document.uri.fsPath.replace(workspaceRoot + '/', '');
                analytics.track('file_rebuilt', { file_path: filePath });
                syncOrchestrator.rebuildFile(activeEditor.document.uri.fsPath).then((result) => {
                    const ids = result.graphIds;
                    if (ids.length > 0) {
                        snapshotStore.save();
                        refreshViews();
                        vscode.window.showInformationMessage(`CodeAtlas: Rebuilt ${ids.length} diagrams.`);
                    }
                }).catch((err: any) => {
                    outputChannel.appendLine(`[rebuildCurrentFile] Error: ${err?.message ?? err}`);
                    vscode.window.showErrorMessage(`CodeAtlas: Rebuild failed. See Output > CodeAtlas.`);
                });
            }
        }),

        // Issue #358 Row 7f (2026-06-07): file-based export commands
        // moved to `src/handlers/exportFileCommands.ts`. Mechanical
        // extraction — behavior unchanged.
        ...registerExportFileCommands({ snapshotStore, workspaceRoot, notifyBrowser }),

        vscode.commands.registerCommand('codeatlas.toggleAutoUpdate', () => {
            const current = syncOrchestrator.isAutoUpdateEnabled();
            analytics.track('auto_update_toggled', { enabled: !current });
            syncOrchestrator.setAutoUpdate(!current);
            const newState = !current ? 'enabled' : 'disabled';
            vscode.window.showInformationMessage(`CodeAtlas: Auto-update ${newState}.`);
            notifyBrowser('info', `Auto-update ${newState}.`);
        }),

        // Sign out — invoked by the browser view's chip (runCommand
        // 'codeatlas.logout') and the auth-status tree item. Clears the stored
        // session, unbinds the analytics profile, stops the expiry timer, and
        // refreshes any open browser tabs so the chip flips back to "Sign in".
        // Features stay available while signed-out.
        vscode.commands.registerCommand('codeatlas.logout', () => {
            authService.clearSession();
            authExpiryNotified = true; // explicit sign-out — suppress the "session expired" prompt
            if (authExpiryTimer) { clearInterval(authExpiryTimer); authExpiryTimer = undefined; }
            void vscode.commands.executeCommand('setContext', 'codeatlas:authenticated', false);
            analytics.track('signed_out', { source: 'user' });
            analytics.setUser(null);
            broadcastWorkspaceInfo();
            void vscode.window.showInformationMessage('CodeAtlas: signed out.');
        }),

        // Issue #358 Row 7a (2026-06-07): the seven timeline / live
        // replay command registrations moved to
        // `src/handlers/replayCommands.ts`. Mechanical extraction —
        // behavior unchanged. The mutable closure state (gitDiffState,
        // liveReplayEnabled) is plumbed through as getters / setters so
        // each command observes the live value.
        ...registerReplayCommands({
            commitTimelineReplay,
            replayOrchestrator,
            wsBridge,
            workspaceRoot,
            // UX-64 Phase 2 — accept an optional scope so handlers that know
        // their `repoId` retrieve the per-repo session directly instead
        // of falling back to the workspace shim.
        getGitDiffState: (scope?: string) => gitDiffStates.get(scope) ?? gitDiffState,
            getLiveReplayEnabled: () => liveReplayEnabled,
            setLiveReplayEnabled: (v) => { liveReplayEnabled = v; },
            requireBrowserOrPromptWelcome,
            notifyBrowser,
        }),

        // Issue #358 Row 7c (2026-06-07): theme-toggle commands moved to
        // `src/handlers/themeCommands.ts`. Mechanical extraction —
        // behavior unchanged.
        ...registerThemeCommands({ context, panelManager, wsBridge }),

        // Issue #358 Row 7e (2026-06-07): the four explorer-filter
        // commands moved to `src/handlers/explorerSearchCommands.ts`.
        // DRY'd via a shared factory function — net behavior unchanged.
        ...registerExplorerSearchCommands({
            apiExplorerProvider,
            functionExplorerProvider,
            fileExplorerProvider,
            featureExplorerProvider,
        }),

        vscode.commands.registerCommand('codeatlas.copyApiRoute', (item: ApiTreeItem) => {
            if (item?.apiRecord) {
                const text = `${item.apiRecord.method} ${item.apiRecord.route}`;
                vscode.env.clipboard.writeText(text);
                vscode.window.showInformationMessage(`Copied: ${text}`);
            }
        }),

        // Issue #358 Row 7g (2026-06-07): the three git-diff entry
        // commands moved to `src/handlers/gitDiffCommands.ts`. Mechanical
        // extraction — behavior unchanged.
        ...registerGitDiffCommands({
            panelManager,
            outputChannel,
            handleRequestGitDiff,
            handleClearGitDiff,
            handleRequestPrDiff,
        }),

        vscode.commands.registerCommand('codeatlas.setOpenRouterApiKey', async () => {
            const provider = config.get<string>('llmProvider', 'openrouter');
            analytics.track('llm_api_key_setup_started', { provider });

            // Ollama: no key needed, just confirm configuration
            if (provider === 'ollama') {
                const endpoint = config.get<string>('llmEndpoint', '') || 'http://localhost:11434/v1/chat/completions';
                const model = config.get<string>('llmModel', 'llama3');
                llmNamingService.configure('', model, provider);
                analytics.track('llm_api_key_set', { provider, model });
                vscode.window.showInformationMessage(`CodeAtlas: Ollama configured (${endpoint}, model: ${model}).`);
                return;
            }

            // Custom: prompt for endpoint URL first
            if (provider === 'custom') {
                const endpoint = await vscode.window.showInputBox({
                    prompt: 'Enter your LLM endpoint URL',
                    placeHolder: 'http://localhost:8080/v1/chat/completions',
                    value: config.get<string>('llmEndpoint', ''),
                });
                if (endpoint !== undefined) {
                    await vscode.workspace.getConfiguration('codeatlas').update('llmEndpoint', endpoint, vscode.ConfigurationTarget.Global);
                }
                const key = await vscode.window.showInputBox({
                    prompt: 'Enter API key (leave empty if not required)',
                    password: true,
                    placeHolder: 'API key (optional)...',
                });
                if (key) {
                    await context.secrets.store('codeatlas.openRouterApiKey', key);
                }
                llmNamingService.configure(key ?? '', config.get<string>('llmModel'), provider);
                vscode.window.showInformationMessage('CodeAtlas: Custom LLM endpoint configured.');
                return;
            }

            // Standard providers: prompt for API key
            const placeholders: Record<string, string> = {
                openrouter: 'sk-or-...',
                openai: 'sk-...',
                anthropic: 'sk-ant-...',
            };
            const key = await vscode.window.showInputBox({
                prompt: `Enter your ${provider} API key`,
                password: true,
                placeHolder: placeholders[provider] ?? 'API key...',
            });
            if (key) {
                await context.secrets.store('codeatlas.openRouterApiKey', key);
                llmNamingService.configure(key, config.get<string>('llmModel'), provider);
                vscode.window.showInformationMessage(`CodeAtlas: ${provider} API key stored securely.`);
            }
        }),

        vscode.commands.registerCommand('codeatlas.showHealthReport', () => {
            const working = snapshotStore.getWorking();
            const health = working.health;
            if (!health) {
                analytics.track('health_report_unavailable');
                vscode.window.showInformationMessage('CodeAtlas: No health data available. Run Initialize Visuals first.');
                notifyBrowser('warning', 'No health data available. Run Initialize Visuals first.');
                return;
            }
            // ADR-030 / Gap 6: track health-report opens with severity counts
            // so we can tell if the feature is used + which categories
            // surface most often.
            const h: any = health;
            analytics.track('health_report_opened', {
                dead_fns: h?.deadFunctions?.length ?? 0,
                god_files: h?.godFiles?.length ?? 0,
                cycles: h?.cycles?.length ?? 0,
                high_coupling: h?.highCoupling?.length ?? 0,
                orphan_clusters: h?.orphanClusters?.length ?? 0,
            });
            const graphId = 'health:report';
            const healthGraph: DiagramGraph = {
                graphId,
                type: 'health',
                nodes: [],
                edges: [],
                anchors: {},
                meta: { health },
            };
            if (!panelManager.navigateActive(graphId, 'health', healthGraph, 'Health Report')) {
                routeDiagramToWelcome(graphId, 'health', healthGraph, 'Health Report');
            }
        }),

        // Issue 106: Impact analysis command — accessible from command palette and sidebar
        vscode.commands.registerCommand('codeatlas.analyzeImpact', (item?: any) => {
            // Impact overlay renders only in the browser; require a tab first.
            if (!requireBrowserOrPromptWelcome('Impact Analysis')) return;
            const working = snapshotStore.getWorking();
            // Determine which file to analyze: from sidebar item or active editor
            let filePath: string | undefined;
            if (item?.filePath) {
                filePath = item.filePath;
            } else if (item?.resourceUri) {
                filePath = vscode.workspace.asRelativePath(item.resourceUri);
            } else {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    filePath = vscode.workspace.asRelativePath(editor.document.uri);
                }
            }
            if (!filePath) {
                vscode.window.showInformationMessage('CodeAtlas: Select a file or function to analyze impact.');
                return;
            }
            const impact = analyzeImpact([filePath], working);
            const highlights = impact.impactedFunctions.map((f: any) => ({
                filePath: f.filePath,
                functionName: f.functionName,
                impactKind: f.impactKind,
            }));
            // Browser is the only consumer — broadcast both messages there.
            wsBridge?.broadcast({ type: 'clearHighlights' });
            wsBridge?.broadcast({ type: 'showImpact', impact });
            wsBridge?.broadcast({ type: 'highlightNodes', highlights });
            vscode.window.showInformationMessage(
                `CodeAtlas: Impact analysis found ${impact.impactedFunctions.length} affected function(s) for ${filePath}.`
            );
        }),

        vscode.commands.registerCommand('codeatlas.loadCoverage', () => {
            const coverage = loadCoverageData(workspaceRoot);
            if (!coverage) {
                vscode.window.showInformationMessage('CodeAtlas: No coverage data found. Run your test suite with coverage enabled first (e.g., npx vitest --coverage).');
                notifyBrowser('warning', 'No coverage data found. Run your test suite with coverage enabled first.');
                return;
            }
            const fileCount = Object.keys(coverage).length;
            // Store coverage in working snapshot meta for diagram rendering
            const working = snapshotStore.getWorking();
            (working as any).coverage = coverage;
            outputChannel.appendLine(`[Coverage] Loaded coverage for ${fileCount} files`);
            vscode.window.showInformationMessage(`CodeAtlas: Loaded test coverage for ${fileCount} files.`);
            notifyBrowser('info', `Loaded test coverage for ${fileCount} files.`);
        }),

        vscode.commands.registerCommand('codeatlas.search', async () => {
            const working = snapshotStore.getWorking();
            const items: vscode.QuickPickItem[] = [];
            // APIs
            for (const api of Object.values(working.apiIndex)) {
                items.push({ label: `$(link) ${api.method} ${api.route}`, description: api.filePath, detail: `API · ${api.handlerName}` });
            }
            // Files
            for (const fp of Object.keys(working.files)) {
                items.push({ label: `$(file) ${fp.split('/').pop()}`, description: fp, detail: 'File' });
            }
            // Clusters
            for (const cluster of Object.values(working.clusters ?? {})) {
                items.push({ label: `$(symbol-namespace) ${cluster.label}`, description: `${cluster.files.length} files`, detail: 'Cluster' });
            }
            // Services
            for (const svc of Object.values(working.services ?? {})) {
                items.push({ label: `$(server) ${svc.name}`, description: svc.technology, detail: 'Service' });
            }
            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Search APIs, files, clusters, services...',
                matchOnDescription: true,
                matchOnDetail: true,
            });
            if (!picked) return;
            const detail = picked.detail ?? '';
            if (detail.startsWith('API')) {
                const api = Object.values(working.apiIndex).find(a => `${a.method} ${a.route}` === picked.label?.replace('$(link) ', ''));
                if (api) vscode.commands.executeCommand('codeatlas.openSequenceForApi', api);
            } else if (detail === 'File') {
                const fp = picked.description ?? '';
                vscode.commands.executeCommand('codeatlas.openFileDiagramForPath', fp);
            } else if (detail === 'Cluster') {
                const label = picked.label?.replace('$(symbol-namespace) ', '') ?? '';
                const cluster = Object.values(working.clusters ?? {}).find(c => c.label === label);
                if (cluster) vscode.commands.executeCommand('codeatlas.openApiListForCluster', cluster);
            } else if (detail === 'Service') {
                const name = picked.label?.replace('$(server) ', '') ?? '';
                const svc = Object.values(working.services ?? {}).find(s => s.name === name);
                if (svc) vscode.commands.executeCommand('codeatlas.openFeatureDiagram', svc.id);
            }
        }),

        vscode.window.onDidChangeWindowState(async (state) => {
            if (state.focused && authService.getUser()) {
                // Refresh the stored token in the background; expiry no longer
                // gates features, but we want analytics user-binding to stay
                // accurate while the user remains signed in.
                const ok = await authService.checkAuth();
                if (!ok) triggerAuthExpiry();
            }
        }, undefined, context.subscriptions),
    );

    // Restore saved theme (if user previously switched to light)
    const savedTheme = context.globalState.get<'dark' | 'light'>('codeatlas.theme', 'dark');
    if (savedTheme !== 'dark') {
        panelManager.setTheme(savedTheme);
    }

}


/**
 * Verify a callback's `state` parameter matches what we stashed at
 * signin_started, then clear it (single-use). Returns true when the
 * round-trip is valid.
 *
 * - Missing stash → reject (no signin was initiated).
 * - Stale stash (>10 min) → reject + clear.
 * - Mismatched state → reject (clears anyway to invalidate replays).
 * - Match → clear and return true.
 */
function verifyAndConsumeAuthState(
    context: vscode.ExtensionContext,
    callbackState: string | null,
): boolean {
    const stored = context.globalState.get<{ token: string; expiresAt: number }>('codeatlas.authState');
    if (!stored) return false;
    // Always consume — single-use semantics, even on failure to invalidate replay attempts.
    void context.globalState.update('codeatlas.authState', undefined);
    if (Date.now() > stored.expiresAt) return false;
    if (!callbackState || stored.token !== callbackState) return false;
    return true;
}

/**
 * Called by the URI handler (editor flow) and the WS bridge `/auth/callback`
 * route (browser flow) after the user completes sign-in on codeatlas.live.
 * Returns `true` when the session was successfully established.
 */
async function handleLogin(
    token: string,
    userId: string,
    email: string,
    firstName: string | undefined,
    lastName: string | undefined,
    context: vscode.ExtensionContext,
): Promise<boolean> {
    const verifyErr = await authService.verifyToken(token);
    if (verifyErr !== null) {
        analytics.track('signin_failed', { reason: String(verifyErr).slice(0, 100) });
        analytics.notification('signin_failed', 'error', { reason: String(verifyErr).slice(0, 100) });
        vscode.window.showErrorMessage(`CodeAtlas: Login failed — ${verifyErr}. Please try again.`);
        return false;
    }
    authService.storeSession(token, userId, email, firstName, lastName);
    authExpiryNotified = false; // re-arm the expiry prompt for this new session
    await vscode.commands.executeCommand('setContext', 'codeatlas:authenticated', true);
    analytics.setUser(authService.getUser());
    analytics.track('signed_in', { source: 'fresh_login', email });
    void loadStateAfterAuth();
    startPeriodicAuthCheck(context);
    return true;
}

/**
 * Load snapshotStore state and wire up views after authentication is confirmed.
 * Safe to call multiple times — snapshotStore.load() is idempotent.
 */
async function loadStateAfterAuth(): Promise<void> {
    await snapshotStore.load();
    commentStore = new CommentStore(snapshotStore.getComments());
    commentsProvider.setComments(commentStore.getAll());
    // Restore persisted git diff session (if any). UX-64: route through
    // the scoped helper so the registry sees the restored session under
    // its `scopedRepo` (or `'workspace'`) key.
    const restored = gitDiffStore.load();
    if (restored) setGitDiffStateScoped(restored);
    vscode.commands.executeCommand('setContext', 'codeatlas:gitDiffActive', gitDiffState !== null);

    // 3.3.2: nudge users toward the browser view when a project loads with
    // diagrams already in place (auto-load path). Throttled to once / day.
    const loadedGraphCount = Object.keys(snapshotStore.getWorking().graphs ?? {}).length;
    if (loadedGraphCount > 0) {
        maybeNudgeOpenInBrowser(loadedGraphCount, 'autoload');
    }
    // Open-source-interest reminder on the autoload path (once/day, editor-only).
    maybeRemindOpenSourceInterest('autoload');

    // Bug 7 (live drift on reload): the persisted working snapshot may be
    // stale relative to disk if the user edited files while the extension
    // was inactive. Sync drifted files first so inline file/flow diffs
    // exist before the cascade runs.
    syncOrchestrator.syncDriftedFilesFromDisk().then(async (drifted) => {
        if (drifted.length > 0) {
            outputChannel.appendLine(`[loadStateAfterAuth] synced ${drifted.length} drifted file(s) from disk: ${drifted.join(', ')}`);
        }
        // INVARIANT: cascade inline file/flow annotations up through L3
        // sequences, L2b api-lists, and L2a/L1 cluster/service nodes.
        // ADR-020 / Issue 359 — routed through `enqueueCascade` so this
        // serializes against any concurrent rebuildFile or replay click.
        // Coalesces with other in-flight cascade requests.
        try {
            if (workingDiffersFromBaselineLive()) {
                const refreshedIds = await syncOrchestrator.enqueueCascade();
                const liveWorking = snapshotStore.getWorking();
                for (const gid of refreshedIds) {
                    const g = liveWorking.graphs[gid];
                    if (g) panelManager.updatePanel(gid, g);
                    if (g && wsBridge?.hasClients()) {
                        wsBridge.broadcast({ type: 'updateGraph', graphId: gid, graph: g });
                    }
                }
                // NOTE: we intentionally do NOT auto-enter the "Baseline → Working"
                // git-diff mode on load. That call only existed to surface the old
                // in-diagram AI Review button (removed — AI review is home-only now),
                // and on a fresh install it dropped System Design straight into the
                // blocking diff view, forcing a manual ✕ Reset before the diagram
                // cascade would respond to clicks. The cascade above still applies
                // the change badges; the diff toolbar is now opt-in via
                // Compare Commits / Branch Diff / Replay.
            }
        } catch (err: any) {
            outputChannel.appendLine(`[loadStateAfterAuth] live cascade failed: ${err?.message ?? err}`);
            analytics.track('cascade_error', { source: 'loadStateAfterAuth', error: String(err?.message ?? err).slice(0, 200) });
        }
    }).catch((err: any) => {
        outputChannel.appendLine(`[loadStateAfterAuth] drift sync failed: ${err?.message ?? err}`);
    });
    refreshViews();
}

/**
 * Bug 2/3/5: returns true when any tracked file's content differs between
 * baseline and working snapshots. Used to decide whether to auto-cascade
 * diff annotations and surface AI Review.
 */
function workingDiffersFromBaselineLive(): boolean {
    const baseline = snapshotStore.getBaseline();
    const working = snapshotStore.getWorking();
    const allPaths = new Set([...Object.keys(baseline.files ?? {}), ...Object.keys(working.files ?? {})]);
    for (const fp of allPaths) {
        const b = baseline.files?.[fp];
        const w = working.files?.[fp];
        if (!b || !w) return true;
        // Compare content hashes — both are populated by the rebuild path
        // and stay on the FileRecord. Avoids loading content into memory.
        if (b.hash !== w.hash) return true;
    }
    return false;
}


/**
 * Browser-nudge subsystem (Issue 363 — `state.json` written non-atomically). Replaces the legacy sign-in popup
 * with multi-trigger "your diagrams are ready, open localhost:7742" nudges.
 *
 * One global cooldown (24h, persisted) covers every source so the user
 * never sees more than one popup per day regardless of how many triggers
 * fire. The wsBridge-client gate skips the nudge when a browser tab is
 * already connected — no point poking someone who's actively viewing.
 *
 * Triggers wired:
 *   1. autoload                — auto-init on activate (existing)
 *   2. initialize              — Initialize Visuals complete (existing)
 *   3. periodic-6h             — 6-hour timer
 *   4. workspace-changed       — onDidChangeWorkspaceFolders
 *   5. focus-after-idle        — window regained focus after >2h away
 *   6. first-save              — first user save in this session
 *   7. (status-bar badge)      — passive ● indicator on L1 changes
 *   8. welcome-opened          — Getting Started panel opened
 *   9. git-diff-started        — Compare Commits flow finished
 */
const nudgeState = {
    firstSaveNudgedThisSession: false,
    welcomeNudgedThisSession: false,
    gitDiffNudgedThisSession: false,
    lastFocusedAt: Date.now(),
    /** Signature `<serviceCount>/<infraCount>` of the most recently observed L1. */
    lastL1Signature: '',
    /** True while the status-bar text carries the unread ● marker. */
    statusBarBadgeActive: false,
};
let periodicNudgeTimer: ReturnType<typeof setInterval> | null = null;

function currentWorkingGraphCount(): number {
    try {
        return Object.keys(snapshotStore.getWorking().graphs ?? {}).length;
    } catch {
        return 0;
    }
}

function maybeNudgeOpenInBrowser(graphCount: number, source: string): void {
    if (graphCount <= 0) return;
    if (!extensionContext) return;
    // Don't poke users who already have a browser tab connected — they're
    // already viewing the diagrams.
    if (wsBridge?.hasClients()) return;
    const KEY = 'codeatlas.lastOpenInBrowserNudge';
    const lastNudge = extensionContext.globalState.get<number>(KEY, 0);
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (Date.now() - lastNudge < oneDayMs) return;
    void extensionContext.globalState.update(KEY, Date.now());
    analytics.notification('open_in_browser_nudge', 'info', { source, graph_count: graphCount });
    vscode.window.showInformationMessage(
        `CodeAtlas: ${graphCount.toLocaleString()} diagrams ready. Open the system map in your browser at localhost:7742.`,
        'Open in Browser', 'Later'
    ).then((choice) => {
        analytics.notificationActionClicked('open_in_browser_nudge', choice ?? 'dismissed');
        if (choice === 'Open in Browser') {
            vscode.commands.executeCommand('codeatlas.openInBrowser');
        }
    });
}

/**
 * Once-per-day reminder to register interest in open-sourcing the CodeAtlas
 * visual engine. EDITOR-ONLY — this file's `activate()` never runs in the
 * standalone `@codeatlas/mcp` server. Shown to anyone not-yet-registered
 * (signed-out included, per product decision); the "Register interest" action
 * opens the dashboard, which deep-links back to `/oss-interest-registered` on
 * success so we stop reminding. Reuses the 24h throttle pattern above.
 */
function maybeRemindOpenSourceInterest(source: string): void {
    if (!extensionContext) return;
    const optOut = vscode.workspace.getConfiguration('codeatlas').get<boolean>('remindOpenSourceInterest') === false;
    const registered = extensionContext.globalState.get<boolean>('codeatlas.ossInterestRegistered', false);
    const lastShownMs = extensionContext.globalState.get<number>('codeatlas.lastOpenSourceReminder', 0);
    if (!shouldRemindOpenSource({ now: Date.now(), lastShownMs, registered, optOut })) return;
    void extensionContext.globalState.update('codeatlas.lastOpenSourceReminder', Date.now());
    analytics.track('oss_reminder_shown', { source });
    vscode.window.showInformationMessage(
        'CodeAtlas is weighing whether to open-source its visual engine — register your interest to help shape it.',
        'Register interest', "Don't remind me"
    ).then((choice) => {
        if (choice === 'Register interest') {
            analytics.track('oss_reminder_clicked', { source });
            // Open the dashboard home (the popup lives there) carrying return
            // params so the dashboard can deep-link back on successful register.
            const ext = extensionContext!.extension.id;
            const scheme = vscode.env.uriScheme;
            const url = `https://www.codeatlas.live/?source=${encodeURIComponent(ext)}&scheme=${encodeURIComponent(scheme)}#oss-interest`;
            void vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
            analytics.track('oss_reminder_dismissed', { source, choice: choice ?? 'dismissed' });
            if (choice === "Don't remind me") {
                void extensionContext!.globalState.update('codeatlas.ossInterestRegistered', true);
            }
        }
    });
}

/** Trigger #6 — fire on the first file save in a given session, then never again. */
function maybeNudgeFirstSave(): void {
    if (nudgeState.firstSaveNudgedThisSession) return;
    nudgeState.firstSaveNudgedThisSession = true;
    maybeNudgeOpenInBrowser(currentWorkingGraphCount(), 'first-save');
}

/** Trigger #8 — fire when the user opens the Getting Started panel. */
function maybeNudgeWelcomeOpened(): void {
    if (nudgeState.welcomeNudgedThisSession) return;
    nudgeState.welcomeNudgedThisSession = true;
    maybeNudgeOpenInBrowser(currentWorkingGraphCount(), 'welcome-opened');
}

/** Trigger #9 — fire when a Compare Commits flow successfully starts. */
function maybeNudgeGitDiffStarted(): void {
    if (nudgeState.gitDiffNudgedThisSession) return;
    nudgeState.gitDiffNudgedThisSession = true;
    maybeNudgeOpenInBrowser(currentWorkingGraphCount(), 'git-diff-started');
}

/**
 * Trigger #7 — passive status-bar badge. Whenever the L1 graph's
 * service+infra signature changes vs the last time we looked, append ●
 * to the status-bar text. Cleared on `codeatlas.openInBrowser`,
 * `codeatlas.openMicroserviceDiagram`, and on first wsBridge client
 * connect — i.e., as soon as the user views the diagram.
 */
function maybeUpdateL1Badge(): void {
    try {
        const working = snapshotStore.getWorking();
        const services = Object.keys(working.services ?? {}).length;
        const l1 = working.graphs['microservice:workspace'];
        if (!l1) return;
        const infraCount = l1.nodes.filter((n: any) => n.meta?.infra === true).length;
        const sig = `${services}/${infraCount}`;
        if (nudgeState.lastL1Signature && nudgeState.lastL1Signature !== sig) {
            nudgeState.statusBarBadgeActive = true;
            if (!statusBarItem.text.includes('●')) {
                statusBarItem.text = `${statusBarItem.text} ●`;
                statusBarItem.tooltip = 'CodeAtlas — System Design changed (services or infra). Click to view.';
            }
        }
        nudgeState.lastL1Signature = sig;
    } catch {
        // Defensive: never let badge bookkeeping crash a rebuild path.
    }
}

function clearStatusBarBadge(): void {
    if (!nudgeState.statusBarBadgeActive) return;
    nudgeState.statusBarBadgeActive = false;
    statusBarItem.text = statusBarItem.text.replace(/\s*●\s*$/, '');
    statusBarItem.tooltip = 'CodeAtlas — Click to open System Design diagram';
}

/**
 * Wire up the time-based and event-based nudge triggers. Called once
 * during `activate()` after wsBridge / snapshotStore / statusBarItem
 * are ready.
 */
function startBrowserNudgeTriggers(context: vscode.ExtensionContext): void {
    // #3 — every 6 hours, while a workspace is open and graphs > 0
    const sixHoursMs = 6 * 60 * 60 * 1000;
    periodicNudgeTimer = setInterval(() => {
        maybeNudgeOpenInBrowser(currentWorkingGraphCount(), 'periodic-6h');
        // Open-source-interest reminder rides the same timer; its own 24h
        // throttle keeps it to at most once per day.
        maybeRemindOpenSourceInterest('periodic-6h');
    }, sixHoursMs);
    context.subscriptions.push({
        dispose: () => {
            if (periodicNudgeTimer) clearInterval(periodicNudgeTimer);
            periodicNudgeTimer = null;
        },
    });

    // #4 — workspace folder added/changed. Auto-init runs on the new
    // folder; defer 5s so the count reflects the rebuilt graphs.
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            setTimeout(
                () => maybeNudgeOpenInBrowser(currentWorkingGraphCount(), 'workspace-changed'),
                5000,
            );
        }),
    );

    // #5 — window regained focus after >2h idle. Separate listener from
    // the auth-refresh `onDidChangeWindowState` to keep concerns split.
    context.subscriptions.push(
        vscode.window.onDidChangeWindowState((state) => {
            if (!state.focused) {
                nudgeState.lastFocusedAt = Date.now();
                return;
            }
            const idleMs = Date.now() - nudgeState.lastFocusedAt;
            const twoHoursMs = 2 * 60 * 60 * 1000;
            if (idleMs >= twoHoursMs) {
                maybeNudgeOpenInBrowser(currentWorkingGraphCount(), 'focus-after-idle');
            }
            nudgeState.lastFocusedAt = Date.now();
        }),
    );
}

function startPeriodicAuthCheck(context: vscode.ExtensionContext): void {
    // Re-arm a SINGLE timer — handleLogin calls this on every fresh sign-in, so
    // clear any prior one first to avoid stacking intervals (each of which would
    // otherwise fire its own expiry prompt).
    if (authExpiryTimer) clearInterval(authExpiryTimer);
    authExpiryTimer = authService.startPeriodicCheck(() => triggerAuthExpiry());
    if (!authExpiryDisposeRegistered) {
        context.subscriptions.push({ dispose: () => { if (authExpiryTimer) clearInterval(authExpiryTimer); } });
        authExpiryDisposeRegistered = true;
    }
}

/**
 * Called when a periodic or focus re-check finds the token has expired. Features
 * stay available — we unbind the user's profile from analytics and offer a
 * one-click re-login. Fires AT MOST ONCE per expiry: once the session is cleared
 * `checkAuth()` returns false forever, so without the guard + timer-stop below
 * the periodic check would re-prompt every interval, and the focus handler could
 * double-fire alongside the timer.
 */
function triggerAuthExpiry(): void {
    if (authExpiryNotified) return;
    authExpiryNotified = true;
    if (authExpiryTimer) { clearInterval(authExpiryTimer); authExpiryTimer = undefined; }
    authService.clearSession();
    analytics.track('session_expired');
    analytics.setUser(null);
    // Update any open browser tabs so the sign-in chip reappears.
    broadcastWorkspaceInfo();
    void vscode.window.showInformationMessage(
        'CodeAtlas: your session expired. Sign in again to sync your account.',
        'Sign in'
    ).then((choice) => {
        analytics.notificationActionClicked('session_expired', choice ?? 'dismissed');
        if (choice === 'Sign in') startSignInFlow('session-expired');
    });
}

/**
 * Start the Clerk sign-in flow from the editor: open the dashboard `/auth`
 * bridge in the browser. On success the dashboard redirects to the local WS
 * bridge `/auth/callback` (browser tab) or the editor deep-link, both of which
 * land in `handleLogin`. Re-surfaced (3.3.x removed the sidebar sign-in) so the
 * user can (re)authenticate + see their account details.
 */
function startSignInFlow(source: string): void {
    analytics.track('sign_in_started', { source });
    const scheme = vscode.env.uriScheme;
    const ext = extensionContext?.extension.id ?? 'codeatlaslive.codeatlas-live';
    const port = wsBridge?.getPort?.();
    const params = new URLSearchParams({ source: ext, scheme });
    if (port) params.set('port', String(port)); // browser-mode callback to the WS bridge
    // Issue 371 / ADR-021: stash a single-use CSRF nonce and pass it as `state`.
    // The dashboard echoes it back on the editor-mode deep-link, and the `/auth`
    // URI handler verifies it via verifyAndConsumeAuthState. (Browser-mode goes
    // through /auth/callback which does its own token verify and ignores state.)
    if (extensionContext) {
        const nonce = randomUUID();
        void extensionContext.globalState.update('codeatlas.authState', {
            token: nonce,
            expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
        });
        params.set('state', nonce);
    }
    void vscode.env.openExternal(vscode.Uri.parse(`${CLERK_AUTH_PAGE_URL}?${params.toString()}`));
}

function refreshViews(): void {
    const baseline = snapshotStore.getBaseline();
    const working = snapshotStore.getWorking();

    // Update API explorer with diff coloring
    const baselineApis = Object.values(baseline.apiIndex);
    const workingApis = Object.values(working.apiIndex);
    const baselineFiles = Object.values(baseline.files);
    const workingFiles = Object.values(working.files);
    apiExplorerProvider.setData(baselineApis, workingApis, baselineFiles, workingFiles);

    // Update File and Function explorers with diff coloring
    fileExplorerProvider.setData(baselineFiles, workingFiles);
    functionExplorerProvider.setData(baselineFiles, workingFiles, snapshotStore.getWorking().apiIndex);

    // Update comments
    commentsProvider.setComments(commentStore.getAll());

    // Update changed items. #355: stream rather than materialize the full
    // graphs map; pre-filter to graphs that actually carry diff'd nodes so
    // the tree view only receives the subset it would render anyway.
    const changedGraphsMap = new Map<string, DiagramGraph>();
    forEachGraph(working.graphs, (gid, g) => {
        if (g.nodes.some(n => n.diff && n.diff !== 'unchanged')) {
            changedGraphsMap.set(gid, g);
        }
    });
    changedItemsProvider.setChangedGraphs(changedGraphsMap);

    // Update feature explorer
    const baselineClusters = Object.values(baseline.clusters ?? {});
    const workingClusters = Object.values(working.clusters ?? {});
    featureExplorerProvider.setData(baselineClusters, workingClusters);

    // Update microservice explorer
    const baselineServices = Object.values(baseline.services ?? {});
    const workingServices = Object.values(working.services ?? {});
    microserviceExplorerProvider.setData(baselineServices, workingServices, workingApis);
}

/**
 * Populate all explorer sidebar views using data from the two git diff snapshots.
 * Called after a successful `buildCommitDiffGraphs()` run.
 */
function refreshViewsForGitDiff(headSnapshot: Snapshot, baseSnapshot: Snapshot): void {
    const baseApis = Object.values(baseSnapshot.apiIndex);
    const headApis = Object.values(headSnapshot.apiIndex);
    const baseFiles = Object.values(baseSnapshot.files);
    const headFiles = Object.values(headSnapshot.files);

    apiExplorerProvider.setData(baseApis, headApis, baseFiles, headFiles);
    fileExplorerProvider.setData(baseFiles, headFiles);
    functionExplorerProvider.setData(baseFiles, headFiles, headSnapshot.apiIndex);
    commentsProvider.setComments(commentStore.getAll());
    changedItemsProvider.setChangedGraphs(new Map(Object.entries(gitDiffState?.diffedGraphs ?? {})));

    const baseClusters = Object.values(baseSnapshot.clusters ?? {});
    const headClusters = Object.values(headSnapshot.clusters ?? {});
    featureExplorerProvider.setData(baseClusters, headClusters);

    const baseServices = Object.values(baseSnapshot.services ?? {});
    const headServices = Object.values(headSnapshot.services ?? {});
    microserviceExplorerProvider.setData(baseServices, headServices, headApis);
}

function buildFileGraphForPath(filePath: string): DiagramGraph | undefined {
    const graphId = `file:${filePath}`;
    let graph = snapshotStore.getWorking().graphs[graphId];
    if (!graph) {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const root = workspaceFolders?.[0]?.uri.fsPath || '';
            const fullPath = resolveUnderRoot(root, filePath);
            const code = fs.readFileSync(fullPath, 'utf-8');
            graph = buildFileGraph(code, filePath);
            snapshotStore.updateWorkingGraph(graph.graphId, graph);
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            outputChannel.appendLine(`[openFileDiagram] Failed to build for ${filePath}: ${msg}`);
            vscode.window.showErrorMessage(`CodeAtlas: Failed to build file diagram: ${msg}`);
            return undefined;
        }
    }
    return graph;
}

function openFileDiagramForPath(filePath: string): void {
    const graph = buildFileGraphForPath(filePath);
    if (!graph) return;
    const label = filePath.split('/').pop() ?? filePath;
    const graphId = `file:${filePath}`;
    if (!panelManager.navigateActive(graphId, 'file', graph, label)) {
        routeDiagramToWelcome(graphId, 'file', graph, label);
    }
}

/**
 * Issue 108: Resolve the service name for a file path in multi-service workspaces.
 * Returns "serviceName > " prefix when 2+ services detected, empty string otherwise.
 */
function servicePrefix(filePath: string): string {
    const services = snapshotStore.getWorkingServices();
    const serviceList = Object.values(services);
    if (serviceList.length < 2) return '';
    for (const svc of serviceList) {
        if (filePath.startsWith(svc.rootPath + '/') || filePath.startsWith(svc.rootPath)) {
            return `${svc.name} > `;
        }
    }
    return '';
}

function openFileDiagramInPanel(filePath: string, sourcePanelId: string): void {
    const graph = buildFileGraphForPath(filePath);
    if (!graph) return;
    const label = servicePrefix(filePath) + (filePath.split('/').pop() ?? filePath);
    panelManager.navigatePanel(sourcePanelId, `file:${filePath}`, 'file', graph, label);
}

function buildFlowGraphForPath(filePath: string, functionName: string): DiagramGraph | undefined {
    const graphId = `flow:${filePath}:${functionName}`;
    let graph = snapshotStore.getWorking().graphs[graphId];
    if (!graph) {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const root = workspaceFolders?.[0]?.uri.fsPath || '';
            const fullPath = resolveUnderRoot(root, filePath);
            const code = fs.readFileSync(fullPath, 'utf-8');
            const analysis = collectTopLevelEntities(code, filePath);
            let fn = analysis.funcs.get(functionName);

            // Handle anonymous route handlers (e.g., anonymous@GET:/articles)
            // These are arrow functions passed to router.get/post/etc — not in analysis.funcs
            if (!fn && functionName.startsWith('anonymous@')) {
                const routeMatch = functionName.match(/^anonymous@(\w+):(.+)$/);
                if (routeMatch) {
                    const [, method, route] = routeMatch;
                    // Find the router.method('/route', handler) call and extract the handler callback
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
                            const bodyBraceIdx = routeIdx + (cbMatch.index ?? 0) + cbMatch[0].length - 1;
                            let depth = 1, bodyEnd = bodyBraceIdx + 1;
                            for (let i = bodyEnd; i < code.length; i++) {
                                if (code[i] === '{') depth++;
                                else if (code[i] === '}') { depth--; if (depth === 0) { bodyEnd = i + 1; break; } }
                            }
                            const fnExprStart = routeIdx + (cbMatch.index ?? 0) + cbMatch[0].length - cbMatch[1].length;
                            if (bodyEnd > fnExprStart) {
                                const rawFn = code.slice(fnExprStart, bodyEnd);
                                const wrappedFn = `const __handler = ${rawFn}`;
                                graph = buildFlowGraph(wrappedFn, filePath, functionName, undefined, undefined, fnExprStart);
                                snapshotStore.updateWorkingGraph(graph.graphId, graph);
                                fn = { node: { start: fnExprStart, end: bodyEnd } } as any;
                            }
                        }
                    }
                }
            }

            if (fn?.node && !graph) {
                const fnCode = code.slice(fn.node.start, fn.node.end);
                const baselineFile = snapshotStore.getBaseline().files[filePath];
                const baselineFn = baselineFile?.symbols?.functions?.find(
                    f => f.name === functionName
                );
                const baselineContent = baselineFile
                    ? snapshotStore.getFileContent('baseline', filePath)
                    : undefined;
                const oldFnCode = baselineFn
                    ? (baselineContent && baselineFn.span.start < baselineFn.span.end
                        ? baselineContent.slice(baselineFn.span.start, baselineFn.span.end)
                        : `${baselineFn.signature} {\n${baselineFn.bodyText}\n}`)
                    : undefined;
                graph = buildFlowGraph(fnCode, filePath, functionName, oldFnCode, undefined, fn.node.start ?? 0);
                snapshotStore.updateWorkingGraph(graph.graphId, graph);
            } else if (!graph) {
                vscode.window.showWarningMessage(`CodeAtlas: Function "${functionName}" not found in ${filePath}.`);
                notifyBrowser('warning', `Function "${functionName}" not found in ${filePath}.`);
                return undefined;
            }
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            outputChannel.appendLine(`[openFunctionFlow] Failed to build for ${functionName} in ${filePath}: ${msg}`);
            vscode.window.showErrorMessage(`CodeAtlas: Failed to build flow for "${functionName}": ${msg}`);
            // Case C parity: browser/standalone clients can't see the native
            // toast above — mirror the notifyBrowser its sibling handler sends.
            notifyBrowser('error', `Failed to build flow for "${functionName}": ${msg}`);
            return undefined;
        }
    }
    return graph;
}

/**
 * Build a flow graph for a non-JS function using tree-sitter, then navigate to it.
 * This is async because tree-sitter parsing is async.
 */
async function buildAndNavigateNonJsFlow(filePath: string, functionName: string, sourcePanelId: string): Promise<void> {
    try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const root = workspaceFolders?.[0]?.uri.fsPath || '';
        const fullPath = resolveUnderRoot(root, filePath);
        const language = detectLanguage(fullPath);
        if (!language) {
            // Case C: surface why the drill produced nothing instead of a silent no-op.
            notifyBrowser('info', `No flow view for "${functionName}" — ${filePath} isn't a supported source language.`);
            return;
        }

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
                    const graph = buildFlowGraphFromBody(bodyNode, code, filePath, functionName);
                    snapshotStore.updateWorkingGraph(graph.graphId, graph);
                    const label = `Flow: ${functionName}`;
                    panelManager.navigatePanel(sourcePanelId, graph.graphId, 'flow', graph, label);
                    return;
                }
            }
        }

        if (!fn?.node) {
            vscode.window.showWarningMessage(`CodeAtlas: Function "${functionName}" not found in ${filePath}.`);
            return;
        }

        const baselineFile = snapshotStore.getBaseline().files[filePath];
        const baselineFn = baselineFile?.symbols?.functions?.find(f => f.name === functionName);
        const graph = buildFlowGraphFromNode(fn.node, code, filePath, functionName, baselineFn?.bodyText);
        snapshotStore.updateWorkingGraph(graph.graphId, graph);
        const label = `Flow: ${functionName}`;
        panelManager.navigatePanel(sourcePanelId, graph.graphId, 'flow', graph, label);
    } catch (err: any) {
        outputChannel.appendLine(`[openFunctionFlow] Non-JS failed for ${functionName} in ${filePath}: ${err?.message ?? err}`);
        vscode.window.showErrorMessage(`CodeAtlas: Failed to build flow for "${functionName}": ${err?.message ?? err}`);
    }
}

function openFunctionFlowForPath(filePath: string, functionName: string): void {
    // Check cache first
    const cached = snapshotStore.getWorking().graphs[`flow:${filePath}:${functionName}`];
    if (cached) {
        const label = `Flow: ${functionName}`;
        if (!panelManager.navigateActive(cached.graphId, 'flow', cached, label)) {
            routeDiagramToWelcome(cached.graphId, 'flow', cached, label);
        }
        return;
    }

    // Non-JS/TS: async tree-sitter build then open in active/new panel
    // Issue 253: JS/TS use Babel (supports anonymous handlers), not tree-sitter
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath || '';
    const fullPath = resolveUnderRoot(root, filePath);
    const detectedLang = detectLanguage(fullPath);
    if (detectedLang && detectedLang !== 'javascript' && detectedLang !== 'typescript') {
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
                            snapshotStore.updateWorkingGraph(g.graphId, g);
                            const label = `Flow: ${functionName}`;
                            routeDiagramToWelcome(g.graphId, 'flow', g, label);
                            return;
                        }
                    }
                }

                if (!fn?.node) { vscode.window.showWarningMessage(`CodeAtlas: Function "${functionName}" not found.`); return; }
                const baselineFn = snapshotStore.getBaseline().files[filePath]?.symbols?.functions?.find(f => f.name === functionName);
                const g = buildFlowGraphFromNode(fn.node, code, filePath, functionName, baselineFn?.bodyText);
                snapshotStore.updateWorkingGraph(g.graphId, g);
                const label = `Flow: ${functionName}`;
                routeDiagramToWelcome(g.graphId, 'flow', g, label);
            } catch (err: any) {
                outputChannel.appendLine(`[openFunctionFlow] ${err?.message ?? err}`);
            }
        })();
        return;
    }

    const graph = buildFlowGraphForPath(filePath, functionName);
    if (!graph) return;
    const label = `Flow: ${functionName}`;
    const graphId = `flow:${filePath}:${functionName}`;
    if (!panelManager.navigateActive(graphId, 'flow', graph, label)) {
        routeDiagramToWelcome(graphId, 'flow', graph, label);
    }
}

function openFunctionFlowInPanel(filePath: string, functionName: string, sourcePanelId: string): void {
    // Check snapshot cache first — avoids re-parsing
    const cached = snapshotStore.getWorking().graphs[`flow:${filePath}:${functionName}`];
    if (cached) {
        const label = servicePrefix(filePath) + `Flow: ${functionName}`;
        panelManager.navigatePanel(sourcePanelId, cached.graphId, 'flow', cached, label);
        return;
    }

    // Issue 253: Non-JS/TS files use tree-sitter; JS/TS use Babel (supports anonymous handlers)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath || '';
    const fullPath = resolveUnderRoot(root, filePath);
    const detLang = detectLanguage(fullPath);
    if (detLang && detLang !== 'javascript' && detLang !== 'typescript') {
        buildAndNavigateNonJsFlow(filePath, functionName, sourcePanelId);
        return;
    }

    const graph = buildFlowGraphForPath(filePath, functionName);
    if (!graph) return;
    const label = `Flow: ${functionName}`;
    panelManager.navigatePanel(sourcePanelId, `flow:${filePath}:${functionName}`, 'flow', graph, label);
}

/**
 * Open the Feature/Domain diagram scoped to a service, or the workspace-wide view.
 */
function buildFeatureGraphForService(serviceId?: string): DiagramGraph | undefined {
    try {
        const working = snapshotStore.getWorking();
        const baseline = snapshotStore.getBaseline();
        const graph = buildFeatureGraph(working, baseline, serviceId);
        snapshotStore.updateWorkingGraph(graph.graphId, graph);
        return graph;
    } catch (err: any) {
        const graphId = serviceId ? `feature:${serviceId}` : 'feature:workspace';
        outputChannel.appendLine(`[openFeatureDiagram] Build failed for ${graphId}: ${err?.message ?? err}`);
        vscode.window.showErrorMessage(`CodeAtlas: Failed to build feature diagram. See Output > CodeAtlas.`);
        return undefined;
    }
}

function openFeatureDiagram(serviceId?: string): void {
    const graph = buildFeatureGraphForService(serviceId);
    if (!graph) return;
    const label = serviceId ? `Features: ${serviceId.replace('service:', '')}` : 'Feature Areas';
    const graphId = serviceId ? `feature:${serviceId}` : 'feature:workspace';
    if (!panelManager.navigateActive(graphId, 'feature', graph, label)) {
        routeDiagramToWelcome(graphId, 'feature', graph, label);
    }
}

function openFeatureDiagramInPanel(serviceId: string | undefined, sourcePanelId: string): void {
    const graph = buildFeatureGraphForService(serviceId);
    if (!graph) return;
    const label = serviceId ? `Features: ${serviceId.replace('service:', '')}` : 'Feature Areas';
    const graphId = serviceId ? `feature:${serviceId}` : 'feature:workspace';
    panelManager.navigatePanel(sourcePanelId, graphId, 'feature', graph, label);
}

/**
 * Build an api-list DiagramGraph from a FeatureCluster.
 * Extracts subsystems from sequence diagram participants outside the cluster.
 */
function buildApiListGraph(cluster: FeatureCluster, working: Snapshot, baseline: Snapshot): DiagramGraph {
    const clusterFileSet = new Set(cluster.files);
    const subsystemMap = new Map<string, { label: string; kind: string; filePath?: string }>();

    // Compute per-API diff status by comparing baseline ↔ working apiIndex
    // and checking whether the corresponding sequence graph has any changed nodes/edges.
    const apisWithDiff: ApiRecord[] = (cluster.apisInCluster ?? []).map((api) => {
        const seqGraph = working.graphs[`sequence:${api.filePath}:${api.handlerName}`];

        // Collect subsystem participants from this API's sequence graph
        if (seqGraph) {
            for (const node of seqGraph.nodes) {
                if (node.type !== 'participant') continue;
                if (node.label === 'API Client') continue;
                const anchor = node.anchor ?? seqGraph.anchors[node.id];
                if (anchor?.filePath && clusterFileSet.has(anchor.filePath)) continue;
                const kind = (node.subtitle ?? '«module»').replace(/«|»/g, '').trim();
                subsystemMap.set(node.label, { label: node.label, kind, filePath: anchor?.filePath });
            }
        }

        // Determine diff status
        const diff = computeApiDiff(
            api,
            baseline.apiIndex,
            seqGraph,
            baseline.files[api.filePath]?.hash,
            working.files[api.filePath]?.hash,
        );

        return { ...api, diff };
    });

    // Also surface APIs that existed in baseline but were removed from this cluster
    for (const [apiId, api] of Object.entries(baseline.apiIndex)) {
        if (api.filePath && clusterFileSet.has(api.filePath) && !working.apiIndex[apiId]) {
            apisWithDiff.push({ ...api, diff: 'deleted' as const });
        }
    }

    return {
        graphId: `api-list:${cluster.id}`,
        type: 'api-list',
        nodes: [],
        edges: [],
        anchors: {},
        meta: {
            clusterId: cluster.id,
            clusterLabel: cluster.label,
            serviceId: cluster.serviceId,
            apis: apisWithDiff.filter((a: any) => !['SCREEN', 'NAV_ROUTE', 'NETWORK', 'DI_BINDING'].includes(a.method)),
            screens: apisWithDiff.filter((a: any) => a.method === 'SCREEN'),
            navRoutes: apisWithDiff.filter((a: any) => a.method === 'NAV_ROUTE'),
            networkCalls: apisWithDiff.filter((a: any) => a.method === 'NETWORK'),
            diBindings: apisWithDiff.filter((a: any) => a.method === 'DI_BINDING'),
            files: cluster.files,
            entryPoints: cluster.entryPoints,
            subsystems: [...subsystemMap.values()],
        },
    };
}

/**
 * Open an interactive API list panel for a feature cluster (L2b).
 */
function buildApiListGraphForCluster(clusterId: string, subClusterFiles?: string[]): DiagramGraph | undefined {
    const graphId = `api-list:${clusterId}`;
    const working = snapshotStore.getWorking();
    let graph = working.graphs[graphId];
    if (!graph) {
        let cluster = working.clusters?.[clusterId];
        // If subClusterFiles provided (sub-cluster click), build a synthetic cluster scoped to those files
        if (!cluster && subClusterFiles) {
            // Look for parent cluster that contains this sub-cluster
            for (const c of Object.values(working.clusters ?? {})) {
                if (c.subClusters?.[clusterId]) {
                    cluster = c.subClusters[clusterId];
                    break;
                }
            }
        }
        if (!cluster) {
            vscode.window.showWarningMessage(`CodeAtlas: Cluster "${clusterId}" not found.`);
            return undefined;
        }
        graph = buildApiListGraph(cluster, working, snapshotStore.getBaseline());
        snapshotStore.updateWorkingGraph(graph.graphId, graph);
    }
    return graph;
}

function openApiListPanel(clusterId: string, _serviceId: string, subClusterFiles?: string[]): void {
    const graph = buildApiListGraphForCluster(clusterId, subClusterFiles);
    if (!graph) return;
    const label = `APIs: ${(graph.meta?.clusterLabel as string) || clusterId}`;
    const graphId = graph.graphId;
    if (!panelManager.navigateActive(graphId, 'api-list', graph, label)) {
        routeDiagramToWelcome(graphId, 'api-list', graph, label);
    }
}

function openApiListPanelInPanel(clusterId: string, _serviceId: string, sourcePanelId: string, subClusterFiles?: string[]): void {
    const graph = buildApiListGraphForCluster(clusterId, subClusterFiles);
    if (!graph) return;
    const label = `APIs: ${(graph.meta?.clusterLabel as string) || clusterId}`;
    panelManager.navigatePanel(sourcePanelId, graph.graphId, 'api-list', graph, label);
}

/**
 * Open the Microservice / System Design diagram.
 * Always rebuilds fresh — never uses the stale snapshot-cached graph, because
 * service detection (findTopLevelSourceDirs, docker-compose parsing) reads the
 * filesystem and the snapshot's `services` field may be from an older detection pass.
 */
function buildMicroserviceGraphCached(): DiagramGraph {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath || '';

    // Issue #790 #8 follow-up — in monorepo mode we keep the existing
    // skeletal L1 service nodes (one per sub-repo, already cloud-banded
    // by the MicroserviceView layout) and APPEND infra nodes + edges
    // computed from per-repo data. Re-running the full
    // `buildMicroserviceGraph` would re-detect services from the
    // filesystem and re-bucket back to the 10 AWS-category cards.
    // Issue #790 #8 follow-up — in monorepo mode return the skeletal L1
    // unmodified here; the SPA hash route at `case 'system-design'`
    // does the async infra enrichment (uses `await getRepoStoreLoaded`
    // to reopen LRU-evicted sqlites). VS Code panel-host callers get
    // the skeleton; they can refresh on the next route push.
    if (workspaceIsMulti && perRepoOrchestrators.size > 0) {
        const skeleton: any = snapshotStore.getWorking().graphs['microservice:workspace'];
        if (skeleton) return skeleton;
    }

    const working = snapshotStore.getWorking();
    const baseline = snapshotStore.getBaseline();
    // FileRecord.content is dropped post-save (#354 — Body-finder gap closure for kotlin-ktor / rust-actix / rust-axum / rust-rocket). Feed serviceDetector a
    // DB-backed lazy fetcher so DB / queue / cache infra is detected on rebuild.
    const getWorking = (fp: string) => snapshotStore.getFileContent('working', fp);
    const getBaseline = (fp: string) => snapshotStore.getFileContent('baseline', fp);
    const graph = buildMicroserviceGraph(root, working, baseline, getWorking, getBaseline);
    snapshotStore.updateWorkingGraph(graph.graphId, graph);
    maybeUpdateL1Badge(); // Issue 363 — trigger #7 (passive status-bar ●)
    return graph;
}

/**
 * Issue #790 #8 follow-up — append infra nodes + service→infra edges to
 * the workspace-level skeletal L1 graph. The skeletal graph already has
 * one node per sub-repo (built by `buildSkeletalL1` and stored in
 * `monorepo.db`). We:
 *   1. Read it as our starting point — preserves service ids, cloud
 *      grouping, statuses.
 *   2. Run `detectInfrastructureServices` per-repo over each sub-repo's
 *      own snapshot (file content is local to the repo store), then
 *      union the results by infra name.
 *   3. Map each `consumedBy` service id from per-repo space (e.g.
 *      `service:aws-dotnet-rest-api-with-dynamodb`) to the matching L1
 *      skeletal node id (`service:<repoId>`).
 *   4. Add one infra node per unique consumer + an edge per
 *      (service, infra) pair.
 */
async function enrichWithInfra(workspaceRoot: string, skeleton: any): Promise<DiagramGraph | null> {
    if (!skeleton || !Array.isArray(skeleton.nodes) || skeleton.nodes.length === 0) return null;

    // Map service id → L1 node id. The skeleton's nodes use
    // `service:<repoId>` ids and carry `meta.repoId`. We match on
    // multiple shapes so per-repo `service:<repoName>` ids resolve too.
    const idToNode = new Map<string, any>();
    const repoIdToNode = new Map<string, any>();
    const rootPathToNode = new Map<string, any>();
    const nameToNode = new Map<string, any>();
    for (const n of skeleton.nodes) {
        idToNode.set(String(n.id), n);
        if (n.meta?.repoId) repoIdToNode.set(String(n.meta.repoId), n);
        if (n.meta?.rootPath) rootPathToNode.set(String(n.meta.rootPath), n);
        if (typeof n.label === 'string') nameToNode.set(n.label.toLowerCase(), n);
    }

    // Each per-repo detection result is keyed by infra.id; union them
    // so a SQLite client appearing in 30 sub-repos becomes ONE node.
    type InfraAggregate = { id: string; name: string; kind: string; consumerNodeIds: Set<string> };
    const aggregateById = new Map<string, InfraAggregate>();
    for (const [, orch] of perRepoOrchestrators) {
        try {
            // Issue #790 #8 follow-up — `orch.getStore()` returns the
            // orchestrator's BOUND store, whose sqlite may be closed by
            // registry LRU eviction. The per-file content reads inside
            // detectInfrastructureServices would then return undefined
            // and no patterns match. Use `getRepoStoreLoaded` so the
            // registry re-opens sqlite if needed.
            const loadedStore: any = await RepoStoreRegistry.instance().getRepoStoreLoaded(orch.getRepoRoot());
            const snap: any = loadedStore.getWorking();
            const repoServices = snap.services ?? {};
            const repoRoot = orch.getRepoRoot();
            const getContent = (fp: string) => loadedStore.getFileContent('working', fp);
            const infraList = detectInfrastructureServices(repoRoot, snap, repoServices, getContent);
            for (const infra of infraList) {
                let agg = aggregateById.get(infra.id);
                if (!agg) {
                    agg = { id: infra.id, name: infra.name, kind: infra.kind, consumerNodeIds: new Set() };
                    aggregateById.set(infra.id, agg);
                }
                for (const svcId of infra.consumedBy) {
                    // Resolve per-repo svcId to a skeletal L1 node. The
                    // skeleton's serviceId is `service:<repoId>`; the
                    // per-repo svcId is `service:<repoName>`. Same repo
                    // is the link.
                    const repoSubdir = repoRoot.split('/').pop() ?? '';
                    const node = rootPathToNode.get(repoSubdir)
                        ?? nameToNode.get(repoSubdir.toLowerCase())
                        ?? nameToNode.get(svcId.replace(/^service:/, '').toLowerCase())
                        ?? idToNode.get(svcId);
                    if (node) agg.consumerNodeIds.add(String(node.id));
                }
            }
        } catch { /* skip evicted repo */ }
    }

    if (aggregateById.size === 0) return skeleton;

    // Clone the skeleton so we don't mutate the cached object.
    const nodes: any[] = [...skeleton.nodes];
    const edges: any[] = [...(skeleton.edges ?? [])];
    const anchors: Record<string, any> = { ...(skeleton.anchors ?? {}) };

    let infraCounter = 0;
    for (const agg of aggregateById.values()) {
        if (agg.consumerNodeIds.size === 0) continue;
        const infraNodeId = `infra_${++infraCounter}`;
        nodes.push({
            id: infraNodeId,
            type: 'service',
            label: agg.name,
            subtitle: `«${agg.kind}»`,
            diff: 'unchanged',
            anchor: { filePath: '' },
            meta: { external: true, infra: true, kind: agg.kind, consumerCount: agg.consumerNodeIds.size },
        });
        anchors[infraNodeId] = { filePath: '' };

        const edgeLabel =
            agg.kind === 'database' ? 'stores' :
            agg.kind === 'cache' ? 'caches' :
            agg.kind === 'queue' ? 'publishes' :
            agg.kind === 'sdk' ? 'imports' : 'uses';
        for (const consumerNodeId of agg.consumerNodeIds) {
            edges.push({
                id: `edge_infra_${infraCounter}_${consumerNodeId}`,
                source: consumerNodeId,
                target: infraNodeId,
                label: edgeLabel,
                edgeType: 'inter-service',
                diff: 'unchanged',
            });
        }
    }

    outputChannel.appendLine(`[enrichWithInfra] wired ${infraCounter} infra nodes (${edges.length - (skeleton.edges ?? []).length} new edges)`);
    return {
        ...skeleton,
        nodes,
        edges,
        anchors,
        meta: {
            ...(skeleton.meta ?? {}),
            workspaceRoot,
            infraEnriched: true,
            infraCount: infraCounter,
        },
    };
}

/**
 * Issue #790 #8 follow-up — union of per-repo `working` / `baseline`
 * snapshots into a synthetic workspace snapshot. `files`, `apiIndex`,
 * `services`, `clusters` are merged shallowly (per-key first-wins).
 * `graphs` is left empty because the consumer (`buildMicroserviceGraph`)
 * doesn't read it. The returned snapshot is throwaway — never stored.
 */
function mergePerRepoSnapshots(kind: 'working' | 'baseline'): import('./core/graph/graphTypes').Snapshot {
    const files: Record<string, any> = {};
    const apiIndex: Record<string, any> = {};
    const services: Record<string, any> = {};
    const clusters: Record<string, any> = {};
    for (const [, orch] of perRepoOrchestrators) {
        try {
            const snap: any = kind === 'working' ? orch.getStore().getWorking() : orch.getStore().getBaseline();
            for (const [k, v] of Object.entries(snap.files ?? {})) if (!files[k]) files[k] = v;
            for (const [k, v] of Object.entries(snap.apiIndex ?? {})) if (!apiIndex[k]) apiIndex[k] = v;
            for (const [k, v] of Object.entries(snap.services ?? {})) if (!services[k]) services[k] = v;
            for (const [k, v] of Object.entries(snap.clusters ?? {})) if (!clusters[k]) clusters[k] = v;
        } catch { /* skip evicted store */ }
    }
    return {
        files,
        apiIndex,
        services,
        clusters,
        graphs: {} as any,
        screens: {},
        screenItems: {},
        timestamp: Date.now(),
    } as any;
}

/**
 * Issue #790 #8 follow-up — route a content read to the per-repo store
 * that owns the file. `filePath` is workspace-relative (`<sub-repo>/...`);
 * the first segment is the sub-repo's `rootPath`. We look up the matching
 * orchestrator and ask its store for the lazy content.
 */
function readContentFromOwningRepo(kind: 'working' | 'baseline', filePath: string): string | undefined {
    if (!filePath) return undefined;
    const slash = filePath.indexOf('/');
    const repoRoot = slash > 0 ? filePath.slice(0, slash) : filePath;
    for (const [, orch] of perRepoOrchestrators) {
        try {
            const orchRepoRoot = orch.getRepoRoot();
            // orchRepoRoot is an absolute path; check if it ends with the
            // sub-repo segment we extracted from filePath.
            if (orchRepoRoot.endsWith('/' + repoRoot) || orchRepoRoot.endsWith(repoRoot)) {
                return orch.getStore().getFileContent(kind, filePath);
            }
        } catch { /* try next */ }
    }
    return undefined;
}

function openMicroserviceDiagram(): void {
    const graph = buildMicroserviceGraphCached();
    clearStatusBarBadge(); // Issue 363 — user is viewing L1; clear unread marker
    const repoName = (graph.meta?.repoName as string | undefined) ?? 'System Design';
    const label = `System Design: ${repoName}`;
    if (!panelManager.navigateActive('microservice:workspace', 'microservice', graph, label)) {
        routeDiagramToWelcome('microservice:workspace', 'microservice', graph, label);
    }
}

function openMicroserviceDiagramInPanel(sourcePanelId: string): void {
    const graph = buildMicroserviceGraphCached();
    clearStatusBarBadge(); // Issue 363 — user is viewing L1; clear unread marker
    const repoName = (graph.meta?.repoName as string | undefined) ?? 'System Design';
    panelManager.navigatePanel(sourcePanelId, 'microservice:workspace', 'microservice', graph, `System Design: ${repoName}`);
}

// ─── Knowledge Map diagram (Issue #700 / #731) ────────────────────────────

/**
 * Always-fresh Knowledge Map graph builder. Same rationale as the L1
 * cached builder above — composition reads `working.services` /
 * `working.clusters` / `working.apiIndex`, all of which may have shifted
 * since the snapshot's cached `map:workspace` was stamped.
 */
function buildMapGraphCachedLocal(): DiagramGraph {
    const working = snapshotStore.getWorking();
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const root = workspaceFolders?.[0]?.uri.fsPath || '';
    const baseline = snapshotStore.getBaseline();
    const getWorking = (fp: string) => snapshotStore.getFileContent('working', fp);
    const graph = buildMapGraph(working, baseline, {
        workspaceRoot: root,
        contentProvider: getWorking,
    });
    snapshotStore.updateWorkingGraph(graph.graphId, graph);
    return graph;
}

function openMapDiagram(): void {
    const graph = buildMapGraphCachedLocal();
    const label = 'Knowledge Map';
    if (!panelManager.navigateActive('map:workspace', 'map', graph, label)) {
        routeDiagramToWelcome('map:workspace', 'map', graph, label);
    }
}

function openMapDiagramInPanel(sourcePanelId: string): void {
    const graph = buildMapGraphCachedLocal();
    panelManager.navigatePanel(sourcePanelId, 'map:workspace', 'map', graph, 'Knowledge Map');
}

/**
 * Reveal an API leaf item in the API Explorer sidebar.
 * Called when opening a sequence diagram for a specific API.
 */
function revealApiInSidebar(apiId: string): void {
    const item = apiExplorerProvider.findItemByApiId(apiId);
    if (item) {
        apiTreeView.reveal(item, { select: true, focus: false, expand: true }).then(
            undefined,
            () => { /* tree item may not be populated yet — ignore */ }
        );
    }
}

/**
 * Reveal a service node in the Microservice sidebar tree.
 * Called when opening a Feature diagram scoped to a service.
 */
function revealServiceInSidebar(serviceId?: string): void {
    if (!serviceId) return;
    microserviceExplorerProvider.setActiveService(serviceId);
    const item = microserviceExplorerProvider.findItemByServiceId(serviceId);
    if (item) {
        microserviceTreeView.reveal(item, { select: true, focus: false, expand: true }).then(
            undefined,
            () => { /* tree item may not be visible yet — ignore */ }
        );
    }
}

/**
 * Reveal a cluster node in the Feature sidebar tree.
 * Called when opening an API list for a cluster.
 */
function revealClusterInSidebar(clusterId?: string): void {
    if (!clusterId) return;
    featureExplorerProvider.setActiveCluster(clusterId);
    const item = featureExplorerProvider.findItemByClusterId(clusterId);
    if (item) {
        featureTreeView.reveal(item, { select: true, focus: false, expand: true }).then(
            undefined,
            () => { /* tree item may not be visible yet — ignore */ }
        );
    }
}

// ─── Git Diff helpers ────────────────────────────────────────────────────────

/**
 * Send setGitDiffContext to a specific panel by its panelId (graph id).
 * Used when opening a new panel in git diff mode.
 */
function sendGitDiffContextToPanel(panelId: string): void {
    if (!gitDiffState) return;
    panelManager.sendToPanel(panelId, {
        type: 'setGitDiffContext',
        baseHash: gitDiffState.baseHash,
        headHash: gitDiffState.headHash,
        baseLabel: gitDiffState.baseLabel,
        headLabel: gitDiffState.headLabel,
    });
}

/**
 * Broadcast setGitDiffContext to all currently open panels.
 */
function broadcastGitDiffContext(): void {
    if (!gitDiffState) return;
    const msg = {
        type: 'setGitDiffContext',
        baseHash: gitDiffState.baseHash,
        headHash: gitDiffState.headHash,
        baseLabel: gitDiffState.baseLabel,
        headLabel: gitDiffState.headLabel,
    };
    panelManager.broadcastMessage(msg);
    if (wsBridge?.hasClients()) wsBridge.broadcast(msg);
}

/**
 * Check whether the working snapshot has any files that differ from the baseline.
 * Used to warn the user before entering git diff mode.
 */
function hasActiveDiff(): boolean {
    const baseline = snapshotStore.getBaseline();
    const working = snapshotStore.getWorking();
    return Object.keys(working.files).some(
        k => working.files[k].hash !== baseline.files[k]?.hash
    );
}

/**
 * Handle the "Compare Commits" button click from the webview.
 * Shows two QuickPick pickers (base, head), builds diffed snapshots, and
 * pushes the result to all open panels.
 */
async function handleRequestGitDiff(sourcePanelId: string, repoId?: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    // UX-63b (2026-06-09) — per-repo Compare Commits. When repoId is
    // supplied and the workspace is multi-repo, list commits from
    // workspaceRoot/<rootPath> instead of workspaceRoot so the picker
    // shows the sub-repo's history (which has its own .git in monorepos
    // where each sub-project is a separate repo, or filtered log when
    // a single git root spans many services).
    let gitRoot = workspaceRoot;
    const resolved = resolveRepoFromArg(repoId, workspaceRoot, aggregatorRef);
    if (resolved) {
        gitRoot = resolved.gitRoot;
        outputChannel.appendLine(`[GitDiff] requestGitDiff: scoped to per-repo gitRoot=${resolved.rootPath}`);
    }

    // Warn if there is an active unsaved diff
    // Issue 137: In browser mode, skip the VS Code dialog — auto-resync instead
    if (hasActiveDiff()) {
        const isBrowser = sourcePanelId.startsWith('ws:');
        if (isBrowser) {
            notifyBrowser('info', 'Re-syncing before commit diff...');
            await resyncWorkspaceSafe();
            refreshViews();
        } else {
            const choice = await vscode.window.showWarningMessage(
                'CodeAtlas: You have an active code diff (baseline ≠ working). Re-sync first to get a clean baseline before comparing commits.',
                'Re-sync & Continue',
                'Cancel',
            );
            if (choice !== 'Re-sync & Continue') return;
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'CodeAtlas: Re-syncing...', cancellable: false },
                async () => { await resyncWorkspaceSafe(); refreshViews(); },
            );
        }
    }

    // Load commits
    const commits = listCommits(gitRoot, 100);
    if (commits.length === 0) {
        vscode.window.showWarningMessage('CodeAtlas: No git commits found in this repository.');
        notifyBrowser('warning', 'No git commits found in this repository.');
        return;
    }

    // Browser mode: send commit list to the webview for in-browser selection
    const isBrowser = sourcePanelId.startsWith('ws:');
    if (isBrowser && wsBridge) {
        const clientId = sourcePanelId.slice(3);
        wsBridge.sendTo(clientId, {
            type: 'showCommitPicker',
            commits: commits.map(c => ({ hash: c.hash, shortHash: c.shortHash, subject: c.subject, author: c.author, relativeDate: c.relativeDate })),
            mode: 'both',
        });
        return; // Selection continues asynchronously via 'commitSelected' message
    }

    const items = commits.map(c => ({
        label: `$(git-commit) ${c.shortHash}  ${c.subject}`,
        description: `${c.relativeDate} · ${c.author}`,
        detail: c.hash,
    }));

    // Picker 1 — base (older)
    const basePick = await vscode.window.showQuickPick(items, {
        title: 'Git Diff: Select base commit (older)',
        placeHolder: 'Type to search by commit message or hash…',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!basePick) return;

    // Picker 2 — head (newer), default HEAD
    const headPick = await vscode.window.showQuickPick(items, {
        title: 'Git Diff: Select head commit (newer)',
        placeHolder: 'Type to search by commit message or hash…',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!headPick) return;

    const baseHash = basePick.detail!;
    const headHash = headPick.detail!;

    if (baseHash === headHash) {
        vscode.window.showWarningMessage('CodeAtlas: Base and head commits are the same — nothing to diff.');
        notifyBrowser('warning', 'Base and head commits are the same — nothing to diff.');
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `CodeAtlas: Building diff ${basePick.label.trim()} → ${headPick.label.trim()}…`,
            cancellable: false,
        },
        async () => {
            try {
                const result = await buildCommitDiffGraphs(
                    workspaceRoot,
                    baseHash,
                    headHash,
                    (msg) => outputChannel.appendLine(msg),
                );

                const baseLabel = `${basePick.detail!.slice(0, 7)} ${basePick.label.replace(/^\$\(git-commit\)\s*\w+\s+/, '').trim()}`;
                const headLabel = `${headPick.detail!.slice(0, 7)} ${headPick.label.replace(/^\$\(git-commit\)\s*\w+\s+/, '').trim()}`;

                // UX-64: scoped write — registry stays authoritative.
                setGitDiffStateScoped({
                    baseHash,
                    headHash,
                    baseLabel,
                    headLabel,
                    diffedGraphs: result.diffedGraphs,
                    apiIndex: result.apiIndex,
                });
                gitDiffSnapshots = { headSnapshot: result.headSnapshot, baseSnapshot: result.baseSnapshot };
                gitDiffStore.save(gitDiffState!);
                vscode.commands.executeCommand('setContext', 'codeatlas:gitDiffActive', true);
                maybeNudgeGitDiffStarted(); // Issue 363 — trigger #9

                // Refresh explorer sidebars with git diff data
                refreshViewsForGitDiff(result.headSnapshot, result.baseSnapshot);

                // Push the context badge to all open panels
                broadcastGitDiffContext();

                // Navigate the source panel to the L1 microservice diff diagram
                const msGraph = result.diffedGraphs['microservice:workspace'];
                if (msGraph) {
                    panelManager.navigatePanel(
                        sourcePanelId,
                        'microservice:workspace',
                        'microservice',
                        msGraph,
                        'System Design',
                    );
                }

                outputChannel.appendLine(`[GitDiff] Done — ${Object.keys(result.diffedGraphs).length} graphs diffed`);
            } catch (err: any) {
                const msg = err?.message ?? String(err);
                outputChannel.appendLine(`[GitDiff] Error: ${msg}`);
                vscode.window.showErrorMessage(`CodeAtlas: Git diff failed — ${msg}. See Output > CodeAtlas.`);
                notifyBrowser('error', `Git diff failed — ${msg}`);
            }
        },
    );
}

/**
 * Ask the user for a PR number, fetch its base/head SHAs from the GitHub API,
 * and run the same commit diff pipeline as handleRequestGitDiff.
 */
async function handleRequestPrDiff(sourcePanelId: string, repoId?: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    // UX-63d (2026-06-09) — per-repo PR Diff. The remote that backs the
    // PR list lives at the sub-repo's path when each sub-repo has its
    // own GitHub origin. Resolve sub-repo gitRoot and use it for
    // `getGithubRemote` so PR lists come from THAT sub-repo's remote.
    let gitRoot = workspaceRoot;
    if (repoId && aggregatorRef) {
        try {
            const repos = aggregatorRef.listRepos();
            const matched = repos.find((r: any) => r.name === repoId || r.repoId === repoId || r.rootPath === repoId);
            if (matched?.rootPath) {
                gitRoot = path.join(workspaceRoot, matched.rootPath);
                outputChannel.appendLine(`[PrDiff] requestPrDiff: scoped to per-repo gitRoot=${matched.rootPath}`);
            }
        } catch (err: any) {
            outputChannel.appendLine(`[PrDiff] per-repo resolve failed: ${err?.message ?? err}`);
        }
    }

    // Warn if there is an active unsaved diff
    if (hasActiveDiff()) {
        const choice = await vscode.window.showWarningMessage(
            'CodeAtlas: You have an active code diff (baseline ≠ working). Re-sync first to get a clean baseline before comparing a PR.',
            'Re-sync & Continue',
            'Cancel',
        );
        if (choice !== 'Re-sync & Continue') {
            replayAfterDiff = false;
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'CodeAtlas: Re-syncing...', cancellable: false },
            async () => { await resyncWorkspaceSafe(); refreshViews(); },
        );
    }

    // Resolve owner/repo from the git remote
    const remote = getGithubRemote(gitRoot);
    if (!remote) {
        replayAfterDiff = false;
        vscode.window.showErrorMessage(
            'CodeAtlas: Could not determine GitHub repository from the origin remote. Make sure the remote is set to a github.com URL.',
        );
        notifyBrowser('error', 'Could not determine GitHub repository from the origin remote.');
        return;
    }

    // Browser mode: fetch open PR list and send to the webview for in-browser selection
    const isBrowser = sourcePanelId.startsWith('ws:');
    if (isBrowser && wsBridge) {
        const clientId = sourcePanelId.slice(3);
        const token = gitHubToken ?? undefined;
        const prs = await listGitHubPrs(remote.owner, remote.repo, token);
        wsBridge.sendTo(clientId, { type: 'showPrPicker', owner: remote.owner, repo: remote.repo, prs, isReplay: replayAfterDiff });
        return; // Selection continues asynchronously via 'prSelected' message
    }

    // Ask for the PR number
    const input = await vscode.window.showInputBox({
        title: `Compare PR — ${remote.owner}/${remote.repo}`,
        prompt: 'Enter the pull request number',
        placeHolder: '123',
        validateInput: (v) => /^\d+$/.test(v.trim()) ? null : 'Enter a numeric PR number',
    });
    if (!input) {
        replayAfterDiff = false;
        return;
    }
    const prNumber = parseInt(input.trim(), 10);

    // Try to get a GitHub auth token via VS Code's built-in GitHub auth provider.
    // Use silent:true so we don't nag the user on every invocation — if they're
    // already signed in we get the token instantly.  If not, we fall back to
    // unauthenticated (60 req/hr) and prompt interactively only when needed.
    let token: string | undefined;
    try {
        const session = await vscode.authentication.getSession('github', ['repo'], { silent: true });
        token = session?.accessToken;
    } catch {
        // Not authenticated — will try unauthenticated first
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `CodeAtlas: Fetching PR #${prNumber} from ${remote.owner}/${remote.repo}…`,
            cancellable: false,
        },
        async () => {
            let pr;
            try {
                pr = await fetchGitHubPr(remote.owner, remote.repo, prNumber, token);
            } catch (firstErr: any) {
                const firstMsg = firstErr?.message ?? String(firstErr);

                // 404 without a token almost always means a private repo (GitHub
                // returns 404 — not 401 — to avoid leaking repo existence).
                // Offer interactive sign-in and retry once with the new token.
                if (!token && firstMsg.includes('not found')) {
                    const choice = await vscode.window.showErrorMessage(
                        `CodeAtlas: ${firstMsg}`,
                        'Sign in to GitHub',
                    );
                    if (choice !== 'Sign in to GitHub') return;

                    try {
                        const session = await vscode.authentication.getSession(
                            'github', ['repo'], { silent: false },
                        );
                        token = session?.accessToken;
                    } catch {
                        vscode.window.showErrorMessage('CodeAtlas: GitHub sign-in failed or was cancelled.');
                        return;
                    }

                    if (!token) {
                        vscode.window.showErrorMessage('CodeAtlas: GitHub sign-in was cancelled.');
                        return;
                    }

                    // Retry with the freshly-obtained token
                    try {
                        pr = await fetchGitHubPr(remote.owner, remote.repo, prNumber, token);
                    } catch (retryErr: any) {
                        const retryMsg = retryErr?.message ?? String(retryErr);
                        outputChannel.appendLine(`[PrDiff] GitHub API error (retry): ${retryMsg}`);
                        vscode.window.showErrorMessage(`CodeAtlas: ${retryMsg}`);
                        return;
                    }
                } else {
                    outputChannel.appendLine(`[PrDiff] GitHub API error: ${firstMsg}`);
                    vscode.window.showErrorMessage(`CodeAtlas: ${firstMsg}`);
                    return;
                }
            }

            if (!pr) return;

            // Ensure both commits exist locally (fetch if needed)
            ensureCommitAvailable(workspaceRoot, pr.baseHash);
            ensureCommitAvailable(workspaceRoot, pr.headHash);

            try {
                const result = await buildCommitDiffGraphs(
                    workspaceRoot,
                    pr.baseHash,
                    pr.headHash,
                    (msg) => outputChannel.appendLine(msg),
                );

                const baseLabel = `${pr.baseHash.slice(0, 7)} ${pr.baseRef} (PR #${prNumber} base)`;
                const headLabel = `${pr.headHash.slice(0, 7)} ${pr.headRef} (PR #${prNumber})`;

                // UX-64: scoped write — registry stays authoritative.
                setGitDiffStateScoped({
                    baseHash: pr.baseHash,
                    headHash: pr.headHash,
                    baseLabel,
                    headLabel,
                    diffedGraphs: result.diffedGraphs,
                    apiIndex: result.apiIndex,
                });
                gitDiffSnapshots = { headSnapshot: result.headSnapshot, baseSnapshot: result.baseSnapshot };
                gitDiffStore.save(gitDiffState!);
                vscode.commands.executeCommand('setContext', 'codeatlas:gitDiffActive', true);
                maybeNudgeGitDiffStarted(); // Issue 363 — trigger #9

                refreshViewsForGitDiff(result.headSnapshot, result.baseSnapshot);
                broadcastGitDiffContext();

                const msGraph = result.diffedGraphs['microservice:workspace'];
                if (msGraph) {
                    panelManager.navigatePanel(
                        sourcePanelId,
                        'microservice:workspace',
                        'microservice',
                        msGraph,
                        'System Design',
                    );
                }

                outputChannel.appendLine(`[PrDiff] Done — PR #${prNumber} (${pr.baseHash.slice(0, 7)}…${pr.headHash.slice(0, 7)}), ${Object.keys(result.diffedGraphs).length} graphs diffed`);
            } catch (err: any) {
                const msg = err?.message ?? String(err);
                outputChannel.appendLine(`[PrDiff] Error: ${msg}`);
                vscode.window.showErrorMessage(`CodeAtlas: PR diff failed — ${msg}. See Output > CodeAtlas.`);
                notifyBrowser('error', `PR diff failed — ${msg}`);
            }
        },
    );
}

/**
 * Browser-mode handler: user selected two commits in the CommitPicker modal.
 * Runs the same diff pipeline as handleRequestGitDiff after the quick-pick stage.
 */
async function handleCommitSelected(sourcePanelId: string, baseHash: string, headHash: string, repoId?: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    // UX-63b — resolve sub-repo gitRoot if scoped.
    let gitRoot = workspaceRoot;
    let scopedRepo: string | undefined;
    if (repoId && aggregatorRef) {
        try {
            const repos = aggregatorRef.listRepos();
            const matched = repos.find((r: any) => r.name === repoId || r.repoId === repoId || r.rootPath === repoId);
            if (matched?.rootPath) {
                gitRoot = path.join(workspaceRoot, matched.rootPath);
                scopedRepo = matched.name ?? matched.rootPath ?? repoId;
                outputChannel.appendLine(`[GitDiff] commitSelected: scoped to per-repo gitRoot=${matched.rootPath}`);
            }
        } catch (err: any) {
            outputChannel.appendLine(`[GitDiff] commitSelected per-repo resolve failed: ${err?.message ?? err}`);
        }
    }

    if (baseHash === headHash) {
        outputChannel.appendLine('[GitDiff] Base and head commits are the same — nothing to diff.');
        return;
    }

    try {
        // Progress: building diff graphs
        if (wsBridge?.hasClients()) {
            wsBridge.broadcast({ type: 'initProgress', phase: 'commit-diff', progress: 0.3, message: `Building diff graphs (${baseHash.slice(0, 7)} → ${headHash.slice(0, 7)})...` });
        }

        const result = await buildCommitDiffGraphs(
            gitRoot,
            baseHash,
            headHash,
            (msg) => outputChannel.appendLine(msg),
        );

        const commits = listCommits(gitRoot, 100);
        const baseCommit = commits.find(c => c.hash === baseHash);
        const headCommit = commits.find(c => c.hash === headHash);
        const baseLabel = `${baseHash.slice(0, 7)} ${baseCommit?.subject ?? ''}${scopedRepo ? ` (${scopedRepo})` : ''}`.trim();
        const headLabel = `${headHash.slice(0, 7)} ${headCommit?.subject ?? ''}${scopedRepo ? ` (${scopedRepo})` : ''}`.trim();

        // UX-64: route through the scoped helper so the per-repo Map
        // stays authoritative. The legacy `gitDiffState` alias is
        // updated inside the helper.
        setGitDiffStateScoped({ baseHash, headHash, baseLabel, headLabel, diffedGraphs: result.diffedGraphs, apiIndex: result.apiIndex, scopedRepo });
        gitDiffSnapshots = { headSnapshot: result.headSnapshot, baseSnapshot: result.baseSnapshot };
        gitDiffStore.save(gitDiffState!);
        vscode.commands.executeCommand('setContext', 'codeatlas:gitDiffActive', true);
        maybeNudgeGitDiffStarted(); // Issue 363 — trigger #9

        refreshViewsForGitDiff(result.headSnapshot, result.baseSnapshot);
        broadcastGitDiffContext();

        // Auto-launch replay if triggered from "Replay PR" / "Replay Branch" actions
        if (replayAfterDiff && gitDiffState) {
            replayAfterDiff = false;
            commitTimelineReplay.playFromDiffResult({
                diffedGraphs: gitDiffState.diffedGraphs,
                baseHash: gitDiffState.baseHash,
                headHash: gitDiffState.headHash,
                baseLabel: gitDiffState.baseLabel,
                headLabel: gitDiffState.headLabel,
            });
        } else {
            const msGraph = result.diffedGraphs['microservice:workspace'];
            if (msGraph) {
                panelManager.navigatePanel(sourcePanelId, 'microservice:workspace', 'microservice', msGraph, 'System Design');
            }
        }

        outputChannel.appendLine(`[GitDiff] commitSelected done — ${Object.keys(result.diffedGraphs).length} graphs diffed`);
    } catch (err: any) {
        replayAfterDiff = false;
        const msg = err?.message ?? String(err);
        outputChannel.appendLine(`[GitDiff] commitSelected error: ${msg}`);
        notifyBrowser('error', `Git diff failed — ${msg}`);
    }
}

/**
 * Show the branch picker so the user can select a branch to diff against HEAD.
 */
async function handleRequestBranchDiff(sourcePanelId: string, repoId?: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    // UX-63c (2026-06-09) — per-repo Branch Diff. Resolve sub-repo
    // gitRoot like handleRequestGitDiff so branch listings come from
    // THAT sub-repo's git tree.
    let gitRoot = workspaceRoot;
    if (repoId && aggregatorRef) {
        try {
            const repos = aggregatorRef.listRepos();
            const matched = repos.find((r: any) => r.name === repoId || r.repoId === repoId || r.rootPath === repoId);
            if (matched?.rootPath) {
                gitRoot = path.join(workspaceRoot, matched.rootPath);
                outputChannel.appendLine(`[BranchDiff] requestBranchDiff: scoped to per-repo gitRoot=${matched.rootPath}`);
            }
        } catch (err: any) {
            outputChannel.appendLine(`[BranchDiff] per-repo resolve failed: ${err?.message ?? err}`);
        }
    }

    // Warn if there is an active unsaved diff
    if (hasActiveDiff()) {
        const choice = await vscode.window.showWarningMessage(
            'CodeAtlas: You have an active code diff (baseline ≠ working). Re-sync first to get a clean baseline before comparing branches.',
            'Re-sync & Continue',
            'Cancel',
        );
        if (choice !== 'Re-sync & Continue') {
            replayAfterDiff = false;
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'CodeAtlas: Re-syncing...', cancellable: false },
            async () => { await resyncWorkspaceSafe(); refreshViews(); },
        );
    }

    const branches = listBranches(gitRoot);
    if (branches.length === 0) {
        vscode.window.showWarningMessage('CodeAtlas: No git branches found in this repository.');
        notifyBrowser('warning', 'No git branches found in this repository.');
        replayAfterDiff = false;
        return;
    }

    // Browser mode: send branch list to the webview for in-browser selection
    const isBrowser = sourcePanelId.startsWith('ws:');
    if (isBrowser && wsBridge) {
        const clientId = sourcePanelId.slice(3);
        wsBridge.sendTo(clientId, {
            type: 'showBranchPicker',
            branches: branches.map(b => ({ name: b.name, isCurrent: b.isCurrent, isRemote: b.isRemote })),
            isReplay: replayAfterDiff,
        });
        return;
    }

    // VS Code mode: use quick pick
    const items = branches.map(b => ({
        label: `${b.isCurrent ? '$(check) ' : b.isRemote ? '$(cloud) ' : '$(git-branch) '}${b.name}`,
        description: b.isCurrent ? '(current)' : b.isRemote ? '(remote)' : '',
        detail: b.name,
        picked: false,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title: 'Branch Diff: Select branch to compare against HEAD',
        placeHolder: 'Type to search branches…',
        matchOnDescription: true,
    });
    if (!picked) {
        replayAfterDiff = false;
        return;
    }

    await handleBranchSelected(sourcePanelId, picked.detail!, repoId);
}

/**
 * Resolve a branch to commit hashes and run the commit diff pipeline.
 * Compares the merge-base of the selected branch and HEAD against HEAD.
 */
async function handleBranchSelected(sourcePanelId: string, branchName: string, repoId?: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    // UX-63c — resolve sub-repo gitRoot so ref resolution uses
    // the right git tree (especially relevant when sub-repos are
    // independent .git repos rather than directories in one big repo).
    let gitRoot = workspaceRoot;
    if (repoId && aggregatorRef) {
        try {
            const repos = aggregatorRef.listRepos();
            const matched = repos.find((r: any) => r.name === repoId || r.repoId === repoId || r.rootPath === repoId);
            if (matched?.rootPath) {
                gitRoot = path.join(workspaceRoot, matched.rootPath);
                outputChannel.appendLine(`[BranchDiff] branchSelected: scoped to per-repo gitRoot=${matched.rootPath}`);
            }
        } catch (err: any) {
            outputChannel.appendLine(`[BranchDiff] branchSelected per-repo resolve failed: ${err?.message ?? err}`);
        }
    }

    const headHash = resolveRef(gitRoot, 'HEAD');
    const branchHash = resolveRef(gitRoot, branchName);

    if (!headHash || !branchHash) {
        outputChannel.appendLine(`[BranchDiff] Could not resolve refs: HEAD=${headHash}, ${branchName}=${branchHash}`);
        notifyBrowser('error', `Could not resolve branch "${branchName}".`);
        replayAfterDiff = false;
        return;
    }

    // Use merge-base as the base commit so the diff shows only the branch's changes
    const baseHash = mergeBase(gitRoot, branchName, 'HEAD') ?? branchHash;

    outputChannel.appendLine(`[BranchDiff] ${branchName} (${branchHash.slice(0, 7)}) merge-base=${baseHash.slice(0, 7)} HEAD=${headHash.slice(0, 7)}`);
    await handleCommitSelected(sourcePanelId, baseHash, headHash, repoId);
}

/**
 * Browser-mode handler: user entered a PR number in the PrPicker modal.
 * Runs the same diff pipeline as handleRequestPrDiff after the input-box stage.
 */
async function handlePrSelected(sourcePanelId: string, prNumber: number, repoId?: string): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    // UX-63d — resolve sub-repo gitRoot for remote + commit ops.
    let gitRoot = workspaceRoot;
    let scopedRepo: string | undefined;
    if (repoId && aggregatorRef) {
        try {
            const repos = aggregatorRef.listRepos();
            const matched = repos.find((r: any) => r.name === repoId || r.repoId === repoId || r.rootPath === repoId);
            if (matched?.rootPath) {
                gitRoot = path.join(workspaceRoot, matched.rootPath);
                scopedRepo = matched.name ?? matched.rootPath ?? repoId;
                outputChannel.appendLine(`[PrDiff] prSelected: scoped to per-repo gitRoot=${matched.rootPath}`);
            }
        } catch (err: any) {
            outputChannel.appendLine(`[PrDiff] prSelected per-repo resolve failed: ${err?.message ?? err}`);
        }
    }

    const remote = getGithubRemote(gitRoot);
    if (!remote) return;

    // Use cached token (proactively obtained at activation or via connectGitHub)
    const token = gitHubToken;

    try {
        // Progress: fetching PR
        if (wsBridge?.hasClients()) {
            wsBridge.broadcast({ type: 'initProgress', phase: 'pr-diff', progress: 0.1, message: `Fetching PR #${prNumber} from GitHub...` });
        }

        const pr = await fetchGitHubPr(remote.owner, remote.repo, prNumber, token);
        if (!pr) return;

        // Progress: downloading commits
        if (wsBridge?.hasClients()) {
            wsBridge.broadcast({ type: 'initProgress', phase: 'pr-diff', progress: 0.3, message: `Downloading commits for PR #${prNumber}...` });
        }

        ensureCommitAvailable(gitRoot, pr.baseHash);
        ensureCommitAvailable(gitRoot, pr.headHash);

        // Progress: building diff graphs
        if (wsBridge?.hasClients()) {
            wsBridge.broadcast({ type: 'initProgress', phase: 'pr-diff', progress: 0.5, message: `Building diff graphs for PR #${prNumber}...` });
        }

        const result = await buildCommitDiffGraphs(
            gitRoot,
            pr.baseHash,
            pr.headHash,
            (msg) => outputChannel.appendLine(msg),
        );

        const baseLabel = `${pr.baseHash.slice(0, 7)} ${pr.baseRef} (PR #${prNumber}: ${pr.prTitle})${scopedRepo ? ` [${scopedRepo}]` : ''}`;
        const headLabel = `${pr.headHash.slice(0, 7)} ${pr.headRef} (PR #${prNumber}: ${pr.prTitle})${scopedRepo ? ` [${scopedRepo}]` : ''}`;

        // UX-64: scoped write — registry stays authoritative.
        setGitDiffStateScoped({ baseHash: pr.baseHash, headHash: pr.headHash, baseLabel, headLabel, diffedGraphs: result.diffedGraphs, apiIndex: result.apiIndex, scopedRepo });
        gitDiffSnapshots = { headSnapshot: result.headSnapshot, baseSnapshot: result.baseSnapshot };
        gitDiffStore.save(gitDiffState!);
        vscode.commands.executeCommand('setContext', 'codeatlas:gitDiffActive', true);
        maybeNudgeGitDiffStarted(); // Issue 363 — trigger #9

        refreshViewsForGitDiff(result.headSnapshot, result.baseSnapshot);
        broadcastGitDiffContext();

        if (replayAfterDiff && gitDiffState) {
            replayAfterDiff = false;
            commitTimelineReplay.playFromDiffResult({
                diffedGraphs: gitDiffState.diffedGraphs,
                baseHash: gitDiffState.baseHash,
                headHash: gitDiffState.headHash,
                baseLabel: gitDiffState.baseLabel,
                headLabel: gitDiffState.headLabel,
            });
        } else {
            const msGraph = result.diffedGraphs['microservice:workspace'];
            if (msGraph) {
                panelManager.navigatePanel(sourcePanelId, 'microservice:workspace', 'microservice', msGraph, 'System Design');
            }
        }

        outputChannel.appendLine(`[PrDiff] prSelected done — PR #${prNumber}, ${Object.keys(result.diffedGraphs).length} graphs diffed`);
    } catch (err: any) {
        replayAfterDiff = false;
        const msg = err?.message ?? String(err);
        outputChannel.appendLine(`[PrDiff] prSelected error: ${msg}`);
        notifyBrowser('error', `PR diff failed — ${msg}`);
    }
}

/**
 * Handle the "✕ Reset" button click — clear git diff mode and restore live diff.
 */
function handleClearGitDiff(): void {
    // UX-64: nuke every active scope (workspace + any per-repo sessions).
    // Phase 2 will add per-scope clear messages for "close one tab's
    // session without affecting the other tab".
    gitDiffStates.clearAll();
    gitDiffState = null;
    gitDiffSnapshots = null;
    gitDiffStore.clear();
    // Clear AI review data when diff is reset
    aiReviewResult = null;
    clearReviewCache();
    panelManager.broadcastMessage({ type: 'aiReviewCleared' });
    if (wsBridge?.hasClients()) wsBridge.broadcast({ type: 'aiReviewCleared' });
    vscode.commands.executeCommand('setContext', 'codeatlas:gitDiffActive', false);

    // Tell all panels to drop the badge and show the live diff again
    panelManager.broadcastMessage({ type: 'clearGitDiffContext' });

    // #387: re-cascade the live working snapshot BEFORE broadcasting so the
    // panels receive the correctly-cascaded baseline-vs-working state.
    // Without this, working.graphs may still carry stale modified annotations
    // from before the user entered git-diff mode (or from a partial cascade),
    // and the browser's React nav stack ends up with stale graph data even
    // after `updateGraph` messages land — the user sees the previous in-flight
    // diff state ("main MODIFIED") with header text showing "No changes",
    // resolved only by a hard browser refresh.
    // force:true — leaving git-diff mode overwrote working.graphs with commit-diff
    // annotations WITHOUT arming `_liveGraphsCascadeDirty`, so the new clean-flag
    // gate would skip this re-cascade and leave stale "MODIFIED" annotations (#387).
    try { syncOrchestrator.applyDiffCascadeToLiveGraphs(undefined, { force: true }); }
    catch (err: any) { outputChannel.appendLine(`[clearGitDiff] cascade failed: ${err?.message ?? err}`); }

    // Push the current working graphs back to open panels. Streamed via
    // #355's lazy iterator so we don't materialize all 20k+ graphs to
    // service this fan-out.
    const working = snapshotStore.getWorking();
    const wsActive = wsBridge?.hasClients();
    if (wsActive) wsBridge!.broadcast({ type: 'clearGitDiffContext' });
    forEachGraph(working.graphs, (graphId, graph) => {
        panelManager.updatePanel(graphId, graph);
        if (wsActive) wsBridge!.broadcast({ type: 'updateGraph', graphId, graph });
    });

    // Restore explorer sidebars to live state.json data
    refreshViews();
}

export function deactivate() {
    // Session lifecycle moved to the web dashboard (2026-08) — the editor no
    // longer emits session_ended; sessions are counted on codeatlas.live.
    try { extensionPrWatcher?.stop(); } catch { /* */ }
    extensionPrWatcher = null;
    wsBridge?.stop();
    panelManager?.disposeAll();
    disposeLspFallbackResolver();
    // Stop the preempt-watch first so we don't race a yield handler during
    // shutdown.
    if (extensionPreemptUnwatch) {
        try { extensionPreemptUnwatch(); } catch { /* */ }
        extensionPreemptUnwatch = null;
    }
    // #829 — stop the reclaim watcher symmetrically.
    if (extensionReclaimUnwatch) {
        try { extensionReclaimUnwatch(); } catch { /* */ }
        extensionReclaimUnwatch = null;
    }
    // Release the workspace write-lock so a future MCP process can pick up
    // read-write ownership next time the user launches it.
    if (extensionWorkspaceLock) {
        extensionWorkspaceLock.release();
        extensionWorkspaceLock = null;
    }
}
