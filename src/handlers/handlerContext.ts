/**
 * handlerContext.ts
 *
 * Shared context interface for all message handlers extracted from extension.ts.
 * Issues #173, #174, #194: Decompose extension.ts into focused handler modules
 * with consistent error handling.
 *
 * Each handler receives this context instead of accessing module-level globals.
 */

import type * as vscode from 'vscode';
import type { PanelManager } from '../views/webview/panelManager';
import type { SnapshotStore } from '../core/storage/snapshotStore';
import type { SyncOrchestrator } from '../core/sync/syncOrchestrator';
import type { CommentStore } from '../core/storage/commentStore';
import type { SourceNavigator } from '../core/navigation/sourceNavigator';
import type { WsBridge } from '../server/wsBridge';
import type { CommitTimelineReplay } from '../core/replay/commitTimelineReplay';
import type { GitDiffStore, PersistedGitDiffState } from '../core/storage/gitDiffStore';
import type { Snapshot } from '../core/graph/graphTypes';
import type { AiReviewResult } from '../core/llm/aiReviewTypes';
import type { ApiExplorerProvider, ApiTreeItem } from '../views/apiExplorerProvider';
import type { FeatureExplorerProvider, FeatureTreeItem } from '../views/featureExplorerProvider';
import type { MicroserviceExplorerProvider, ServiceTreeItem } from '../views/microserviceExplorerProvider';
import type { ChangeLog } from '../core/replay/changeLog';
import type { ImpactReplayOrchestrator } from '../core/replay/impactReplayOrchestrator';
import type { CommentsProvider } from '../views/commentsProvider';
import type { LlmNamingService } from '../core/llm/llmNamingService';
import type { RepoStoreRegistry } from '../core/storage/repoStoreRegistry';
import type { IAggregatorStore } from '../core/storage/storeInterfaces';

/**
 * #547: Platform abstraction so handler modules can run under either the VS
 * Code extension or the standalone WS server. Each runtime supplies a
 * concrete implementation; handlers call `ctx.platform.*` instead of
 * reaching into `ctx.panelManager` / `ctx.context.secrets` directly.
 *
 * - Extension: panelManager-backed (broadcasts to every VS Code webview AND
 *   the WS bridge if connected), VS Code SecretStorage.
 * - Standalone: wsBridge-only broadcast, SecretsStore from
 *   src/standalone/secrets.ts.
 *
 * Optional methods (`refreshSidebar`, `revealApi`, etc.) are no-op on
 * standalone where there's no sidebar to refresh.
 */
export interface PlatformAdapter {
    /** Broadcast a webview message to all clients (extension panels + WS tabs). */
    broadcast(msg: any): void;
    /** Push an updated graph to every panel that has it open. */
    updateGraph(graphId: string, graph: any): void;
    /** Retrieve a secret from the runtime's secret store. */
    getSecret(key: string): Promise<string | undefined>;
    /** Persist a secret in the runtime's secret store. */
    setSecret(key: string, value: string): Promise<void>;
    /**
     * Read a setting (`codeatlas.<dottedKey>`). Returns `defaultValue` when
     * unset. Extension routes through `vscode.workspace.getConfiguration`;
     * standalone routes through its `SettingsResolver` (env override →
     * file → default).
     */
    getSetting<T>(key: string, defaultValue?: T): T | undefined;
    /**
     * Write a setting. Extension persists to Workspace scope so the value
     * survives reloads. Standalone persists to its settings file.
     */
    setSetting<T>(key: string, value: T): Promise<void>;
    /** Refresh sidebar tree views. No-op on standalone (no sidebar). */
    refreshSidebar?(): void;
    /** Reveal a node in the API sidebar. No-op on standalone. */
    revealApi?(apiId: string): void;
    /** Reveal a node in the microservice sidebar. No-op on standalone. */
    revealService?(serviceId: string): void;
    /** Reveal a node in the feature sidebar. No-op on standalone. */
    revealCluster?(clusterId: string): void;
}

/**
 * Shared context passed to all handler modules.
 * Replaces direct access to module-level variables in extension.ts.
 *
 * #547: VS Code-specific fields (`context`, `outputChannel`, `panelManager`,
 * tree-view providers, `commentsProvider`) are now optional so the
 * standalone WS server can supply a context that satisfies the interface
 * without faking VS Code APIs. Handlers prefer the `platform` adapter for
 * cross-runtime operations (broadcast, secrets, sidebar reveal).
 */
export interface HandlerContext {
    // VS Code services (optional — standalone runs without VS Code)
    context?: vscode.ExtensionContext;
    outputChannel?: vscode.OutputChannel;
    workspaceRoot: string;

    // Platform abstraction (cross-runtime — required)
    platform: PlatformAdapter;

    // Core services
    panelManager?: PanelManager;
    snapshotStore: SnapshotStore;
    syncOrchestrator?: SyncOrchestrator;
    /**
     * Multi-repo-safe workspace resync. When set (extension activation wires
     * it), the resyncEverything handler MUST call this instead of
     * `syncOrchestrator.resync()` — for a multi-repo workspace the monolithic
     * single-store resync hangs/OOMs on large workspaces (polar), so this
     * routes to the distributed per-repo path. Falls back to
     * `syncOrchestrator.resync()` when unset (single-repo / standalone).
     */
    resyncWorkspace?: () => Promise<void>;
    commentStore: CommentStore;

    // ADR-034 Phase B (#787 — Phase B: per-repo writes in multi-repo mode (ADR-034)) — multi-repo store routing. Optional so
    // single-repo workspaces + standalone tests run identically without
    // these set (resolveStoreForPath falls back to snapshotStore when
    // missing). Extension activation wires them.
    repoStoreRegistry?: RepoStoreRegistry;
    aggregatorStore?: IAggregatorStore;
    sourceNavigator?: SourceNavigator;
    gitDiffStore?: GitDiffStore;

    // Optional services (browser mode)
    wsBridge?: WsBridge;

    // Sidebar providers + tree views (extension only)
    apiExplorerProvider?: ApiExplorerProvider;
    apiTreeView?: vscode.TreeView<ApiTreeItem>;
    featureExplorerProvider?: FeatureExplorerProvider;
    featureTreeView?: vscode.TreeView<FeatureTreeItem>;
    microserviceExplorerProvider?: MicroserviceExplorerProvider;
    microserviceTreeView?: vscode.TreeView<ServiceTreeItem>;

    // Comments (extension only — sidebar tree view)
    commentsProvider?: CommentsProvider;

    // LLM
    llmNamingService: LlmNamingService;
    clerkAuthPageUrl?: string;

    // #851 — PR watcher control (parity with the standalone deps thunk;
    // see ADR-045). Undefined ⇒ this surface can't run a watcher.
    prWatcher?: () => import('../core/review/prWatcher').PrWatcher | undefined;

    // Replay (extension only — uses VS Code SCM APIs)
    commitTimelineReplay?: CommitTimelineReplay;
    changeLog?: ChangeLog;
    replayOrchestrator?: ImpactReplayOrchestrator;

    // Mutable state accessors (extension-only; standalone manages its own state).
    // 2026-06-09 — UX-64 Phase 2: `getGitDiffState` now accepts an optional
    // `scope` (repoId / sub-repo name). When provided, the registry returns
    // the per-repo session keyed by that scope so concurrent diff sessions
    // across sibling sub-repos stay isolated. Callers without a scope still
    // hit the legacy fallback shim (first available state) — Phase 2 walks
    // the call sites and plumbs the scope through one at a time.
    getGitDiffState?: (scope?: string) => PersistedGitDiffState | null;
    setGitDiffState?: (state: PersistedGitDiffState | null) => void;
    getGitDiffSnapshots?: () => { headSnapshot: Snapshot; baseSnapshot: Snapshot } | null;
    setGitDiffSnapshots?: (s: { headSnapshot: Snapshot; baseSnapshot: Snapshot } | null) => void;
    getAiReviewResult?: () => AiReviewResult | null;
    setAiReviewResult?: (r: AiReviewResult | null) => void;
    getReplayAfterDiff?: () => boolean;
    setReplayAfterDiff?: (v: boolean) => void;
    getGitHubToken?: () => string | undefined;
    setGitHubToken?: (token: string | undefined) => void;
    getGitHubUser?: () => { login: string; avatar_url: string; html_url: string } | null;
    setGitHubUser?: (user: { login: string; avatar_url: string; html_url: string } | null) => void;
    /**
     * Fetch the GitHub profile for an access token. Returns null on any
     * failure (network / 401 / parse). Used by the connectGitHub handler so
     * the browser sees username + avatar right after connection.
     */
    fetchGitHubUser?: (token: string) => Promise<{ login: string; avatar_url: string; html_url: string } | null>;
    /**
     * Run the full GitHub connect lifecycle: trigger VS Code's auth provider,
     * fetch the user profile on success, and broadcast every state change to
     * the connected browser tab. The `source` argument is recorded in
     * analytics (`uri_handler` | `ws_message`) so we can tell which entry
     * point the user actually used.
     */
    performGitHubConnect?: (source: string, originClientId?: string) => Promise<void>;

    // Git diff operation callbacks (extension only; standalone uses ./gitDiff helpers directly)
    handleRequestGitDiff?: (sourcePanelId: string, repoId?: string) => Promise<void>;
    handleCommitSelected?: (sourcePanelId: string, baseHash: string, headHash: string, repoId?: string) => Promise<void>;
    handleBranchSelected?: (sourcePanelId: string, branchName: string, repoId?: string) => Promise<void>;
    handleRequestPrDiff?: (sourcePanelId: string, repoId?: string) => Promise<void>;
    handleRequestBranchDiff?: (sourcePanelId: string, repoId?: string) => Promise<void>;
    handlePrSelected?: (sourcePanelId: string, prNumber: number, repoId?: string) => Promise<void>;
    handleClearGitDiff?: () => void;

    // Builder callback
    buildWorkspaceInfo?: () => any;

    // Helper functions (cross-runtime)
    notifyBrowser: (level: 'info' | 'warning' | 'error', message: string) => void;
    refreshViews?: () => void;
    log: (msg: string) => void;

    /**
     * Route a request that historically opened a VS Code webview panel to the
     * welcome page instead. Per user directive, diagrams render only at
     * localhost:7742 in the user's browser. Optional — standalone doesn't
     * have a welcome panel.
     */
    routeDiagramToWelcome?: (graphId: string, mode: string, graph: any, label: string) => void;
}

/**
 * Issue #194: Consistent error wrapper for all handler functions.
 * Logs errors to output channel AND broadcasts to browser clients.
 */
export async function withErrorHandling(
    ctx: HandlerContext,
    handlerName: string,
    fn: () => Promise<void>,
): Promise<void> {
    try {
        await fn();
    } catch (err: any) {
        const message = err?.message ?? String(err);
        ctx.log(`[${handlerName}] Error: ${message}`);
        ctx.notifyBrowser('error', `${handlerName} failed: ${message.slice(0, 150)}`);
    }
}

/**
 * Type for a message handler function.
 * Each handler module exports a function matching this signature.
 */
export type MessageHandler = (
    message: any,
    sourcePanelId: string,
    ctx: HandlerContext,
) => Promise<void> | void;
