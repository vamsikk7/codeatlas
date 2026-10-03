import React, { useState, useEffect, useCallback, useReducer, useRef, useMemo } from 'react';
import DiagramView from './components/DiagramView';
import SavedViewsToolbar from './components/SavedViewsToolbar';
import TourView from './components/TourView';
import ViolationsView from './components/ViolationsView';
import ErrorBoundary from './components/ErrorBoundary';
import ExportMenu from './components/ExportMenu';
import HomePage from './components/HomePage';
import CommandBar from './components/CommandBar';
import ExplorerSidebar from './components/ExplorerSidebar';
import CommitPicker from './components/CommitPicker';
import PrPicker from './components/PrPicker';
import SearchPicker, { type PickerItem } from './components/SearchPicker';
import { LayerLegend } from './components/OnboardingHints';
import PathFinderModal, { type FunctionItem as PathFinderFunctionItem } from './components/PathFinderModal';
import ApiTestingView, { type ApiTestingPayload } from './components/ApiTestingView';
import ChainRunnerModal, { type ChainRunResult } from './components/ChainRunnerModal';
import TimelineBar from './components/TimelineBar';
import CommitRangePicker from './components/CommitRangePicker';
import ReplayControls from './components/ReplayControls';
import TourPlaybackControls from './components/TourPlaybackControls';
import TextPromptModal from './components/TextPromptModal';
import { shouldStopTourOnNavigate } from './lib/tourPlayback';
import { shouldDismissFileScopedPanel } from './lib/panelDismiss';
import { shouldShowNavLoader, isReplayActive } from './lib/navLoader';
import CommentsPanel from './components/CommentsPanel';
import AiReviewErrorBanner, { type AiReviewErrorState } from './components/AiReviewErrorBanner';
import { UpstreamChangesChip, type UpstreamChangeEntry } from './components/UpstreamChangesChip';
import { decideCrossRepoAction, type CrossRepoEdgeChangedMsg } from './crossRepoPushClient';
import { OverlaysPanel, type OverlayRowState } from './components/OverlaysPanel';
import { overlayEmptyToastDecision } from './lib/overlayEmptyToast';
import { trackWebviewEvent } from './analytics';
import { setFindings, addFindings, updateFinding, setCounts, markFindingsStale, getState as getFindingsState } from './components/ai-review/aiReviewBus';
import { prettifyGraphLabel } from './lib/prettifyGraphLabel';
import { categoryFromGraph } from './lib/entryPointLabel';
import { outsideRouteTitle } from './lib/outsideRouteTitle';
import { resolveL1ClickAction } from './lib/l1ClickAction';
import { participantHasNoTarget, edgeHasNoTarget, participantDeadEndMessage, MESSAGE_DEAD_END_EDGE } from './lib/seqDeadEnd';
import { graphIdToScopedHash, graphIdToHash, expectedGraphIdForRoute } from './lib/hashRoutes';

declare global {
    interface Window {
        vscodeApi?: {
            postMessage: (msg: any) => void;
            getState: () => any;
            setState: (state: any) => void;
        };
        initialMode?: string;
    }
}

type ViewMode = 'sequence' | 'file' | 'flow' | 'feature' | 'microservice' | 'api-list' | 'health' | 'screen-content' | 'map' | 'domain' | 'tour';

interface GraphData {
    graphId: string;
    type: string;
    nodes: any[];
    edges: any[];
    anchors: Record<string, any>;
    meta: Record<string, any>;
    // Issue #736 — Tour mode reuses the GraphData slot in nav entries to
    // carry tour-specific payload. Both optional so non-tour entries
    // continue to pass type-checking unchanged.
    steps?: any[];
    tourMode?: 'codebase' | 'recent';
}

/**
 * Open a source file in the user's editor. When we know the editor's URI
 * scheme (sent by the extension in workspaceInfo), we open the deep link —
 * the OS focuses the editor BEFORE the file opens, so the user actually
 * sees the navigation instead of the editor opening in the background.
 *
 * Falls back to a plain WS message if the scheme isn't known yet (browser
 * connected before the first workspaceInfo arrived, or the extension is an
 * older build that doesn't send these fields).
 *
 * Used by every flow / file / sequence / impact-panel click that ends in
 * "open the source for this symbol."
 */
function openSourceViaEditor(
    filePath: string,
    opts: { line?: number; column?: number; charOffset?: number },
    editorUriScheme: string | undefined,
    extensionId: string | undefined,
    clientId: string | null,
): void {
    if (editorUriScheme && extensionId) {
        const params = new URLSearchParams({ file: filePath });
        if (opts.line != null) params.set('line', String(opts.line));
        if (opts.column != null) params.set('col', String(opts.column));
        if (opts.charOffset != null) params.set('offset', String(opts.charOffset));
        if (clientId) params.set('cid', clientId);
        window.location.href = `${editorUriScheme}://${extensionId}/open-source?${params.toString()}`;
    } else {
        (window as any).vscodeApi?.postMessage({
            type: 'openSource',
            filePath,
            ...(opts.line != null && { line: opts.line }),
            ...(opts.column != null && { column: opts.column }),
            ...(opts.charOffset != null && { charOffset: opts.charOffset }),
        });
    }
}

// ─── Hash routing helpers ────────────────────────────────────────────────────

/** Convert a graphId to a URL hash path */
// 2026-06-09 — scope-aware variant for system-design / map per-repo views.
// `graph.meta.scopedRepo` is set by the extension when a multi-repo
// workspace user picked a sub-repo from the home picker.
/** Parse hash into a route request. Returns null for home route. */
/**
 * HOME-2 (2026-06-07): single source of truth for "is the current hash
 * the home route?". The render guard at the bottom of App and the
 * hashchange listener both consult this, and the listener uses it to
 * bypass `suppressHashChange` so direct URL nav to `#/home` always
 * resets `showHome=true` regardless of what the app was doing.
 */
export function isHomeHashRoute(hash: string): boolean {
    if (!hash) return true;
    return hash === '#' || hash === '#/' || hash === '#/home';
}

// UX-63 (2026-06-09) — map a per-repo diff/replay route to the
// corresponding extension message. Returns true when a matching route is
// handled (caller skips the generic `requestRoute` dispatch). The hash
// listener owns the URL; this helper translates URL → message so the
// `repoId` flows through to the handler.
function dispatchDiffReplayRoute(route: { route: string; param?: string }): boolean {
    const repoId = route.param;
    switch (route.route) {
        case 'replay-working':
            window.vscodeApi?.postMessage({ type: 'replayWorkingDiff', repoId });
            return true;
        case 'compare-commits':
            window.vscodeApi?.postMessage({ type: 'requestGitDiff', repoId });
            return true;
        case 'branch-diff':
            window.vscodeApi?.postMessage({ type: 'requestBranchDiff', repoId });
            return true;
        case 'pr-diff':
            window.vscodeApi?.postMessage({ type: 'runCommand', command: 'codeatlas.openPrDiff', repoId });
            return true;
        case 'replay-pr':
            window.vscodeApi?.postMessage({ type: 'requestPrDiffReplay', repoId });
            return true;
        case 'replay-branch':
            window.vscodeApi?.postMessage({ type: 'requestBranchDiffReplay', repoId });
            return true;
        case 'timeline-replay':
            window.vscodeApi?.postMessage({ type: 'runCommand', command: 'codeatlas.timelineReplay', repoId });
            return true;
        default:
            return false;
    }
}

export function parseHash(hash: string): { route: string; param?: string; param2?: string } | null {
    let path = hash.replace(/^#\/?/, '');
    try { path = decodeURIComponent(path); } catch { /* keep as-is */ }
    if (!path || path === 'home') return null; // home page

    if (path === 'system-design') return { route: 'system-design' };
    // 2026-06-09 — per-repo scoped L1 in multi-repo workspaces.
    const sysScopeMatch = path.match(/^system-design\/(.+)$/);
    if (sysScopeMatch) return { route: 'system-design', param: sysScopeMatch[1] };
    if (path === 'health') return { route: 'health' };
    // UX-69 (2026-06-09) — per-repo Health drill-in.
    const healthScopeMatch = path.match(/^health\/(.+)$/);
    if (healthScopeMatch) return { route: 'health', param: healthScopeMatch[1] };
    if (path === 'features') return { route: 'features' };
    if (path === 'map') return { route: 'map' };
    // 2026-06-09 — per-repo scoped Map in multi-repo workspaces.
    const mapScopeMatch = path.match(/^map\/(.+)$/);
    if (mapScopeMatch) return { route: 'map', param: mapScopeMatch[1] };
    // Bug B (2026-06-04): accept plural `#/domains` as an alias for the
    // canonical singular `domain` route — plural is the natural typo and
    // without this the SPA silently hangs on "Connecting…".
    if (path === 'domain' || path === 'domains') return { route: 'domain' };
    // 2026-06-09 — per-repo scoped Domain Map.
    const domScopeMatch = path.match(/^domain(?:s)?\/(.+)$/);
    if (domScopeMatch) return { route: 'domain', param: domScopeMatch[1] };
    if (path === 'tour') return { route: 'tour' };
    // ADR-034 Phase H Pass 3 (#793) — `#/tour/<repoId>` per-repo tour.
    const tourMatch = path.match(/^tour\/(.+)$/);
    if (tourMatch) return { route: 'tour', param: tourMatch[1] };
    if (path === 'api-testing') return { route: 'api-testing' };
    // UX-68 (2026-06-09) — per-repo API Testing scope.
    const apiTestingScopeMatch = path.match(/^api-testing\/(.+)$/);
    if (apiTestingScopeMatch) return { route: 'api-testing', param: apiTestingScopeMatch[1] };
    // UX-63 (2026-06-09) — per-repo diff / replay deep-links. Each route
    // accepts the bare workspace form for legacy single-repo or the
    // `<route>/<repoId>` form for the multi-repo picker. The corresponding
    // message handler in standalone messageHandler.ts reads `param` as
    // `repoId` and switches to the per-repo snapshotStore.
    if (path === 'replay-working') return { route: 'replay-working' };
    const replayWorkingMatch = path.match(/^replay-working\/(.+)$/);
    if (replayWorkingMatch) return { route: 'replay-working', param: replayWorkingMatch[1] };
    if (path === 'compare-commits') return { route: 'compare-commits' };
    const compareCommitsMatch = path.match(/^compare-commits\/(.+)$/);
    if (compareCommitsMatch) return { route: 'compare-commits', param: compareCommitsMatch[1] };
    if (path === 'branch-diff') return { route: 'branch-diff' };
    const branchDiffMatch = path.match(/^branch-diff\/(.+)$/);
    if (branchDiffMatch) return { route: 'branch-diff', param: branchDiffMatch[1] };
    if (path === 'pr-diff') return { route: 'pr-diff' };
    const prDiffMatch = path.match(/^pr-diff\/(.+)$/);
    if (prDiffMatch) return { route: 'pr-diff', param: prDiffMatch[1] };
    if (path === 'replay-pr') return { route: 'replay-pr' };
    const replayPrMatch = path.match(/^replay-pr\/(.+)$/);
    if (replayPrMatch) return { route: 'replay-pr', param: replayPrMatch[1] };
    if (path === 'replay-branch') return { route: 'replay-branch' };
    const replayBranchMatch = path.match(/^replay-branch\/(.+)$/);
    if (replayBranchMatch) return { route: 'replay-branch', param: replayBranchMatch[1] };
    if (path === 'timeline-replay') return { route: 'timeline-replay' };
    const timelineReplayMatch = path.match(/^timeline-replay\/(.+)$/);
    if (timelineReplayMatch) return { route: 'timeline-replay', param: timelineReplayMatch[1] };
    // Issue #749 — architecture rule violations view.
    if (path === 'violations') return { route: 'violations' };

    const featureMatch = path.match(/^features\/(.+)$/);
    if (featureMatch) return { route: 'features', param: featureMatch[1] };

    const apisMatch = path.match(/^apis\/(.+)$/);
    if (apisMatch) return { route: 'apis', param: apisMatch[1] };

    const seqMatch = path.match(/^sequence\/(.+)$/);
    if (seqMatch) return { route: 'sequence', param: seqMatch[1] };

    const fileMatch = path.match(/^file\/(.+)$/);
    if (fileMatch) return { route: 'file', param: fileMatch[1] };

    // #444-B: accept either `/` or `:` as the file→function separator. The
    // canonical graph-id form is `flow:<filePath>:<functionName>`, so users
    // pasting a graph-id-shaped hash should also navigate cleanly.
    const flowMatch = path.match(/^flow\/(.+)[\/:]([^\/:]+)$/);
    if (flowMatch) return { route: 'flow', param: flowMatch[1], param2: flowMatch[2] };

    return null;
}

// ─── Navigation history ───────────────────────────────────────────────────────

const MAX_NAV_STACK = 50; // Issue 100: cap nav stack to prevent unbounded memory growth

export interface NavEntry { graphId: string; mode: ViewMode; graph: GraphData; label: string }
export interface NavState { stack: NavEntry[]; index: number }
export type NavAction =
    | { type: 'push'; entry: NavEntry }
    | { type: 'go'; index: number }
    | { type: 'updateByGraphId'; graphId: string; graph: GraphData }
    | { type: 'clear' };

/**
 * BREAD-1 (2026-06-07): graphIds that represent the workspace-root view of
 * a layer. Navigating to one of these is the architectural equivalent of
 * "go to the top of layer X" — the breadcrumb should restart there rather
 * than appending after whatever deeper view the user was on. Without this,
 * clicking System Design from inside a sequence/file view produced a
 * non-monotonic breadcrumb like `APIs › sequence › System Design › file`.
 */
const WORKSPACE_ROOT_GRAPH_IDS: ReadonlySet<string> = new Set([
    'microservice:workspace',
    'feature:workspace',
    'map:workspace',
    'domain:workspace',
    'tour:workspace',
    'health:report',
]);

export function navReducer(state: NavState, action: NavAction): NavState {
    switch (action.type) {
        case 'push': {
            const existingIndex = state.stack.findIndex(e => e.graphId === action.entry.graphId);
            if (existingIndex >= 0 && existingIndex <= state.index) {
                const trimmed = state.stack.slice(0, existingIndex + 1);
                trimmed[existingIndex] = { ...trimmed[existingIndex], graph: action.entry.graph };
                return { stack: trimmed, index: existingIndex };
            }
            // BREAD-1: workspace-root entries reset the stack — the user is
            // jumping to the top of a layer, not drilling deeper. The
            // existing-index branch above already handles the "click root
            // that's already at index 0" case; this branch handles "first
            // visit to a workspace-root graph after a deep drill-in".
            //
            // #784 (2026-06-07): only reset when the PRIOR entry is a deep
            // drill-in. If the prior entry is itself a workspace-root, the
            // user is layer-hopping at the top (e.g. System Design → Feature
            // Areas) and back-navigation should be able to undo it — so push
            // normally, don't reset. Without this guard, landing directly at
            // #/system-design and then clicking Feature Areas leaves the
            // stack as just `[feature:workspace]`, and clicking back drops
            // the user straight to home instead of System Design.
            if (WORKSPACE_ROOT_GRAPH_IDS.has(action.entry.graphId)) {
                const prior = state.stack[state.index];
                const priorIsWorkspaceRoot = !!prior && WORKSPACE_ROOT_GRAPH_IDS.has(prior.graphId);
                if (!priorIsWorkspaceRoot) {
                    return { stack: [action.entry], index: 0 };
                }
                // Fall through to the normal push path so back-nav works
                // across root-to-root hops.
            }
            const newStack = [...state.stack.slice(0, state.index + 1), action.entry];
            // Issue 100: Trim stack if it exceeds max
            const trimmed = newStack.length > MAX_NAV_STACK ? newStack.slice(-MAX_NAV_STACK) : newStack;
            return { stack: trimmed, index: trimmed.length - 1 };
        }
        case 'go':
            return { ...state, index: Math.max(0, Math.min(action.index, state.stack.length - 1)) };
        case 'updateByGraphId':
            return {
                ...state,
                stack: state.stack.map(e => {
                    if (e.graphId !== action.graphId) return e;
                    // 2026-06-09 — don't let a workspace-wide updateGraph
                    // for `microservice:workspace` / `map:workspace`
                    // overwrite a per-repo scoped entry. The graphId is
                    // shared between scoped and unscoped views; refusing
                    // the swap only when the incoming graph is UNSCOPED
                    // (no scopedRepo) keeps the user on their picked scope
                    // while still permitting a scope→scope transition
                    // (e.g. user picks a different repo from the picker
                    // without going home first).
                    const existingScope = (e.graph as any)?.meta?.scopedRepo;
                    const incomingScope = (action.graph as any)?.meta?.scopedRepo;
                    if (existingScope && !incomingScope) return e;
                    return { ...e, graph: action.graph };
                }),
            };
        case 'clear':
            return { stack: [], index: -1 };
    }
}

// ─── App ─────────────────────────────────────────────────────────────────────

export interface WorkspaceInfo {
    name: string;
    /** Issue #431: full workspace path — used by the SPA to detect a
     *  workspace switch (browser still open, extension restarted in a
     *  different workspace) and force a `location.reload()` to discard
     *  the stale in-memory snapshot. */
    workspaceRoot?: string;
    fileCount: number;
    apiCount: number;
    serviceCount: number;
    /** Issue 108: optional service list used to compute a service-name
     *  prefix in breadcrumbs for multi-service monorepos. */
    services?: Array<{ id: string; name: string; rootPath: string }>;
    /** #917 — extraction-confidence signal: drives the Home confidence chip
     *  ("N entry points across K frameworks") + the per-repo GAP banner. */
    extractionConfidence?: {
        totalEntryPoints: number;
        frameworkCount: number;
        gaps: Array<{ service: string; technology: string }>;
    };
    clusterCount: number;
    /** v2 phase 3 #484 — FE/mobile L2a screen total. Surfaced on the
     *  home stats row when > 0 (backend-only repos don't see the chip). */
    screenCount?: number;
    /** Diagram counts by prefix (file:* / flow:* / sequence:*). Surfaced on
     *  the home stats row so the user sees coverage at a glance. */
    fileGraphCount?: number;
    flowGraphCount?: number;
    sequenceGraphCount?: number;
    initialized: boolean;
    isAuthenticated: boolean;
    userEmail?: string;
    userId?: string;
    userFirstName?: string;
    userLastName?: string;
    hasGitRemote: boolean;
    gitHubConnected: boolean;
    gitHubUser?: { login: string; avatar_url: string; html_url: string };
    gitRemoteOwner?: string;
    gitRemoteRepo?: string;
    editorUriScheme?: string;
    extensionId?: string;
    /**
     * Issue #776: identifies the extension build currently serving the
     * webview (`<version>.<buildNumber>`). The SPA compares this to its
     * own compile-time `__CODEATLAS_VERSION__.__CODEATLAS_BUILD__` on
     * first workspaceInfo arrival; on mismatch the page hard-reloads
     * to fetch the new JS and drop any stale cached graph state.
     */
    extensionBundleId?: string;
    /**
     * MCP standalone bundle version (only present when the server is
     * `@codeatlas/mcp` running with `--browser`, not when the VS Code
     * extension is serving). The webview-ui itself is compiled with the
     * EXTENSION version+build defines (`webview-ui/vite.config.ts` reads
     * `../package.json`), so the footer shows `v6.X.Y.Z` regardless of
     * which surface is serving. When `mcpServerVersion` is set, the
     * footer also renders an explicit `MCP <version>` badge so end users
     * running `npx @codeatlas/mcp@<version>` can confirm which standalone
     * they're connected to.
     */
    mcpServerVersion?: string | null;
    llmProvider?: string;
    llmModel?: string;
    llmEndpoint?: string;
}

/**
 * Single-source version display for the webview. When the server is the
 * MCP standalone (`@codeatlas/mcp`), `wsInfo.mcpServerVersion` carries
 * its semver; we show that. Otherwise the webview was bundled from the
 * extension build (`webview-ui/vite.config.ts` reads `../package.json`),
 * so the build-time defines `__CODEATLAS_VERSION__` + `__CODEATLAS_BUILD__`
 * are the right thing to show. Picking one stamp avoids the confusing
 * "v6.X.Y.Z · MCP 2.X.Y" double-label when both happen to be set.
 *
 * Exported so unit tests can pin the choice rule.
 */
export function formatAppVersion(mcpServerVersion: string | null | undefined): string {
    if (mcpServerVersion) return `CodeAtlas MCP v${mcpServerVersion}`;
    return `CodeAtlas v${__CODEATLAS_VERSION__}${__CODEATLAS_BUILD__ ? `.${__CODEATLAS_BUILD__}` : ''}`;
}

/**
 * Issue #431: when the extension switches to a different workspace while
 * the browser tab stays open, the previous workspace's snapshot remains in
 * React state and overlays the new one. Compare the incoming workspaceRoot
 * against the last one we observed in sessionStorage; if it changed,
 * trigger a full page reload to clear all in-memory state cleanly. Storing
 * in sessionStorage rather than module state keeps it stable across the
 * reload itself (so the freshly-loaded SPA records the new root once and
 * doesn't loop).
 *
 * Exported for unit testing.
 */
export function maybeReloadOnWorkspaceSwitch(
    incomingRoot: string | undefined,
    storage: Pick<Storage, 'getItem' | 'setItem'>,
    reload: () => void,
): boolean {
    if (!incomingRoot) return false;
    const KEY = 'codeatlas:workspaceRoot';
    const last = storage.getItem(KEY);
    if (last && last !== incomingRoot) {
        storage.setItem(KEY, incomingRoot);
        reload();
        return true;
    }
    if (!last) storage.setItem(KEY, incomingRoot);
    return false;
}

/**
 * Issue #776: when a fresh VSIX is installed but the browser tab stays
 * open, the React tree keeps the old bundle's cached graph state in
 * memory. On the next navigation, the L2a / L2b / L3 / etc. surfaces
 * render that stale state on first paint before the WS push arrives,
 * which looks like a regression during live-verify. Mirror the
 * `maybeReloadOnWorkspaceSwitch` pattern: compare the incoming bundle
 * id (semver + build) against the last one we recorded; on mismatch,
 * force a hard reload to clear all in-memory state cleanly.
 *
 * Exported for unit testing.
 */
export function maybeReloadOnBundleSwitch(
    incomingBundle: string | undefined,
    storage: Pick<Storage, 'getItem' | 'setItem'>,
    reload: () => void,
): boolean {
    if (!incomingBundle) return false;
    const KEY = 'codeatlas:bundleBuild';
    const last = storage.getItem(KEY);
    if (last && last !== incomingBundle) {
        storage.setItem(KEY, incomingBundle);
        reload();
        return true;
    }
    if (!last) storage.setItem(KEY, incomingBundle);
    return false;
}

interface GitDiffContext {
    baseHash: string;
    headHash: string;
    baseLabel: string;
    headLabel: string;
}

interface CommitPickerState {
    commits: Array<{ hash: string; shortHash: string; subject: string; author: string; relativeDate: string }>;
    mode: 'base' | 'both';
}

interface PrPickerState {
    owner: string;
    repo: string;
    prs: Array<{ number: number; title: string; author: string; branch: string; updatedAt: string; isDraft: boolean }>;
    isReplay?: boolean;
}

function App() {
    const [navState, navDispatch] = useReducer(navReducer, { stack: [], index: -1 });
    const [loading, setLoading] = useState(true);
    const [initProgress, setInitProgress] = useState<{ phase: string; progress: number; message: string } | null>(null);
    const [impactData, setImpactData] = useState<any | null>(null);
    // BUG-EXPLORE-11: in-webview comment composer (replaces native window.prompt).
    const [commentComposer, setCommentComposer] = useState<{ nodeId: string; layer: ViewMode; anchor: any } | null>(null);
    const [highlightedNodes, setHighlightedNodes] = useState<Record<string, string>>({});
    const [highlightReasons, setHighlightReasons] = useState<Record<string, string>>({});
    const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId: string; nodeData: any } | null>(null);
    const [gitDiffContext, setGitDiffContext] = useState<GitDiffContext | null>(null);
    const [explorerVisible, setExplorerVisible] = useState(false);
    const [showHome, setShowHome] = useState(() => {
        const isBrowser = !!(window as any).__codeAtlasBrowserMode;
        if (!isBrowser) return false; // VS Code webview: wait for extension to send navigateTo
        const parsed = parseHash(window.location.hash);
        return parsed === null; // browser mode: show home if hash is / or /home or empty
    });
    const [wsInfo, setWsInfo] = useState<WorkspaceInfo | null>(null);
    // Server-assigned WebSocket client id; included as `?cid=` on deep links
    // (e.g. the connect-github URI handler) so the extension can route
    // success/failure responses back to THIS tab specifically instead of
    // broadcasting to every connected browser tab.
    const [clientId, setClientId] = useState<string | null>(null);
    // Browser ↔ extension WebSocket connection status. The wsBridge dispatches
    // a `ws-status` CustomEvent on connect / disconnect / reconnecting; we
    // surface a banner when not connected so the user knows why diagrams
    // aren't updating instead of staring at a stale view.
    const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
    // Issue #754: surfaced when the WS bridge has failed to reconnect
    // 3+ times in a row. Typical cause: VS Code restarted while the
    // browser tab was kept open; the prior session's client id is
    // rejected. We render a top-of-page banner with a Reload button
    // so the user has an actionable signal instead of a silent loop.
    const [wsStuck, setWsStuck] = useState(false);
    // Issue #749: track when the URL is a route that lives outside the
    // graph-based nav stack (currently just `#/violations`). The
    // dedicated render bypasses the diagram canvas while still
    // honouring breadcrumbs + theme + WS banner.
    const [outsideRoute, setOutsideRoute] = useState<string | null>(() => {
        const parsed = parseHash(window.location.hash);
        return parsed?.route === 'violations' ? 'violations' : null;
    });
    useEffect(() => {
        const handler = () => {
            const parsed = parseHash(window.location.hash);
            setOutsideRoute(parsed?.route === 'violations' ? 'violations' : null);
        };
        window.addEventListener('hashchange', handler);
        return () => window.removeEventListener('hashchange', handler);
    }, []);

    // Bug A (2026-06-04): outside-routes (violations, tour, api-testing)
    // bypass the navState-driven title update, so `document.title` would
    // inherit whatever the previous view set ("Health Report" persisting
    // on /violations was the original bug). Pin the title explicitly.
    useEffect(() => {
        if (outsideRoute) {
            const suffix = outsideRouteTitle(outsideRoute);
            if (suffix) document.title = `CodeAtlas — ${suffix}`;
        }
    }, [outsideRoute]);
    // GitHub auth result banner — replaces the transient toast for the
    // GitHub flow so the user always sees a clear "what happened" state
    // when they switch back to the browser tab after the editor's auth
    // dialog finished.
    const [githubAuthBanner, setGithubAuthBanner] = useState<
        | { status: 'success'; user: { login: string; avatar_url: string; html_url: string } | null }
        | { status: 'failure'; error?: string }
        | null
    >(null);
    const [currentTheme, setCurrentTheme] = useState<'dark' | 'light'>('dark');
    const [commitPicker, setCommitPicker] = useState<CommitPickerState | null>(null);
    const [prPicker, setPrPicker] = useState<PrPickerState | null>(null);
    const [searchPicker, setSearchPicker] = useState<{ title: string; placeholder: string; items: PickerItem[]; kind: string } | null>(null);
    // Issue #707 — Path Finder modal. `open` toggles the modal; `result`
    // holds the latest server response so the modal re-renders inline.
    // `functions` is populated from the explorerData broadcast so we don't
    // need a separate request round-trip on open.
    const [pathFinderOpen, setPathFinderOpen] = useState(false);
    const [pathFinderResult, setPathFinderResult] = useState<any | null>(null);
    const [pathFinderFunctions, setPathFinderFunctions] = useState<PathFinderFunctionItem[]>([]);
    // Issue #601 — API Testing surface state. Populated on demand when
    // the user navigates to `#/api-testing` (auto-fetched via the
    // matching `requestApiTesting` message in the route effect below).
    const [apiTestingPayload, setApiTestingPayload] = useState<ApiTestingPayload | null>(null);
    const [showApiTesting, setShowApiTesting] = useState(false);
    // Issue #602 — keyed by requestId so multiple in-flight requests don't
    // collide. Phase 2.5 will persist history; v1 lives in memory only.
    const [apiTestingResponses, setApiTestingResponses] = useState<Record<string, any>>({});
    // #744 — generated request-body proposals keyed by apiId.
    const [apiTestingBodyProposals, setApiTestingBodyProposals] = useState<Record<string, import('./components/ApiTestingView').GeneratedRequestBodyState>>({});
    // #744 (2026-06-06) — generated chain proposal. Single in-flight
    // chain at a time so a single slot is enough.
    const [apiTestingChainProposal, setApiTestingChainProposal] = useState<import('./components/ApiTestingView').GeneratedChainState | undefined>(undefined);
    // #744 (2026-06-06) — generated test cases keyed by apiId.
    const [apiTestingTestCases, setApiTestingTestCases] = useState<Record<string, import('./components/ApiTestingView').GeneratedTestCasesState>>({});
    // #745 — current/last import operation state. Only one import is
    // in-flight at a time, so a single slot is enough.
    const [apiTestingImportState, setApiTestingImportState] = useState<import('./components/ApiTestingView').ImportApiCollectionState | undefined>(undefined);
    // #745 (2026-06-06) — OAuth2 AuthTab state. Three per-flow slots
    // (client-credentials / authorize-url / exchange-code), one
    // in-flight at a time per flow so individual fields suffice.
    const [authTabState, setAuthTabState] = useState<import('./components/AuthTab').AuthTabState>({});
    // #745 (2026-06-06) — WebSocket + SSE tab state (one connection at a time).
    const [wsTabState, setWsTabState] = useState<import('./components/WebSocketTab').WebSocketTabState | undefined>(undefined);
    const [sseTabState, setSseTabState] = useState<import('./components/SseTab').SseTabState | undefined>(undefined);
    // #750 (2026-06-06) — saved filter views (loaded once on bootstrap +
    // refreshed after every save/delete round-trip).
    const [savedFilterViews, setSavedFilterViews] = useState<import('./components/SavedViewsToolbar').SavedFilterView[]>([]);
    // Issue #603 — chain runner modal state.
    const [chainRunnerOpen, setChainRunnerOpen] = useState(false);
    const [chainEnvText, setChainEnvText] = useState<string>('base=http://localhost:3000\n');
    const [chainResult, setChainResult] = useState<ChainRunResult | null>(null);
    const [branchPicker, setBranchPicker] = useState<{ branches: Array<{ name: string; isCurrent: boolean; isRemote: boolean }>; isReplay?: boolean } | null>(null);
    const [appToast, setAppToast] = useState<{ text: string; level: string } | null>(null);
    // #817 (2026-06-11) — pending cross-repo pushes for tabs NOT scoped to
    // an affected consumer (passive badge; see crossRepoPushClient.ts).
    const [upstreamChanges, setUpstreamChanges] = useState<UpstreamChangeEntry[]>([]);
    // #826 (2026-06-11) — overlay contract: panel rows + open state. Rows
    // arrive via `overlayState`; data fetches mark rows known-empty so the
    // panel shows the adapter's empty hint inline.
    const [overlayRows, setOverlayRows] = useState<OverlayRowState[]>([]);
    const [overlaysPanelOpen, setOverlaysPanelOpen] = useState(false);
    // BUG-EXPLORE-16 — overlays we've already flagged as empty via a canvas
    // toast, so navigating between graphs doesn't re-nag. Cleared per overlay
    // when its data later shows up (see overlayEmptyToastDecision).
    const emptyOverlayToastRef = useRef<Set<string>>(new Set());
    // graphId → overlayId → nodeId → value. Applied at render time so the
    // nav stack's graphs stay pristine (one render path, no graph mutation).
    const [overlayValues, setOverlayValues] = useState<Record<string, Record<string, Record<string, { value: number; severity?: string; pointCount: number }>>>>({});
    const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
    const [comments, setComments] = useState<any[]>([]);
    const [commentsPanelVisible, setCommentsPanelVisible] = useState(false);
    const [changeLog, setChangeLog] = useState<any[]>([]);
    const [replayState, setReplayState] = useState<{ index: number; total: number; functionName: string; layer: string } | null>(null);
    const [commitRangePicker, setCommitRangePicker] = useState<{ commits: any[]; branches?: any[]; currentBranch?: string; baselineHash?: string } | null>(null);
    const [timelineReplay, setTimelineReplay] = useState<{ step: any; commitInfo: { index: number; total: number; hash: string; subject: string } | null; paused: boolean } | null>(null);
    // UX-PAGE-LOADER — a transient overlay between a manual navigation click and
    // the next layer's render, so the user gets immediate feedback instead of
    // staring at the stale page during the round-trip. Excluded during replay
    // (see navLoader.ts). `navPending` is armed when we dispatch a manual
    // requestRoute and cleared when navigateTo/updateGraph lands (or the timer
    // fires, so it can never stick).
    const [navPending, setNavPending] = useState(false);
    const navPendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const replayActiveRef = useRef(false);
    const beginNav = useCallback(() => {
        if (replayActiveRef.current) return; // never flash the loader during replay
        setNavPending(true);
        if (navPendingTimer.current) clearTimeout(navPendingTimer.current);
        // Safety net: auto-clear so a dropped/absent navigateTo can't strand the overlay.
        navPendingTimer.current = setTimeout(() => setNavPending(false), 6000);
    }, []);
    const endNav = useCallback(() => {
        if (navPendingTimer.current) { clearTimeout(navPendingTimer.current); navPendingTimer.current = null; }
        setNavPending(false);
    }, []);
    // Tour playback — walks message edges of an L3 sequence diagram one at
    // a time after the user hits "Play" on a tour step. Purely client-side;
    // the server just serves the sequence graph as it would for any other
    // drill-down. `pendingGraphId` is set the instant Play is clicked and
    // cleared when `navigateTo` for that graph arrives, at which point we
    // seed the walker from `graph.edges`.
    const [tourPlayback, setTourPlayback] = useState<{
        stepIndex: number;
        steps: any[];
        pendingGraphId: string | null;
        edgeIds: string[];
        edgeLabels: string[];
        msgIndex: number;
        paused: boolean;
        speedMs: number;
    } | null>(null);
    const tourPlaybackRef = useRef<typeof tourPlayback>(null);
    useEffect(() => { tourPlaybackRef.current = tourPlayback; }, [tourPlayback]);
    // Keep the replay-active ref fresh so beginNav (called from message-handler
    // closures) sees the current replay state, and clear any pending nav loader
    // the instant a replay starts.
    useEffect(() => {
        replayActiveRef.current = isReplayActive(replayState, timelineReplay);
        if (replayActiveRef.current && navPendingTimer.current) {
            clearTimeout(navPendingTimer.current); navPendingTimer.current = null; setNavPending(false);
        }
    }, [replayState, timelineReplay]);

    // Kicked by TourView when the user clicks Play on a tour step. Stashes
    // the step list + the graphId we're about to navigate to, then fires the
    // standard requestRoute — the navigateTo handler picks the pending state
    // up and seeds the walker.
    const handleTourPlayStep = useCallback((stepIndex: number, steps: any[]) => {
        const step = steps[stepIndex];
        if (!step?.drillDownGraphId) return;
        setTourPlayback({
            stepIndex,
            steps,
            pendingGraphId: step.drillDownGraphId,
            edgeIds: [],
            edgeLabels: [],
            msgIndex: 0,
            paused: false,
            speedMs: 2000,
        });
        try { (window as any).vscodeApi?.postMessage({ type: 'requestRoute', graphId: step.drillDownGraphId }); } catch { /* noop */ }
    }, []);

    // Ticker: advance to the next message every `speedMs` while playing. When
    // we hit the end of a step's messages, auto-advance to the next tour step
    // (which re-runs the request flow). On the very last step we stop.
    useEffect(() => {
        if (!tourPlayback || tourPlayback.paused || tourPlayback.pendingGraphId) return;
        if (tourPlayback.edgeIds.length === 0) return;
        const timer = window.setTimeout(() => {
            setTourPlayback(prev => {
                if (!prev || prev.paused || prev.pendingGraphId) return prev;
                if (prev.msgIndex < prev.edgeIds.length - 1) {
                    return { ...prev, msgIndex: prev.msgIndex + 1 };
                }
                // End of this step — auto-advance to the next step if any.
                const nextStepIndex = prev.stepIndex + 1;
                if (nextStepIndex >= prev.steps.length) return prev;
                const next = prev.steps[nextStepIndex];
                if (!next?.drillDownGraphId) return prev;
                try { (window as any).vscodeApi?.postMessage({ type: 'requestRoute', graphId: next.drillDownGraphId }); } catch { /* noop */ }
                return {
                    ...prev,
                    stepIndex: nextStepIndex,
                    pendingGraphId: next.drillDownGraphId,
                    edgeIds: [],
                    edgeLabels: [],
                    msgIndex: 0,
                };
            });
        }, tourPlayback.speedMs);
        return () => window.clearTimeout(timer);
    }, [tourPlayback]);

    const handleTourPlaybackControl = useCallback((action: 'pause' | 'resume' | 'stop' | 'skipStep' | 'next' | 'prev') => {
        setTourPlayback(prev => {
            if (!prev) return prev;
            switch (action) {
                case 'pause': return { ...prev, paused: true };
                case 'resume': return { ...prev, paused: false };
                case 'next':
                    if (prev.msgIndex < prev.edgeIds.length - 1) return { ...prev, msgIndex: prev.msgIndex + 1, paused: true };
                    return prev;
                case 'prev':
                    if (prev.msgIndex > 0) return { ...prev, msgIndex: prev.msgIndex - 1, paused: true };
                    return prev;
                case 'skipStep': {
                    const nextStepIndex = prev.stepIndex + 1;
                    if (nextStepIndex >= prev.steps.length) return prev;
                    const next = prev.steps[nextStepIndex];
                    if (!next?.drillDownGraphId) return prev;
                    try { (window as any).vscodeApi?.postMessage({ type: 'requestRoute', graphId: next.drillDownGraphId }); } catch { /* noop */ }
                    return {
                        ...prev,
                        stepIndex: nextStepIndex,
                        pendingGraphId: next.drillDownGraphId,
                        edgeIds: [],
                        edgeLabels: [],
                        msgIndex: 0,
                        paused: false,
                    };
                }
                case 'stop': return null;
            }
            return prev;
        });
    }, []);
    // ADR-034 Phase G follow-up — workspace registry pushed from the extension
    // after init/retry/resync. Single-repo workspaces still receive a single-
    // entry list so downstream consumers get a uniform shape.
    const [workspaceState, setWorkspaceState] = useState<{
        mode: 'single' | 'multi';
        repos: Array<{ repoId: string; name: string; rootPath: string; status: string; diff: string | null }>;
    } | null>(null);
    // UX-72 (2026-06-09) — counts pushed by the extension after every
    // workspace cascade. HomePage renders these as the init progress
    // banner (e.g. "130/132 ready, 2 failed").
    const [multiRepoInitStats, setMultiRepoInitStats] = useState<{
        total: number;
        ready: number;
        parsing: number;
        failed: number;
        stale: number;
        failures: Array<{ repoId: string; name?: string; rootPath?: string; errorMessage?: string }>;
        receivedAt: number;
    } | null>(null);
    // Issue 609 — last classified review error. Rendered as a banner on the
    // home page until dismissed or until the next review starts.
    const [aiReviewError, setAiReviewError] = useState<AiReviewErrorState | null>(null);

    // AI Review is home-only now (the "Code Review" card on the home screen).
    // The in-diagram AI review — toggle overlay, per-node markers, layer chips,
    // scoped panel, and finding popover — was removed, along with the
    // `ca:openAiReviewPanel` / `ca:openAiFindingPopover` event plumbing that
    // hosted it here.
    // Issue 192: Removed forceUpdate anti-pattern — theme state change triggers re-render naturally

    // Guard against hashchange → navigateTo loops
    const suppressHashChange = useRef(false);
    // Track whether initial navigateTo has been received (for dedup with requestRoute)
    const initialNavReceived = useRef(false);
    // Ref that tracks showHome so the message handler closure can read the latest value
    const showHomeRef = useRef(showHome);
    useEffect(() => { showHomeRef.current = showHome; }, [showHome]);

    // Auth gate — a signed-out browser session may not view diagrams; force the
    // home screen (which renders the sign-in gate) whenever we're not
    // authenticated, so a diagram can't stay on screen after sign-out / on a
    // signed-out load. The server also refuses gated messages authoritatively.
    useEffect(() => {
        const isBrowser = !!(window as { __codeAtlasBrowserMode?: boolean }).__codeAtlasBrowserMode;
        if (isBrowser && wsInfo && !wsInfo.isAuthenticated) setShowHome(true);
    }, [wsInfo]);

    // Listen for WebSocket connection state changes from `wsBridge.ts`. The
    // bridge emits a `ws-status` CustomEvent on every transition; surfacing
    // the state in a banner gives the browser-mode user clear feedback
    // instead of a silent freeze when the localhost extension restarts.
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as 'connecting' | 'connected' | 'disconnected';
            if (detail) setWsStatus(detail);
        };
        window.addEventListener('ws-status', handler);
        // Seed initial state if the bridge already connected before mount.
        const initial = (window as any).vscodeApi?.getConnectionState?.();
        if (initial) setWsStatus(initial);
        return () => window.removeEventListener('ws-status', handler);
    }, []);

    // Issue #754: pickup stuck/cleared events from the WS bridge so the
    // user sees an actionable banner instead of a silent reconnect loop.
    useEffect(() => {
        const onStuck = () => setWsStuck(true);
        const onCleared = () => setWsStuck(false);
        window.addEventListener('ws-stuck', onStuck);
        window.addEventListener('ws-stuck-cleared', onCleared);
        return () => {
            window.removeEventListener('ws-stuck', onStuck);
            window.removeEventListener('ws-stuck-cleared', onCleared);
        };
    }, []);

    // Issue 134: clicking a 💬 comment badge on any diagram node opens the
    // Comments Panel so the user can read comment text + navigate to other
    // commented nodes. Badges in AtlasNode / SequenceNode / FlowNode /
    // MicroserviceView / FeatureView dispatch this event.
    useEffect(() => {
        const openComments = () => setCommentsPanelVisible(true);
        window.addEventListener('codeatlas:open-comments', openComments);
        return () => window.removeEventListener('codeatlas:open-comments', openComments);
    }, []);
    // Ref that tracks current graphId so the message handler can deduplicate pushes
    const currentGraphIdRef = useRef<string | null>(null);
    const wsInfoRef = useRef(wsInfo);
    useEffect(() => {
        wsInfoRef.current = wsInfo;
        // 3.3.2: auth gate removed — diagrams are accessible without sign-in.
        // The legacy "force-back-to-home + sign-in toast" branch is gone.
        if (false) {
            setShowHome(true);
            setLoading(false);
            setAppToast({ text: '', level: 'warning' });
            setTimeout(() => setAppToast(null), 4000);
        }
    }, [wsInfo]);

    const currentEntry = navState.index >= 0 ? navState.stack[navState.index] : null;

    // #826 — request overlay data for the current graph whenever the graph
    // or the enabled set changes. Bootstrap the state rows on first mount.
    const currentGraphId = currentEntry?.graphId ?? null;
    const enabledOverlayIds = overlayRows.filter((r) => r.enabled && !r.renderManaged).map((r) => r.id).join(',');
    useEffect(() => {
        window.vscodeApi?.postMessage({ type: 'requestOverlayState' });
    }, []);
    useEffect(() => {
        if (!currentGraphId || !enabledOverlayIds) return;
        for (const id of enabledOverlayIds.split(',')) {
            window.vscodeApi?.postMessage({ type: 'requestOverlayData', overlayId: id, graphId: currentGraphId });
        }
    }, [currentGraphId, enabledOverlayIds]);
    currentGraphIdRef.current = currentEntry?.graphId ?? null;
    const mode: ViewMode = currentEntry?.mode ?? ((window.initialMode as ViewMode) ?? 'file');
    const rawGraph = currentEntry?.graph ?? null;
    // #826 — apply enabled overlay values at render time (ONE render path;
    // the nav stack's graphs stay pristine). Each painted node carries
    // `meta.overlays: Array<{overlayId, value, severity, pointCount}>`
    // which AtlasNode renders as a generic chip.
    const graph = useMemo(() => {
        if (!rawGraph) return rawGraph;
        const perOverlay = overlayValues[rawGraph.graphId];
        if (!perOverlay) return rawGraph;
        const enabledIds = new Set(overlayRows.filter((r) => r.enabled && !r.renderManaged).map((r) => r.id));
        const active = Object.entries(perOverlay).filter(([id]) => enabledIds.has(id));
        if (active.length === 0) return rawGraph;
        let touched = false;
        const nodes = rawGraph.nodes.map((n: any) => {
            const hits: Array<{ overlayId: string; value: number; severity?: string; pointCount: number }> = [];
            for (const [overlayId, values] of active) {
                const v = (values as any)[n.id];
                if (v) hits.push({ overlayId, ...v });
            }
            if (hits.length === 0) return n;
            touched = true;
            return { ...n, meta: { ...(n.meta ?? {}), overlays: hits } };
        });
        return touched ? { ...rawGraph, nodes } : rawGraph;
    }, [rawGraph, overlayValues, overlayRows]);

    // Issue 108: derive the owning service for the current entry so the
    // breadcrumb can prepend its name in multi-service monorepos. Strategy:
    //   • L2a feature graphs encode the service in `feature:service:<id>`.
    //   • L2b / L3 / L4 / L5 graphs encode a file path — match the longest
    //     `service.rootPath` prefix from `wsInfo.services`.
    //   • L1 microservice graphs are workspace-level → no prefix.
    const currentServiceName = useMemo<string | null>(() => {
        const services = wsInfo?.services;
        if (!services || services.length < 2) return null;
        if (!currentEntry) return null;
        const gid = currentEntry.graphId;
        if (gid === 'microservice:workspace' || gid === 'feature:workspace') return null;
        // L2a feature:service:<id>
        if (gid.startsWith('feature:service:')) {
            const svcId = gid.slice('feature:'.length);
            return services.find((s) => s.id === svcId)?.name ?? null;
        }
        // L2b / L3 / L4 / L5 — extract file-path-ish suffix and prefix-match
        let pathLike = '';
        if (gid.startsWith('file:')) pathLike = gid.slice('file:'.length);
        else if (gid.startsWith('sequence:')) pathLike = gid.slice('sequence:'.length).split(':')[0];
        else if (gid.startsWith('flow:')) pathLike = gid.slice('flow:'.length).split(':')[0];
        else if (gid.startsWith('api-list:')) {
            // api-list:cluster:<id> doesn't carry filePath — fall back to graph.meta.files[0] if present
            const files = (currentEntry.graph as any)?.meta?.files as string[] | undefined;
            pathLike = files?.[0] ?? '';
        }
        if (!pathLike) return null;
        // Longest-prefix match (sorted by descending rootPath length to handle nested services).
        const sorted = services
            .filter((s) => s.rootPath && pathLike.startsWith(s.rootPath + '/'))
            .sort((a, b) => b.rootPath.length - a.rootPath.length);
        return sorted[0]?.name ?? null;
    }, [wsInfo?.services, currentEntry]);


    // ─── Hash routing: request initial route on mount ────────────────────────
    useEffect(() => {
        // Issue 136: If hash is empty, show homepage (don't restore from localStorage).
        // Users navigating to localhost:7742 or localhost:7742/# expect the homepage.
        if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/' || window.location.hash === '#/home') {
            setShowHome(true);
            // Don't setLoading(false) yet — wait for workspaceInfo to arrive
            // so the home renders with real stats instead of zero placeholders.
            // The workspaceInfo handler below drops loading; the 8-second
            // timeout in the message-handler useEffect is the safety net.
            document.title = 'CodeAtlas';
            return;
        }
        const route = parseHash(window.location.hash);
        if (route) {
            // Hash is set (e.g., page refresh or direct URL) — leave home so navigateTo is accepted
            // Set both state AND ref synchronously so the message handler sees the update immediately
            setShowHome(false);
            showHomeRef.current = false;
            // Issue UX-4 follow-up (2026-06-03 v2) — route-specific bootstrap.
            // `#/tour` requires `requestTour` to fetch tour steps (the SPA
            // sits on a "Loading…" placeholder until `mode === 'tour'`),
            // and `#/api-testing` requires `requestRoute { route:
            // 'api-testing' }` which the standalone routes to its special
            // builder. Without these per-route messages the safety-net
            // timeout fires after 8s and the user sees a stuck spinner.
            let replayFallback: ReturnType<typeof setTimeout> | undefined;
            if (route.route === 'tour') {
                window.vscodeApi?.postMessage({ type: 'requestTour', mode: route.param === 'recent' ? 'recent' : 'codebase', repoId: (route.param && route.param !== 'recent' && route.param !== 'codebase' && route.param !== 'workspace') ? route.param : undefined });
            } else if (route.route === 'api-testing') {
                window.vscodeApi?.postMessage({ type: 'requestRoute', route: 'api-testing', param: route.param });
            } else if (dispatchDiffReplayRoute(route)) {
                // BUG-POLAR-28: a replay DEEP-LINK (#/replay-working etc.) can resolve
                // to "no working changes" — the handler answers with an info toast and
                // NO navigateTo, so nothing clears the initial spinner and the SPA hangs
                // on "Loading…" (the hashchange path has this fallback; the initial-mount
                // path did not). Clear loading + fall back to Home if no diagram lands.
                replayFallback = setTimeout(() => {
                    if (!initialNavReceived.current) {
                        setLoading(false);
                        setShowHome(true);
                    }
                }, 3500);
            } else {
                window.vscodeApi?.postMessage({ type: 'requestRoute', route: route.route, param: route.param, param2: route.param2 });
            }
            return () => { if (replayFallback) clearTimeout(replayFallback); };
        }
    }, []);

    // ─── UX-28 (2026-06-05) — re-request route when WS reconnects ─────────────
    // Cold deep-link race: the SPA's initial-mount useEffect above posts a
    // `requestRoute` immediately on mount. In multi-repo workspaces the
    // server may not have built the requested graph (e.g.
    // `api-list:cluster:http-api`) yet at message-arrival time, so the
    // server logs `Diagram not found` and broadcasts a `clientToast` —
    // the SPA stays on "Loading…". When the server's init pipeline
    // completes and the cluster's api-list graph lands, no further
    // navigateTo arrives because the request was already dropped.
    //
    // Re-post the route request when (a) the bridge reports connected
    // AFTER mount AND (b) we never received a navigateTo. The server
    // by then has finished cascade and the second request finds the
    // graph. Safe to fire multiple times — handleRequestRoute is
    // idempotent (broadcasts navigateTo with whatever the current
    // working snapshot has).
    useEffect(() => {
        if (wsStatus !== 'connected') return;
        if (initialNavReceived.current) return;
        if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/' || window.location.hash === '#/home') return;
        const route = parseHash(window.location.hash);
        if (!route) return;
        // Debounce so we don't spam the server every time wsStatus flips.
        const t = setTimeout(() => {
            if (initialNavReceived.current) return;
            if (route.route === 'tour') {
                window.vscodeApi?.postMessage({ type: 'requestTour', mode: route.param === 'recent' ? 'recent' : 'codebase', repoId: (route.param && route.param !== 'recent' && route.param !== 'codebase' && route.param !== 'workspace') ? route.param : undefined });
            } else if (route.route === 'api-testing') {
                window.vscodeApi?.postMessage({ type: 'requestRoute', route: 'api-testing', param: route.param });
            } else if (!dispatchDiffReplayRoute(route)) {
                window.vscodeApi?.postMessage({ type: 'requestRoute', route: route.route, param: route.param, param2: route.param2 });
            }
        }, 1500);
        return () => clearTimeout(t);
    }, [wsStatus]);

    // Ref for route fallback timer
    const routeFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ─── Hash routing: listen for browser back/forward ───────────────────────
    useEffect(() => {
        const onHashChange = () => {
            // HOME-2 (2026-06-07): the user navigating to `#/home` must
            // ALWAYS reset to HomePage, even if a programmatic hash sync
            // had just set `suppressHashChange`. Previously the suppress
            // flag swallowed the home reset, leaving `showHome=false` and
            // the previously-rendered graph in place.
            if (isHomeHashRoute(window.location.hash)) {
                suppressHashChange.current = false;
                setShowHome(true);
                showHomeRef.current = true;
                document.title = 'CodeAtlas';
                return;
            }
            if (suppressHashChange.current) {
                suppressHashChange.current = false;
                return;
            }
            const route = parseHash(window.location.hash);
            if (route === null) {
                setShowHome(true);
                document.title = 'CodeAtlas';
            } else {
                // 3.3.2: auth gate removed — every route is accessible to
                // both signed-in and unsigned users.
                setShowHome(false);
                showHomeRef.current = false;
                // Issue UX-4 follow-up (2026-06-03 v2) — same per-route
                // bootstrap as the initial-mount useEffect. `#/tour` needs
                // `requestTour` (otherwise the SPA hangs on "Loading…"
                // until the 5-second fallback below); `#/api-testing`
                // needs the route variant the standalone special-cases.
                if (route.route === 'tour') {
                    window.vscodeApi?.postMessage({ type: 'requestTour', mode: route.param === 'recent' ? 'recent' : 'codebase', repoId: (route.param && route.param !== 'recent' && route.param !== 'codebase' && route.param !== 'workspace') ? route.param : undefined });
                } else if (route.route === 'api-testing') {
                    window.vscodeApi?.postMessage({ type: 'requestRoute', route: 'api-testing', param: route.param });
                } else if (dispatchDiffReplayRoute(route)) {
                    // UX-63 — diff/replay routes dispatched via dedicated message types
                    // carrying `repoId`. dispatchDiffReplayRoute returns true on handle.
                } else {
                    // UX-PAGE-LOADER — a real user drill (L1→L2→L3…) via hash change.
                    // Arm the transition loader (no-op during replay) so the click
                    // gets instant feedback until the next layer renders.
                    beginNav();
                    window.vscodeApi?.postMessage({ type: 'requestRoute', route: route.route, param: route.param, param2: route.param2 });
                }
                // Fallback: if no navigateTo arrives in 5s, show home instead of stuck loading
                if (routeFallbackTimer.current) clearTimeout(routeFallbackTimer.current);
                routeFallbackTimer.current = setTimeout(() => {
                    setLoading(false);
                    if (!currentEntry) setShowHome(true);
                }, 5000);
            }
        };
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            switch (message.type) {
                case 'signInRequired': {
                    // Server refused a gated action (diagram / git / tool) because
                    // we're signed out — bounce back to the home screen, which
                    // shows the sign-in gate. The accompanying clientToast explains why.
                    setShowHome(true);
                    return;
                }
                case 'navigateTo': {
                    // BUG-EXPLORE-6: a playing tour auto-advances by requesting each
                    // step's graph; if this navigateTo is for a graph the tour did NOT
                    // request (the user navigated away themselves), stop the tour so it
                    // no longer hijacks the view.
                    if (shouldStopTourOnNavigate(tourPlaybackRef.current, message.graphId)) {
                        setTourPlayback(null);
                    }
                    // BUG-EXPLORE-8: auto-dismiss the file-scoped Impact / Blast-Radius
                    // panel when the user jumps to a non-file destination (L1 / L2 /
                    // map / domain / health) so it doesn't linger with a stale scope.
                    if (shouldDismissFileScopedPanel(message.graphId)) {
                        setImpactData((prev: unknown) => (prev ? null : prev));
                    }
                    // BUG-VERIFY-4 (cold-deep-link race): on a fresh page load
                    // of a deep link in a multi-repo workspace, the server's
                    // handleReady BROADCASTS an unsolicited initial
                    // `microservice:workspace` navigateTo. Left unguarded it
                    // clobbers the deep-link — pushing L1 and rewriting the hash
                    // to `#/system-design` before the deep-link's own graph
                    // arrives (so `#/features` refresh/bookmark bounces to
                    // System Design). Ignore an initial workspace-root broadcast
                    // that doesn't match the graphId the URL is actually asking
                    // for, until our own navigateTo lands (initialNavReceived).
                    // Warm SPA nav is unaffected (initialNavReceived is already
                    // true), and a legit `#/system-design` load still matches.
                    if (!initialNavReceived.current && !showHomeRef.current
                        && WORKSPACE_ROOT_GRAPH_IDS.has(message.graphId)) {
                        const expected = expectedGraphIdForRoute(parseHash(window.location.hash));
                        if (expected && expected !== message.graphId) {
                            break;
                        }
                    }
                    initialNavReceived.current = true;
                    if (routeFallbackTimer.current) { clearTimeout(routeFallbackTimer.current); routeFallbackTimer.current = null; }
                    // 3.3.2: auth gate removed — every navigateTo is honored
                    // regardless of sign-in status.
                    setLoading(false);
                    endNav(); // UX-PAGE-LOADER — next layer arrived; drop the transition overlay
                    // Issue 136: Don't push nav entries while on the homepage —
                    // these are stale lastBrowserNav from the extension. The user
                    // will navigate from home via card clicks which set showHome=false first.
                    if (showHomeRef.current) {
                        break;
                    }
                    // Issue 136: Skip push if the current entry already has this graphId
                    // (prevents double-push from breadcrumb click → requestRoute → navigateTo loop)
                    if (currentGraphIdRef.current === message.graphId) {
                        navDispatch({ type: 'updateByGraphId', graphId: message.graphId, graph: message.graph });
                    } else {
                        navDispatch({
                            type: 'push',
                            entry: {
                                graphId: message.graphId,
                                mode: message.mode,
                                graph: message.graph,
                                label: message.label,
                            },
                        });
                    }
                    // Tour playback: if the user pressed Play on a tour step,
                    // we stashed `pendingGraphId` matching this navigateTo.
                    // Seed the message walker from the freshly-arrived graph's
                    // message edges so the ticker can start spotlighting them
                    // one at a time.
                    if (tourPlaybackRef.current?.pendingGraphId === message.graphId) {
                        const messageEdges = (message.graph?.edges ?? []).filter((e: any) => e?.edgeType === 'message');
                        const edgeIds = messageEdges.map((e: any) => String(e.id));
                        const edgeLabels = messageEdges.map((e: any) => String(e.label ?? ''));
                        setTourPlayback(prev => prev ? {
                            ...prev,
                            pendingGraphId: null,
                            edgeIds,
                            edgeLabels,
                            msgIndex: 0,
                            paused: false,
                        } : prev);
                    }
                    // Update title and hash
                    if (!showHomeRef.current) {
                        setShowHome(false);
                        // Issue UX-6 — never show raw graphIds to the user.
                        document.title = `CodeAtlas — ${prettifyGraphLabel(message.graphId, message.label, categoryFromGraph(message.graph as any))}`;
                        {
                            // 2026-06-09 — scope-aware hash; see graphIdToScopedHash().
                            const hash = graphIdToScopedHash(message.graphId, message.graph).slice(1);
                            // 2026-06-09 — guard: an unscoped navigateTo for
                            // microservice/map MUST NOT clobber a scoped URL.
                            // The extension can push a workspace-wide
                            // updateGraph (no scopedRepo) after the user
                            // has already drilled into a per-repo view; the
                            // updateByGraphId reducer refuses the graph swap,
                            // but the hash setter here would still reset the
                            // URL — leaving render/URL out of sync.
                            const currentHashNow = window.location.hash.replace(/^#/, '');
                            const wouldUnscope =
                                (message.graphId === 'microservice:workspace' && /^\/system-design\//.test(currentHashNow) && hash === '/system-design') ||
                                (message.graphId === 'map:workspace' && /^\/map\//.test(currentHashNow) && hash === '/map') ||
                                (message.graphId === 'domain:workspace' && /^\/domain(?:s)?\//.test(currentHashNow) && (hash === '/domain' || hash === '/domains'));
                            if (wouldUnscope) {
                                break;
                            }
                            // Issue #441: only set the suppress flag if the
                            // hash will ACTUALLY change. If the SPA is
                            // setting the hash to the same value (initial
                            // load, deep-link refresh), no `hashchange`
                            // event fires to reset the flag — leaving it
                            // stuck `true` and silently suppressing the
                            // next real user-initiated hashchange. That
                            // broke deep-link navigation + browser back/
                            // forward across diagram layers.
                            const currentHash = window.location.hash.replace(/^#/, '');
                            if (currentHash !== hash) {
                                suppressHashChange.current = true;
                                window.location.hash = hash;
                            }
                            localStorage.setItem('codeatlas:lastRoute', '#' + hash);
                        }
                    }
                    break;
                }
                case 'updateGraph': {
                    navDispatch({ type: 'updateByGraphId', graphId: message.graphId, graph: message.graph });
                    setLoading(false);
                    endNav(); // UX-PAGE-LOADER — a graph the pending nav was waiting on landed
                    // Incremental L1 (Issue #785): if the SPA is currently
                    // waiting on the route this graph belongs to (user opened
                    // #/system-design before init finished, so the original
                    // requestRoute returned nothing), treat the updateGraph
                    // as the long-awaited navigateTo. Push it onto the nav
                    // stack so the diagram renders instead of staying in the
                    // loading gate. Matched by graphId → expected route via
                    // the same prefix map the hash router uses.
                    const expectedGid = (() => {
                        const ph = parseHash(window.location.hash);
                        if (!ph) return null;
                        switch (ph.route) {
                            case 'system-design': return 'microservice:workspace';
                            case 'map': return 'map:workspace';
                            case 'domain': return 'domain:workspace';
                            case 'features': return ph.param ? `feature:${ph.param}` : 'feature:workspace';
                            case 'apis': return ph.param ? `api-list:${ph.param}` : null;
                            case 'sequence': return ph.param ? `sequence:${ph.param}` : null;
                            case 'file': return ph.param ? `file:${ph.param}` : null;
                            case 'flow': return (ph.param && ph.param2) ? `flow:${ph.param}:${ph.param2}` : null;
                            case 'health': return 'health:report';
                            default: return null;
                        }
                    })();
                    const inStack = navState.stack.some(e => e.graphId === message.graphId);
                    if (expectedGid === message.graphId && !inStack && !showHomeRef.current) {
                        navDispatch({
                            type: 'push',
                            entry: {
                                graphId: message.graphId,
                                mode: message.mode ?? ((message.graph as any)?.type),
                                graph: message.graph,
                                label: message.label ?? message.graphId,
                            },
                        });
                        document.title = `CodeAtlas — ${prettifyGraphLabel(message.graphId, message.label, categoryFromGraph(message.graph as any))}`;
                    }
                    // Brief toast for live updates (#10)
                    if ((window as any).__codeAtlasBrowserMode) {
                        setAppToast({ text: 'Diagram updated', level: 'info' });
                        setTimeout(() => setAppToast(null), 1500);
                    }
                    break;
                }
                case 'setMode':
                    // Legacy — no-op; navigateTo supersedes this
                    break;
                case 'setTheme':
                    document.documentElement.dataset.theme = message.theme === 'light' ? 'light' : '';
                    setCurrentTheme(message.theme);
                    // Theme state change at setCurrentTheme above triggers re-render
                    break;
                case 'initProgress':
                    if (message.phase === 'complete') {
                        // Init/resync finished — clear the loading overlay
                        setInitProgress(null);
                        setLoading(false);
                        // Resync rebuilds the workspace but nothing re-pushes
                        // workspaceInfo, so `wsInfo` stays stale (initialized=false
                        // → the home stat cards freeze at "—" until a manual
                        // refresh remounts the app). Re-run the `ready` handshake
                        // so the server re-broadcasts fresh counts, matching how
                        // the regression banner is re-requested on the same event.
                        window.vscodeApi?.postMessage({ type: 'ready' });
                    } else {
                        setInitProgress({ phase: message.phase, progress: message.progress, message: message.message });
                    }
                    break;
                case 'showImpact':
                    setImpactData(message.impact);
                    break;
                case 'highlightNodes': {
                    const map: Record<string, string> = {};
                    const reasons: Record<string, string> = {};
                    for (const h of message.highlights ?? []) {
                        const key = `${h.filePath}::${h.functionName}`;
                        map[key] = h.impactKind;
                        if (h.matchReason) reasons[key] = h.matchReason;
                    }
                    setHighlightedNodes(map);
                    setHighlightReasons(reasons);
                    break;
                }
                case 'setGitDiffContext':
                    setGitDiffContext({
                        baseHash: message.baseHash,
                        headHash: message.headHash,
                        baseLabel: message.baseLabel,
                        headLabel: message.headLabel,
                    });
                    break;
                case 'clearGitDiffContext':
                    setGitDiffContext(null);
                    setHighlightedNodes({}); // Clear stale diff highlights (#18)
                    break;
                case 'highlightNode':
                    break;
                case 'clearHighlights':
                    setHighlightedNodes({});
                    setHighlightReasons({});
                    break;
                // AI Review messages. In-diagram AI review was removed (the home
                // "Code Review" card is the only surface now); these cases only
                // manage the home error banner. `aiReviewResult` — the old
                // in-diagram overlay trigger — is intentionally ignored, and the
                // home card tracks its own running/progress state.
                case 'aiReviewLoading':
                    // Starting a new review clears any prior error banner (#609).
                    if (message.loading) setAiReviewError(null);
                    break;
                case 'aiReviewCleared':
                    setAiReviewError(null);
                    break;
                // Issue 609 — classified review failure
                case 'aiReviewError':
                    setAiReviewError({
                        kind: message.kind, message: message.message,
                        rawResponse: message.rawResponse, provider: message.provider, status: message.status,
                    });
                    break;
                // ─── per-entry-point AI findings (#500-#502) ───────────────
                case 'aiFindings': {
                    if (Array.isArray(message.items)) setFindings(message.items, message.counts);
                    else if (message.counts) setCounts(message.counts);
                    break;
                }
                case 'aiFindingAdded': {
                    if (Array.isArray(message.findings)) addFindings(message.findings);
                    break;
                }
                case 'aiFindingUpdated': {
                    if (message.finding) updateFinding(message.finding);
                    if (message.counts) setCounts(message.counts);
                    break;
                }
                case 'aiReviewComplete': {
                    if (message.counts) setCounts(message.counts);
                    break;
                }
                case 'aiFindingsStale': {
                    // #536 — server detected baseline/guidelines drift; flip
                    // listed findings to 'stale' so they fall out of the
                    // headline count but stay reachable behind the toggle.
                    const ids = (message as { findingIds?: string[] }).findingIds;
                    if (Array.isArray(ids)) markFindingsStale(ids);
                    break;
                }
                case 'aiFindingsCleared': {
                    // #537 — wipe the bus so the popover + count chip update
                    // immediately. The server also pushes a fresh `aiFindings`
                    // payload right after, which handles narrow-scope clears
                    // (when only one entry-point worth of findings is removed).
                    setFindings([], { byGraph: {}, byEntryPoint: {}, bySeverity: { error: 0, warning: 0, info: 0 }, total: 0 });
                    break;
                }
                case 'cascadeRefresh': {
                    // Standalone tells us a file changed and the L1→L5 cascade
                    // rebuilt. Re-fetch the currently-displayed graph so the
                    // user sees diff annotations + updated counts. The home
                    // page benefits from the workspaceInfo broadcast that
                    // accompanies this message.
                    const gid = currentGraphIdRef.current;
                    if (gid) {
                        try { (window as any).vscodeApi?.postMessage({ type: 'requestRoute', graphId: gid }); } catch { /* noop */ }
                    }
                    break;
                }
                case 'workspaceState': {
                    // ADR-034 Phase G follow-up — caches the workspace
                    // registry so multi-repo features (AI Review scope
                    // picker, future per-repo views) render correctly.
                    const m = message as any;
                    setWorkspaceState({ mode: m.mode, repos: m.repos });
                    break;
                }
                case 'multiRepoInitStats': {
                    // UX-72 (2026-06-09) — multi-repo init progress feed.
                    // Emitted by `broadcastWorkspaceState` at the end of
                    // every workspace cascade; lets the home page render
                    // a "Init: ready/parsing/failed/stale" banner so the
                    // user sees progress on the 100+ repo workspaces
                    // (serverless-examples ships 132). The detailed
                    // failures payload is surfaced as a tooltip.
                    const m = message as any;
                    setMultiRepoInitStats({
                        total: Number(m.total ?? 0),
                        ready: Number(m.ready ?? 0),
                        parsing: Number(m.parsing ?? 0),
                        failed: Number(m.failed ?? 0),
                        stale: Number(m.stale ?? 0),
                        failures: Array.isArray(m.failures) ? m.failures : [],
                        receivedAt: Date.now(),
                    });
                    break;
                }
                case 'tourSteps': {
                    // Issue #702 / #736 — onboarding tour data arrived. Push
                    // a synthetic nav entry with mode='tour' so the existing
                    // breadcrumb + history machinery treats it like a normal
                    // diagram view, but the render path swaps DiagramView
                    // for TourView based on the mode.
                    // The tour broadcasts `tourSteps` instead of `navigateTo`,
                    // so the 8-second safety-net timer (which checks
                    // initialNavReceived) would otherwise fire and flip
                    // showHome → true, leaving any later `navigateTo`
                    // (e.g. the tour Play drill-down into L3) silently
                    // dropped because the handler short-circuits when
                    // showHomeRef.current is true.
                    initialNavReceived.current = true;
                    if (routeFallbackTimer.current) { clearTimeout(routeFallbackTimer.current); routeFallbackTimer.current = null; }
                    setLoading(false);
                    const label = (message as any).mode === 'recent'
                        ? 'Tour — recent changes'
                        : 'Tour — codebase walkthrough';
                    // 2026-06-09 — when the user picked a per-repo tour from
                    // the home picker, the URL is already `#/tour/<repoId>`.
                    // Stamp `meta.scopedRepo` on the entry's graph so the
                    // navState-driven title/hash effect uses the scoped form
                    // and breadcrumb/back navigation keeps the scope.
                    const tourScopeMatch = window.location.hash.match(/^#\/tour\/(.+)$/);
                    const tourScope = tourScopeMatch ? tourScopeMatch[1] : undefined;
                    navDispatch({
                        type: 'push',
                        entry: {
                            graphId: 'tour:workspace',
                            mode: 'tour',
                            graph: {
                                // Tour mode reuses the GraphData slot; the
                                // non-tour fields are stub values since
                                // TourView doesn't read them.
                                graphId: 'tour:workspace',
                                type: 'tour',
                                nodes: [],
                                edges: [],
                                anchors: {},
                                meta: { label, ...(tourScope ? { scopedRepo: tourScope } : {}) },
                                steps: (message as any).steps,
                                tourMode: (message as any).mode,
                            },
                            label,
                        },
                    });
                    setShowHome(false);
                    showHomeRef.current = false;
                    document.title = `CodeAtlas — ${label}`;
                    // 2026-06-09 — preserve `#/tour/<repoId>` when the
                    // user picked a per-repo tour from the home picker.
                    // Without the guard, this unconditional replaceState
                    // clobbers the scope and refresh/back loses it.
                    if (!/^#\/tour(\/|$)/.test(window.location.hash)) {
                        try { window.history.replaceState(null, '', '#/tour'); } catch { /* noop */ }
                    }
                    break;
                }
                case 'workspaceInfo':
                    // Issue #431: detect workspace switch and reload to clear stale state.
                    maybeReloadOnWorkspaceSwitch(
                        (message as unknown as WorkspaceInfo).workspaceRoot,
                        window.sessionStorage,
                        () => window.location.reload(),
                    );
                    // Issue #776: detect a mid-session VSIX upgrade and
                    // force a reload so the SPA picks up the new bundle's
                    // JS and drops stale cached graph state from React.
                    // Issue #790 #3 follow-on — Vite builds the webview
                    // bundle with fixed `assets/index.js` filenames (no
                    // content hash; see webview-ui/vite.config.ts), so
                    // `window.location.reload()` re-renders against the
                    // *cached* JS and the new bundle never lands. Drop a
                    // cache-busting query string so the browser HAS to
                    // refetch `index.html` — which carries the same
                    // entrypoint URL but the response now bypasses the
                    // disk cache. The trailing hash is preserved so
                    // deep-link state survives the reload.
                    maybeReloadOnBundleSwitch(
                        (message as unknown as WorkspaceInfo).extensionBundleId,
                        window.sessionStorage,
                        () => {
                            const hash = window.location.hash || '#/';
                            window.location.href = `${window.location.pathname}?_b=${Date.now()}${hash}`;
                        },
                    );
                    setWsInfo(message as unknown as WorkspaceInfo);
                    // #750 (2026-06-06) — load saved filter views on
                    // workspaceInfo arrival so the SavedViewsToolbar
                    // has its list ready by the time the user opens
                    // an API list.
                    window.vscodeApi?.postMessage({ type: 'requestSavedFilterViews' });
                    // Performance fix (2026-05-13): on root navigation, the
                    // home page only needs workspaceInfo to show real stats.
                    // Drop the loading overlay as soon as it arrives so the
                    // user sees the home with actual data — typically within
                    // a few hundred milliseconds — instead of waiting on the
                    // 8-second safety-net timeout below.
                    {
                        const h = window.location.hash;
                        const isRootNav = !h || h === '#' || h === '#/' || h === '#/home';
                        if (isRootNav) setLoading(false);
                    }
                    break;
                case 'clientId':
                    setClientId((message as any).clientId);
                    break;
                case 'githubAuthCompleted': {
                    const m = message as { status: 'success' | 'failure'; user: any; error?: string };
                    setGithubAuthBanner(
                        m.status === 'success'
                            ? { status: 'success', user: m.user }
                            : { status: 'failure', error: m.error },
                    );
                    // Try window.focus — works when the tab has focus permission
                    // (limited by browser security; openExternal on the server
                    // side is the primary refocus mechanism).
                    try { window.focus(); } catch { /* ignore */ }
                    break;
                }
                // #817 (2026-06-11) — cross-repo push. A producer repo's API
                // surface changed and this workspace has consumers of it.
                // Tabs whose current view renders cross-repo edges refresh
                // in place (+ toast); other tabs queue a passive badge.
                // #826 — overlay state + data.
                case 'overlayState': {
                    const incoming = (message as any).overlays ?? [];
                    setOverlayRows((prev) => incoming.map((o: any) => ({
                        ...o,
                        knownEmpty: prev.find((p) => p.id === o.id)?.knownEmpty,
                    })));
                    break;
                }
                case 'overlayData': {
                    const m = message as any;
                    // BUG-EXPLORE-16 — a data-backed overlay the user just enabled
                    // came back with no source data. Surface it on the canvas (not
                    // just the modal sub-label) so enabling coverage/Sentry/regression
                    // with nothing loaded isn't a silent no-op.
                    const emptyDecision = overlayEmptyToastDecision(
                        { overlayId: m.overlayId, empty: !!m.empty, emptyHint: m.emptyHint },
                        emptyOverlayToastRef.current,
                    );
                    if (emptyDecision.toast) {
                        setAppToast({ text: emptyDecision.toast, level: 'warning' });
                        setTimeout(() => setAppToast(null), 6000);
                    }
                    setOverlayRows((prev) => prev.map((r) => r.id === m.overlayId ? { ...r, knownEmpty: !!m.empty } : r));
                    setOverlayValues((prev) => ({
                        ...prev,
                        [m.graphId]: { ...(prev[m.graphId] ?? {}), [m.overlayId]: m.values ?? {} },
                    }));
                    if (m.unresolvedCount > 0) {
                        setAppToast({ text: `${m.unresolvedCount} of ${m.totalPoints} ${m.overlayId} points couldn't be mapped onto this view`, level: 'warning' });
                        setTimeout(() => setAppToast(null), 4000);
                    }
                    break;
                }
                case 'crossRepoEdgeChanged': {
                    const pushMsg = message as unknown as CrossRepoEdgeChangedMsg;
                    const decision = decideCrossRepoAction(window.location.hash, pushMsg);
                    if (decision.refresh) {
                        const route = parseHash(window.location.hash);
                        if (route) {
                            window.vscodeApi?.postMessage({ type: 'requestRoute', route: route.route, param: route.param, param2: route.param2 });
                        }
                        if (decision.toast) {
                            setAppToast({ text: decision.toast, level: 'info' });
                            setTimeout(() => setAppToast(null), 4000);
                        }
                    } else {
                        setUpstreamChanges((prev) => {
                            const next = [...prev];
                            for (const e of pushMsg.edges) {
                                const idx = next.findIndex((x) =>
                                    x.producerRepoName === pushMsg.producerRepoName
                                    && x.consumerRepoName === e.consumerRepoName
                                    && x.method === e.method && x.route === e.route);
                                if (e.diff === null || e.diff === 'unchanged' || e.diff === 'deleted') {
                                    // Revert-clear (R4): drop the pending entry.
                                    if (idx >= 0) next.splice(idx, 1);
                                } else if (idx < 0) {
                                    next.push({
                                        producerRepoName: pushMsg.producerRepoName,
                                        consumerRepoName: e.consumerRepoName,
                                        method: e.method, route: e.route,
                                    });
                                }
                            }
                            return next;
                        });
                    }
                    break;
                }
                case 'showCommitPicker':
                    setCommitPicker({ commits: message.commits, mode: message.mode });
                    break;
                case 'showPrPicker':
                    setPrPicker({ owner: message.owner, repo: message.repo, prs: message.prs ?? [], isReplay: message.isReplay });
                    break;
                case 'showBranchPicker':
                    setBranchPicker({ branches: message.branches, isReplay: message.isReplay });
                    break;
                case 'showSearchPicker':
                    setSearchPicker({ title: 'Search', placeholder: 'Search APIs, files, clusters, services...', items: message.items, kind: 'search' });
                    break;
                // Issue #707 — open the Path Finder modal in response to
                // an extension-side command (Cmd+Shift+P → "Find call
                // path") or the HomePage card.
                case 'showPathFinder':
                    setPathFinderResult(null);
                    setPathFinderOpen(true);
                    break;
                case 'callPathResult':
                    setPathFinderResult((message as any).result ?? null);
                    break;
                case 'apiTestingData':
                    setApiTestingPayload((message as any).payload ?? null);
                    setShowApiTesting(true);
                    setShowHome(false);
                    showHomeRef.current = false;
                    document.title = 'CodeAtlas — API Testing';
                    try { window.history.replaceState(null, '', '#/api-testing'); } catch { /* noop */ }
                    break;
                case 'sendRequestResult': {
                    const requestId = (message as any).requestId as string | undefined;
                    const response = (message as any).response;
                    if (requestId && response) {
                        setApiTestingResponses(prev => ({ ...prev, [requestId]: response }));
                    }
                    break;
                }
                // #745 — import result arriving from the extension /
                // standalone `importApiCollection` handler. On success
                // we splice the imported collections into the current
                // ApiTestingPayload so the imported endpoints show up
                // in the left-pane tree alongside the auto-detected
                // ones.
                case 'importApiCollectionResult': {
                    const requestId = (message as any).requestId as string | undefined;
                    if (!requestId) break;
                    const err = (message as any).error as string | undefined;
                    if (err) {
                        setApiTestingImportState({ status: 'error', requestId, error: err });
                        break;
                    }
                    const imported = (message as any).payload as ApiTestingPayload | undefined;
                    const format = (message as any).format as 'openapi' | 'postman' | 'insomnia' | 'unknown' | undefined;
                    if (!imported || !imported.collections) {
                        setApiTestingImportState({ status: 'error', requestId, error: 'Importer returned an empty payload.' });
                        break;
                    }
                    setApiTestingPayload(prev => {
                        if (!prev) return imported;
                        // Re-tag imported collections so they don't
                        // collide with existing l2a-cluster ids and so
                        // the user can tell them apart in the tree.
                        const tagged = imported.collections.map(c => ({
                            ...c,
                            id: `import:${format ?? 'unknown'}:${c.id}`,
                            label: `${c.label} (imported · ${format ?? 'spec'})`,
                            source: 'manual' as const,
                        }));
                        const importedCount = tagged.reduce((n, c) => n + c.endpoints.length, 0);
                        return {
                            totalEndpoints: prev.totalEndpoints + importedCount,
                            collections: [...prev.collections, ...tagged],
                        };
                    });
                    const importedCount = imported.collections.reduce((n, c) => n + c.endpoints.length, 0);
                    setApiTestingImportState({ status: 'ready', requestId, format, importedCount });
                    break;
                }
                // #744 — proposal arriving from the extension/standalone
                // `generateRequestBody` handler. Keyed by apiId so the
                // ApiTestingView can render the proposal next to the
                // matching endpoint's body editor.
                case 'generateRequestBodyResult': {
                    const apiId = (message as any).apiId as string | undefined;
                    const requestId = (message as any).requestId as string | undefined;
                    if (!apiId || !requestId) break;
                    const err = (message as any).error as string | undefined;
                    if (err) {
                        setApiTestingBodyProposals(prev => ({
                            ...prev,
                            [apiId]: { status: 'error', requestId, error: err },
                        }));
                    } else {
                        const r = (message as any).result as { body?: Record<string, unknown>; evidence?: Record<string, string>; dropped?: number } | undefined;
                        if (!r || !r.body) {
                            setApiTestingBodyProposals(prev => ({
                                ...prev,
                                [apiId]: { status: 'error', requestId, error: 'Empty proposal returned.' },
                            }));
                        } else {
                            setApiTestingBodyProposals(prev => ({
                                ...prev,
                                [apiId]: { status: 'ready', requestId, body: r.body, evidence: r.evidence, dropped: r.dropped },
                            }));
                        }
                    }
                    break;
                }
                case 'runChainResult': {
                    const r = (message as any).result;
                    if (r) setChainResult(r);
                    break;
                }
                // #744 (2026-06-06) — chain proposal coming back from the
                // extension/standalone `generateChain` handler.
                case 'generateChainResult': {
                    const requestId = (message as any).requestId as string | undefined;
                    if (!requestId) break;
                    const err = (message as any).error as string | undefined;
                    if (err) {
                        setApiTestingChainProposal({ status: 'error', requestId, error: err });
                    } else {
                        const r = (message as any).result as { chain?: any; droppedExtracts?: number } | undefined;
                        if (!r || !r.chain) {
                            setApiTestingChainProposal({ status: 'error', requestId, error: 'Empty chain proposal returned.' });
                        } else {
                            setApiTestingChainProposal({ status: 'ready', requestId, chain: r.chain, droppedExtracts: r.droppedExtracts });
                        }
                    }
                    break;
                }
                // #604 (2026-06-06) — OAuth2 callback receiver
                // broadcast by wsBridge after the IdP redirect lands.
                // Auto-fills the AuthTab exchange-code form's `code`
                // field by stashing it into a dedicated state slot the
                // AuthTab reads. The user still clicks "Exchange code"
                // explicitly — we don't auto-fire the round-trip to
                // avoid surprising token requests from a stale window.
                case 'oauth2CallbackReceived': {
                    const ok = (message as any).ok as boolean;
                    if (ok) {
                        const code = (message as any).code as string;
                        const state = (message as any).state as string | undefined;
                        setAuthTabState(prev => ({
                            ...prev,
                            callback: { ok: true, code, state },
                        }));
                    } else {
                        const error = (message as any).error as string;
                        const errorDescription = (message as any).errorDescription as string | undefined;
                        const state = (message as any).state as string | undefined;
                        setAuthTabState(prev => ({
                            ...prev,
                            callback: { ok: false, error, errorDescription, state },
                        }));
                    }
                    break;
                }
                // #745 (2026-06-06) — OAuth2 client-credentials result.
                case 'oauth2ClientCredentialsResult': {
                    const requestId = (message as any).requestId as string | undefined;
                    if (!requestId) break;
                    const err = (message as any).error as string | undefined;
                    setAuthTabState(prev => ({
                        ...prev,
                        clientCredentials: err
                            ? { status: 'error', requestId, error: err }
                            : { status: 'ready', requestId, token: (message as any).token },
                    }));
                    break;
                }
                // #745 (2026-06-06) — OAuth2 authorize-URL result.
                case 'oauth2AuthorizeUrlResult': {
                    const requestId = (message as any).requestId as string | undefined;
                    if (!requestId) break;
                    const err = (message as any).error as string | undefined;
                    setAuthTabState(prev => ({
                        ...prev,
                        authorizeUrl: err
                            ? { status: 'error', requestId, error: err }
                            : {
                                status: 'ready',
                                requestId,
                                url: (message as any).url,
                                state: (message as any).state,
                                codeVerifier: (message as any).codeVerifier,
                            },
                    }));
                    break;
                }
                // #750 (2026-06-06) — saved filter views list arrived
                // from the host. Replace the local cache wholesale; the
                // host is the source of truth.
                case 'savedFilterViewsResult': {
                    const arr = (message as any).views;
                    if (Array.isArray(arr)) setSavedFilterViews(arr);
                    break;
                }
                // #604 (2026-06-06) — collection export result. Server
                // formats the spec body; we trigger a browser download
                // via a blob URL so the file lands in the user's
                // Downloads folder without any new wiring.
                case 'exportApiCollectionResult': {
                    const err = (message as any).error as string | undefined;
                    if (err) {
                        setAppToast({ text: `Export failed: ${err.slice(0, 200)}`, level: 'error' });
                        setTimeout(() => setAppToast(null), 5000);
                        break;
                    }
                    const body = (message as any).body as string | undefined;
                    const filename = (message as any).suggestedFilename as string | undefined;
                    if (!body || !filename) break;
                    try {
                        const blob = new Blob([body], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                        setAppToast({ text: `Exported ${filename}`, level: 'info' });
                        setTimeout(() => setAppToast(null), 3000);
                    } catch (e: any) {
                        setAppToast({ text: `Download failed: ${e?.message ?? e}`, level: 'error' });
                        setTimeout(() => setAppToast(null), 5000);
                    }
                    break;
                }
                // #745 (2026-06-06) — WebSocket connection result.
                case 'wsConnectResult': {
                    const requestId = (message as any).requestId as string | undefined;
                    if (!requestId) break;
                    const err = (message as any).error as string | undefined;
                    setWsTabState(err
                        ? { status: 'error', requestId, error: err }
                        : { status: 'ready', requestId, result: (message as any).result },
                    );
                    break;
                }
                // #745 (2026-06-06) — SSE stream result.
                case 'sseStreamResult': {
                    const requestId = (message as any).requestId as string | undefined;
                    if (!requestId) break;
                    const err = (message as any).error as string | undefined;
                    setSseTabState(err
                        ? { status: 'error', requestId, error: err }
                        : { status: 'ready', requestId, result: (message as any).result },
                    );
                    break;
                }
                // #745 (2026-06-06) — OAuth2 code-exchange result.
                case 'oauth2ExchangeCodeResult': {
                    const requestId = (message as any).requestId as string | undefined;
                    if (!requestId) break;
                    const err = (message as any).error as string | undefined;
                    setAuthTabState(prev => ({
                        ...prev,
                        exchangeCode: err
                            ? { status: 'error', requestId, error: err }
                            : { status: 'ready', requestId, token: (message as any).token },
                    }));
                    break;
                }
                // #744 (2026-06-06) — per-endpoint test-case proposal.
                case 'generateTestCasesResult': {
                    const apiId = (message as any).apiId as string | undefined;
                    const requestId = (message as any).requestId as string | undefined;
                    if (!apiId || !requestId) break;
                    const err = (message as any).error as string | undefined;
                    if (err) {
                        setApiTestingTestCases(prev => ({
                            ...prev,
                            [apiId]: { status: 'error', requestId, error: err },
                        }));
                    } else {
                        const r = (message as any).result as { cases?: any[]; dropped?: number } | undefined;
                        if (!r || !Array.isArray(r.cases)) {
                            setApiTestingTestCases(prev => ({
                                ...prev,
                                [apiId]: { status: 'error', requestId, error: 'Empty test-cases proposal returned.' },
                            }));
                        } else {
                            setApiTestingTestCases(prev => ({
                                ...prev,
                                [apiId]: { status: 'ready', requestId, cases: r.cases, dropped: r.dropped },
                            }));
                        }
                    }
                    break;
                }
                case 'explorerData': {
                    // Populate the function list for the Path Finder.
                    // ExplorerSidebar consumes the same message via its own
                    // window listener; we just snapshot the `functions[]`
                    // field. Keep the array stable when the broadcast
                    // arrives mid-render by mapping into the PathFinder
                    // item shape eagerly.
                    const fns = ((message as any).functions ?? []) as any[];
                    setPathFinderFunctions(fns.map((f: any) => ({
                        id: String(f.id ?? ''),
                        label: String(f.label ?? ''),
                        subtitle: f.subtitle ? String(f.subtitle) : undefined,
                        // UX-73 (2026-06-10) — carry repoId through so the
                        // PathFinder per-scope toggle can filter the
                        // candidate lists. Server broadcasts already
                        // stamp `repoId` on every explorerData function
                        // in multi-repo (see extension.ts buildExplorer
                        // Data + standalone messageHandler.ts).
                        repoId: f.repoId ? String(f.repoId) : undefined,
                    })).filter((f: PathFinderFunctionItem) => f.id && f.label));
                    break;
                }
                case 'showFunctionPicker':
                    setSearchPicker({
                        title: 'Select Function',
                        placeholder: 'Search by function name or file...',
                        items: message.functions.map((f: any) => ({ id: `${f.filePath}:${f.name}`, label: f.name, description: f.filePath, kind: 'Function' })),
                        kind: 'function',
                    });
                    break;
                case 'showFilePicker':
                    setSearchPicker({
                        title: 'Select File for Impact Analysis',
                        placeholder: 'Search by file name or path...',
                        items: message.files.map((f: any) => ({ id: f.path, label: f.label, description: f.path, kind: 'File' })),
                        kind: 'impact',
                    });
                    break;
                case 'openUrl':
                    // Browser auth redirect — open URL in same tab
                    if (message.url) window.location.href = message.url;
                    break;
                case 'showComments':
                    setComments(message.comments ?? []);
                    break;
                case 'showNotification':
                    setAppToast({ text: message.message, level: message.level });
                    setTimeout(() => setAppToast(null), message.level === 'error' ? 5000 : 3000);
                    break;
                // Issue UX-2 / UX-3 (2026-06-03) — the standalone uses
                // `clientToast` (`broadcastToast` helper in
                // src/standalone/messageHandler.ts:1115). The webview
                // previously had no handler so unsupported-command toasts
                // ("Command X not available in standalone v1.") vanished and
                // ✨ Ask AI / 🔍 Search / 🎯 Impact etc. clicks looked dead.
                // Mirror the showNotification handler.
                case 'clientToast': {
                    const text = String(message.text ?? message.message ?? '');
                    const level = String(message.level ?? 'info');
                    if (!text) break;
                    setAppToast({ text, level });
                    setTimeout(() => setAppToast(null), level === 'error' ? 5000 : 3000);
                    break;
                }
                // Change Log + Replay
                case 'changeLogEntry':
                    setChangeLog(prev => [...prev, message.entry]);
                    break;
                case 'changeLogFull':
                    setChangeLog(message.entries ?? []);
                    break;
                case 'replayStep':
                    setReplayState(message.step);
                    break;
                case 'replayStarted':
                    setReplayState({ index: 0, total: message.totalSteps, functionName: '', layer: '' });
                    // BUG-EXPLORE-2: "Replay Working Changes" is launched from the
                    // landing page, but the walkthrough (diagrams + replay HUD) renders
                    // in the diagram area BEHIND the home overlay. The server only
                    // broadcasts `replayStarted` once a real working diff exists (the
                    // no-diff case returns early with a warning toast), so this is always
                    // a genuine replay — force-leave home so the walkthrough is visible,
                    // mirroring the commit-timeline path (`timelineReplayCommitStart`).
                    setShowHome(false);
                    break;
                case 'replayStopped':
                    setReplayState(null);
                    break;
                // Commit Timeline Replay
                case 'showCommitRangePicker':
                    setCommitRangePicker({ commits: message.commits, branches: message.branches, currentBranch: message.currentBranch, baselineHash: message.baselineHash });
                    break;
                case 'timelineReplayStep':
                    setTimelineReplay(prev => prev ? { ...prev, step: message.step } : { step: message.step, commitInfo: null, paused: false });
                    break;
                case 'timelineReplayCommitStart':
                    setTimelineReplay(prev => ({
                        step: prev?.step ?? null,
                        commitInfo: { index: message.index, total: message.total, hash: message.hash, subject: message.subject },
                        paused: prev?.paused ?? false,
                    }));
                    // Force-leave home page so replay controls and diagrams are visible
                    setShowHome(false);
                    break;
                case 'timelineReplayEnd':
                    setTimelineReplay(null);
                    break;
                case 'timelineReplayPaused':
                    setTimelineReplay(prev => prev ? { ...prev, paused: true } : null);
                    break;
                case 'timelineReplayResumed':
                    setTimelineReplay(prev => prev ? { ...prev, paused: false } : null);
                    break;
                case 'downloadFile': {
                    // Trigger browser file download
                    const blob = new Blob([message.content], { type: message.mimeType });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = message.filename;
                    a.click();
                    URL.revokeObjectURL(url);
                    break;
                }
            }
        };

        window.addEventListener('message', handleMessage);
        // BUG-VERIFY-1: the wsBridge fires `ws-reconnected` when the socket
        // re-opens after a drop (the server may have restarted under us — e.g.
        // `code -r` switched the workspace folder). Re-run the mount handshake
        // so the server re-pushes workspaceInfo; the workspaceInfo handler's
        // maybeReloadOnWorkspaceSwitch then reloads the tab if the workspace
        // changed, dropping the previous workspace's stale in-memory state.
        const handleReconnect = () => {
            try {
                window.vscodeApi?.postMessage({ type: 'ready' });
                window.vscodeApi?.postMessage({ type: 'requestChangeLog' });
            } catch { /* bridge may be mid-teardown */ }
        };
        window.addEventListener('ws-reconnected', handleReconnect);
        // Replay any messages that arrived before React mounted (browser mode timing race)
        (window.vscodeApi as any)?.flushIncoming?.();
        window.vscodeApi?.postMessage({ type: 'ready' });
        window.vscodeApi?.postMessage({ type: 'requestChangeLog' });
        // Safety-net timeout: if no workspaceInfo / diagram arrives in 8s,
        // show home anyway. Common path:
        //   • Root nav: workspaceInfo handler drops `loading` within a few
        //     hundred ms, well before this timer fires.
        //   • Deep URL: a `navigateTo` message drops loading via the
        //     showDiagram / navigateTo handlers.
        //   • Slow/disconnected extension: this timer is the user-visible
        //     escape hatch so the spinner doesn't hang forever.
        const timeout = setTimeout(() => {
            setLoading(false);
            if (!initialNavReceived.current) {
                setShowHome(true);
            }
        }, 8000);

        return () => {
            window.removeEventListener('message', handleMessage);
            window.removeEventListener('ws-reconnected', handleReconnect);
            clearTimeout(timeout);
        };
    }, []);

    // Dismiss context menu on outside click
    useEffect(() => {
        if (!ctxMenu) return;
        const dismiss = () => setCtxMenu(null);
        document.addEventListener('mousedown', dismiss);
        return () => document.removeEventListener('mousedown', dismiss);
    }, [ctxMenu]);

    // Notify extension of current graphId when nav index changes
    useEffect(() => {
        if (currentEntry) {
            window.vscodeApi?.postMessage({ type: 'panelNavigated', graphId: currentEntry.graphId });
        }
    }, [currentEntry?.graphId]);


    const handleSetLlmConfig = useCallback((cfg: { apiKey?: string; provider?: string; model?: string; endpoint?: string }) => {
        window.vscodeApi?.postMessage({ type: 'setLlmConfig', ...cfg });
    }, []);

    const handleBack = useCallback(() => {
        // Issue 110: when arriving via a Cmd+Click deep-link the nav stack
        // has a single entry (index === 0). Back from that bottom-of-stack
        // position routes to Home so the user always has a working back path.
        if (navState.index <= 0) {
            handleHome();
            return;
        }
        if (navState.index > 0) {
            const targetEntry = navState.stack[navState.index - 1];
            // #763 (2026-06-06) — sync hash before dispatch to avoid the
            // directNavPending Loading-flash race. See handleBreadcrumbNav.
            if (targetEntry) {
                const newHash = graphIdToScopedHash(targetEntry.graphId, targetEntry.graph).slice(1);
                if (window.location.hash.replace(/^#/, '') !== newHash) {
                    suppressHashChange.current = true;
                    window.location.hash = newHash;
                }
            }
            navDispatch({ type: 'go', index: navState.index - 1 });
            // Bug 5 (stale state on back): the nav stack carries the graph
            // captured at original-visit time. After file edits the server
            // has fresher graphs but the back button would render the stale
            // cached one. Re-request the target graph so the server sends
            // an updateGraph with current diff annotations.
            // Bug 9 (per user): the requestRoute handler prefixes the
            // route type to the param (e.g. `sequence:` + param). The
            // graphId already INCLUDES that prefix (`sequence:src/...`),
            // so we must strip it before passing as the route param —
            // otherwise the lookup becomes `sequence:sequence:src/...`
            // and the server reports "Sequence diagram not found".
            if (targetEntry?.graphId) {
                const gid = targetEntry.graphId;
                const mode = targetEntry.mode;
                const stripPrefix = (s: string, prefix: string) =>
                    s.startsWith(prefix) ? s.slice(prefix.length) : s;
                let route = 'file';
                let param = '';
                let param2: string | undefined = undefined;
                if (mode === 'microservice') { route = 'system-design'; param = String(targetEntry.graph?.meta?.scopedRepo ?? ''); }
                else if (mode === 'map') { route = 'map'; param = String(targetEntry.graph?.meta?.scopedRepo ?? ''); }
                else if (mode === 'domain') { route = 'domain'; param = String(targetEntry.graph?.meta?.scopedRepo ?? ''); }
                else if (mode === 'feature') {
                    route = 'features';
                    const stripped = stripPrefix(gid, 'feature:');
                    param = stripped === 'workspace' ? '' : stripped;
                }
                else if (mode === 'api-list') { route = 'apis'; param = stripPrefix(gid, 'api-list:'); }
                else if (mode === 'sequence') { route = 'sequence'; param = stripPrefix(gid, 'sequence:'); }
                else if (mode === 'file') { route = 'file'; param = stripPrefix(gid, 'file:'); }
                else if (mode === 'flow') {
                    // flow:<path>:<fnName> — fnName can contain colons
                    // (e.g. `anonymous@GET:/user`). Split on the FIRST
                    // occurrence of `:<extension>:` boundary by finding
                    // the file extension. For the common .ts/.js/.py/etc.
                    // case this is unambiguous.
                    route = 'flow';
                    const stripped = stripPrefix(gid, 'flow:');
                    const extMatch = stripped.match(/^(.+?\.[a-zA-Z0-9]{1,6}):(.+)$/);
                    if (extMatch) {
                        param = extMatch[1];
                        param2 = extMatch[2];
                    } else {
                        // No extension found — fall back to cached graph
                        // (don't re-request).
                        return;
                    }
                }
                window.vscodeApi?.postMessage({ type: 'requestRoute', route, param, param2 });
            }
        }
    }, [navState.index, navState.stack]);

    // Issue 109: Forward navigation
    const handleForward = useCallback(() => {
        if (navState.index < navState.stack.length - 1) {
            // #763 (2026-06-06) — sync hash before dispatch; same race as
            // handleBreadcrumbNav. See comment there.
            const target = navState.stack[navState.index + 1];
            if (target) {
                const newHash = graphIdToScopedHash(target.graphId, target.graph).slice(1);
                if (window.location.hash.replace(/^#/, '') !== newHash) {
                    suppressHashChange.current = true;
                    window.location.hash = newHash;
                }
            }
            navDispatch({ type: 'go', index: navState.index + 1 });
        }
    }, [navState.index, navState.stack]);

    // Home navigation — go to home page
    const handleHome = useCallback(() => {
        navDispatch({ type: 'clear' });
        setShowHome(true);
        // Issue #441: only set the suppress flag if the hash will change.
        // If the user clicks Home while already on /home, the hash doesn't
        // change, no `hashchange` fires, and the flag stays stuck true —
        // breaking the next legit user-driven hash navigation.
        const currentHash = window.location.hash.replace(/^#/, '');
        if (currentHash !== '/home') {
            suppressHashChange.current = true;
            window.location.hash = '/home';
        }
        localStorage.setItem('codeatlas:lastRoute', '#/home');
        document.title = 'CodeAtlas';
    }, []);

    const handleBreadcrumbNav = useCallback((i: number) => {
        // #763 (2026-06-06) — sync hash BEFORE state update. The
        // `directNavPending` guard at line ~2112 derives `expectedMode`
        // from `window.location.hash` synchronously during render. Without
        // this pre-sync, the render that flips `navState.index` sees the
        // NEW currentEntry (mode='microservice' say) but the OLD hash
        // (`#/sequence/...` → expectedMode='sequence'), fires the Loading
        // placeholder, and stays there because the post-render hash-update
        // effect's hashchange is suppressed → no re-render. Test: click a
        // breadcrumb from a 2-deep stack → all breadcrumbs disappear.
        const target = navState.stack[i];
        if (target) {
            const newHash = graphIdToScopedHash(target.graphId, target.graph).slice(1);
            if (window.location.hash.replace(/^#/, '') !== newHash) {
                suppressHashChange.current = true;
                window.location.hash = newHash;
            }
        }
        navDispatch({ type: 'go', index: i });
    }, [navState.stack]);

    // Update hash and title when navigating via breadcrumbs or back/forward
    useEffect(() => {
        // Bug A (2026-06-04): when we're on an outside-route (violations,
        // tour, api-testing), the dedicated outside-route title effect
        // owns `document.title`. Don't let the navState-driven effect
        // here clobber it with the previous graph entry's label.
        if (outsideRoute) return;
        if (currentEntry && !showHome) {
            // Issue 136: Also update document.title on breadcrumb/back/forward navigation
            // Issue UX-6 — prettify raw graphIds before they reach the title bar.
            document.title = `CodeAtlas — ${prettifyGraphLabel(currentEntry.graphId, currentEntry.label, categoryFromGraph(currentEntry.graph as any))}`;
            // 2026-06-09 — preserve per-repo scope when the navState's
            // current entry carries a scoped graph. Without this, the
            // navState-driven title/hash effect overrides the scoped URL
            // back to `#/system-design` / `#/map` after every breadcrumb
            // or back/forward action.
            const newHash = graphIdToScopedHash(currentEntry.graphId, currentEntry.graph);
            if ('#' + window.location.hash.replace(/^#/, '') !== newHash) {
                suppressHashChange.current = true;
                window.location.hash = newHash.slice(1);
            }
        }
    }, [currentEntry?.graphId, showHome, outsideRoute]);

    // Transient info toast (auto-clears). Used to give honest feedback when an
    // L3 click has no deeper navigation target instead of a silent no-op.
    const showInfoToast = useCallback((text: string) => {
        setAppToast({ text, level: 'info' });
        setTimeout(() => setAppToast(null), 4000);
    }, []);

    const handleNodeClick = useCallback((nodeId: string, nodeData: any, event?: React.MouseEvent) => {
        if (!window.vscodeApi) return;

        const newWindow = !!(event?.metaKey || event?.ctrlKey);
        const anchor = nodeData?.anchor;

        // UX-PAGE-LOADER — a node click almost always drills to the next layer
        // (via an open*/requestRoute message → navigateTo, or a hash drill).
        // Arm the transition loader now so the click is acknowledged instantly;
        // it clears when navigateTo/updateGraph lands (endNav) or the safety
        // timer fires. Skip cmd/ctrl-click (opens a separate window — the
        // current view isn't replaced) and replay (beginNav self-guards).
        // Genuine no-op branches below (infra/domain nodes, bucket-toast) call
        // endNav() before returning so the loader never lingers on a dead click.
        if (!newWindow) beginNav();

        // Microservice layer: click service → open feature diagram for that service
        if (mode === 'microservice' && nodeData.type === 'service' && !nodeData.meta?.external) {
            // UX-65 (2026-06-09) — cross-repo hop. In a scoped L1 the
            // extension stamps `meta.crossRepoTarget = '<rootPath>'` on
            // any consumed neighbour that lives in a different sub-repo.
            // Clicking it should re-scope to THAT sub-repo's L1 instead
            // of trying to open its L2a (which would be empty in the
            // current scope).
            // #836 — decision table extracted to lib/l1ClickAction.ts
            // (cross-repo rescope / bucket hint / scoped feature drill).
            const action = resolveL1ClickAction(nodeData, window.location.hash);
            if (action.kind === 'rescope') {
                window.location.hash = action.hash;
                return;
            }
            if (action.kind === 'bucket-toast') {
                endNav(); // no navigation — don't leave the loader hanging
                setAppToast({ text: action.text, level: 'info' });
                setTimeout(() => setAppToast(null), 4000);
                return;
            }
            window.vscodeApi.postMessage({
                type: 'openFeatureForService',
                serviceId: action.serviceId,
                ...(action.repoId ? { repoId: action.repoId } : {}),
                newWindow,
            });
            return;
        }

        // Issue #751: Knowledge Map drill-downs. Cluster nodes drill into
        // their L2b API list; API/participant leaf nodes drill into their
        // sequence; service nodes open the service's feature view;
        // infrastructure/domain nodes are no-ops by design (no drill
        // target). All branches use the existing open* handlers so the
        // navigation path is identical to clicking the same entity from
        // the L1/L2 diagrams directly.
        if (mode === 'map') {
            // #848b — workspace repo cards (bare multi-repo map) drill into
            // that repo's scoped Knowledge Map.
            if (nodeData.meta?.workspaceMap && !nodeData.meta?.external && (nodeData.meta?.rootPath || nodeData.meta?.repoId)) {
                const scope = String(nodeData.meta.rootPath || nodeData.meta.repoId);
                window.location.hash = `#/map/${scope}`;
                return;
            }
            const layer = nodeData.meta?.layer as string | undefined;
            if (layer === 'cluster' && nodeData.meta?.clusterId) {
                window.vscodeApi.postMessage({
                    type: 'openApiListForCluster',
                    clusterId: nodeData.meta.clusterId as string,
                    serviceId: nodeData.meta?.serviceId ?? '',
                    newWindow,
                });
                return;
            }
            if (layer === 'service' && nodeData.meta?.serviceId && !nodeData.meta?.external) {
                // UX-65e (2026-06-09) — cross-repo hop. Map nodes stamped
                // `meta.crossRepoTarget` by `scopedMapGraphFilter.ts`
                // re-scope the URL to THAT sub-repo's Knowledge Map.
                const crossRepoTarget = nodeData.meta?.crossRepoTarget as string | undefined;
                if (crossRepoTarget) {
                    window.location.hash = `#/map/${crossRepoTarget}`;
                    return;
                }
                window.vscodeApi.postMessage({
                    type: 'openFeatureForService',
                    serviceId: nodeData.meta.serviceId as string,
                    newWindow,
                });
                return;
            }
            if (layer === 'api' && nodeData.meta?.apiId) {
                window.vscodeApi.postMessage({
                    type: 'openSequenceForApi',
                    apiId: nodeData.meta.apiId as string,
                    newWindow,
                });
                return;
            }
            // Infrastructure / domain nodes have no drill target — silent no-op.
            endNav(); // no navigation — clear the transition loader
            return;
        }

        // #L2merge — an api-typed node opens its sequence (L3). The merged backend
        // Feature view (mode 'feature') renders API rows directly, so its api clicks
        // must resolve here — not only in mode 'api-list'. Same message + serviceId
        // resolution the L2b panel uses, so behaviour is identical across surfaces.
        if (nodeData.type === 'api' && nodeData.meta?.apiId) {
            const apiServiceId = (currentEntry?.graph as any)?.meta?.serviceId as string | undefined;
            window.vscodeApi.postMessage({
                type: 'openSequenceForApi',
                apiId: nodeData.meta.apiId as string,
                serviceId: apiServiceId,
                newWindow,
            });
            return;
        }

        // BUG-FE-NO-L3L4L5-L2A — a `type:'graph'` node carries a pre-resolved
        // drill target in `meta.graphId`. The FRONTEND L2a screen list uses it:
        // each screen row opens its `screen-content:<id>` graph. Route via
        // `requestRoute` (same mechanism as the Domain drill) so the hash
        // changes and the extension serves the screen-content L2b panel — which
        // in turn makes the render-flow (L3) / component-data (L4) reachable.
        // Before this branch the click matched no case and silently no-op'd.
        if (nodeData.type === 'graph' && typeof nodeData.meta?.graphId === 'string' && nodeData.meta.graphId) {
            window.vscodeApi.postMessage({ type: 'requestRoute', graphId: nodeData.meta.graphId as string });
            return;
        }

        // Issue UX-1 (2026-06-03) — Domain view drill. The Domain graph
        // builder pre-computes `meta.drillDownGraphId` (a representative
        // sequence:<file>:<handler> for the first route, file:<path> as a
        // fallback). Route to it via `requestRoute` so domain → routes is
        // a real journey instead of a dead click. Pure-function decision
        // logic is unit-tested at
        // `webview-ui/src/lib/__tests__/decideNodeClick.test.ts`.
        if (mode === 'domain' && nodeData.type === 'cluster') {
            const drill = nodeData.meta?.drillDownGraphId as string | undefined;
            if (drill) {
                window.vscodeApi.postMessage({ type: 'requestRoute', graphId: drill });
                return;
            }
            const cid = String(nodeData.meta?.domainId ?? nodeData.meta?.clusterId ?? nodeData.clusterMembership ?? '');
            if (cid) {
                window.vscodeApi.postMessage({
                    type: 'openApiListForCluster',
                    clusterId: cid,
                    serviceId: String(nodeData.meta?.serviceId ?? nodeData.serviceId ?? ''),
                    newWindow,
                });
            }
            return;
        }

        // Feature layer: a cluster-typed node → open that cluster's API list (L2b).
        // Post-L2merge this fires for the "Internal modules" rows of the merged
        // backend view and for the Domains cluster map — the merged view's API
        // rows are type:'api' and were already handled above.
        // If the click was on a sub-cluster pill, scope to that sub-cluster's files
        if (mode === 'feature' && nodeData.type === 'cluster') {
            const target = event?.target as HTMLElement | undefined;
            const subClusterId = target?.dataset?.subclusterId ?? target?.closest?.('[data-subcluster-id]')?.getAttribute('data-subcluster-id');
            if (subClusterId && nodeData.meta?.subClusters?.[subClusterId]) {
                const subCluster = nodeData.meta.subClusters[subClusterId];
                window.vscodeApi.postMessage({
                    type: 'openApiListForCluster',
                    clusterId: subClusterId,
                    serviceId: nodeData.meta?.serviceId ?? '',
                    subClusterFiles: subCluster.files,
                    newWindow,
                });
            } else {
                window.vscodeApi.postMessage({
                    type: 'openApiListForCluster',
                    clusterId: nodeData.meta?.clusterId ?? '',
                    serviceId: nodeData.meta?.serviceId ?? '',
                    newWindow,
                });
            }
            return;
        }

        // API list layer: API click → open sequence diagram; file click → open file diagram
        if (mode === 'api-list') {
            if (nodeData.type === 'api' && nodeData.meta?.apiId) {
                // 2026-06-09 — pass the owning serviceId so the multi-repo
                // openSequenceForApi handler can resolve apiId collisions
                // (`sls:deleteUser:...` exists in many sub-repos) to the
                // right per-repo store rather than the workspace's
                // last-write-wins record.
                const serviceId = (currentEntry?.graph as any)?.meta?.serviceId as string | undefined;
                window.vscodeApi.postMessage({
                    type: 'openSequenceForApi',
                    apiId: nodeData.meta.apiId as string,
                    serviceId,
                    newWindow,
                });
            } else if (nodeData.type === 'file' && anchor?.filePath) {
                window.vscodeApi.postMessage({ type: 'openFileDiagram', filePath: anchor.filePath, newWindow });
            }
            return;
        }

        if (!anchor) {
            endNav(); // no diagram navigation — just a selection ping
            // Dead-end participant (external/unresolved lane) — surface why the
            // click doesn't drill instead of a silent no-op.
            if (mode === 'sequence' && nodeData.type === 'participant') {
                showInfoToast(participantDeadEndMessage(nodeData.label));
            }
            window.vscodeApi.postMessage({ type: 'nodeClicked', nodeId, nodeType: nodeData.type });
            return;
        }

        // Sequence layer: participant click → open file diagram
        if (nodeData.type === 'participant' && mode === 'sequence') {
            if (anchor.filePath) {
                window.vscodeApi.postMessage({ type: 'openFileDiagram', filePath: anchor.filePath, newWindow });
            } else if (participantHasNoTarget(anchor)) {
                showInfoToast(participantDeadEndMessage(nodeData.label));
            }
        }
        // File layer: function click → open function flow
        else if (nodeData.type === 'function' && mode === 'file') {
            if (anchor.filePath && anchor.symbol) {
                window.vscodeApi.postMessage({
                    type: 'openFunctionFlow',
                    filePath: anchor.filePath,
                    functionName: anchor.symbol,
                    newWindow,
                });
            }
        }
        // Flow layer: block click → open source at that line
        else if (mode === 'flow' && anchor.filePath) {
            endNav(); // opens the editor, not a new diagram — no transition loader
            const charOffset = anchor.span?.start;
            // For consolidated blocks, try to find which line was clicked
            let lineOffset = charOffset;
            const stmts = nodeData?.meta?.statements;
            if (stmts && stmts.length > 0 && event) {
                const target = event.target as HTMLElement;
                const stmtEl = target.closest?.('[data-stmt-index]');
                if (stmtEl) {
                    const idx = parseInt(stmtEl.getAttribute('data-stmt-index') ?? '0', 10);
                    if (stmts[idx]?.span?.start != null) {
                        lineOffset = stmts[idx].span.start;
                    }
                }
            }
            // Editor-scheme deep link → focuses editor, then opens file at line.
            openSourceViaEditor(
                anchor.filePath,
                { charOffset: lineOffset ?? charOffset },
                wsInfo?.editorUriScheme,
                wsInfo?.extensionId,
                clientId,
            );
        }
        // Default: open source file
        else if (anchor.filePath) {
            endNav(); // opens the editor, not a new diagram — no transition loader
            openSourceViaEditor(
                anchor.filePath,
                {},
                wsInfo?.editorUriScheme,
                wsInfo?.extensionId,
                clientId,
            );
        }

        window.vscodeApi.postMessage({ type: 'nodeClicked', nodeId, nodeType: nodeData.type, anchor });
    }, [mode, wsInfo?.editorUriScheme, wsInfo?.extensionId, clientId, showInfoToast]);

    const handleNodeRightClick = useCallback((nodeId: string, nodeData: any, event?: React.MouseEvent) => {
        event?.preventDefault();
        setCtxMenu({ x: event?.clientX ?? 0, y: event?.clientY ?? 0, nodeId, nodeData });
    }, []);

    const handleEdgeClick = useCallback((edgeId: string, edgeData: any) => {
        if (!window.vscodeApi) return;

        if (mode === 'sequence' && edgeData) {
            // Priority 1: edge-level anchor (set when BFS resolves the called method to a known file).
            // If symbol is present → navigate to function flow; if absent → open file diagram.
            if (edgeData.anchor?.filePath) {
                window.vscodeApi.postMessage({ type: 'edgeClicked', edgeId, anchor: edgeData.anchor });
                return;
            }

            // Priority 2: target participant has a known symbol (e.g. injected service with named entry)
            const targetParticipant = edgeData.targetParticipant;
            if (targetParticipant?.anchor?.symbol && targetParticipant?.anchor?.filePath) {
                window.vscodeApi.postMessage({
                    type: 'openFunctionFlow',
                    filePath: targetParticipant.anchor.filePath,
                    functionName: targetParticipant.anchor.symbol,
                });
                return;
            }

            // Priority 3: open target participant's file diagram
            if (targetParticipant?.anchor?.filePath) {
                window.vscodeApi.postMessage({
                    type: 'openFileDiagram',
                    filePath: targetParticipant.anchor.filePath,
                });
                return;
            }
        }

        if (edgeData?.anchor) {
            window.vscodeApi.postMessage({ type: 'edgeClicked', edgeId, anchor: edgeData.anchor });
        } else if (mode === 'sequence' && edgeHasNoTarget(edgeData)) {
            // Dead-end message edge (unresolved target) — honest feedback
            // instead of a silent no-op.
            showInfoToast(MESSAGE_DEAD_END_EDGE);
        }
    }, [mode, showInfoToast]);

    const handleImpactNavigate = useCallback((filePath: string) => {
        openSourceViaEditor(
            filePath,
            {},
            wsInfo?.editorUriScheme,
            wsInfo?.extensionId,
            clientId,
        );
    }, [wsInfo?.editorUriScheme, wsInfo?.extensionId, clientId]);

    if (loading) {
        return (
            <div className="ca-loading">
                <div className="ca-loading-spinner" />
                {initProgress ? (
                    <div style={{ textAlign: 'center' }}>
                        <div>{initProgress.message}</div>
                        <div style={{ marginTop: 8, width: 200, height: 4, background: 'var(--ca-border)', borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{ width: `${Math.round(initProgress.progress * 100)}%`, height: '100%', background: 'var(--ca-accent)', borderRadius: 2, transition: 'width 0.3s ease' }} />
                        </div>
                    </div>
                ) : (
                    <span>Loading diagram...</span>
                )}
            </div>
        );
    }

    const isBrowserMode = !!(window as any).__codeAtlasBrowserMode;

    // Shared modal overlays — rendered on both home and diagram views
    const modalOverlays = (
        <>
            {/* #826 — the Overlays control surface (R2b). */}
            {overlaysPanelOpen && (
                <OverlaysPanel
                    overlays={overlayRows}
                    onToggle={(id, enabled) => window.vscodeApi?.postMessage({ type: 'setOverlayEnabled', overlayId: id, enabled })}
                    onClose={() => setOverlaysPanelOpen(false)}
                />
            )}
            {/* #817 — passive upstream-change badge. Clicking navigates to
                the first affected consumer's L1 (scoped) and clears. */}
            <UpstreamChangesChip
                changes={upstreamChanges}
                onOpen={(consumer) => {
                    setUpstreamChanges([]);
                    window.location.hash = `#/system-design/${encodeURIComponent(consumer)}`;
                }}
                onDismiss={() => setUpstreamChanges([])}
            />
            {commitPicker && (
                <CommitPicker
                    commits={commitPicker.commits}
                    onSelect={(baseHash, headHash) => {
                        setCommitPicker(null);
                        setShowHome(false); // User explicitly requested a diagram — leave home
                        setLoading(true);
                        setInitProgress({ phase: 'commit-diff', progress: 0.2, message: 'Building diff graphs...' });
                        // UX-63b — preserve per-repo scope: URL is the source
                        // of truth (`#/compare-commits/<repo>` from picker).
                        const cmpMatch = window.location.hash.match(/^#\/compare-commits\/(.+)$/);
                        const repoId = cmpMatch ? cmpMatch[1] : undefined;
                        window.vscodeApi?.postMessage({ type: 'commitSelected', baseHash, headHash, repoId });
                    }}
                    onCancel={() => setCommitPicker(null)}
                />
            )}
            {commitRangePicker && (
                <CommitRangePicker
                    commits={commitRangePicker.commits}
                    branches={commitRangePicker.branches}
                    currentBranch={commitRangePicker.currentBranch}
                    baselineHash={commitRangePicker.baselineHash}
                    onStart={(selectedCommits) => {
                        setCommitRangePicker(null);
                        setShowHome(false);
                        window.vscodeApi?.postMessage({ type: 'startTimelineReplay', commits: selectedCommits });
                    }}
                    onCancel={() => setCommitRangePicker(null)}
                    onBranchChange={(branch) => {
                        window.vscodeApi?.postMessage({ type: 'requestTimelineCommits', branch });
                    }}
                />
            )}
            {prPicker && (
                <PrPicker
                    owner={prPicker.owner}
                    repo={prPicker.repo}
                    prs={prPicker.prs}
                    gitHubConnected={wsInfo?.gitHubConnected ?? false}
                    editorUriScheme={wsInfo?.editorUriScheme}
                    extensionId={wsInfo?.extensionId}
                    clientId={clientId}
                    isReplay={prPicker.isReplay}
                    onSelect={(prNumber) => {
                        setPrPicker(null);
                        setShowHome(false); // User explicitly requested a diagram — leave home
                        setLoading(true); // Show loading/progress while diff builds
                        setInitProgress({ phase: 'pr-diff', progress: 0.1, message: `Loading PR #${prNumber}...` });
                        // UX-63d — preserve per-repo scope. URL is the source of truth
                        // (`#/pr-diff/<repo>` from picker, or `#/replay-pr/<repo>` from
                        // the replay flow). Either way, derive repoId from hash.
                        const prMatch = window.location.hash.match(/^#\/(?:pr-diff|replay-pr)\/(.+)$/);
                        const repoId = prMatch ? prMatch[1] : undefined;
                        window.vscodeApi?.postMessage({ type: 'prSelected', prNumber, repoId });
                    }}
                    onCancel={() => setPrPicker(null)}
                />
            )}
            {searchPicker && (
                <SearchPicker
                    title={searchPicker.title}
                    placeholder={searchPicker.placeholder}
                    items={searchPicker.items}
                    // UX-73 (2026-06-09) — pass the active URL-hash scope so
                    // the picker renders an "in this repo" toggle. The toggle
                    // defaults ON whenever the user is browsing a scoped
                    // route (e.g. `#/system-design/api-svc`); items keyed to
                    // OTHER repos are hidden until the user opts out.
                    scope={(() => {
                        const m = window.location.hash.match(/^#\/(?:system-design|map|features|api-testing|health|tour|file|flow|sequence)\/([^/?]+)$/);
                        return m ? m[1] : undefined;
                    })()}
                    scopeLabel={(() => {
                        const m = window.location.hash.match(/^#\/(?:system-design|map|features|api-testing|health|tour|file|flow|sequence)\/([^/?]+)$/);
                        if (!m) return undefined;
                        const r = workspaceState?.repos.find(x => x.repoId === m[1] || x.name === m[1] || x.rootPath === m[1]);
                        return r?.name ?? m[1];
                    })()}
                    onSelect={(item) => {
                        const pickerKind = searchPicker.kind;
                        setSearchPicker(null);
                        if (pickerKind === 'search') {
                            window.vscodeApi?.postMessage({ type: 'searchSelected', id: item.id, kind: item.kind });
                        } else if (pickerKind === 'function') {
                            const [filePath, ...fnParts] = item.id.split(':');
                            const fnName = fnParts.join(':');
                            window.vscodeApi?.postMessage({ type: 'functionSelected', filePath, functionName: fnName });
                        } else if (pickerKind === 'impact') {
                            // Issue 147: Navigate to the file diagram first so impact overlay is visible
                            setShowHome(false);
                            showHomeRef.current = false;
                            window.vscodeApi?.postMessage({ type: 'openFileDiagram', filePath: item.id });
                            // Then request impact analysis
                            setTimeout(() => {
                                window.vscodeApi?.postMessage({ type: 'fileSelectedForImpact', filePath: item.id });
                            }, 500);
                        }
                    }}
                    onCancel={() => setSearchPicker(null)}
                />
            )}
            {branchPicker && (
                <SearchPicker
                    title={branchPicker.isReplay ? 'Replay Branch' : 'Branch Diff'}
                    placeholder="Select branch to compare against HEAD..."
                    items={branchPicker.branches.map(b => ({
                        id: b.name,
                        label: `${b.isCurrent ? '* ' : ''}${b.name}`,
                        description: b.isCurrent ? '(current)' : b.isRemote ? '(remote)' : '(local)',
                        kind: b.isRemote ? 'Remote' : 'Branch',
                    }))}
                    onSelect={(item) => {
                        setBranchPicker(null);
                        setShowHome(false); // User explicitly requested a diagram — leave home
                        setLoading(true);
                        setInitProgress({ phase: 'branch-diff', progress: 0.2, message: `Comparing branch ${item.id}...` });
                        // UX-63c — preserve per-repo scope.
                        const brMatch = window.location.hash.match(/^#\/branch-diff\/(.+)$/);
                        const repoId = brMatch ? brMatch[1] : undefined;
                        window.vscodeApi?.postMessage({ type: 'branchSelected', branchName: item.id, repoId });
                    }}
                    onCancel={() => setBranchPicker(null)}
                />
            )}
            {pathFinderOpen && (
                <PathFinderModal
                    functions={pathFinderFunctions}
                    initialResult={pathFinderResult}
                    postMessage={(msg) => window.vscodeApi?.postMessage(msg)}
                    onOpenFlow={(filePath, functionName) => {
                        setPathFinderOpen(false);
                        setShowHome(false);
                        showHomeRef.current = false;
                        window.vscodeApi?.postMessage({ type: 'openFunctionFlow', filePath, functionName });
                    }}
                    onCancel={() => { setPathFinderOpen(false); setPathFinderResult(null); }}
                    // UX-73 (2026-06-10) — per-scope toggle. Same scope
                    // extraction as the SearchPicker above.
                    scope={(() => {
                        const m = window.location.hash.match(/^#\/(?:system-design|map|features|api-testing|health|tour|file|flow|sequence)\/([^/?]+)$/);
                        return m ? m[1] : undefined;
                    })()}
                    scopeLabel={(() => {
                        const m = window.location.hash.match(/^#\/(?:system-design|map|features|api-testing|health|tour|file|flow|sequence)\/([^/?]+)$/);
                        if (!m) return undefined;
                        const r = workspaceState?.repos.find(x => x.repoId === m[1] || x.name === m[1] || x.rootPath === m[1]);
                        return r?.name ?? m[1];
                    })()}
                />
            )}
        </>
    );

    // Issue #601 — API Testing surface. Shown when `apiTestingData`
    // arrives. Takes precedence over HomePage so the route lands the
    // user directly on the read-only browser.
    //
    // Issue #779: also gate on the URL hash route — otherwise the
    // ApiTestingView render path "wins" even after the user navigates
    // to `#/map` (or any other route), because `showApiTesting` was
    // never reset on hashchange. `parseHash` is already exported so
    // the gate semantics ship with the same test surface.
    if (showApiTesting && apiTestingPayload && parseHash(window.location.hash)?.route === 'api-testing') {
        const allEndpoints = apiTestingPayload.collections.flatMap(c => c.endpoints);
        return (
            <ErrorBoundary>
                <ApiTestingView
                    payload={apiTestingPayload}
                    onOpenSource={(filePath) => window.vscodeApi?.postMessage({ type: 'openSource', filePath })}
                    onSendRequest={(args) => window.vscodeApi?.postMessage({ type: 'sendRequest', ...args })}
                    responses={apiTestingResponses}
                    onOpenChainRunner={() => { setChainResult(null); setChainRunnerOpen(true); }}
                    onGenerateRequestBody={(apiId, requestId) => {
                        // Mark loading immediately so the button flips
                        // before the round-trip completes.
                        setApiTestingBodyProposals(prev => ({
                            ...prev,
                            [apiId]: { status: 'loading', requestId },
                        }));
                        window.vscodeApi?.postMessage({ type: 'generateRequestBody', apiId, requestId });
                    }}
                    bodyProposals={apiTestingBodyProposals}
                    onGenerateChain={(requestId, intent) => {
                        setApiTestingChainProposal({ status: 'loading', requestId });
                        window.vscodeApi?.postMessage({ type: 'generateChain', requestId, intent });
                    }}
                    chainProposal={apiTestingChainProposal}
                    onGenerateTestCases={(apiId, requestId) => {
                        setApiTestingTestCases(prev => ({
                            ...prev,
                            [apiId]: { status: 'loading', requestId },
                        }));
                        window.vscodeApi?.postMessage({ type: 'generateTestCases', apiId, requestId });
                    }}
                    testCasesProposals={apiTestingTestCases}
                    onImportApiCollection={(specText, requestId) => {
                        setApiTestingImportState({ status: 'loading', requestId });
                        window.vscodeApi?.postMessage({ type: 'importApiCollection', specText, requestId });
                    }}
                    importState={apiTestingImportState}
                    onExportApiCollection={(format, requestId) => {
                        window.vscodeApi?.postMessage({ type: 'exportApiCollection', format, requestId });
                    }}
                    onOAuth2ClientCredentials={(args) => {
                        setAuthTabState(prev => ({ ...prev, clientCredentials: { status: 'loading', requestId: args.requestId } }));
                        window.vscodeApi?.postMessage({ type: 'oauth2ClientCredentials', ...args });
                    }}
                    onOAuth2BuildAuthorizationUrl={(args) => {
                        setAuthTabState(prev => ({ ...prev, authorizeUrl: { status: 'loading', requestId: args.requestId } }));
                        window.vscodeApi?.postMessage({ type: 'oauth2BuildAuthorizationUrl', ...args });
                    }}
                    onOAuth2ExchangeAuthorizationCode={(args) => {
                        setAuthTabState(prev => ({ ...prev, exchangeCode: { status: 'loading', requestId: args.requestId } }));
                        window.vscodeApi?.postMessage({ type: 'oauth2ExchangeAuthorizationCode', ...args });
                    }}
                    authTabState={authTabState}
                    onWsConnect={(args) => {
                        setWsTabState({ status: 'loading', requestId: args.requestId });
                        window.vscodeApi?.postMessage({ type: 'wsConnect', ...args });
                    }}
                    wsTabState={wsTabState}
                    onSseConnect={(args) => {
                        setSseTabState({ status: 'loading', requestId: args.requestId });
                        window.vscodeApi?.postMessage({ type: 'sseConnect', ...args });
                    }}
                    sseTabState={sseTabState}
                />
                {chainRunnerOpen && (
                    <ChainRunnerModal
                        available={allEndpoints}
                        envText={chainEnvText}
                        postMessage={(msg) => window.vscodeApi?.postMessage(msg)}
                        result={chainResult}
                        onCancel={() => { setChainRunnerOpen(false); }}
                    />
                )}
                {modalOverlays}
            </ErrorBoundary>
        );
    }

    // Issue #756: on cold load with a direct URL like `#/tour` (or any
    // recognized non-home route), there's a window between requestRoute
    // firing and the response arriving where `graph` is null and the
    // condition below would render the HomePage. That's the "tour shows
    // home" bug. When the URL is a non-home recognized route, render a
    // brief loading placeholder until the route's payload arrives (or
    // the 5s fallback fires). The 5s fallback at line 568 still flips
    // back to home if nothing arrives.
    // Issue #762: explicit per-route pending flag. The previous
    // implementation tried to derive "is this a direct-nav waiting for
    // its data?" purely from `!showHome && !graph && !initProgress`,
    // but the home-render condition below (`!graph && !initProgress`)
    // could fire first depending on React's batching and the route
    // would briefly flash the HomePage. We now explicitly check the
    // URL hash + match it against the navigation state's `mode` and
    // render a loading placeholder until the expected mode arrives.
    const parsedHash = (() => {
        try { return parseHash(window.location.hash); } catch { return null; }
    })();
    // The non-diagram routes (tour, violations) take a separate
    // broadcast path that doesn't update `mode`. For diagram routes
    // we expect mode to converge to one of the layer names.
    const expectedModeForRoute: Record<string, string | undefined> = {
        'system-design': 'microservice',
        'features': 'feature',
        'apis': 'api-list',
        'sequence': 'sequence',
        'file': 'file',
        'flow': 'flow',
        'health': 'health',
        'tour': 'tour',
        'map': 'map',
        'domain': 'domain',
    };
    const expectedMode = parsedHash ? expectedModeForRoute[parsedHash.route] : undefined;
    // Issue #762: for the tour route, the broadcast path goes through a
    // separate `tourSteps` message that doesn't intercept the showHome
    // race. Render a loading placeholder whenever the URL is #/tour and
    // mode hasn't yet converged to 'tour' — regardless of showHome /
    // graph / initProgress. The case 'tourSteps' handler clears showHome
    // and pushes a 'tour' nav entry; once mode === 'tour' the placeholder
    // unmounts and TourView takes over.
    const tourPending = parsedHash?.route === 'tour' && mode !== 'tour';
    const directNavPending =
        parsedHash !== null
        && parsedHash.route !== 'violations' // ViolationsView mounts on outsideRoute below
        && !showHome
        && !initProgress
        && (mode !== expectedMode || !graph);
    if (tourPending || directNavPending) {
        return (
            <ErrorBoundary>
                <div className="ca-loading">
                    <div className="ca-loading-spinner" />
                    <span>Loading…</span>
                </div>
                {/* #828 (2026-06-10): keep the shared pickers mounted while a
                    route is pending. The UX-63 per-repo diff/replay flows set
                    the hash FIRST (#/pr-diff/<repo>) and then open a picker
                    via a server push (showPrPicker / showBranchPicker /
                    showCommitPicker) — without this, the loading gate
                    unmounted the modal and the flow dead-ended on
                    "Loading…" in every multi-repo workspace. */}
                {modalOverlays}
            </ErrorBoundary>
        );
    }

    // Issue #749: render ViolationsView outside the graph-based stack.
    // The view requests its own data via `requestRoute violations` on
    // mount, so we don't need the extension to broadcast a graph entry.
    if (outsideRoute === 'violations') {
        return (
            <ErrorBoundary>
                <div className="ca-app">
                    {wsStuck && (
                        <div role="alert" style={{ background: 'var(--ca-error-bg, #5b2120)', color: 'var(--ca-error-text, #fee2e2)', padding: '8px 16px', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, borderBottom: '1px solid var(--ca-error-border, #7f1d1d)' }}>
                            <span>⚠ Connection lost. Reload to reconnect.</span>
                            <button onClick={() => window.location.reload()} style={{ padding: '4px 12px', background: 'var(--ca-error-btn, #b91c1c)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Reload</button>
                        </div>
                    )}
                    <nav className="ca-nav-bar">
                        <div className="ca-nav-breadcrumbs">
                            <button className="ca-back-btn" onClick={handleHome} aria-label="Home" title="Home">⌂</button>
                            <span className="ca-breadcrumb-divider">›</span>
                            <span className="ca-breadcrumb-current">Architecture Violations</span>
                        </div>
                    </nav>
                    <ViolationsView postMessage={(m) => (window as any).vscodeApi?.postMessage(m)} />
                </div>
            </ErrorBoundary>
        );
    }

    // Issue #762: when the URL is a recognized non-home route AND the
    // navigation entry hasn't arrived yet, render the loading placeholder
    // instead of falling through to HomePage. This is the safety net for
    // the tour direct-nav race that prior gates failed to catch — the
    // home check below fires when `!graph` is true regardless of intent,
    // even though the URL says the user is heading somewhere specific.
    if (parsedHash && parsedHash.route !== 'violations' && (!graph || mode !== expectedMode)) {
        return (
            <ErrorBoundary>
                <div className="ca-loading">
                    <div className="ca-loading-spinner" />
                    <span>Loading…</span>
                </div>
                {/* #828 — same picker-survival rule as the gate above. */}
                {modalOverlays}
            </ErrorBoundary>
        );
    }

    // Issue #762: hard-block HomePage when URL is a recognized non-home
    // route. The above loading-gate covers the common case but live
    // testing showed the tour broadcast path can still race past it,
    // causing HomePage to flash briefly. This stricter check inverts
    // the home-render guard to require an explicit home hash.
    const isHomeHash = isHomeHashRoute(window.location.hash);

    // Show HomePage when on home route (no graph needed)
    if (isHomeHash && (showHome || (!graph && !initProgress))) {
        return (
            <ErrorBoundary>
                <HomePage
                    isBrowserMode={isBrowserMode}
                    onNavigateDiagram={() => { setShowHome(false); showHomeRef.current = false; }}
                    wsInfo={wsInfo}
                    currentTheme={currentTheme}
                    onSetLlmConfig={handleSetLlmConfig}
                    clientId={clientId}
                    aiReviewError={aiReviewError}
                    onDismissAiReviewError={() => setAiReviewError(null)}
                    onOpenPathFinder={() => { setPathFinderResult(null); setPathFinderOpen(true); }}
                    repos={workspaceState?.mode === 'multi'
                        ? workspaceState.repos.map(r => ({ repoId: r.repoId, name: r.name, rootPath: r.rootPath }))
                        : undefined}
                    multiRepoInitStats={multiRepoInitStats}
                />
                {modalOverlays}
                {githubAuthBanner && (
                    <div
                        role="status"
                        aria-live="polite"
                        style={{
                            position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
                            zIndex: 1100, maxWidth: 'min(560px, calc(100% - 32px))',
                            padding: '12px 16px', borderRadius: 8,
                            display: 'flex', alignItems: 'center', gap: 12,
                            background: githubAuthBanner.status === 'success' ? '#dafbe1' : '#ffebe9',
                            border: `1px solid ${githubAuthBanner.status === 'success' ? '#1a7f37' : '#cf222e'}`,
                            color: githubAuthBanner.status === 'success' ? '#0d4e1f' : '#82071e',
                            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                            fontSize: 13,
                        }}
                    >
                        <span style={{ fontSize: 18, lineHeight: 1 }}>
                            {githubAuthBanner.status === 'success' ? '✓' : '⚠'}
                        </span>
                        <div style={{ flex: 1 }}>
                            {githubAuthBanner.status === 'success' ? (
                                githubAuthBanner.user ? (
                                    <>
                                        <strong>GitHub connected.</strong> Signed in as{' '}
                                        <a href={githubAuthBanner.user.html_url} target="_blank" rel="noreferrer"
                                            style={{ color: 'inherit', fontWeight: 700 }}>
                                            @{githubAuthBanner.user.login}
                                        </a>.
                                    </>
                                ) : (
                                    <><strong>GitHub connected.</strong> (Profile details unavailable.)</>
                                )
                            ) : (
                                <>
                                    <strong>GitHub connection failed.</strong>
                                    {githubAuthBanner.error ? <> {githubAuthBanner.error}</> : null}
                                    {' '}You can try again from the home page.
                                </>
                            )}
                        </div>
                        <button
                            onClick={() => setGithubAuthBanner(null)}
                            aria-label="Dismiss"
                            style={{
                                border: 0, background: 'transparent', cursor: 'pointer',
                                color: 'inherit', fontSize: 16, padding: 4, lineHeight: 1,
                            }}
                        >×</button>
                    </div>
                )}
                {appToast && (
                    <div className={`ca-home-toast${appToast.level === 'error' ? ' ca-toast-error' : appToast.level === 'warning' ? ' ca-toast-warning' : ''}`}>
                        {appToast.text}
                    </div>
                )}
                {wsStatus !== 'connected' && (window as any).__codeAtlasBrowserMode && (
                    <div className="ca-ws-banner" role="status" aria-live="polite">
                        {wsStatus === 'connecting'
                            ? 'Connecting to CodeAtlas extension…'
                            : 'Extension disconnected. Diagrams won\'t update until the connection is restored.'}
                    </div>
                )}
                <footer className="ca-app-footer" aria-label="CodeAtlas footer">
                    <span className="ca-app-footer-version">{formatAppVersion(wsInfo?.mcpServerVersion)}</span>
                </footer>
            </ErrorBoundary>
        );
    }

    if (!graph) {
        // No diagram data yet — show loading or init status
        return (
            <div className="ca-loading-screen">
                {initProgress ? (
                    <div>
                        <span className="ca-loading-spinner" />
                        <p>{initProgress.message}</p>
                        <div style={{ width: 200, height: 4, background: 'var(--ca-border, #3b4261)', borderRadius: 2, marginTop: 8 }}>
                            <div style={{ width: `${Math.round(initProgress.progress * 100)}%`, height: '100%', background: 'var(--ca-accent)', borderRadius: 2, transition: 'width 0.3s ease' }} />
                        </div>
                    </div>
                ) : (
                    <span>Connecting to CodeAtlas...</span>
                )}
            </div>
        );
    }

    return (
        <ErrorBoundary>
        <div className="ca-app">
            {/* Issue #754: prominent stuck-WS banner. Renders only after
                the bridge has failed to reconnect 3+ times in a row,
                so it doesn't flash on a normal momentary disconnect.
                Clicking Reload triggers a hard reload, which clears the
                stale session cache that's usually the root cause. */}
            {wsStuck && (
                <div
                    role="alert"
                    style={{
                        background: 'var(--ca-error-bg, #5b2120)',
                        color: 'var(--ca-error-text, #fee2e2)',
                        padding: '8px 16px',
                        fontSize: 13,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 16,
                        borderBottom: '1px solid var(--ca-error-border, #7f1d1d)',
                    }}
                >
                    <span>
                        ⚠ Connection lost. The browser tab can't reconnect to the CodeAtlas extension. The VS Code window may have restarted.
                    </span>
                    <button
                        onClick={() => window.location.reload()}
                        style={{
                            padding: '4px 12px',
                            background: 'var(--ca-error-btn, #b91c1c)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: 13,
                            fontWeight: 600,
                        }}
                    >
                        Reload
                    </button>
                </div>
            )}
            {/* Nav bar — always visible: breadcrumbs on left, git diff controls on right */}
            <nav className="ca-nav-bar">
                <div className="ca-nav-breadcrumbs">
                    {/* Home page button */}
                    <button className="ca-back-btn" onClick={handleHome} aria-label="Home" title="Home">⌂</button>
                    {/* Issue 110: render back whenever there's anything in the stack — at
                        index 0 (Cmd+Click deep-link) the button routes back to Home. */}
                    {navState.stack.length > 0 && (
                        <button className="ca-back-btn" onClick={handleBack} aria-label="Go back">←</button>
                    )}
                    {/* Issue 109: Forward button */}
                    {navState.stack.length > 0 && navState.index < navState.stack.length - 1 && (
                        <button className="ca-back-btn" onClick={handleForward} aria-label="Go forward">→</button>
                    )}
                    {/* Issue 108: service-name prefix in multi-service monorepos. */}
                    {currentServiceName && (
                        <React.Fragment>
                            <button
                                className="ca-breadcrumb-item"
                                onClick={handleHome}
                                title={`Service: ${currentServiceName}`}
                                aria-label={`Service ${currentServiceName} — go to system design`}
                                style={{ fontWeight: 600, opacity: 0.75 }}
                            >
                                {currentServiceName}
                            </button>
                            <span className="ca-breadcrumb-sep">›</span>
                        </React.Fragment>
                    )}
                    {(() => {
                        const visible = navState.stack.slice(0, navState.index + 1);
                        const maxShow = 4;
                        const collapsed = visible.length > maxShow;
                        const items = collapsed
                            ? [visible[0], null /* ellipsis */, ...visible.slice(-2)]
                            : visible;
                        let realIndex = 0;
                        return items.map((e, i) => {
                            if (e === null) {
                                return <React.Fragment key="ellipsis"><span className="ca-breadcrumb-sep">›</span><span className="ca-breadcrumb-item" style={{ opacity: 0.5 }}>...</span></React.Fragment>;
                            }
                            const idx = collapsed ? (i === 0 ? 0 : visible.length - (items.length - i)) : i;
                            return (
                                <React.Fragment key={idx}>
                                    {i > 0 && <span className="ca-breadcrumb-sep">›</span>}
                                    <button
                                        className={`ca-breadcrumb-item${idx === navState.index ? ' active' : ''}`}
                                        onClick={() => handleBreadcrumbNav(idx)}
                                        title={e.label}
                                        aria-label={`Navigate to ${e.label}`}
                                        aria-current={idx === navState.index ? 'page' : undefined}
                                    >
                                        {e.label}
                                    </button>
                                </React.Fragment>
                            );
                        });
                    })()}
                </div>
                <div className="ca-nav-git-diff" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {/* Issue 39: PNG / SVG / Markdown export menu */}
                    <ExportMenu
                        diagramLabel={currentEntry?.label ?? mode}
                        onToast={(text, level) => {
                            setAppToast({ text, level });
                            setTimeout(() => setAppToast(null), 2200);
                        }}
                    />
                    {gitDiffContext ? (
                        <>
                            <span
                                className="ca-git-diff-badge"
                                title={`${gitDiffContext.baseLabel} → ${gitDiffContext.headLabel}`}
                            >
                                {(() => {
                                    const prMatch = gitDiffContext.headLabel.match(/PR #(\d+)/);
                                    const prPrefix = prMatch ? `PR #${prMatch[1]} · ` : '';
                                    return `⎇ ${prPrefix}${gitDiffContext.baseHash.slice(0, 7)} → ${gitDiffContext.headHash.slice(0, 7)}`;
                                })()}
                            </span>
                            {!timelineReplay && (
                                <button
                                    className="ca-git-diff-replay"
                                    title="Replay changes layer by layer"
                                    onClick={() => window.vscodeApi?.postMessage({ type: 'replayCurrentDiff' })}
                                >
                                    ▶ Replay
                                </button>
                            )}
                            <button
                                className="ca-git-diff-clear"
                                title="Reset to live diff view"
                                onClick={() => window.vscodeApi?.postMessage({ type: 'clearGitDiff' })}
                            >
                                ✕ Reset
                            </button>
                        </>
                    ) : (
                        <button
                            className="ca-git-diff-btn"
                            title="Compare two git commits across all diagram layers"
                            onClick={() => window.vscodeApi?.postMessage({ type: 'requestGitDiff' })}
                        >
                            ⎇ Compare Commits
                        </button>
                    )}
                </div>
            </nav>


            {/* Command toolbar — visible on all diagram views */}
            <CommandBar activeMode={mode} currentGraphId={currentGraphId} currentCategory={categoryFromGraph(rawGraph as any)} currentTheme={currentTheme} isStandalone={!!wsInfo?.mcpServerVersion} explorerVisible={explorerVisible} onExplorerToggle={() => setExplorerVisible(v => !v)}
            onCommentsToggle={() => {
                setCommentsPanelVisible(v => {
                    const next = !v;
                    if (next) trackWebviewEvent('comments_panel_opened', { open_count: comments.filter(c => c.status === 'open').length });
                    return next;
                });
            }} commentCount={comments.filter(c => c.status === 'open').length}
            onOverlaysToggle={() => setOverlaysPanelOpen(v => !v)} />

            {/* Toast notification */}
            {appToast && (
                <div className={`ca-home-toast${appToast.level === 'error' ? ' ca-toast-error' : appToast.level === 'warning' ? ' ca-toast-warning' : ''}`}>
                    {appToast.text}
                </div>
            )}

            {/* BUG-EXPLORE-11: in-webview comment composer (replaces native prompt). */}
            {commentComposer && (
                <TextPromptModal
                    title="Add comment"
                    placeholder="Write a comment…"
                    submitLabel="Add comment"
                    multiline
                    onSubmit={(body) => {
                        window.vscodeApi?.postMessage({
                            type: 'addComment',
                            targetId: commentComposer.nodeId,
                            targetType: 'node',
                            body,
                            layer: commentComposer.layer,
                            anchor: commentComposer.anchor,
                        });
                        setCommentCounts(prev => ({ ...prev, [commentComposer.nodeId]: (prev[commentComposer.nodeId] ?? 0) + 1 }));
                        setCommentComposer(null);
                    }}
                    onCancel={() => setCommentComposer(null)}
                />
            )}

            {/* WS connection status banner — only shown when the localhost
                extension is unreachable from the browser tab. */}
            {wsStatus !== 'connected' && (window as any).__codeAtlasBrowserMode && (
                <div className="ca-ws-banner" role="status" aria-live="polite">
                    {wsStatus === 'connecting'
                        ? 'Connecting to CodeAtlas extension…'
                        : 'Extension disconnected. Diagrams won\'t update until the connection is restored.'}
                </div>
            )}

            {/* Modal overlays (commit picker, PR picker, branch picker, search picker) */}
            {modalOverlays}

            {/* Explorer sidebar (floating) */}
            <ExplorerSidebar
                visible={explorerVisible}
                onToggle={() => setExplorerVisible(v => !v)}
                repos={workspaceState?.mode === 'multi'
                    ? workspaceState.repos.map(r => ({ repoId: r.repoId, name: r.name, rootPath: r.rootPath }))
                    : undefined}
            />

            {/* Diagram canvas — wrapped in ErrorBoundary to prevent full-app crash (#12) */}
            {/* Issue #755: previously used `key={mode + currentGraphIdRef.current}`
                to force-remount on route change, but `currentGraphIdRef` is a
                ref (not state) so its read in render races with state updates
                and the resulting key churn caused a hook-count regression
                (Issue #759 / React #310). Use only `mode` for the key — that's
                state-derived and stable per render, and it's enough to flush
                the stale Chain-Runner content from #/api-testing when the user
                navigates to a different mode. */}
            <div className="ca-diagram-container" key={mode}>
                {/* Attribution. Rendered inside the canvas container so it is
                    captured in exported screenshots and screen recordings.
                    Non-interactive (pointer-events: none in CSS). */}
                <div className="ca-attribution-badge" aria-hidden="true">Powered by CodeAtlas</div>
                {/* UX-PAGE-LOADER — transient overlay shown between a manual
                    navigation click and the next layer's render. Suppressed
                    during replay (shouldShowNavLoader). */}
                {shouldShowNavLoader(navPending, isReplayActive(replayState, timelineReplay)) && (
                    <div className="ca-nav-loader" role="status" aria-live="polite" aria-label="Loading next view">
                        <div className="ca-nav-loader-spinner" />
                    </div>
                )}
                <ErrorBoundary>
                {mode === 'tour' ? (
                    // Issue #702 / #736 — TourView replaces DiagramView when
                    // we're showing the guided onboarding tour. The tour
                    // graph entry carries `{ steps, tourMode }` in its graph
                    // payload (synthesized when `tourSteps` arrives).
                    <TourView
                        postMessage={(m) => (window as any).vscodeApi?.postMessage(m)}
                        steps={(graph as any)?.steps ?? []}
                        mode={((graph as any)?.tourMode === 'recent') ? 'recent' : 'codebase'}
                        onPlayStep={handleTourPlayStep}
                    />
                ) : (
                    <>
                    {/* #919 — persistent per-layer "what am I looking at?" one-liner. */}
                    <LayerLegend mode={mode} />
                    <DiagramView
                        graph={graph}
                        mode={mode}
                        onNodeClick={handleNodeClick}
                        onNodeRightClick={handleNodeRightClick}
                        onEdgeClick={handleEdgeClick}
                        impactData={impactData}
                        highlightedNodes={highlightedNodes}
                        highlightReasons={highlightReasons}
                        commentCounts={commentCounts}
                        onImpactClose={() => { setImpactData(null); setHighlightedNodes({}); setHighlightReasons({}); }}
                        onImpactNavigate={handleImpactNavigate}
                        workspaceServiceCount={wsInfo?.serviceCount ?? null}
                        activeMessageEdgeId={
                            tourPlayback && !tourPlayback.pendingGraphId && tourPlayback.edgeIds.length > 0
                                ? tourPlayback.edgeIds[tourPlayback.msgIndex]
                                : undefined
                        }
                        savedViewsSlot={mode === 'api-list' ? (
                            <SavedViewsToolbar
                                views={savedFilterViews}
                                onSave={(name) => {
                                    const view = {
                                        id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${Date.now()}`,
                                        name,
                                        route: window.location.hash.replace(/^#/, '') || '/',
                                        filters: {},
                                        createdAt: Date.now(),
                                    };
                                    window.vscodeApi?.postMessage({ type: 'saveFilterView', view });
                                }}
                                onApply={(id) => {
                                    const view = savedFilterViews.find(v => v.id === id);
                                    if (view) window.location.hash = `#${view.route}`;
                                }}
                                onDelete={(id) => {
                                    window.vscodeApi?.postMessage({ type: 'deleteFilterView', id });
                                }}
                            />
                        ) : undefined}
                    />
                    </>
                )}
                </ErrorBoundary>

                {/* Live replay indicator (from file save) */}
                {replayState && !timelineReplay && (
                    <div style={{
                        position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)',
                        background: 'var(--ca-surface)', border: '1px solid var(--ca-accent)',
                        borderRadius: 'var(--ca-radius-lg)', padding: '6px 14px',
                        fontSize: 'var(--ca-font-body)', color: 'var(--ca-accent)',
                        display: 'flex', alignItems: 'center', gap: 8, zIndex: 25, boxShadow: 'var(--ca-shadow-md)',
                    }}>
                        <span>&#9654; Replay {((replayState as any).globalIndex ?? replayState.index) + 1}/{(replayState as any).totalSteps ?? replayState.total}</span>
                        {/* #818 R4 — coda chip on the standalone's simple replay bar. */}
                        {(replayState as any).replayKind === 'cross-repo-coda' && (
                            <span
                                data-testid="ca-replay-coda-chip"
                                style={{ fontSize: 10, padding: '1px 7px', borderRadius: 9, background: 'rgba(59,130,246,0.18)', border: '1px solid var(--ca-accent)' }}
                            >
                                🔗 cross-repo {(replayState as any).codaProducer} → {(replayState as any).codaConsumer}
                            </span>
                        )}
                        {replayState.functionName && <span style={{ color: 'var(--ca-text)' }}>{replayState.functionName}</span>}
                        <span style={{ color: 'var(--ca-text-muted)' }}>{replayState.layer}</span>
                        <button
                            onClick={() => window.vscodeApi?.postMessage({ type: 'stopReplay' })}
                            style={{ background: 'var(--ca-danger)', border: 'none', borderRadius: 4, color: '#fff', padding: '2px 8px', cursor: 'pointer', fontSize: 11 }}
                        >Stop</button>
                    </div>
                )}

                {/* Commit Timeline Replay controls */}
                {timelineReplay && (
                    <ReplayControls
                        step={timelineReplay.step}
                        commitInfo={timelineReplay.commitInfo}
                        paused={timelineReplay.paused}
                        onControl={(action) => window.vscodeApi?.postMessage({ type: 'timelineReplayControl', action })}
                        onSpeedChange={(ms) => window.vscodeApi?.postMessage({ type: 'timelineReplaySpeed', speedMs: ms })}
                    />
                )}

                {/* Tour Playback controls (active during "Play diagram" walk-through) */}
                {tourPlayback && (
                    <TourPlaybackControls
                        stepIndex={tourPlayback.stepIndex}
                        totalSteps={tourPlayback.steps.length}
                        stepLabel={tourPlayback.steps[tourPlayback.stepIndex]?.label ?? ''}
                        msgIndex={tourPlayback.msgIndex}
                        totalMsgs={tourPlayback.edgeIds.length}
                        activeMessageLabel={tourPlayback.edgeLabels[tourPlayback.msgIndex] ?? ''}
                        paused={tourPlayback.paused}
                        onControl={handleTourPlaybackControl}
                        onSpeedChange={(ms) => setTourPlayback(prev => prev ? { ...prev, speedMs: ms } : prev)}
                    />
                )}
            </div>

            {/* Timeline bar */}
            <TimelineBar
                entries={changeLog}
                onNavigate={(id) => window.vscodeApi?.postMessage({ type: 'navigateToChangeEntry', entryId: id })}
                onPlayPause={(action) => window.vscodeApi?.postMessage({ type: 'playbackChangeLog', action })}
                playing={!!replayState}
            />

            {/* Comments panel */}
            <CommentsPanel
                comments={comments}
                visible={commentsPanelVisible}
                onClose={() => setCommentsPanelVisible(false)}
                onNavigate={(comment) => {
                    trackWebviewEvent('comment_navigated', {
                        layer: String(comment.layer ?? 'unknown'),
                        has_symbol: !!comment.anchor?.symbol,
                    });
                    // Navigate to the diagram containing this comment
                    if (comment.anchor?.filePath && comment.anchor?.symbol && (comment.layer === 'flow' || comment.layer === 'file')) {
                        window.vscodeApi?.postMessage({ type: comment.layer === 'flow' ? 'openFunctionFlow' : 'openFileDiagram', filePath: comment.anchor.filePath, functionName: comment.anchor.symbol });
                    } else if (comment.anchor?.filePath) {
                        window.vscodeApi?.postMessage({ type: 'openFileDiagram', filePath: comment.anchor.filePath });
                    }
                }}
                onResolve={(id) => {
                    window.vscodeApi?.postMessage({ type: 'resolveComment', commentId: id });
                }}
            />


            {/* Context menu */}
            {ctxMenu && (
                <div
                    className="ca-context-menu"
                    role="menu"
                    aria-label="Node context menu"
                    style={{ left: Math.min(ctxMenu.x, window.innerWidth - 210), top: Math.min(ctxMenu.y, window.innerHeight - 120) }}
                    onMouseDown={e => e.stopPropagation()}
                >
                    {/* Hide "Open in new window" in browser mode — no VS Code panels (#10) */}
                    {!(window as any).__codeAtlasBrowserMode && (
                        <div
                            className="ca-context-menu-item"
                            onClick={() => {
                                setCtxMenu(null);
                                handleNodeClick(ctxMenu.nodeId, ctxMenu.nodeData, { metaKey: true } as React.MouseEvent);
                            }}
                        >
                            Open in new window
                        </div>
                    )}
                    {ctxMenu.nodeData?.anchor?.filePath && (
                        <>
                            <div className="ca-context-menu-sep" />
                            <div
                                className="ca-context-menu-item"
                                onClick={() => {
                                    setCtxMenu(null);
                                    window.vscodeApi?.postMessage({
                                        type: 'requestImpact',
                                        nodeId: ctxMenu.nodeId,
                                        filePath: ctxMenu.nodeData.anchor.filePath,
                                        functionName: ctxMenu.nodeData.anchor?.symbol,
                                    });
                                }}
                            >
                                Impact analysis
                            </div>
                        </>
                    )}
                    <div className="ca-context-menu-sep" />
                    <div
                        className="ca-context-menu-item"
                        onClick={() => {
                            // BUG-EXPLORE-11: open the in-webview composer instead of the
                            // freezing native prompt().
                            setCommentComposer({ nodeId: ctxMenu.nodeId, layer: mode, anchor: ctxMenu.nodeData?.anchor });
                            setCtxMenu(null);
                        }}
                    >
                        Add comment
                    </div>
                    {/* Issue 134: View existing comments on this node */}
                    {(() => {
                        const nodeComments = comments.filter(c =>
                            c.targetId === ctxMenu.nodeId ||
                            (c.anchor?.filePath && c.anchor?.symbol && ctxMenu.nodeData?.anchor?.filePath === c.anchor.filePath && ctxMenu.nodeData?.anchor?.symbol === c.anchor.symbol)
                        );
                        if (nodeComments.length === 0) return null;
                        return (
                            <div
                                className="ca-context-menu-item"
                                onClick={() => {
                                    setCtxMenu(null);
                                    setCommentsPanelVisible(true);
                                }}
                            >
                                View {nodeComments.length} comment{nodeComments.length > 1 ? 's' : ''}
                            </div>
                        );
                    })()}
                </div>
            )}
            <footer className="ca-app-footer" aria-label="CodeAtlas footer">
                <span className="ca-app-footer-version">{formatAppVersion(wsInfo?.mcpServerVersion)}</span>
            </footer>
        </div>
        </ErrorBoundary>
    );
}

export default App;
