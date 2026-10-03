/**
 * Typed message protocol between extension host and webview.
 * All messages are typed to ensure compile-time safety.
 *
 * Issue 243: Protocol version — increment when message shapes change.
 * Webview should check version on first message and warn if mismatched.
 *
 * 6-layer navigation:
 * microservice → feature → api-list → sequence → file → function → source
 */

/** Current protocol version. Increment when message shapes change. */
export const PROTOCOL_VERSION = 1;

export type ViewMode = 'sequence' | 'file' | 'flow' | 'feature' | 'microservice' | 'api-list' | 'health' | 'map' | 'domain' | 'tour' | 'screen-content';

// Extension -> Webview messages
export type ExtensionToWebviewMessage =
    | { type: 'updateGraph'; graphId: string; graph: any }
    | { type: 'setMode'; mode: ViewMode }
    | { type: 'highlightNode'; nodeId: string }
    | { type: 'clearHighlights' }
    | { type: 'showComments'; comments: any[] }
    | { type: 'updateSettings'; settings: any }
    | { type: 'showImpact'; impact: any }
    // #827 — regression-scope composer result (changed entities, blast
    // radius, tests-to-run, untested blast radius, runner command).
    | { type: 'regressionScopeData'; scope: any; repo: string | null }
    // #817 — cross-repo push: a producer repo's API surface changed and
    // consumer repos' edges transitioned. Consumer tabs refresh / badge.
    | { type: 'crossRepoEdgeChanged'; producerRepoId: string; producerRepoName: string; edges: Array<{ consumerRepoId: string; consumerRepoName: string; method: string; route: string; diff: string | null; prevDiff?: string | null }>; at: number }
    // #826 — overlay contract: registered overlays + toggle state, and one
    // overlay's joined values for a specific graph.
    | { type: 'overlayState'; overlays: Array<{ id: string; displayName: string; enabled: boolean; paint: string; emptyHint?: string; renderManaged: boolean }> }
    | { type: 'overlayData'; overlayId: string; graphId: string; values: Record<string, { value: number; severity?: string; pointCount: number }>; unresolvedCount: number; totalPoints: number; empty: boolean; emptyHint?: string }
    | { type: 'highlightNodes'; highlights: Array<{ filePath: string; functionName: string; impactKind: string; matchReason?: string }> }
    // Push a new diagram onto the webview's navigation history stack
    | { type: 'navigateTo'; graphId: string; mode: ViewMode; graph: any; label: string }
    // Theme switch — sent to all open panels
    | { type: 'setTheme'; theme: 'dark' | 'light' }
    // Git diff mode: sent to all open panels when a commit diff session starts or ends
    | { type: 'setGitDiffContext'; baseHash: string; headHash: string; baseLabel: string; headLabel: string }
    | { type: 'clearGitDiffContext' }
    // Initialize progress — sent during workspace scanning/building
    | { type: 'initProgress'; phase: string; progress: number; message: string }
    // Issue #733 — echoes the current `codeatlas.domainLlmRefinementEnabled`
    // value so the HomePage chip reflects the persisted state. Sent once
    // on webview connect + after the user toggles the chip + after the
    // setting changes externally (via VS Code Settings UI).
    | { type: 'domainLlmRefinementState'; enabled: boolean }
    // #851 — PR watcher state for the HomePage card. Sent on request, after
    // a toggle, and on every watcher status change (poll start/end). When
    // the surface can't run a watcher (e.g. no git remote), `status` still
    // arrives so the card can render the reason.
    | {
        type: 'prWatcherStatus';
        status: {
            enabled: boolean;
            repoSlug: string | null;
            tokenPresent: boolean;
            llmKeyPresent: boolean;
            intervalMs: number;
            lastPollAt: number | null;
            lastResult: string | null;
            lastError: string | null;
            reviewedCount: number;
            polling: boolean;
        } | null;
    }
    // Issue #702 / #736 — the requested tour's ordered step list.
    | { type: 'tourSteps'; mode: 'codebase' | 'recent'; steps: any[] }
    // ADR-034 Phase G follow-up — workspace mode + per-repo registry
    // surface for multi-repo features (AI Review scope picker, future
    // per-repo views). Sent after `WorkspaceOrchestrator.initialize()`,
    // after `retryRepo` completes, and after `resync` completes. Single-
    // repo workspaces broadcast `{ mode: 'single', repos: [<the-one>] }`
    // so consumers get a uniform shape.
    | { type: 'workspaceState'; mode: 'single' | 'multi'; repos: Array<{
        repoId: string;
        name: string;
        rootPath: string;
        status: 'parsing' | 'ready' | 'failed' | 'stale';
        diff: 'added' | 'modified' | 'deleted' | 'unchanged' | null;
    }> }
    // ADR-034 Phase G follow-up — fired once the workspace fan-out
    // (`requestFullReview` with `workspaceScope.kind='workspace'`) has
    // settled. Each per-repo recursive review emits its own
    // `aiFindingAdded` / `aiFindings` / etc. as usual; this message just
    // marks the end of the iteration with per-repo durations + ok/failed.
    | { type: 'aiReviewWorkspaceComplete'; durationMs: number; repoCount: number; repos: Array<{
        repoId: string;
        name: string;
        durationMs: number;
        status: 'ok' | 'failed';
        error?: string;
    }> }
    // Browser mode: workspace metadata for home screen
    | { type: 'workspaceInfo'; name: string; fileCount: number; apiCount: number; serviceCount: number; clusterCount: number; screenCount?: number /* v2 phase 3 #484 — FE/mobile L2a screen total; undefined on pre-v2 builds */; initialized: boolean; isAuthenticated: boolean; userEmail?: string; userId?: string; userFirstName?: string; userLastName?: string; hasGitRemote: boolean; gitHubConnected: boolean; gitHubUser?: { login: string; avatar_url: string; html_url: string }; gitRemoteOwner?: string; gitRemoteRepo?: string; editorUriScheme?: string; extensionId?: string; llmProvider?: string; llmModel?: string; llmEndpoint?: string; services?: Array<{ id: string; name: string; rootPath: string }> /* Issue 108: drives service-name prefix in breadcrumbs for multi-service monorepos */ }
    // Browser mode: server-assigned WebSocket client id, sent once on 'ready'.
    // Browser stores this and includes it in deep links (e.g.
    // `${editorUriScheme}://${extensionId}/connect-github?cid=...`) so the
    // extension can route results back to the originating tab specifically
    // instead of broadcasting to every open browser tab.
    | { type: 'clientId'; clientId: string }
    // Browser mode: structured GitHub auth result. Replaces / supplements
    // the transient `showNotification` toast with a persistent banner the
    // browser can render so the user always knows whether the auth dance
    // they kicked off in the editor succeeded or failed.
    | { type: 'githubAuthCompleted'; status: 'success' | 'failure'; user: { login: string; avatar_url: string; html_url: string } | null; error?: string }
    // Browser mode: explorer tree data for floating sidebar
    | { type: 'explorerData'; services: any[]; features: any[]; apis: any[]; files: any[]; functions: any[] }
    // Browser mode: commit picker for git diff (replaces VS Code quickPick)
    | { type: 'showCommitPicker'; commits: Array<{ hash: string; shortHash: string; subject: string; author: string; relativeDate: string }>; mode: 'base' | 'both' }
    // Browser mode: PR picker with list of open PRs
    | { type: 'showPrPicker'; owner: string; repo: string; prs: Array<{ number: number; title: string; author: string; branch: string; updatedAt: string; isDraft: boolean }> }
    // Browser mode: search picker (replaces VS Code quickPick)
    | { type: 'showSearchPicker'; items: Array<{ id: string; label: string; description: string; kind: string }> }
    // Browser mode: function picker (replaces VS Code quickPick)
    | { type: 'showFunctionPicker'; functions: Array<{ name: string; filePath: string }> }
    // Browser mode: file download (replaces VS Code openTextDocument)
    | { type: 'downloadFile'; filename: string; content: string; mimeType: string }
    // Browser mode: impact analysis file picker
    | { type: 'showFilePicker'; files: Array<{ path: string; label: string }> }
    // Browser mode: branch picker for branch diff
    | { type: 'showBranchPicker'; branches: Array<{ name: string; isCurrent: boolean; isRemote: boolean }> }
    // Browser mode: toast notification (replaces VS Code showInformationMessage/showWarningMessage/showErrorMessage)
    | { type: 'showNotification'; level: 'info' | 'warning' | 'error'; message: string }
    // LLM Test Connection result (broadcast after `testLlmConnection`)
    | { type: 'llmConnectionTestResult'; ok: boolean; message: string; latencyMs?: number }
    // NL Query Engine: loading state and result metadata
    // Live Impact Replay + Change Log
    | { type: 'changeLogEntry'; entry: any }
    | { type: 'changeLogFull'; entries: any[] }
    | { type: 'replayStep'; step: { index: number; total: number; functionName: string; filePath: string; layer: string } }
    | { type: 'replayStarted'; totalSteps: number }
    | { type: 'replayStopped' }
    // Commit Timeline Replay
    | { type: 'showCommitRangePicker'; commits: Array<{ hash: string; shortHash: string; subject: string; author: string; relativeDate: string }>; branches?: Array<{ name: string; isCurrent: boolean; isRemote: boolean }>; currentBranch?: string; baselineHash?: string }
    | { type: 'timelineReplayStep'; step: any }
    | { type: 'timelineReplayCommitStart'; index: number; total: number; hash: string; subject: string }
    | { type: 'timelineReplayEnd' }
    | { type: 'timelineReplayPaused' }
    | { type: 'timelineReplayResumed' }
    // AI Review: LLM-powered code review bubbles on diff diagram nodes
    | { type: 'aiReviewResult'; result: any }
    | { type: 'aiReviewLoading'; loading: boolean; progress?: string }
    | { type: 'aiReviewCleared' }
    /**
     * Issue 609: classified AI Review failure — surfaces a specific banner
     * instead of a generic toast. `kind` mirrors `LlmErrorKind` plus
     * `evidence-gate-too-strict` (signalled when every finding was rejected
     * by the gate). `rawResponse` is the captured LLM body for the
     * "View raw response" debug link.
     */
    | { type: 'aiReviewError'; kind: 'network' | 'auth' | 'rate-limit' | 'model-not-found' | 'server-error' | 'schema-invalid' | 'evidence-gate-too-strict' | 'unknown'; message: string; rawResponse?: string; provider?: string; status?: number }
    /** Issue 609: dismiss the error banner. Sent by the UI. */
    | { type: 'aiReviewErrorDismiss' }
    /**
     * Issue 608: pre-flight cost estimate response. The UI requests this
     * via `requestReviewCostEstimate` BEFORE starting a review and shows
     * the result in a confirm modal.
     */
    | { type: 'reviewCostEstimate'; entryPointCount: number; estimatedUSD: number; model: string; provider?: string; pricingIsEstimate: boolean; budgetCapUSD: number; willExceedCap: boolean; summary: string };

// Webview -> Extension messages
export type WebviewToExtensionMessage =
    | { type: 'nodeClicked'; nodeId: string; nodeType: string; anchor?: any }
    | { type: 'edgeClicked'; edgeId: string; anchor?: any }
    | { type: 'openSource'; filePath: string; line?: number; column?: number; charOffset?: number }
    | { type: 'openFileDiagram'; filePath: string; newWindow?: boolean }
    | { type: 'openFunctionFlow'; filePath: string; functionName: string; newWindow?: boolean }
    | { type: 'openSequenceForApi'; apiId: string; newWindow?: boolean }
    | { type: 'openFeatureDiagram'; serviceId: string; newWindow?: boolean }
    | { type: 'openApiListForCluster'; clusterId: string; serviceId: string; subClusterFiles?: string[]; newWindow?: boolean }
    | { type: 'openMicroserviceDiagram'; newWindow?: boolean }
    // Issue #700 — Knowledge Map (workspace-wide unified diagram). Singleton
    // graphId (`map:workspace`), no per-service variant; HomePage card sends
    // this when the user clicks "🗺 Map".
    | { type: 'openMapDiagram'; newWindow?: boolean }
    // Issue #701 — Domain graph (business-intent clusters). Singleton
    // `domain:workspace` graphId.
    | { type: 'openDomainDiagram'; newWindow?: boolean }
    // Issue #733 — toggle the optional Domain LLM refinement. The
    // deterministic heuristic always runs; this enables the on-top
    // enhancement pass.
    | { type: 'setDomainLlmRefinement'; enabled: boolean }
    // #851 — PR watcher card: fetch current status / flip the toggle.
    | { type: 'getPrWatcherStatus' }
    | { type: 'setPrWatcherEnabled'; enabled: boolean }
    // Issue #702 / #736 — request a guided onboarding tour. `mode`
    // defaults to 'codebase' (fan-in DESC); 'recent' orders by diff.
    | { type: 'requestTour'; mode?: 'codebase' | 'recent'; maxSteps?: number }
    | { type: 'openFeatureForService'; serviceId: string; newWindow?: boolean }
    // ADR-034 Phase E (#790 — Phase E: failure isolation UX + multi-repo cascade tests (ADR-034)) — retry a failed repo's init in isolation.
    // Sent by the L1 service node's "Retry" button when status='failed'.
    | { type: 'retryRepo'; repoId: string }
    // #912 — `repoId` (optional) scopes the blast radius to a sub-repo's store
    // in multi-repo workspaces; `nodeId` is optional for the home-card path
    // (which supplies only a file).
    | { type: 'requestImpact'; nodeId?: string; filePath: string; functionName?: string; repoId?: string }
    // #912 — per-repo Markdown + Mermaid architecture export (browser surface).
    // `repoId` selects the sub-repo store; omitted ⇒ primary/workspace.
    | { type: 'requestArchitectureExport'; repoId?: string }
    // #827 — request the regression-scope composition (tests-to-run +
    // untested blast radius). `repo` scopes to a sub-repo in multi-repo
    // workspaces; omitted = primary/single repo.
    | { type: 'requestRegressionScope'; repo?: string }
    // #826 — overlay contract requests.
    | { type: 'requestOverlayState' }
    | { type: 'setOverlayEnabled'; overlayId: string; enabled: boolean }
    | { type: 'requestOverlayData'; overlayId: string; graphId: string }
    | { type: 'addComment'; targetId: string; targetType: 'node' | 'edge'; body: string; layer?: ViewMode; anchor?: { filePath?: string; symbol?: string } }
    | { type: 'resolveComment'; commentId: string }
    // Notify extension of the graphId currently shown in this panel (for live-update routing)
    | { type: 'panelNavigated'; graphId: string }
    // Issue 111: Navigate to L1 System Design from any layer
    | { type: 'navigateHome' }
    // Git diff: user clicked "Compare Commits" or "✕ Reset" button in the webview header
    | { type: 'requestGitDiff' }
    | { type: 'clearGitDiff' }
    | { type: 'ready' }
    // Browser mode: trigger extension commands
    | { type: 'runCommand'; command: string; args?: any[] }
    // Browser mode: request explorer data refresh
    | { type: 'requestExplorerData' }
    // URL routing: webview requests a diagram by route slug
    | { type: 'requestRoute'; route: string; param?: string; param2?: string }
    // Browser mode: commit selection from CommitPicker
    | { type: 'commitSelected'; baseHash: string; headHash: string }
    // Browser mode: PR number selection from PrPicker
    | { type: 'prSelected'; prNumber: number }
    // Browser mode: theme toggle
    | { type: 'toggleTheme' }
    // Browser mode: search result selected
    | { type: 'searchSelected'; id: string; kind: string }
    // Browser mode: function flow selected
    | { type: 'functionSelected'; filePath: string; functionName: string }
    // Browser mode: file selected for impact analysis
    | { type: 'fileSelectedForImpact'; filePath: string; repoId?: string }
    // Browser mode: connect to GitHub for PR access
    | { type: 'connectGitHub' }
    // Browser mode: branch diff
    | { type: 'requestBranchDiff' }
    | { type: 'branchSelected'; branchName: string }
    // NL Query Engine: user submits or clears a natural language query
    // Live Impact Replay + Change Log
    | { type: 'requestChangeLog' }
    | { type: 'navigateToChangeEntry'; entryId: string }
    | { type: 'playbackChangeLog'; action: 'play' | 'pause' }
    | { type: 'stopReplay' }
    // Commit Timeline Replay
    | { type: 'startTimelineReplay'; commits: Array<{ hash: string; shortHash: string; subject: string; author: string; relativeDate: string }> }
    | { type: 'timelineReplayControl'; action: 'pause' | 'resume' | 'stop' | 'skipCommit' | 'next' | 'prev' }
    | { type: 'timelineReplaySpeed'; speedMs: number }
    | { type: 'requestTimelineCommits'; branch: string }
    | { type: 'replayCurrentDiff' }
    | { type: 'replayWorkingDiff' }
    | { type: 'requestPrDiffReplay' }
    | { type: 'requestBranchDiffReplay' }
    | { type: 'replayFromFile'; filePath: string }
    // NL Query Engine: browser/webview — user configures LLM connection
    | { type: 'setLlmConfig'; apiKey?: string; provider?: string; model?: string; endpoint?: string }
    // LLM Test Connection — probe the configured endpoint with a free / read-only request.
    | { type: 'testLlmConnection' }
    // AI Review: request/clear LLM-powered code review
    | { type: 'requestAiReview' }
    | { type: 'clearAiReview' }
    | { type: 'resolveAiReview'; reviewId: string }
    | { type: 'ignoreAiReview'; reviewId: string }
    | { type: 'reopenAiReview'; reviewId: string };

export function createUpdateGraphMessage(graphId: string, graph: any): ExtensionToWebviewMessage {
    return { type: 'updateGraph', graphId, graph };
}

export function createSetModeMessage(mode: ViewMode): ExtensionToWebviewMessage {
    return { type: 'setMode', mode };
}

// Handler receives both the message and the ID of the panel it came from
export type MessageHandler = (message: WebviewToExtensionMessage, sourcePanelId: string) => void;
