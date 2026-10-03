/**
 * messageHandler.ts — standalone WS message router.
 *
 * The VS Code extension routes browser messages through
 * `panelManager.handleMessage` → `messageRouter.dispatch` → per-feature
 * handler modules. The standalone server doesn't have a PanelManager (it
 * has no webview, only the browser) and skips the messageRouter so we
 * can selectively support a subset of features without dragging in the
 * full HandlerContext shape.
 *
 * v1 message support:
 *   - `ready` — initial handshake, ack with capabilities + initial graph
 *   - `requestRoute` — read graph from SnapshotStore + broadcast navigate
 *   - `nodeClicked` / `edgeClicked` — open in editor when anchor present
 *   - `resolveComment` — comment write via CommentStore
 *   - `toggleTheme`, `panelNavigated` — pass-through state
 *   - `runCommand` — limited subset (theme, export)
 *
 * v1 messages that broadcast a "feature not yet available" toast:
 *   - replay, AI review, NL query, git diff, GitHub connect
 *
 * Each of those follows up in a separate PR — the goal of this file is to
 * support core diagram navigation end-to-end first.
 */

import type { SnapshotStore } from '../core/storage/snapshotStore';
import type { CommentStore } from '../core/storage/commentStore';
import { aggregateMultiRepoCounts, stripForeignServiceRows } from '../core/storage/workspaceInfoAggregator';
import { getLazyGraphMap } from '../core/storage/lazyGraphMap';
import { buildSkeletalL1, buildCrossRepoEdges } from '../core/sync/skeletalL1';
import { markMultiRepoL1Diff } from '../core/sync/multiRepoL1Diff';
import { buildTour, buildWorkspaceMetaTour, toLiteSteps } from '../core/analysis/tourBuilder';
import { computeExtractionConfidence } from '../core/analysis/extractionConfidence';
import { buildWorkspaceMapGraph } from '../core/graph/mapGraphBuilder';
import { buildWorkspaceApiListGraph, WORKSPACE_API_LIST_ID } from '../core/graph/workspaceApiListBuilder';
import { deriveSequenceFallbackIds } from '../core/graph/sequenceFallbackIds';
import { pickerSubtitle, repoCategoryFromServices } from '../core/graph/pickerLabels';
import { resolveFlowGraphId } from '../core/graph/flowGraphResolve';
import { safeResolve } from '../core/navigation/pathValidator';
import type { WsBridge } from '../server/wsBridge';
import type { DiagramGraph, GraphNode } from '../core/graph/graphTypes';
import { openInEditor } from './editorOpener';
import type { SettingsResolver } from './settings';
import type { SecretsStore } from './secrets';
import type { StandaloneClerkAuth } from './clerkAuth';
import { isAllowedWhenSignedOut, workspaceAuthFields, type WorkspaceAuthFields } from '../lib/browserAuthGate';
import { createMessageRouter } from '../handlers/messageRouter';
import { registerCommentHandlers } from '../handlers/commentHandlers';
import { registerAiReviewHandlers } from '../handlers/aiReviewHandlers';
import type { HandlerContext } from '../handlers/handlerContext';
import { createStandalonePlatform } from './platform';
import { runAiReview, clearAiReview as clearAiReviewState, createAiReviewState, type AiReviewState } from './aiReview';
import { replayWorkingChanges, stopReplay as stopReplayFn, applyReplayControl, setReplaySpeed, createReplayState, type ReplayState } from './replay';
import {
    requestGitDiff as gitDiffRequest,
    commitSelected as gitDiffCommitSelected,
    requestBranchDiff as gitDiffRequestBranch,
    branchSelected as gitDiffBranchSelected,
    requestPrDiff as gitDiffRequestPr,
    prSelected as gitDiffPrSelected,
    clearGitDiff as gitDiffClear,
    requestTimelineCommits as gitDiffRequestTimelineCommits,
    startTimelineReplay as gitDiffStartTimelineReplay,
    skipReplayCommit as gitDiffSkipCommit,
    createGitDiffState,
    type GitDiffState,
} from './gitDiff';

export interface StandaloneHandlerDeps {
    snapshotStore: SnapshotStore;
    commentStore: CommentStore;
    wsBridge: WsBridge;
    workspaceRoot: string;
    log: (msg: string) => void;
    /**
     * Editor opener injected for tests. Defaults to the real
     * `openInEditor` from editorOpener.ts.
     */
    editorOpener?: typeof openInEditor;
    /** Settings + secrets needed by AI Review / NL query. Optional — when
     *  absent, those features fall back to the "not available" toast. */
    settings?: SettingsResolver;
    secrets?: SecretsStore;
    /** Clerk auth for the browser view (login + user details). */
    auth?: StandaloneClerkAuth;
    /**
     * MCP standalone bundle version, broadcast in `workspaceInfo` so the
     * webview can render a `MCP <version>` badge alongside the extension
     * version (which is what `webview-ui/vite.config.ts` injects). Only
     * set when serving from `@codeatlas/mcp` — undefined for the
     * VS Code extension host path.
     */
    mcpServerVersion?: string;
    /**
     * Issue #733 — optional trigger for immediate Domain refinement.
     * When wired (by `standalone/server.ts` which holds a reference to
     * the SyncOrchestrator), toggling the chip on the HomePage fires
     * this callback so the user sees the refined graph without having
     * to save a file first. When absent, the toggle writes the setting
     * and the next file-save cascade picks it up.
     */
    triggerDomainRefresh?: () => Promise<string[]>;
    /**
     * #815 (2026-06-10) — multi-repo plumbing. When the underlying
     * `WorkspaceBootstrap` registered ≥2 sub-repos, the entry point
     * threads them through here so explorerData / route handlers /
     * wsInfo can match the extension's multi-repo behaviour.
     */
    multiRepo?: {
        aggregator: unknown;
        perRepoStores: Map<string, SnapshotStore>;
        repos: ReadonlyArray<{ repoId: string; name: string; rootPath: string }>;
    };
    /**
     * #851 — PR watcher control, late-bound thunk (the watcher is built
     * after the wsBridge it broadcasts through). Undefined ⇒ this surface
     * can't run a watcher; the card renders "not available".
     */
    prWatcher?: () => import('../core/review/prWatcher').PrWatcher | undefined;
}

/** Map of WS message type → handler function. */
export interface StandaloneMessageHandler {
    handle(msg: any, clientId: string): void | Promise<void>;
}

const UNAVAILABLE = [
    // Clerk-based sign-in is out of scope. Kept in the toast set because it's a
    // genuine USER action (a "Sign in" button) — the toast explains the no-op.
    'connectGitHub',
] as const;
// NOTE: change-log messages (`requestChangeLog` / `navigateToChangeEntry` /
// `playbackChangeLog`) are NOT here — `requestChangeLog` is posted
// unconditionally on webview mount, so toasting it fired a spurious "not
// available" warning on every plain L1 load. They're handled silently below
// (empty change log) so passive probes never toast.

const UNAVAILABLE_MESSAGE = 'Feature not yet available in the standalone npm package — install the VS Code extension or wait for a follow-up release.';

export function createStandaloneMessageHandler(deps: StandaloneHandlerDeps): StandaloneMessageHandler {
    const opener = deps.editorOpener ?? openInEditor;
    const unavailable = new Set<string>(UNAVAILABLE);
    // Per-handler state — kept locally so we don't pollute callers with the
    // bookkeeping (request IDs, in-flight flags, last result).
    const aiReviewState: AiReviewState = createAiReviewState();
    const replayState: ReplayState = createReplayState();
    const gitDiffState: GitDiffState = createGitDiffState();

    // #547: shared message router for handler modules that target both
    // runtimes. Today only `commentHandlers` registers here (uses
    // `ctx.platform.*` and snapshotStore — cross-runtime). Other modules
    // early-return on missing `ctx.context` so calling them on the
    // standalone is a safe no-op should they ever be added below. Messages
    // with no shared registration fall through to the switch below.
    const sharedRouter = buildSharedRouter(deps);

    async function handle(msg: any, clientId: string): Promise<void> {
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

        // Auth gate — block diagram/git/tool messages while signed out (only
        // init/re-init/resync + sign-in are allowed). Authoritative: enforced
        // here regardless of what the webview UI shows. Only active when an auth
        // service is wired (the real server); the test harness omits it.
        if (deps.auth && !deps.auth.getUser() && !isAllowedWhenSignedOut(msg)) {
            deps.wsBridge.sendTo?.(clientId, { type: 'signInRequired', action: msg.type === 'runCommand' ? msg.command : msg.type });
            deps.wsBridge.sendTo?.(clientId, { type: 'clientToast', level: 'info', message: 'Sign in to view diagrams and use the tools — you can still initialize / re-sync while signed out.' });
            return;
        }

        // #547: try the shared router first — if a migrated handler module
        // has registered this message type, it owns dispatch. Falls through
        // to the switch when no shared registration exists.
        if (sharedRouter.canHandle(msg.type)) {
            sharedRouter.dispatch(msg, clientId);
            return;
        }

        switch (msg.type) {
            case 'ready':
                handleReady(deps, clientId);
                return;

            case 'requestRoute':
                // Issue #601 — `route: 'api-testing'` is a top-level
                // surface (not a graphId), so it needs its own dispatch.
                if ((msg as any).route === 'api-testing') {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { buildApiTestingPayload } = require('../core/apiTesting/buildFromApiRecord');
                        const payload = buildApiTestingPayload(deps.snapshotStore.getWorking());
                        deps.wsBridge.broadcast({ type: 'apiTestingData', payload });
                    } catch (err: any) {
                        deps.log(`[standalone] api-testing build failed: ${err?.message ?? err}`);
                        broadcastToast(deps, 'error', `API Testing build failed: ${(err?.message ?? err).slice(0, 200)}`);
                    }
                    return;
                }
                handleRequestRoute(deps, msg, clientId);
                return;

            // Issue #603 Phase 3 — chain runner. Runs N steps server-side
            // and ships the aggregate per-step result back to the
            // originating client.
            case 'runChain': {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { runChain } = require('../core/apiTesting/runChain');
                    const runId = (msg as any).runId ?? '';
                    const result = await runChain({
                        steps: (msg as any).steps ?? [],
                        initialEnv: (msg as any).initialEnv ?? {},
                        stopOnFirstFailure: Boolean((msg as any).stopOnFirstFailure),
                        allowPrivateHosts: true, // #887 — user-initiated workbench run
                    });
                    deps.wsBridge.sendTo(clientId, { type: 'runChainResult', runId, result });
                } catch (err: any) {
                    deps.log(`[standalone] runChain failed: ${err?.message ?? err}`);
                    broadcastToast(deps, 'error', `Chain failed: ${(err?.message ?? err).slice(0, 200)}`);
                }
                return;
            }

            // Issue #602 Phase 2 — API Testing send request. The relay
            // runs in the server process, then the response is shipped
            // back to the originating client (not broadcast — only the
            // requester sees the result).
            case 'sendRequest': {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { executeRequest } = require('../core/apiTesting/relay');
                    const requestId = (msg as any).requestId ?? '';
                    const response = await executeRequest({
                        method: (msg as any).method,
                        url: (msg as any).url,
                        headers: (msg as any).headers,
                        body: (msg as any).body,
                        env: (msg as any).env,
                        bearerToken: (msg as any).bearerToken,
                        apiKey: (msg as any).apiKey,
                        apiKeyHeader: (msg as any).apiKeyHeader,
                        timeoutMs: (msg as any).timeoutMs,
                        allowPrivateHosts: true, // #887 — user-initiated workbench Send
                    });
                    deps.wsBridge.sendTo(clientId, {
                        type: 'sendRequestResult',
                        requestId,
                        response,
                    });
                } catch (err: any) {
                    deps.log(`[standalone] sendRequest failed: ${err?.message ?? err}`);
                    broadcastToast(deps, 'error', `Request failed: ${(err?.message ?? err).slice(0, 200)}`);
                }
                return;
            }

            // #745 (2026-06-05) — API collection importer
            // (OpenAPI / Postman / Insomnia). Mirrors the extension-host
            // handler in src/extension.ts. Webview posts the raw spec;
            // server returns an ApiTestingPayload chunk the webview merges
            // into its collection list.
            case 'importApiCollection': {
                const requestId = ((msg as any).requestId as string | undefined) ?? `import-${Date.now()}`;
                const send = (payload: any): void => {
                    deps.wsBridge.sendTo(clientId, payload);
                };
                try {
                    const raw = (msg as any).spec ?? (msg as any).specText;
                    let parsed: unknown = raw;
                    if (typeof raw === 'string') {
                        try { parsed = JSON.parse(raw); }
                        catch (e: any) {
                            send({ type: 'importApiCollectionResult', requestId, error: `Spec is not valid JSON: ${e?.message ?? e}` });
                            return;
                        }
                    }
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { importApiCollection } = require('../core/apiTesting/importers');
                    const result = importApiCollection(parsed);
                    if (!result) {
                        send({ type: 'importApiCollectionResult', requestId, error: 'Spec format not recognised. Expected OpenAPI 3.x / Swagger 2.0 / Postman v2.1 / Insomnia v4.' });
                        return;
                    }
                    send({ type: 'importApiCollectionResult', requestId, payload: result.payload, format: result.format });
                } catch (err: any) {
                    deps.log(`[standalone] importApiCollection failed: ${err?.message ?? err}`);
                    send({ type: 'importApiCollectionResult', requestId, error: err?.message ?? String(err) });
                }
                return;
            }

            // #744 (2026-06-05) — LLM-driven request-body generator.
            // Mirrors the extension-host handler in src/extension.ts so
            // the standalone server exposes the same UI affordance.
            case 'generateRequestBody': {
                const apiId = (msg as any).apiId as string;
                const requestId = ((msg as any).requestId as string | undefined) ?? `gen-body-${Date.now()}`;
                const send = (payload: any): void => {
                    deps.wsBridge.sendTo(clientId, payload);
                };
                try {
                    const snap = deps.snapshotStore.getWorking();
                    const api = snap?.apiIndex?.[apiId];
                    if (!api) {
                        send({ type: 'generateRequestBodyResult', requestId, apiId, error: `Endpoint ${apiId} not found.` });
                        return;
                    }
                    const handlerSource = deps.snapshotStore.getFileContent('working', api.filePath) ?? '';
                    if (!handlerSource) {
                        send({ type: 'generateRequestBodyResult', requestId, apiId, error: `Handler source not available for ${api.filePath}.` });
                        return;
                    }
                    const provider = (deps.settings?.get<string>('llmProvider') ?? 'openrouter');
                    const keyOptional = provider === 'ollama' || provider === 'custom';
                    const storedKey = (await deps.secrets?.get('codeatlas.openRouterApiKey')) ?? '';
                    if (!storedKey && !keyOptional) {
                        send({ type: 'generateRequestBodyResult', requestId, apiId, error: 'No API key configured.' });
                        return;
                    }
                    const isLocal = provider === 'ollama' || provider === 'custom';
                    const llmConfig = {
                        apiKey: storedKey,
                        model: deps.settings?.get<string>('llmModel') ?? 'openrouter/free',
                        timeoutMs: isLocal ? 120_000 : 30_000,
                        provider,
                        endpoint: deps.settings?.get<string>('llmEndpoint') ?? '',
                        allowCustomEndpointAuth: true, // #885 — user-configured endpoint = consent
                    };
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { generateRequestBody } = require('../core/apiTesting/aiTestGen/generateRequestBody');
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { toEndpoint } = require('../core/apiTesting/buildFromApiRecord');
                    const result = await generateRequestBody({ endpoint: toEndpoint(api), handlerSource }, llmConfig);
                    send({ type: 'generateRequestBodyResult', requestId, apiId, result });
                } catch (err: any) {
                    deps.log(`[standalone] generateRequestBody failed: ${err?.message ?? err}`);
                    send({ type: 'generateRequestBodyResult', requestId, apiId, error: err?.message ?? String(err) });
                }
                return;
            }

            // #744 (2026-06-06) — chain composer for the standalone path.
            case 'generateChain': {
                const requestId = ((msg as any).requestId as string | undefined) ?? `gen-chain-${Date.now()}`;
                const intent = (msg as any).intent as string | undefined;
                const maxSteps = (msg as any).maxSteps as number | undefined;
                const send = (payload: any): void => {
                    deps.wsBridge.sendTo(clientId, payload);
                };
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { buildApiTestingPayload } = require('../core/apiTesting/buildFromApiRecord');
                    const payload = buildApiTestingPayload(deps.snapshotStore.getWorking());
                    const endpoints = (payload?.collections ?? []).flatMap((c: any) => c.endpoints ?? []);
                    if (endpoints.length === 0) {
                        send({ type: 'generateChainResult', requestId, error: 'No endpoints available to compose a chain from.' });
                        return;
                    }
                    const provider = (deps.settings?.get<string>('llmProvider') ?? 'openrouter');
                    const keyOptional = provider === 'ollama' || provider === 'custom';
                    const storedKey = (await deps.secrets?.get('codeatlas.openRouterApiKey')) ?? '';
                    if (!storedKey && !keyOptional) {
                        send({ type: 'generateChainResult', requestId, error: 'No API key configured.' });
                        return;
                    }
                    const isLocal = provider === 'ollama' || provider === 'custom';
                    const llmConfig = {
                        apiKey: storedKey,
                        model: deps.settings?.get<string>('llmModel') ?? 'openrouter/free',
                        timeoutMs: isLocal ? 120_000 : 30_000,
                        provider,
                        endpoint: deps.settings?.get<string>('llmEndpoint') ?? '',
                        allowCustomEndpointAuth: true, // #885 — user-configured endpoint = consent
                    };
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { generateChain } = require('../core/apiTesting/aiTestGen/generateChain');
                    const result = await generateChain({ endpoints, intent, maxSteps }, llmConfig);
                    send({ type: 'generateChainResult', requestId, result });
                } catch (err: any) {
                    deps.log(`[standalone] generateChain failed: ${err?.message ?? err}`);
                    send({ type: 'generateChainResult', requestId, error: err?.message ?? String(err) });
                }
                return;
            }

            // #744 (2026-06-06) — per-endpoint test-case generator.
            case 'generateTestCases': {
                const apiId = (msg as any).apiId as string;
                const requestId = ((msg as any).requestId as string | undefined) ?? `gen-tests-${Date.now()}`;
                const maxCases = (msg as any).maxCases as number | undefined;
                const send = (payload: any): void => {
                    deps.wsBridge.sendTo(clientId, payload);
                };
                try {
                    const snap = deps.snapshotStore.getWorking();
                    const api = snap?.apiIndex?.[apiId];
                    if (!api) {
                        send({ type: 'generateTestCasesResult', requestId, apiId, error: `Endpoint ${apiId} not found.` });
                        return;
                    }
                    const handlerSource = deps.snapshotStore.getFileContent('working', api.filePath) ?? '';
                    if (!handlerSource) {
                        send({ type: 'generateTestCasesResult', requestId, apiId, error: `Handler source not available for ${api.filePath}.` });
                        return;
                    }
                    const provider = (deps.settings?.get<string>('llmProvider') ?? 'openrouter');
                    const keyOptional = provider === 'ollama' || provider === 'custom';
                    const storedKey = (await deps.secrets?.get('codeatlas.openRouterApiKey')) ?? '';
                    if (!storedKey && !keyOptional) {
                        send({ type: 'generateTestCasesResult', requestId, apiId, error: 'No API key configured.' });
                        return;
                    }
                    const isLocal = provider === 'ollama' || provider === 'custom';
                    const llmConfig = {
                        apiKey: storedKey,
                        model: deps.settings?.get<string>('llmModel') ?? 'openrouter/free',
                        timeoutMs: isLocal ? 120_000 : 30_000,
                        provider,
                        endpoint: deps.settings?.get<string>('llmEndpoint') ?? '',
                        allowCustomEndpointAuth: true, // #885 — user-configured endpoint = consent
                    };
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { generateTestCases } = require('../core/apiTesting/aiTestGen/generateTestCases');
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { toEndpoint } = require('../core/apiTesting/buildFromApiRecord');
                    const result = await generateTestCases({ endpoint: toEndpoint(api), handlerSource, maxCases }, llmConfig);
                    send({ type: 'generateTestCasesResult', requestId, apiId, result });
                } catch (err: any) {
                    deps.log(`[standalone] generateTestCases failed: ${err?.message ?? err}`);
                    send({ type: 'generateTestCasesResult', requestId, apiId, error: err?.message ?? String(err) });
                }
                return;
            }

            // #745 (2026-06-06) — OAuth2 standalone handlers.
            case 'oauth2ClientCredentials': {
                const requestId = ((msg as any).requestId as string | undefined) ?? `cc-${Date.now()}`;
                const send = (payload: any): void => { deps.wsBridge.sendTo(clientId, payload); };
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { clientCredentialsGrant } = require('../core/apiTesting/oauth2');
                    const result = await clientCredentialsGrant({
                        tokenEndpoint: (msg as any).tokenEndpoint,
                        clientId: (msg as any).clientId,
                        clientSecret: (msg as any).clientSecret,
                        scope: (msg as any).scope,
                        audience: (msg as any).audience,
                    });
                    if (result.ok) send({ type: 'oauth2ClientCredentialsResult', requestId, token: result.token });
                    else send({ type: 'oauth2ClientCredentialsResult', requestId, error: `${result.error.error}${result.error.description ? ': ' + result.error.description : ''}` });
                } catch (err: any) {
                    deps.log(`[standalone] oauth2ClientCredentials failed: ${err?.message ?? err}`);
                    send({ type: 'oauth2ClientCredentialsResult', requestId, error: err?.message ?? String(err) });
                }
                return;
            }

            case 'oauth2BuildAuthorizationUrl': {
                const requestId = ((msg as any).requestId as string | undefined) ?? `au-${Date.now()}`;
                const send = (payload: any): void => { deps.wsBridge.sendTo(clientId, payload); };
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { buildAuthorizationUrl, generatePkcePair } = require('../core/apiTesting/oauth2');
                    let pkce: any;
                    let codeVerifier: string | undefined;
                    if ((msg as any).usePkce) {
                        const pair = await generatePkcePair();
                        pkce = { codeChallenge: pair.codeChallenge, codeChallengeMethod: 'S256' };
                        codeVerifier = pair.codeVerifier;
                    }
                    const built = buildAuthorizationUrl({
                        authorizationEndpoint: (msg as any).authorizationEndpoint,
                        clientId: (msg as any).clientId,
                        redirectUri: (msg as any).redirectUri,
                        scope: (msg as any).scope,
                        pkce,
                    });
                    send({ type: 'oauth2AuthorizeUrlResult', requestId, url: built.url, state: built.state, codeVerifier });
                } catch (err: any) {
                    deps.log(`[standalone] oauth2BuildAuthorizationUrl failed: ${err?.message ?? err}`);
                    send({ type: 'oauth2AuthorizeUrlResult', requestId, error: err?.message ?? String(err) });
                }
                return;
            }

            case 'oauth2ExchangeAuthorizationCode': {
                const requestId = ((msg as any).requestId as string | undefined) ?? `ex-${Date.now()}`;
                const send = (payload: any): void => { deps.wsBridge.sendTo(clientId, payload); };
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { authorizationCodeGrant } = require('../core/apiTesting/oauth2');
                    const result = await authorizationCodeGrant({
                        tokenEndpoint: (msg as any).tokenEndpoint,
                        clientId: (msg as any).clientId,
                        clientSecret: (msg as any).clientSecret,
                        code: (msg as any).code,
                        redirectUri: (msg as any).redirectUri,
                        codeVerifier: (msg as any).codeVerifier,
                    });
                    if (result.ok) send({ type: 'oauth2ExchangeCodeResult', requestId, token: result.token });
                    else send({ type: 'oauth2ExchangeCodeResult', requestId, error: `${result.error.error}${result.error.description ? ': ' + result.error.description : ''}` });
                } catch (err: any) {
                    deps.log(`[standalone] oauth2ExchangeAuthorizationCode failed: ${err?.message ?? err}`);
                    send({ type: 'oauth2ExchangeCodeResult', requestId, error: err?.message ?? String(err) });
                }
                return;
            }

            // #745 (2026-06-06) — WebSocket + SSE standalone handlers.
            case 'wsConnect': {
                const requestId = ((msg as any).requestId as string | undefined) ?? `ws-${Date.now()}`;
                const send = (payload: any): void => { deps.wsBridge.sendTo(clientId, payload); };
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { connectWebSocket } = require('../core/apiTesting/ws');
                    const result = await connectWebSocket({
                        url: (msg as any).url,
                        sendMessages: (msg as any).sendMessages,
                        maxMessages: (msg as any).maxMessages,
                        allowPrivateHosts: true, // #887 — user-initiated workbench connect
                    });
                    if (result.error) send({ type: 'wsConnectResult', requestId, error: result.error });
                    else send({ type: 'wsConnectResult', requestId, result });
                } catch (err: any) {
                    deps.log(`[standalone] wsConnect failed: ${err?.message ?? err}`);
                    send({ type: 'wsConnectResult', requestId, error: err?.message ?? String(err) });
                }
                return;
            }

            case 'sseConnect': {
                const requestId = ((msg as any).requestId as string | undefined) ?? `sse-${Date.now()}`;
                const send = (payload: any): void => { deps.wsBridge.sendTo(clientId, payload); };
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { streamSse } = require('../core/apiTesting/sse');
                    const result = await streamSse({
                        url: (msg as any).url,
                        bearerToken: (msg as any).bearerToken,
                        maxEvents: (msg as any).maxEvents,
                        allowPrivateHosts: true, // #887 — user-initiated workbench connect
                    });
                    if (result.error) send({ type: 'sseStreamResult', requestId, error: result.error });
                    else send({ type: 'sseStreamResult', requestId, result });
                } catch (err: any) {
                    deps.log(`[standalone] sseConnect failed: ${err?.message ?? err}`);
                    send({ type: 'sseStreamResult', requestId, error: err?.message ?? String(err) });
                }
                return;
            }

            // #750 (2026-06-06) — saved filter views (standalone).
            case 'requestSavedFilterViews': {
                const send = (payload: any): void => { deps.wsBridge.sendTo(clientId, payload); };
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { loadSavedFilterViews } = require('../core/savedViews/filterViews');
                    send({ type: 'savedFilterViewsResult', views: loadSavedFilterViews(deps.workspaceRoot) });
                } catch (err: any) {
                    deps.log(`[standalone] requestSavedFilterViews failed: ${err?.message ?? err}`);
                    send({ type: 'savedFilterViewsResult', views: [] });
                }
                return;
            }
            case 'saveFilterView': {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { saveFilterView, loadSavedFilterViews } = require('../core/savedViews/filterViews');
                    saveFilterView(deps.workspaceRoot, (msg as any).view);
                    deps.wsBridge.broadcast({ type: 'savedFilterViewsResult', views: loadSavedFilterViews(deps.workspaceRoot) });
                } catch (err: any) {
                    deps.log(`[standalone] saveFilterView failed: ${err?.message ?? err}`);
                }
                return;
            }
            case 'deleteFilterView': {
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { deleteFilterView, loadSavedFilterViews } = require('../core/savedViews/filterViews');
                    deleteFilterView(deps.workspaceRoot, (msg as any).id);
                    deps.wsBridge.broadcast({ type: 'savedFilterViewsResult', views: loadSavedFilterViews(deps.workspaceRoot) });
                } catch (err: any) {
                    deps.log(`[standalone] deleteFilterView failed: ${err?.message ?? err}`);
                }
                return;
            }

            // #604 (2026-06-06) — collection exporter standalone handler.
            case 'exportApiCollection': {
                const requestId = ((msg as any).requestId as string | undefined) ?? `export-${Date.now()}`;
                const format = (msg as any).format;
                const send = (payload: any): void => { deps.wsBridge.sendTo(clientId, payload); };
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { buildApiTestingPayload } = require('../core/apiTesting/buildFromApiRecord');
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const { exportApiCollection } = require('../core/apiTesting/exporters');
                    const apiPayload = buildApiTestingPayload(deps.snapshotStore.getWorking());
                    const result = exportApiCollection(apiPayload, format);
                    send({ type: 'exportApiCollectionResult', requestId, ...result });
                } catch (err: any) {
                    deps.log(`[standalone] exportApiCollection failed: ${err?.message ?? err}`);
                    send({ type: 'exportApiCollectionResult', requestId, error: err?.message ?? String(err) });
                }
                return;
            }

            case 'openFileDiagram':
            case 'openFeatureDiagram':
            case 'openFunctionFlow':
            case 'openMicroserviceDiagram':
            case 'openMapDiagram':
            case 'openDomainDiagram': {
                // Each of these requests a specific layer. Reuse the same
                // route resolver — the URL hash already determines the graphId.
                // HomePage cards send these messages without a graphId; map
                // the message type to a canonical workspace-level graphId.
                let graphId = msg.graphId as string | undefined;
                if (!graphId) {
                    switch (msg.type) {
                        case 'openMicroserviceDiagram': graphId = 'microservice:workspace'; break;
                        // Issue #700 — Knowledge Map: single workspace-wide
                        // graphId (`map:workspace`), no per-service variant.
                        case 'openMapDiagram': graphId = 'map:workspace'; break;
                        // Issue #701 — Domain graph: single workspace-wide
                        // `domain:workspace` graphId.
                        case 'openDomainDiagram': graphId = 'domain:workspace'; break;
                        case 'openFeatureDiagram': {
                            const sid = msg.serviceId ? String(msg.serviceId) : '';
                            graphId = sid ? `feature:${sid}` : 'feature:workspace';
                            break;
                        }
                        case 'openFileDiagram':
                            graphId = msg.filePath ? `file:${msg.filePath}` : undefined;
                            break;
                        case 'openFunctionFlow':
                            graphId = (msg.filePath && msg.functionName)
                                ? `flow:${msg.filePath}:${msg.functionName}`
                                : undefined;
                            break;
                    }
                }
                handleRequestRoute(deps, { graphId }, clientId);
                return;
            }

            // HomePage "API List" / "Sequence" / "Flow Chart" cards dispatch
            // these — they're not handled by VS Code's webview directly, so
            // map them to the equivalent route here.
            case 'openApiList':
                handleRequestRoute(deps, { graphId: 'api-list:workspace' }, clientId);
                return;
            case 'openSequence':
                // No top-level "workspace sequence" — pick the first sequence
                // graph if any exists. The user typically reaches sequence by
                // drilling from an API row, but the home card needs a target.
                {
                    const seqId = Object.keys(deps.snapshotStore.getWorking().graphs ?? {}).find((g) => g.startsWith('sequence:'));
                    if (seqId) handleRequestRoute(deps, { graphId: seqId }, clientId);
                    else broadcastToast(deps, 'info', 'No sequence diagrams yet — pick an API to view its sequence.');
                }
                return;
            case 'openFunctionFlowChart':
                {
                    const flowId = Object.keys(deps.snapshotStore.getWorking().graphs ?? {}).find((g) => g.startsWith('flow:'));
                    if (flowId) handleRequestRoute(deps, { graphId: flowId }, clientId);
                    else broadcastToast(deps, 'info', 'No flow diagrams yet — pick a function to view its flow.');
                }
                return;

            case 'nodeClicked':
                await handleAnchorClick(deps, opener, msg);
                return;

            case 'edgeClicked': {
                // L3 sequence-edge click. UX bug 2026-06-03: standalone was
                // routing every edgeClicked to `handleAnchorClick`, which
                // opens the source file in an editor instead of drilling
                // into the called function's flow. The VSIX extension
                // (src/handlers/toolHandlers.ts:133) navigates to the flow
                // graph when the edge anchor carries a `symbol`. Mirror
                // that here so the SPA actually drills L3 → L5.
                const anchor = (msg as any).anchor;
                if (anchor?.filePath && anchor?.symbol) {
                    // TICKET-UI-3 — the sequence-edge anchor carries the CLASS-
                    // QUALIFIED symbol (`ArticleService.findComments`) while the
                    // stored flow graph is keyed by the BARE method name
                    // (`flow:…:findComments`), so a direct lookup missed and the
                    // L3 message → L5 flow drill dead-ended in a file-open toast.
                    // resolveFlowGraphId bridges bare ↔ class-prefixed (both
                    // directions), matching the tolerant lookup handleRequestRoute
                    // already uses for `flow:` deep-links.
                    const graphs = deps.snapshotStore.getWorking().graphs ?? {};
                    const flowId = `flow:${anchor.filePath}:${anchor.symbol}`;
                    const resolved = resolveFlowGraphId(Object.keys(graphs), flowId);
                    if (resolved && (graphs[resolved] as DiagramGraph)?.nodes?.length) {
                        handleRequestRoute(deps, { graphId: resolved }, clientId);
                        return;
                    }
                }
                await handleAnchorClick(deps, opener, msg);
                return;
            }

            // `addComment` and `resolveComment` are now handled by the
            // shared `commentHandlers` module (#547 — HandlerContext standalone-compatible via PlatformAdapter) registered above.
            // The router catches both message types before the switch.

            case 'panelNavigated':
                // Track last view per client. v1: silent — no persistence
                // (the URL hash is the source of truth on reload).
                return;

            case 'toggleTheme':
                deps.wsBridge.broadcast({ type: 'setTheme', theme: msg.theme ?? 'dark' });
                return;

            case 'runCommand':
                handleRunCommand(deps, msg, clientId);
                return;

            case 'setLlmConfig':
                handleSetLlmConfig(deps, msg);
                return;

            // UX (2026-06-04) — "Test Connection" probe for the LLM
            // Config card. Broadcasts `llmConnectionTestResult` back to
            // the webview when the probe completes.
            case 'testLlmConnection':
                handleTestLlmConnection(deps);
                return;

            // Issue #733 — toggle the optional Domain LLM refinement.
            // The deterministic heuristic always runs; this just flips
            // the boolean setting + triggers an immediate re-refinement
            // when turning ON (so the user sees the change without
            // waiting for the next cascade).
            case 'setDomainLlmRefinement':
                handleSetDomainLlmRefinement(deps, msg);
                return;

            // #851 — PR watcher card: status fetch + on/off toggle. The
            // watcher itself broadcasts `prWatcherStatus` on every state
            // change via its onStatus hook; these handlers cover the
            // explicit request + persistence of the toggle.
            case 'getPrWatcherStatus':
                void handleGetPrWatcherStatus(deps);
                return;
            case 'setPrWatcherEnabled':
                void handleSetPrWatcherEnabled(deps, msg);
                return;

            // Issue #702 / #736 — build + return the onboarding tour.
            case 'requestTour':
                handleRequestTour(deps, msg);
                return;

            case 'requestExplorerData':
                // The standalone webview reads diagram lists from the store on
                // demand. v1 sends back a small payload mirroring what the
                // VS Code sidebar providers expose.
                handleRequestExplorerData(deps);
                return;

            case 'searchSelected':
            case 'functionSelected':
                // Pass through as a navigate request — these reduce to "open
                // the indicated graph".
                if (msg.graphId) handleRequestRoute(deps, { graphId: msg.graphId }, clientId);
                return;

            // #147: file-picker selection should run blast-radius analysis +
            // broadcast `showImpact` so the webview's ImpactPanel overlay
            // renders. Same cross-runtime path the extension toolHandlers
            // takes — uses `analyzeImpact` from `core/analysis/impactAnalyzer`
            // which only reads snapshotStore data.
            case 'fileSelectedForImpact': {
                const filePath = msg.filePath;
                if (!filePath) return;
                try {
                    const { analyzeImpact } = await import('../core/analysis/impactAnalyzer');
                    // #912 — scope the blast radius to the picked sub-repo's
                    // store when `repoId` is supplied (multi-repo); else primary.
                    const working = resolveRepoStore(deps, (msg as any).repoId).store.getWorking();
                    const impact = analyzeImpact([String(filePath)], working);
                    // Clear stale highlights from a prior impact run.
                    deps.wsBridge.broadcast({ type: 'clearHighlights' });
                    // Show the blast-radius panel.
                    deps.wsBridge.broadcast({ type: 'showImpact', impact });
                    // Highlight every impacted function.
                    const highlights = (impact.impactedFunctions ?? []).map((f: any) => ({
                        filePath: f.filePath,
                        functionName: f.functionName,
                        impactKind: f.impactKind,
                    }));
                    if (highlights.length > 0) {
                        deps.wsBridge.broadcast({ type: 'highlightNodes', highlights });
                    }
                } catch (err: any) {
                    broadcastToast(deps, 'error', `Impact analysis failed: ${err?.message ?? err}`);
                }
                return;
            }

            // Issue #707 — Path Finder. Server-side BFS over the workspace
            // call graph; targets the originating client so we don't blast
            // every browser tab with a query a single user issued.
            case 'findCallPath': {
                try {
                    const { traceCallPath } = await import('../mcp/callPath');
                    const fromFile = String(msg.fromFile ?? '');
                    const fromFn = String(msg.fromFn ?? '');
                    const toFile = String(msg.toFile ?? '');
                    const toFn = String(msg.toFn ?? '');
                    const maxDepth = Math.max(1, Math.min(20, Number(msg.maxDepth) || 8));
                    if (!fromFile || !fromFn || !toFile || !toFn) return;
                    const working = deps.snapshotStore.getWorking();
                    const result = traceCallPath(working, fromFile, fromFn, toFile, toFn, maxDepth);
                    deps.wsBridge.sendTo(clientId, { type: 'callPathResult', result });
                } catch (err: any) {
                    broadcastToast(deps, 'error', `Path finder failed: ${err?.message ?? err}`);
                }
                return;
            }

            case 'requestAiReview':
                if (!deps.settings || !deps.secrets) {
                    broadcastToast(deps, 'warning', UNAVAILABLE_MESSAGE);
                    return;
                }
                await runAiReview(
                    { snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, settings: deps.settings, secrets: deps.secrets, log: deps.log, workspaceRoot: deps.workspaceRoot },
                    aiReviewState,
                );
                return;

            case 'clearAiReview':
                if (!deps.settings || !deps.secrets) return;
                clearAiReviewState(
                    { snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, settings: deps.settings, secrets: deps.secrets, log: deps.log, workspaceRoot: deps.workspaceRoot },
                    aiReviewState,
                );
                return;

            // #MCP-STD-3 (2026-06-07) — webview polls this on mount + every
            // few seconds so the AI Review card knows whether a run is in
            // flight. The extension host's `aiReviewHandlers.ts` checks
            // `_currentRun` and broadcasts `aiReviewStarted` +
            // `aiReviewLoading: true` when active. Standalone has no
            // long-running aiReview pipeline; just emit a stable "idle"
            // response so the webview doesn't sit in a loading limbo and
            // the standalone stderr doesn't spam `unknown msg.type=…`.
            case 'requestAiReviewStatus':
                deps.wsBridge.broadcast({ type: 'aiReviewLoading' as const, loading: false });
                return;

            case 'replayWorkingDiff':
            case 'replayCurrentDiff': {
                // Both message types reduce to "replay the current diff state",
                // which in standalone is always working-vs-baseline.
                // #818 (2026-06-11) — in multi-repo workspaces, thread the
                // aggregator + per-repo stores so the cross-repo coda can
                // append consumer frames. The producer is the repo whose
                // store backs this daemon (the primary).
                let coda;
                if (deps.multiRepo) {
                    const primaryEntry = [...deps.multiRepo.perRepoStores.entries()]
                        .find(([, s]) => s === deps.snapshotStore);
                    if (primaryEntry) {
                        let maxConsumers: number | undefined;
                        try { maxConsumers = deps.settings?.get<number>('codeatlas.replayCodaMaxConsumers'); } catch { /* default */ }
                        coda = {
                            aggregator: deps.multiRepo.aggregator,
                            perRepoStores: deps.multiRepo.perRepoStores as ReadonlyMap<string, unknown>,
                            producer: primaryEntry[0],
                            maxConsumers,
                        };
                    }
                }
                replayWorkingChanges(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, log: deps.log },
                    replayState,
                    coda,
                );
                return;
            }

            case 'stopReplay':
                stopReplayFn(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, log: deps.log },
                    replayState,
                );
                return;

            case 'timelineReplayControl': {
                const action = msg.action as 'pause' | 'resume' | 'next' | 'prev' | 'skipCommit' | 'stop';
                // skipCommit / stop belong to the multi-commit walk
                // (gitDiff's timeline). pause / resume / next / prev are
                // shared by both that and the working-diff replay; route
                // to whichever timeline is active.
                if (action === 'skipCommit') {
                    gitDiffSkipCommit(
                        { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, secrets: deps.secrets!, log: deps.log },
                        gitDiffState,
                    );
                    return;
                }
                if (action === 'stop') {
                    stopReplayFn(
                        { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, log: deps.log },
                        replayState,
                    );
                    if (gitDiffState.timeline) {
                        gitDiffState.timeline.stop();
                        deps.wsBridge.broadcast({ type: 'replayStopped' });
                    }
                    return;
                }
                // Apply pause/resume/next/prev to BOTH potential timelines —
                // only the active one will react (the other is idle).
                applyReplayControl(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, log: deps.log },
                    replayState,
                    action as 'pause' | 'resume' | 'next' | 'prev',
                );
                if (gitDiffState.timeline) {
                    switch (action) {
                        case 'pause': gitDiffState.timeline.pause(); break;
                        case 'resume': gitDiffState.timeline.resume(); break;
                        case 'next': gitDiffState.timeline.nextStep(); break;
                        case 'prev': gitDiffState.timeline.prevStep(); break;
                    }
                }
                return;
            }

            case 'timelineReplaySpeed': {
                const ms = Number(msg.stepMs ?? msg.speedMs ?? 2000);
                setReplaySpeed(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, log: deps.log },
                    replayState,
                    ms,
                );
                gitDiffState.timeline?.setSpeed(ms);
                return;
            }

            // ── Git diff: commit picker ───────────────────────────────
            case 'requestGitDiff':
                if (!deps.secrets) { broadcastToast(deps, 'warning', UNAVAILABLE_MESSAGE); return; }
                gitDiffRequest(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, secrets: deps.secrets, log: deps.log },
                    clientId,
                );
                return;

            case 'commitSelected':
                if (!deps.secrets) return;
                await gitDiffCommitSelected(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, secrets: deps.secrets, log: deps.log },
                    gitDiffState,
                    String(msg.baseHash),
                    String(msg.headHash),
                );
                return;

            // ── Git diff: branch picker ───────────────────────────────
            case 'requestBranchDiff':
            case 'requestBranchDiffReplay':
                if (!deps.secrets) { broadcastToast(deps, 'warning', UNAVAILABLE_MESSAGE); return; }
                gitDiffRequestBranch(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, secrets: deps.secrets, log: deps.log },
                    clientId,
                );
                return;

            case 'branchSelected':
                if (!deps.secrets) return;
                await gitDiffBranchSelected(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, secrets: deps.secrets, log: deps.log },
                    gitDiffState,
                    String(msg.branchName ?? msg.branch ?? ''),
                );
                return;

            // ── Git diff: PR picker (uses GITHUB_TOKEN if private repo) ──
            case 'requestPrDiffReplay':
                if (!deps.secrets) { broadcastToast(deps, 'warning', UNAVAILABLE_MESSAGE); return; }
                await gitDiffRequestPr(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, secrets: deps.secrets, log: deps.log },
                    clientId,
                );
                return;

            case 'prSelected':
                if (!deps.secrets) return;
                await gitDiffPrSelected(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, secrets: deps.secrets, log: deps.log },
                    gitDiffState,
                    Number(msg.prNumber),
                );
                return;

            case 'clearGitDiff':
                if (!deps.secrets) return;
                gitDiffClear(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, secrets: deps.secrets, log: deps.log },
                    gitDiffState,
                );
                return;

            // ── Multi-commit timeline walk ─────────────────────────────
            case 'requestTimelineCommits':
                if (!deps.secrets) { broadcastToast(deps, 'warning', UNAVAILABLE_MESSAGE); return; }
                gitDiffRequestTimelineCommits(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, secrets: deps.secrets, log: deps.log },
                    clientId,
                    typeof msg.branch === 'string' ? msg.branch : undefined,
                );
                return;

            case 'startTimelineReplay':
                if (!deps.secrets) { broadcastToast(deps, 'warning', UNAVAILABLE_MESSAGE); return; }
                await gitDiffStartTimelineReplay(
                    { workspaceRoot: deps.workspaceRoot, snapshotStore: deps.snapshotStore, wsBridge: deps.wsBridge, secrets: deps.secrets, log: deps.log },
                    gitDiffState,
                    Array.isArray(msg.commits) ? msg.commits : [],
                );
                return;

            // ─── AI review / guidelines (#505/#506/#510/#511) ──────────
            // `requestReviewGuidelines` and `saveReviewGuidelines` are now
            // handled by the shared aiReviewHandlers module (#547 — HandlerContext standalone-compatible via PlatformAdapter) — the
            // standalone router catches them before this switch.
            // `requestEvidenceGate` / `setEvidenceGate` / `requestAiFindings`
            // / `updateAiFindingStatus` / `searchAiFindings` /
            // `requestAiFindingsForNode` are now handled by the shared
            // aiReviewHandlers module (#547 round 4) — the standalone router
            // catches them before this switch.
            // `requestFullReview`, `requestSpecificReview`, `cancelFullReview`,
            // `cancelAiReview`, `clearFindings` are now handled by the shared
            // aiReviewHandlers module (#547 round 5) — the standalone router
            // catches them before this switch. The standalone's own
            // `runFullReview` / `runSpecificReview` / `cancelCurrentReview` in
            // src/standalone/aiReview.ts are no longer wired here (still
            // exported for backward compat — may be removed in a future
            // cleanup once we verify no external caller imports them).

            // ─── Parity aliases (extension-router message names) ──────────
            // The extension dispatches these via the shared messageRouter;
            // the standalone keeps a flat switch, so each name needs an
            // explicit case. Each case maps the extension's wire name to
            // the equivalent standalone behaviour.

            case 'resolveAiReview':
            case 'ignoreAiReview':
            case 'reopenAiReview': {
                // Extension splits AI-review status actions into three
                // message types for analytics granularity. Standalone uses
                // a single `updateAiFindingStatus` with an explicit status
                // value — translate here so the same UI button works on
                // both backends.
                const status = msg.type === 'resolveAiReview'
                    ? 'resolved'
                    : msg.type === 'ignoreAiReview'
                        ? 'ignored'
                        : 'open';
                const findingId = String(msg.findingId ?? msg.reviewId ?? '');
                if (!findingId) { broadcastToast(deps, 'warning', 'Missing finding id.'); return; }
                const updated = deps.snapshotStore.updateAiReviewFindingStatus(findingId, status as any);
                if (!updated) { broadcastToast(deps, 'warning', 'Finding not found.'); return; }
                const counts = deps.snapshotStore.getAiReviewFindingCounts();
                deps.wsBridge.broadcast({ type: 'aiFindingUpdated', finding: updated, counts });
                return;
            }

            case 'openSource': {
                // Extension's source-navigator opens at the given anchor.
                // Standalone funnels through the editor opener.
                const fp = msg.anchor?.filePath ?? msg.filePath;
                if (fp) {
                    // #888 — boundary-check the WS-supplied path before spawning the
                    // editor. `wsBridge` accepts no-Origin clients, so an absolute /
                    // `../` path would otherwise open arbitrary files (~/.ssh/id_rsa).
                    const abs = safeResolve(deps.workspaceRoot, String(fp));
                    if (!abs) {
                        broadcastToast(deps, 'warning', 'Refused to open a file outside the workspace.');
                        return;
                    }
                    await opener(abs, typeof msg.line === 'number' ? msg.line : undefined);
                }
                return;
            }

            case 'openApiListForCluster': {
                // Extension routes to `api-list:<clusterId>`. Standalone's
                // `openApiList` is a workspace-wide variant; this one is
                // scoped to a specific cluster.
                const cid = String(msg.clusterId ?? '');
                if (cid) handleRequestRoute(deps, { graphId: `api-list:${cid}` }, clientId);
                return;
            }

            case 'openFeatureForService': {
                // Extension navigates to `feature:<serviceId>`. UX bug
                // 2026-06-03: in single-service repos the orchestrator only
                // builds `feature:workspace`, never `feature:service:<sid>`,
                // so clicking the service in L1 used to silently land on a
                // "Diagram not found" toast. Mirror the VSIX extension's
                // `buildFeatureGraphForService` path — build on demand and
                // persist before routing. Build failures fall through to the
                // workspace graph so the user still lands on something.
                const sid = String(msg.serviceId ?? '');
                // #836B — repo-scope hint. The SPA threads the
                // `#/system-design/<repo>` scope as `msg.repoId` so a bare
                // `service:main` click on a scoped L1 resolves the repo the
                // user is looking at instead of the primary store. Mirrors
                // the extension's openFeatureForService hint branch; see ADR-038.
                if (msg.repoId && deps.multiRepo && deps.multiRepo.repos.length >= 2) {
                    const hint = String(msg.repoId);
                    const matched = deps.multiRepo.repos.find(r =>
                        r.repoId === hint || r.name === hint || r.rootPath === hint
                        || (r.rootPath && r.rootPath.endsWith('/' + hint))
                        || (r.name && r.name.endsWith('/' + hint)));
                    const subStore = matched ? deps.multiRepo.perRepoStores.get(matched.repoId) : undefined;
                    if (subStore) {
                        const subGraphs = (subStore.getWorking().graphs ?? {}) as Record<string, DiagramGraph>;
                        const candidates = [
                            `feature:service:${matched!.name}`,
                            `feature:service:${matched!.rootPath}`,
                            'feature:workspace',
                            ...Object.keys(subGraphs).filter(k => k.startsWith('feature:')),
                        ];
                        const hit = candidates.map(k => subGraphs[k]).find(g => g && Array.isArray(g.nodes) && g.nodes.length > 0);
                        if (hit) {
                            // #845 — carry the repo scope so the SPA keeps
                            // `#/features/<repo>` in the URL.
                            const scoped = { ...hit, meta: { ...(hit.meta ?? {}), scopedRepo: matched!.name } };
                            const navMsg = { type: 'navigateTo', graphId: hit.graphId, mode: hit.type, graph: scoped, label: `Features: ${matched!.name}` };
                            if (clientId && typeof (deps.wsBridge as { sendTo?: unknown }).sendTo === 'function') deps.wsBridge.sendTo(clientId, navMsg);
                            else deps.wsBridge.broadcast(navMsg);
                            return;
                        }
                        deps.log(`[standalone] openFeatureForService: repo hint ${hint} matched ${matched!.name} but no non-empty feature graph`);
                    }
                }
                const graphId = sid ? `feature:${sid}` : 'feature:workspace';
                const workingNow = deps.snapshotStore.getWorking();
                if (!workingNow.graphs[graphId]) {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-require-imports
                        const { buildFeatureGraph } = require('../core/graph/featureGraphBuilder');
                        const baseline = deps.snapshotStore.getBaseline();
                        const built = buildFeatureGraph(workingNow, baseline, sid || undefined);
                        if (built?.graphId) {
                            deps.snapshotStore.updateWorkingGraph(built.graphId, built);
                        }
                    } catch (err: any) {
                        deps.log(`[standalone] openFeatureForService: build failed for ${graphId}: ${err?.message ?? err}`);
                    }
                }
                const stillMissing = !deps.snapshotStore.getWorking().graphs[graphId];
                handleRequestRoute(deps, { graphId: stillMissing ? 'feature:workspace' : graphId }, clientId);
                return;
            }

            case 'openSequenceForApi': {
                // Extension constructs the sequence graphId from the api
                // record. Mirror that here by walking apiIndex — primary
                // store first, then per-repo stores in multi-repo mode.
                const apiId = String(msg.apiId ?? '');
                if (apiId) {
                    let api: any = deps.snapshotStore.getWorking().apiIndex?.[apiId];
                    const stores: SnapshotStore[] = [deps.snapshotStore];
                    if (deps.multiRepo) stores.push(...deps.multiRepo.perRepoStores.values());
                    if (!api) {
                        for (const s of stores) {
                            try {
                                const cand = (s.getWorking().apiIndex as any)?.[apiId];
                                if (cand) { api = cand; break; }
                            } catch { /* skip */ }
                        }
                    }
                    if (api?.filePath && api?.handlerName) {
                        const findGraph = (gid: string, allowEmpty = false): DiagramGraph | undefined => {
                            let emptyHit: DiagramGraph | undefined;
                            for (const s of stores) {
                                try {
                                    const g = (s.getWorking().graphs as Record<string, DiagramGraph>)?.[gid];
                                    if (g && Array.isArray(g.nodes) && g.nodes.length > 0) return g;
                                    if (g && !emptyHit) emptyHit = g;
                                } catch { /* skip */ }
                            }
                            return allowEmpty ? emptyHit : undefined;
                        };
                        const navigate = (g: DiagramGraph, label: string, fallback: boolean) => {
                            const graph = fallback
                                ? { ...g, meta: { ...(g.meta ?? {}), fallbackFromSequence: true, originalApi: { method: api.method, route: api.route, handler: api.handlerName, apiId: api.apiId } } }
                                : g;
                            const navMsg = { type: 'navigateTo', graphId: g.graphId, mode: g.type, graph, label };
                            if (clientId && typeof (deps.wsBridge as { sendTo?: unknown }).sendTo === 'function') deps.wsBridge.sendTo(clientId, navMsg);
                            else deps.wsBridge.broadcast(navMsg);
                        };
                        // Empty-but-defined sequence graphs still navigate
                        // when no flow fallback exists (the SequenceView
                        // renders its own placeholder — same contract as the
                        // extension's openSequenceForApi).
                        const seq = findGraph(`sequence:${api.filePath}:${api.handlerName}`, true);
                        if (seq && seq.nodes.length > 0) { navigate(seq, `${api.method} ${api.route}`, false); return; }
                        // #839 — no (or empty) sequence graph (IaC routes the
                        // sequence builder skipped): fall back flow → file
                        // with a toast; NEVER leave the SPA on "Loading…";
                        // see ADR-039.
                        const flow = findGraph(`flow:${api.filePath}:${api.handlerName}`);
                        if (flow) {
                            navigate(flow, `Flow: ${api.handlerName}`, true);
                            broadcastToast(deps, 'info', `No sequence diagram for ${api.method} ${api.route} — showing the handler's flow chart.`);
                            return;
                        }
                        if (seq) { navigate(seq, `${api.method} ${api.route}`, false); return; }
                        const file = findGraph(`file:${api.filePath}`);
                        if (file) {
                            navigate(file, `File: ${String(api.filePath).split('/').pop()}`, true);
                            broadcastToast(deps, 'info', `No sequence diagram for ${api.method} ${api.route} — showing the handler's file diagram.`);
                            return;
                        }
                        broadcastToast(deps, 'warning', `No diagram available yet for ${api.method} ${api.route}.`);
                        return;
                    }
                }
                if (msg.graphId) handleRequestRoute(deps, { graphId: String(msg.graphId) }, clientId);
                return;
            }

            case 'requestImpact': {
                // #147 (continued): same analysis as `fileSelectedForImpact`,
                // just a different webview entry point (context-menu vs
                // file-picker). Reuse the analyzer + broadcast envelope.
                const filePath = msg.filePath;
                if (!filePath) return;
                try {
                    const { analyzeImpact } = await import('../core/analysis/impactAnalyzer');
                    // #912 — per-repo scope when `repoId` present (multi-repo).
                    const working = resolveRepoStore(deps, (msg as any).repoId).store.getWorking();
                    const impact = analyzeImpact([String(filePath)], working);
                    deps.wsBridge.broadcast({ type: 'clearHighlights' });
                    deps.wsBridge.broadcast({ type: 'showImpact', impact });
                    const highlights = (impact.impactedFunctions ?? []).map((f: any) => ({
                        filePath: f.filePath,
                        functionName: f.functionName,
                        impactKind: f.impactKind,
                    }));
                    if (highlights.length > 0) {
                        deps.wsBridge.broadcast({ type: 'highlightNodes', highlights });
                    }
                } catch (err: any) {
                    broadcastToast(deps, 'error', `Impact analysis failed: ${err?.message ?? err}`);
                }
                return;
            }

            case 'requestArchitectureExport': {
                // #912 — real per-repo Markdown + Mermaid export for the browser
                // surface. Pre-#912 the home "Export Docs" card only showed a
                // pointer toast standalone-side; now it resolves the picked
                // sub-repo's store (multi-repo) or the primary store, builds the
                // doc, and ships it back for a client-side download.
                try {
                    const { exportArchitectureDocs } = await import('../core/export/markdownExporter');
                    const { store, repoName } = resolveRepoStore(deps, (msg as any).repoId);
                    const markdown = exportArchitectureDocs(store.getWorking(), store.getBaseline(), repoName);
                    const safeName = repoName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'architecture';
                    // Reuse the existing `downloadFile` browser path (App.tsx) so
                    // export has one delivery shape across both runtimes.
                    deps.wsBridge.sendTo(clientId, {
                        type: 'downloadFile',
                        filename: `${safeName}-architecture.md`,
                        content: markdown,
                        mimeType: 'text/markdown',
                    });
                } catch (err: any) {
                    broadcastToast(deps, 'error', `Architecture export failed: ${err?.message ?? err}`);
                }
                return;
            }

            // #826 — overlay contract (state + data). Same OverlayService
            // the extension handlers use (parity by construction).
            case 'requestOverlayState': {
                deps.wsBridge.sendTo(clientId, getOverlayService(deps).stateMessage());
                return;
            }
            case 'setOverlayEnabled': {
                const stateMsg = getOverlayService(deps).setEnabled(String(msg.overlayId ?? ''), !!msg.enabled);
                deps.wsBridge.broadcast(stateMsg);
                return;
            }
            case 'requestOverlayData': {
                const overlayId = String(msg.overlayId ?? '');
                const graphId = String(msg.graphId ?? '');
                let graph = deps.snapshotStore.getWorking().graphs?.[graphId];
                if (!graph && deps.multiRepo) {
                    for (const s of [...deps.multiRepo.perRepoStores.values()].slice(0, 20)) {
                        try {
                            const g = (s as any).getWorking?.().graphs?.[graphId];
                            if (g) { graph = g; break; }
                        } catch { /* skip */ }
                    }
                }
                const data = await getOverlayService(deps).dataMessage(overlayId, graphId, graph);
                deps.wsBridge.sendTo(clientId, data);
                return;
            }

            case 'requestRegressionScope': {
                // #827 — same composition as the extension handler + MCP
                // get_regression_scope (shared core = parity by construction).
                try {
                    const { computeRegressionScope } = await import('../core/analysis/regressionScope');
                    const { loadCoverageData } = await import('../core/analysis/coverageReader');
                    const repo = typeof msg.repo === 'string' && msg.repo ? msg.repo : undefined;
                    let store = deps.snapshotStore;
                    let root = deps.workspaceRoot;
                    let repoName = repo;
                    let crossRepoEdges: any[] = [];
                    if (deps.multiRepo) {
                        const row = repo
                            ? deps.multiRepo.repos.find((r) => r.name === repo || r.repoId === repo)
                            : undefined;
                        if (row) {
                            const s = deps.multiRepo.perRepoStores.get(row.repoId);
                            if (s) {
                                store = s;
                                root = require('path').isAbsolute(row.rootPath)
                                    ? row.rootPath
                                    : require('path').join(deps.workspaceRoot, row.rootPath);
                                repoName = row.name;
                            }
                        }
                        // #817.1 — shared producer-edge helper (pre-filtered
                        // to this repo's consumers, names resolved).
                        try {
                            if (repoName) {
                                const { listCrossRepoEdgesForProducer } = await import('../core/analysis/crossRepoHttpAnalyzer');
                                crossRepoEdges = listCrossRepoEdgesForProducer(deps.multiRepo.aggregator as any, repoName)
                                    .map((e) => ({ sourceRepo: e.consumerRepoName, targetRepo: repoName!, method: e.method, route: e.route }));
                            }
                        } catch { /* aggregator optional */ }
                    }
                    let coverage = null;
                    try { coverage = loadCoverageData(root); } catch { /* optional */ }
                    const scope = computeRegressionScope({
                        working: store.getWorking(),
                        baseline: store.getBaseline(),
                        coverage, crossRepoEdges, repoName,
                    });
                    deps.wsBridge.broadcast({ type: 'regressionScopeData', scope, repo: repo ?? null });
                } catch (err: any) {
                    broadcastToast(deps, 'error', `Regression scope failed: ${err?.message ?? err}`);
                }
                return;
            }

            case 'webviewAnalytics':
                // Telemetry is opt-in and currently a no-op on standalone
                // (the extension uses VS Code's telemetry channel). Logged
                // for visibility so we can wire a real sink later.
                deps.log(`[standalone] webviewAnalytics ${JSON.stringify(msg).slice(0, 200)}`);
                return;

            case 'navigateHome':
                // Mirror the extension's "go back to L1" intent.
                handleRequestRoute(deps, { graphId: 'microservice:workspace' }, clientId);
                return;

            // Change-log / history journal is a VS Code extension feature; the
            // standalone daemon keeps no file-watch journal. `requestChangeLog`
            // is posted on webview mount, so reply with an EMPTY log (the panel
            // renders "no history") instead of a spurious "not available" toast.
            // The panel controls are silent no-ops for the same reason.
            case 'requestChangeLog':
                deps.wsBridge.sendTo(clientId, { type: 'changeLogFull', entries: [] });
                return;
            case 'navigateToChangeEntry':
            case 'playbackChangeLog':
                return;

            default:
                if (unavailable.has(msg.type)) {
                    deps.log(`[standalone] msg.${msg.type}: unavailable in v1, sending toast`);
                    broadcastToast(deps, 'warning', UNAVAILABLE_MESSAGE);
                    return;
                }
                deps.log(`[standalone] unknown msg.type=${msg.type}`);
        }
    }

    return { handle };
}

// ─── Handlers ────────────────────────────────────────────────────────────

/** Auth-related workspaceInfo fields, reading the stored session exactly once. */
function authWorkspaceFields(deps: StandaloneHandlerDeps): WorkspaceAuthFields {
    // Shared with the extension (:7742) so `isAuthenticated` can never diverge
    // from the presence of a user — see workspaceAuthFields.
    return workspaceAuthFields(deps.auth?.getUser());
}

/**
 * Broadcast the home-screen `workspaceInfo` (stat cards + auth chip + LLM badge).
 * Extracted from `handleReady` so state changes that only affect this payload —
 * e.g. sign-out — can re-push it without re-sending capabilities/workspaceState.
 */
function broadcastWorkspaceInfo(deps: StandaloneHandlerDeps): void {
    const counts = computeWorkspaceCounts(deps);
    const { fileCount, apiCount, serviceCount, clusterCount, screenCount, fileGraphCount, flowGraphCount, sequenceGraphCount, services } = counts;
    const llmProvider = deps.settings?.get<string>('codeatlas.llmProvider');
    const llmModel = deps.settings?.get<string>('codeatlas.llmModel');
    const llmEndpoint = deps.settings?.get<string>('codeatlas.llmEndpoint');
    deps.wsBridge.broadcast({
        type: 'workspaceInfo',
        name: require('path').basename(deps.workspaceRoot),
        workspaceRoot: deps.workspaceRoot,
        fileCount,
        apiCount,
        serviceCount,
        clusterCount,
        screenCount,
        fileGraphCount,
        flowGraphCount,
        sequenceGraphCount,
        initialized: fileCount > 0,
        ...authWorkspaceFields(deps),
        hasGitRemote: false,
        gitHubConnected: false,
        editorUriScheme: 'vscode',
        extensionId: 'codeatlas.standalone',
        mcpServerVersion: deps.mcpServerVersion ?? null,
        llmProvider,
        llmModel,
        llmEndpoint,
        services,
        extractionConfidence: computeExtractionConfidence({ apiIndex: deps.snapshotStore.getWorking().apiIndex ?? {}, services: services as any }),
        isMultiRepo: !!(deps.multiRepo && deps.multiRepo.repos.length >= 2),
        repos: deps.multiRepo ? deps.multiRepo.repos.map(r => ({
            repoId: r.repoId, name: r.name, rootPath: r.rootPath,
        })) : [],
    });
}

function handleReady(deps: StandaloneHandlerDeps, _clientId: string): void {
    // Send capabilities so the webview can hide features that don't apply.
    // AI Review and NL query require settings + secrets — disable if either
    // is absent (e.g. the standalone test harness builds without them).
    const hasLlm = Boolean(deps.settings && deps.secrets);
    const hasSecrets = Boolean(deps.secrets);
    deps.wsBridge.broadcast({
        type: 'capabilities',
        capabilities: {
            // Clerk sign-in is available in the browser view when an auth service
            // is wired (it always is in the real server; the test harness omits
            // it). Diagrams remain accessible without signing in — auth only binds
            // the analytics identity + shows the user chip.
            canSignIn: !!deps.auth,
            canAiReview: hasLlm,
            // #910 — search is a pure index walk over the snapshot (APIs / files /
            // clusters / services), NOT an LLM feature. It must NOT be gated on
            // `hasLlm` — a non-LLM standalone user still gets the cross-surface
            // palette. (The `codeatlas.search` handler broadcasts `showSearchPicker`
            // regardless; this capability now matches that reality.)
            canSearch: true,
            canReplay: true,            // working-vs-baseline replay
            canGitDiff: hasSecrets,     // commit / branch / PR comparison
            canEditCode: true,
            canComment: true,
            mode: 'standalone',
        },
    });
    // Send workspaceInfo so the home-screen stat cards populate. Mirrors
    // the VS Code extension's `buildWorkspaceInfo` (extension.ts:818) — the
    // browser HomePage reads from `workspaceInfo.fileCount` etc. Counts come
    // from `computeWorkspaceCounts` (#835), which unions per-repo workings in
    // multi-repo mode. See `broadcastWorkspaceInfo` for the full payload.
    broadcastWorkspaceInfo(deps);
    // #815 (2026-06-10) — `workspaceState` is the message HomePage actually
    // reads to derive `isMultiRepo` (via `workspaceState.mode === 'multi'`
    // + `repos[]`). Without this broadcast the wsInfo signal above never
    // reaches the inline Code Review chip / two-step picker / per-repo
    // guidelines, which all gate on the `repos` prop. Mirror the
    // extension's `broadcastWorkspaceState` in `extension.ts:647`.
    if (deps.multiRepo) {
        const mode = deps.multiRepo.repos.length > 1 ? 'multi' : 'single';
        deps.wsBridge.broadcast({
            type: 'workspaceState',
            mode,
            repos: deps.multiRepo.repos.map(r => ({
                repoId: r.repoId,
                name: r.name,
                rootPath: r.rootPath,
                status: 'ready',
                diff: null,
            })),
        });
        // UX-72 (2026-06-10) — multi-repo init stats. Mirrors the
        // extension's broadcastWorkspaceState (extension.ts:680-688)
        // so the welcome banner can render "Init: 132/132 ready" on
        // MCP standalone connect. MCP's WorkspaceBootstrap currently
        // exposes only `ready` repos (no partial / failed tracking),
        // so failed/parsing/stale stay 0 here — fleshing them out is
        // a follow-on once bootstrap surfaces per-repo failure data.
        if (mode === 'multi') {
            deps.wsBridge.broadcast({
                type: 'multiRepoInitStats',
                total: deps.multiRepo.repos.length,
                ready: deps.multiRepo.repos.length,
                parsing: 0,
                failed: 0,
                stale: 0,
                failures: [],
            });
        }
    }
    // Issue #733 — initial state of the Domain LLM toggle, so the
    // HomePage chip reflects the persisted setting on connect (off by
    // default — heuristic system stays the source of truth).
    if (deps.settings) {
        deps.wsBridge.broadcast({
            type: 'domainLlmRefinementState',
            enabled: deps.settings.get<boolean>('codeatlas.domainLlmRefinementEnabled') === true,
        });
    }
    // BUG-VERIFY-4 (cold-deep-link race): DON'T broadcast an initial graph on
    // ready. The SPA is hash-routed — it drives navigation itself (a deep-link
    // tab posts its own `requestRoute` on mount; a no-hash tab shows Home and
    // ignores any pushed graph). The WsBridge connect handler already skips the
    // initial navigateTo for exactly this reason. Broadcasting an unsolicited
    // `microservice:workspace` here raced the deep-link: on a fresh
    // `#/features` load the L1 push rewrote the hash to `#/system-design`
    // before the feature graph arrived, so refresh/bookmark of any multi-repo
    // deep link bounced to System Design. Removing the push lets the client's
    // own requestRoute be the sole navigation driver.
}

// #817 live-verify (2026-06-11) — `clientId` routes the navigateTo response
// to the REQUESTING tab only. The previous broadcast steered every open tab
// to whichever route any one tab requested; the cross-repo push's fan-out
// soft refresh turned that into visible tab-stealing. Internal callers
// without a client context omit it and keep the legacy broadcast.
function handleRequestRoute(deps: StandaloneHandlerDeps, msg: { graphId?: string; route?: string; param?: string; param2?: string }, clientId?: string): void {
    // Issue UX-4 (2026-06-03) — the SPA's initial-mount hash-routing
    // useEffect (`webview-ui/src/App.tsx:790`) posts a `{ type:
    // 'requestRoute', route, param, param2 }` message for cold deep-
    // links (URLs like `#/system-design`, `#/file/src/x.ts`,
    // `#/flow/src/x.ts/doThing`). Previously this function only read
    // `msg.graphId` so cold deep-links were silently dropped — the SPA
    // waited 8 seconds for a navigateTo that never arrived, then fell
    // back to home. Resolve the hash-route shape to a graphId here
    // before doing the lookup. Same mapping table as
    // `webview-ui/src/lib/prettifyGraphLabel.ts` but in reverse.

    // #MCP-STD-2 (2026-06-07) — `#/violations` doesn't have a graphId;
    // its ViolationsView panel posts `requestRoute({route:'violations'})`
    // and waits for a `{type:'violations', rules, violations}` reply.
    // The extension host installs a `violationsBroadcaster` on
    // activate() that handles this; the MCP standalone runtime was
    // missing it, so navigating to `#/violations` rendered "0 rules / 0
    // violations" forever. Compute + broadcast on-demand here. The
    // builder is pure over the current snapshot, so always-recompute is
    // cheap. Idempotent: the broadcaster's signature-dedup happens on
    // the extension-host hot path; here we just send the latest.
    if (msg.route === 'violations') {
        try {
            const { computeAndBroadcastViolations } = require('../core/llm/violationsBroadcaster');
            computeAndBroadcastViolations(
                deps.snapshotStore.getWorking(),
                deps.workspaceRoot,
                (m: any) => deps.wsBridge.broadcast(m),
                deps.log,
                { lastSignature: null }, // force-emit regardless of dedup
            );
        } catch (err: any) {
            deps.log(`[standalone] violations broadcast failed: ${err?.message ?? err}`);
        }
        return;
    }

    let id = msg.graphId ?? resolveHashRouteToGraphId(msg);
    if (!id) return;
    const working = deps.snapshotStore.getWorking();
    let graph = working.graphs[id];
    // #815 (2026-06-10) — per-sub-repo rebuild for system-design + map.
    // Mirrors extension.ts:2517-3022. When the user picks a sub-repo from
    // the home picker, `msg.param` carries that repo's name/id; rebuild
    // `microservice:workspace` from the sub-repo's snapshot so the L1 +
    // KMap render the rich slice (infra siblings, all clusters) instead
    // of falling back to the primary store's workspace overview.
    const subParam = msg.param ? String(msg.param).replace(/^service:/, '') : '';
    const isMultiRepo = !!(deps.multiRepo && deps.multiRepo.repos.length >= 2);
    // #841 — ADR-037 mirror for the standalone: in multi-repo, the bare
    // workspace L1 is aggregator-owned. The primary store's copy can be a
    // workspace-polluted per-repo build (146 nodes / "133 services" live on
    // the 132-repo fixture) — never serve it for the workspace slot. Prefer
    // the aggregator's skeletal/bucketed copy (read from the extension's
    // monorepo.db); else build a skeletal L1 from the repo registry.
    if (isMultiRepo && !subParam && id === 'microservice:workspace') {
        try {
            const aggCopy = (deps.multiRepo!.aggregator as { getWorkingGraph?: (id: string) => DiagramGraph | undefined })?.getWorkingGraph?.('microservice:workspace');
            if (aggCopy && Array.isArray(aggCopy.nodes) && aggCopy.nodes.length > 0) {
                graph = aggCopy;
            } else {
                const rows = deps.multiRepo!.repos.map(r => ({
                    repoId: r.repoId, name: r.name, rootPath: r.rootPath,
                    realpathHash: r.repoId, technology: null,
                    status: 'ready' as const, lastInitAt: 0, errorMessage: null,
                }));
                // BUG-L1-CROSSREPO-EDGE: pass cross-repo HTTP edges so the fallback L1 draws them too (parity with the aggregator path).
                const httpEdges = (deps.multiRepo!.aggregator as { listCrossRepoHttpEdges?: () => ReadonlyArray<any> })?.listCrossRepoHttpEdges?.() ?? [];
                graph = buildSkeletalL1(rows as unknown as Parameters<typeof buildSkeletalL1>[0], deps.workspaceRoot, httpEdges as any);
            }
            // BUG-L1-CROSSREPO-EDGE (2026-07-19) — inject cross-repo edges from the
            // table when the stored aggregator copy predates the cross-repo pass
            // (init-ordering fragility). Parity with the extension.ts serve path.
            if (graph && Array.isArray(graph.nodes) && graph.nodes.length > 0) {
                const httpEdges2 = (deps.multiRepo!.aggregator as { listCrossRepoHttpEdges?: () => ReadonlyArray<any> })?.listCrossRepoHttpEdges?.() ?? [];
                const existing = new Set((graph.edges ?? []).map((e: any) => e.id));
                const injected = buildCrossRepoEdges(graph.nodes as any, httpEdges2 as any).filter((e) => !existing.has(e.id));
                if (injected.length) graph = { ...graph, edges: [...(graph.edges ?? []), ...injected] } as DiagramGraph;
            }
            // #852 — the skeletal/aggregator L1 carries no per-repo diff, so a
            // sub-repo with an in-repo edit showed no `~` on its L1 service
            // node. Map the set of CHANGED FILES (working-vs-baseline across the
            // live primary + every per-repo store) to their owning sub-repo by
            // rootPath, then mark that repo's L1 node. File-based mapping is
            // surface-agnostic: the standalone routes sub-repo edits into the
            // primary store, the extension into per-repo stores — both land in
            // `changedFiles`, and the rootPath prefix resolves the owner.
            if (graph) {
                const changedFiles = new Set<string>();
                const collect = (s: SnapshotStore | undefined) => {
                    if (!s) return;
                    try {
                        const w = s.getWorking().files ?? {}; const b = s.getBaseline().files ?? {};
                        for (const [fp, rec] of Object.entries(w)) {
                            if (!b[fp] || (b[fp] as any).hash !== (rec as any).hash) changedFiles.add(fp);
                        }
                        for (const fp of Object.keys(b)) if (!w[fp]) changedFiles.add(fp);
                    } catch { /* skip */ }
                };
                collect(deps.snapshotStore);
                for (const s of deps.multiRepo!.perRepoStores.values()) collect(s);
                const repoById = new Map(deps.multiRepo!.repos.map(r => [r.repoId, r.rootPath || '']));
                graph = markMultiRepoL1Diff(graph, (repoId) => {
                    const root = repoById.get(repoId);
                    if (root === undefined) return false;
                    // root '' = the primary at workspace root; any change counts.
                    if (root === '') return changedFiles.size > 0
                        && deps.multiRepo!.repos.length === 1;
                    for (const f of changedFiles) {
                        if (f === root || f.startsWith(root + '/')) return true;
                    }
                    return false;
                });
            }
        } catch (err: any) {
            deps.log(`[standalone] workspace L1 aggregator/skeletal resolve failed: ${err?.message ?? err}`);
        }
    }
    if (isMultiRepo && subParam && (id === 'microservice:workspace' || id === 'map:workspace')) {
        try {
            // Find the matching repo by name / rootPath / repoId.
            const repos = deps.multiRepo!.repos;
            const matched = repos.find(r =>
                r.name === subParam || r.rootPath === subParam || r.repoId === subParam
                || (r.rootPath && r.rootPath.endsWith('/' + subParam))
                || (r.name && r.name.endsWith('/' + subParam))
            );
            if (matched) {
                const subStore = deps.multiRepo!.perRepoStores.get(matched.repoId);
                if (subStore) {
                    const rawSnap: any = subStore.getWorking();
                    const subRepoAbs = matched.rootPath
                        ? require('path').join(deps.workspaceRoot, matched.rootPath)
                        : deps.workspaceRoot;
                    // #815/#819 — the snapshot filter + scoped rebuild live
                    // in the SHARED `core/graph/scopedSubRepoView.ts`
                    // module, also consumed by extension.ts's map route —
                    // parity by construction. Defensive rootPath filtering
                    // stays (per-repo stores can carry workspace-wide data
                    // from the aggregator post-init pass; removing it
                    // regressed dotnet L1 3→12 nodes), and cached graphs
                    // are always cleared so a stale workspace-overview map
                    // can't win (the #819 wrong-repo bug).
                    // Lazy content provider — file content lives in SQLite,
                    // not snapshot.files[fp].content (it's dropped by the
                    // redactor). Without this the .NET / Go / Java infra
                    // patterns scan zero bytes and DynamoDB et al. never
                    // surface (matches the extension's #811 fix).
                    const getContent = (fp: string): string | undefined => {
                        try {
                            return (subStore as any).getFileContent?.('working', fp);
                        } catch { return undefined; }
                    };
                    if (id === 'microservice:workspace') {
                        const { filterSnapshotToSubRepo } = require('../core/graph/scopedSubRepoView');
                        const { buildMicroserviceGraph } = require('../core/graph/microserviceGraphBuilder');
                        const subSnap = filterSnapshotToSubRepo(rawSnap, matched.rootPath);
                        const freshG: any = buildMicroserviceGraph(
                            subRepoAbs,
                            subSnap,
                            undefined,
                            getContent,
                        );
                        if (freshG && Array.isArray(freshG.nodes) && freshG.nodes.length > 0) {
                            freshG.meta = {
                                ...(freshG.meta ?? {}),
                                scopedRepo: subParam,
                            };
                            graph = freshG;
                            deps.log(`[standalone] sub-repo pick: fresh microservice graph for ${matched.name} (${graph!.nodes.length} nodes / ${graph!.edges?.length ?? 0} edges incl infra)`);
                        }
                    } else if (id === 'map:workspace') {
                        try {
                            const { buildScopedSubRepoMapGraph } = require('../core/graph/scopedSubRepoView');
                            // eslint-disable-next-line @typescript-eslint/no-require-imports
                            const pathMod = require('path');
                            const freshM: any = buildScopedSubRepoMapGraph({
                                matched: { repoId: matched.repoId, name: matched.name, rootPath: matched.rootPath },
                                subSnapshot: rawSnap,
                                workspaceRoot: deps.workspaceRoot,
                                scopedRepo: subParam,
                                contentProvider: getContent,
                                joinPath: (...parts: string[]) => pathMod.join(...parts),
                            });
                            if (freshM) {
                                graph = freshM;
                                deps.log(`[standalone] sub-repo pick: fresh scoped map for ${matched.name} (${graph!.nodes.length} nodes)`);
                            }
                        } catch (err: any) {
                            deps.log(`[standalone] per-repo map rebuild failed: ${err?.message ?? err}`);
                        }
                    }
                }
            }
        } catch (err: any) {
            deps.log(`[standalone] sub-repo route rebuild failed: ${err?.message ?? err}`);
        }
    }
    // Issue #700 — Knowledge Map: rebuild on-demand so the panel always
    // shows the current workspace state even if the cascade hasn't
    // re-broadcast the graph yet. The builder is composition-only (no
    // AST) so the cost is bounded by `services + clusters + APIs`.
    //
    // #815 (2026-06-10) — skip this workspace-overview rebuild when the
    // per-sub-repo branch above already produced a scoped map. Without
    // this guard the workspace-wide rebuild OVERWRITES the sub-repo
    // slice (15 nodes → 556 nodes) and the URL hash strips to `#/map`.
    if (id === 'map:workspace' && !(graph as any)?.meta?.scopedRepo) {
        // #848b — bare multi-repo map = repo-card overview (one card per
        // sub-repo, drill into `#/map/<repo>`), mirroring the extension.
        if (isMultiRepo) {
            try {
                const agg: any = deps.multiRepo!.aggregator;
                if (agg?.listRepos) {
                    const cards = buildWorkspaceMapGraph(agg, deps.workspaceRoot);
                    if (cards && Array.isArray(cards.nodes) && cards.nodes.length > 0) {
                        graph = cards;
                    }
                }
            } catch (err: any) {
                deps.log(`[standalone] repo-card map overview failed: ${err?.message ?? err}`);
            }
        }
    }
    if (id === 'map:workspace' && !(graph as any)?.meta?.scopedRepo && !(graph as any)?.nodes?.some?.((n: any) => n?.meta?.workspaceMap)) {
        try {
            const { buildMapGraph } = require('../core/graph/mapGraphBuilder');
            const baseline = deps.snapshotStore.getBaseline();
            const contentProvider = (fp: string) => deps.snapshotStore.getFileContent('working', fp);
            graph = buildMapGraph(working, baseline, {
                workspaceRoot: deps.workspaceRoot,
                contentProvider,
            });
            deps.snapshotStore.updateWorkingGraph(graph.graphId, graph);
        } catch (err: any) {
            deps.log(`[standalone] map graph rebuild failed: ${err?.message ?? err}`);
        }
    }
    // Issue #701 — Domain graph: same on-demand rebuild pattern. Pure
    // transform over the existing clusters + apiIndex.
    if (id === 'domain:workspace') {
        try {
            const { buildDomainGraph } = require('../core/graph/domainGraphBuilder');
            const { detectDomains } = require('../core/analysis/domainAnalyzer');
            graph = buildDomainGraph(detectDomains(working), working);
            deps.snapshotStore.updateWorkingGraph(graph.graphId, graph);
        } catch (err: any) {
            deps.log(`[standalone] domain graph rebuild failed: ${err?.message ?? err}`);
        }
    }
    // #MCP-STD-1 (2026-06-07) — Health Report: built on-demand here so
    // navigating to `#/health` actually surfaces the workspace's
    // dead-code / cyclic-dep / god-files findings. The extension host
    // builds the same stub graph wrapper at activate() time; the MCP
    // standalone runtime was missing it, so the panel showed
    // "Diagram not found: health:report". `analyzeHealth` is pure over
    // the current snapshot, so always-rebuild is cheap and correct.
    if (id === 'health:report') {
        try {
            const { analyzeHealth } = require('../core/analysis/healthAnalyzer');
            const health = analyzeHealth(working);
            graph = {
                graphId: 'health:report',
                type: 'health' as any,
                nodes: [],
                edges: [],
                anchors: {},
                meta: { health },
            } as any;
        } catch (err: any) {
            deps.log(`[standalone] health graph build failed: ${err?.message ?? err}`);
        }
    }
    // #846c — tour graphIds (`tour:workspace` / `tour:<repoId>`) have no
    // stored graph; route them to the tour handler so the meta-tour's
    // "Drill into repo tour" works on the standalone too.
    if (id.startsWith('tour:')) {
        const tourParam = id.slice('tour:'.length);
        handleRequestTour(deps, tourParam && tourParam !== 'workspace' ? { repoId: tourParam } : {});
        return;
    }
    // #843 — sequence routes reached by graphId (tour drills, deep links)
    // bypass openSequenceForApi's fallback chain. When the sequence graph
    // doesn't exist, try the same flow → file substitutes before giving up;
    // see ADR-039.
    if (!graph && id.startsWith('sequence:')) {
        try {
            const stores: SnapshotStore[] = [deps.snapshotStore];
            if (deps.multiRepo) stores.push(...deps.multiRepo.perRepoStores.values());
            for (const cand of deriveSequenceFallbackIds(id.slice('sequence:'.length))) {
                let cg: DiagramGraph | undefined;
                let resolvedGid = cand.gid;
                for (const s of stores) {
                    try {
                        const graphs = s.getWorking().graphs as Record<string, DiagramGraph>;
                        // #861 — flow candidates may be bare while Java stores
                        // them class-prefixed; resolve before lookup.
                        const realGid = cand.gid.startsWith('flow:')
                            ? (resolveFlowGraphId(Object.keys(graphs ?? {}), cand.gid) ?? cand.gid)
                            : cand.gid;
                        const g = graphs?.[realGid];
                        if (g && Array.isArray(g.nodes) && g.nodes.length > 0) { cg = g; resolvedGid = realGid; break; }
                    } catch { /* skip */ }
                }
                if (cg) {
                    graph = { ...cg, meta: { ...(cg.meta ?? {}), fallbackFromSequence: true } } as DiagramGraph;
                    id = resolvedGid; // navigate under the substitute's real graphId
                    broadcastToast(deps, 'info', `No sequence diagram yet — showing ${cand.mode === 'flow' ? 'the flow chart' : 'the file diagram'} instead.`);
                    break;
                }
            }
        } catch (err: any) {
            deps.log(`[standalone] sequence fallback failed: ${err?.message ?? err}`);
        }
    }
    // #861 — Java/Kotlin class methods store their flow under a class-prefixed
    // id (`flow:<file>:<Class>.<method>`) while routes / L2b / the L3→L5
    // fallback reference the bare method name. Resolve bare → class-prefixed
    // so Java controller routes drill to L5 instead of dead-ending on file.
    if (!graph && id.startsWith('flow:')) {
        try {
            const stores: SnapshotStore[] = [deps.snapshotStore];
            if (deps.multiRepo) stores.push(...deps.multiRepo.perRepoStores.values());
            for (const s of stores) {
                const graphs = s.getWorking().graphs as Record<string, DiagramGraph>;
                const real = resolveFlowGraphId(Object.keys(graphs ?? {}), id);
                if (real && graphs[real]?.nodes?.length) { graph = graphs[real]; id = real; break; }
            }
        } catch (err: any) {
            deps.log(`[standalone] flow id resolve failed: ${err?.message ?? err}`);
        }
    }
    // BUG-EXP-13 — a cold deep-link to bare `#/features` requests
    // `feature:workspace`, which may not be built on a multi-service repo, so
    // the SPA hangs on "Loading…". Build it on demand; if still missing/empty,
    // fall back to the first non-empty per-service feature graph so the user
    // lands on a real view instead of an infinite spinner.
    if (!graph && id.startsWith('feature:')) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { buildFeatureGraph } = require('../core/graph/featureGraphBuilder');
            const sid = id === 'feature:workspace' ? undefined : id.replace(/^feature:/, '');
            const built = buildFeatureGraph(working, deps.snapshotStore.getBaseline(), sid);
            if (built?.graphId && Array.isArray(built.nodes) && built.nodes.length > 0) {
                deps.snapshotStore.updateWorkingGraph(built.graphId, built);
                graph = built;
                id = built.graphId;
            }
        } catch (err: any) {
            deps.log(`[standalone] on-demand feature build failed for ${id}: ${err?.message ?? err}`);
        }
        if (!graph) {
            // BUG-VERIFY-4 — in a multi-repo workspace the primary/workspace
            // store holds NO feature graphs (clustering runs per-repo, so the
            // real `feature:service:*` graphs live in the per-repo stores).
            // The pre-fix lookup only scanned `working.graphs` (the empty
            // workspace store), so a monorepo's `#/features` fell through to
            // "Diagram not found" / a System-Design bounce. Walk the primary
            // + every per-repo store: for a specific `feature:service:X` take
            // that exact graph; for the bare `feature:workspace` overview pick
            // the feature graph with the MOST entry points so the user lands
            // on a useful default (the biggest service's L2a) instead of an
            // empty page. Single-repo behaviour is unchanged (the primary
            // store's own `feature:service:*` graphs are scanned first).
            // `id` is a string here (guarded by `id.startsWith('feature:')`
            // above and only reassigned on the success branch that sets
            // `graph`, which this `!graph` block excludes) — capture it so TS
            // keeps the narrowing across the loop closures.
            const fId: string = id!;
            const bare = fId === 'feature:workspace';
            const stores: SnapshotStore[] = [deps.snapshotStore];
            if (deps.multiRepo) stores.push(...deps.multiRepo.perRepoStores.values());
            let bestId = fId;
            let bestEntryPoints = -1;
            for (const s of stores) {
                let graphs: Record<string, DiagramGraph>;
                try { graphs = (s.getWorking().graphs ?? {}) as Record<string, DiagramGraph>; }
                catch { continue; }
                // PERF (2026-07-20) — `graphs` is a lazy SQLite-backed Proxy where
                // reading a VALUE (and hence `Object.keys`, which the spec routes
                // through the per-key getOwnPropertyDescriptor trap) force-fetches
                // that graph. On a 14k-graph repo the bare `#/features` overview
                // paid ~1s. Enumerate the id keyspace fetch-free via the
                // LazyGraphMap, reading only the `feature:service:*` values.
                const lazyMap = getLazyGraphMap(graphs);
                const allKeys = lazyMap ? lazyMap.keys() : Object.keys(graphs);
                const keys = bare
                    ? allKeys.filter((k) => k.startsWith('feature:service:'))
                    : (graphs[fId] ? [fId] : []);
                for (const k of keys) {
                    const g = graphs[k];
                    if (!g || !Array.isArray(g.nodes) || g.nodes.length === 0) continue;
                    if (!bare) { graph = g; bestId = k; break; }
                    const ep = g.nodes.reduce((sum: number, n: any) =>
                        sum + (Array.isArray(n?.meta?.apisInCluster) ? n.meta.apisInCluster.length : 0), 0);
                    if (ep > bestEntryPoints) { bestEntryPoints = ep; graph = g; bestId = k; }
                }
                if (graph && !bare) break;
            }
            if (graph) {
                id = bestId;
                deps.log(`[standalone] feature multi-repo resolve → ${id} (${graph.nodes.length} clusters${bare ? `, ${bestEntryPoints} entry points` : ''})`);
            }
        }
    }
    // TICKET-UI-1 — `api-list:workspace` is a synthetic aggregate (every entry
    // point in the workspace); it is never persisted to the store, so build it
    // on-demand here (mirrors the on-demand feature-graph build above). Shared
    // builder → identical shape to the VSIX's `toolHandlers.ts` list.
    if (!graph && id === WORKSPACE_API_LIST_ID) {
        const built = buildWorkspaceApiListGraph(working.apiIndex);
        if (built) graph = built;
    }
    if (!graph) {
        deps.log(`[standalone] requestRoute: ${id} not found in working snapshot`);
        broadcastToast(deps, 'warning', `Diagram not found: ${id}`);
        return;
    }
    const navMsg = {
        type: 'navigateTo',
        graphId: id,
        mode: graph.type,
        graph,
        label: graphLabelFor(graph),
    };
    // Per-client when possible; broadcast fallback for internal callers
    // and minimal test fakes without `sendTo`.
    if (clientId && typeof (deps.wsBridge as { sendTo?: unknown }).sendTo === 'function') {
        deps.wsBridge.sendTo(clientId, navMsg);
    } else {
        deps.wsBridge.broadcast(navMsg);
    }
}

async function handleAnchorClick(
    deps: StandaloneHandlerDeps,
    opener: typeof openInEditor,
    msg: { anchor?: { filePath?: string; line?: number; span?: { start: number; end: number } } },
): Promise<void> {
    const fp = msg.anchor?.filePath;
    if (!fp) return;
    // #888 — boundary-check before spawning the editor (no-Origin WS clients).
    const abs = safeResolve(deps.workspaceRoot, fp);
    if (!abs) {
        broadcastToast(deps, 'warning', 'Refused to open a file outside the workspace.');
        return;
    }
    const line = msg.anchor?.line;
    const result = await opener(abs, line, {});
    broadcastToast(deps, result.spawned ? 'info' : 'warning', result.toast);
}

function handleResolveComment(deps: StandaloneHandlerDeps, msg: { commentId?: string }): void {
    const id = msg.commentId;
    if (!id) return;
    deps.commentStore.resolve(id);
    deps.wsBridge.broadcast({ type: 'commentResolved', commentId: id });
}

function handleRunCommand(deps: StandaloneHandlerDeps, msg: { command?: string }, clientId?: string): void {
    switch (msg.command) {
        case 'codeatlas.login': {
            if (!deps.auth) {
                broadcastToast(deps, 'info', 'Sign-in is not available in this build.');
                return;
            }
            // Open the dashboard /auth bridge in the browser; on success it
            // redirects to this server's /auth/callback, which StandaloneClerkAuth
            // verifies + persists. Pass `port` so the dashboard uses browser mode.
            const port = deps.wsBridge.getPort();
            const params = new URLSearchParams({ port: String(port), source: 'codeatlaslive.codeatlas-live', scheme: 'vscode' });
            const authUrl = `https://www.codeatlas.live/auth?${params.toString()}`;
            const payload = { type: 'openUrl' as const, url: authUrl };
            if (clientId) deps.wsBridge.sendTo(clientId, payload);
            else deps.wsBridge.broadcast(payload);
            return;
        }
        case 'codeatlas.logout': {
            // Clear the persisted session and re-push workspaceInfo so every
            // open tab's chip flips back to "Sign in". Diagrams stay available.
            deps.auth?.clearSession();
            broadcastWorkspaceInfo(deps);
            broadcastToast(deps, 'info', 'Signed out.');
            return;
        }
        case 'codeatlas.lightMode':
            deps.wsBridge.broadcast({ type: 'setTheme', theme: 'light' });
            return;
        case 'codeatlas.darkMode':
            deps.wsBridge.broadcast({ type: 'setTheme', theme: 'dark' });
            return;
        // Diagram-card commands fired from HomePage. The VS Code extension
        // implements these as commands; in the standalone we map them to
        // the equivalent graph route. The user explicitly invoked them.
        case 'codeatlas.openApiExplorer': {
            // TICKET-UI-1 — route to the workspace-wide L2b list (ALL entry
            // points), matching the VSIX (`toolHandlers.ts`). handleRequestRoute
            // builds `api-list:workspace` on-demand from the full apiIndex.
            if (Object.keys(deps.snapshotStore.getWorking().apiIndex ?? {}).length > 0) {
                handleRequestRoute(deps, { graphId: WORKSPACE_API_LIST_ID });
            } else {
                broadcastToast(deps, 'info', 'No API-list diagrams yet — run "Initialize" to scan the workspace.');
            }
            return;
        }
        case 'codeatlas.searchApiExplorer':
        case 'codeatlas.openFunctionFlow': {
            // Issue UX-7 (2026-06-03) — previously these cards landed on
            // an alphabetical-first sequence / flow graph, which on the
            // test project meant DELETE /:slug or `constructor` (a 3-node
            // trivial). Both are negative-sounding landings for a new dev.
            //
            // Route to the L2b API list (the first cluster) so the user
            // sees a picker grid of every API in the workspace and can
            // CHOOSE which sequence/flow to drill into. Hint toast tells
            // them what to do next.
            const verb = msg.command === 'codeatlas.openFunctionFlow' ? 'function flow' : 'API sequence';
            // TICKET-UI-1 — land on the workspace-wide L2b list so the user sees
            // EVERY API to choose from, not an incidental near-empty cluster.
            if (Object.keys(deps.snapshotStore.getWorking().apiIndex ?? {}).length > 0) {
                handleRequestRoute(deps, { graphId: WORKSPACE_API_LIST_ID });
                broadcastToast(deps, 'info', `Pick an API to see its ${verb}.`);
            } else {
                broadcastToast(deps, 'info', `No ${verb} diagrams yet — run "Initialize" to scan the workspace.`);
            }
            return;
        }
        case 'codeatlas.showHealthReport':
            handleRequestRoute(deps, { graphId: 'health:report' });
            return;

        // Issue UX-3 remaining (2026-06-03) — wire what's feasible
        // standalone-side; route the rest to a friendly, actionable
        // toast instead of the generic "unsupported in v1" message.

        case 'codeatlas.analyzeImpact':
            // Impact Analysis in the extension takes a file picker. The
            // standalone has a `requestImpact` handler that accepts a
            // filePath in the message — surface that to the user.
            handleRequestRoute(deps, { graphId: 'health:report' });
            broadcastToast(deps, 'info', 'Health Report opened. Use the AI Review side panel to surface impact-style findings, or right-click a node → "Impact analysis" once the inline picker ships.');
            return;

        case 'codeatlas.exportArchitectureDocs':
            // Defer to the existing `exportArchitectureDocs` message
            // case (already handled separately by the router). For users
            // who click the home card / toolbar icon, show a helpful
            // pointer rather than a silent drop.
            broadcastToast(deps, 'info', 'Use the Export ↓ menu (top-right of any diagram) → "Markdown + Mermaid" to download architecture docs.');
            return;

        case 'codeatlas.search':
            // #MCP-STD-5 (2026-06-07): broadcast `showSearchPicker` with
            // every searchable entity (APIs + files + clusters +
            // services). The webview's App.tsx already handles this
            // envelope — it opens the global cross-surface palette modal
            // backed by the `<SearchPicker>` component. Previously this
            // case routed to api-list with a toast hinting at the `/`
            // shortcut, but that only filtered routes WITHIN one L2b
            // panel; users hitting the toolbar 🔍 button expected
            // workspace-wide search.
            {
                const w = deps.snapshotStore.getWorking();
                const items: Array<{ id: string; label: string; description: string; kind: string }> = [];
                for (const api of Object.values(w.apiIndex ?? {})) {
                    items.push({
                        id: api.apiId,
                        label: `${api.method} ${api.route}`,
                        description: api.filePath,
                        kind: 'API',
                    });
                }
                for (const fp of Object.keys(w.files ?? {})) {
                    items.push({
                        id: fp,
                        label: fp.split('/').pop() ?? fp,
                        description: fp,
                        kind: 'File',
                    });
                }
                for (const cluster of Object.values(w.clusters ?? {})) {
                    items.push({
                        id: cluster.id,
                        label: cluster.label,
                        description: `${cluster.files.length} files`,
                        kind: 'Cluster',
                    });
                }
                for (const svc of Object.values(w.services ?? {})) {
                    items.push({
                        id: svc.id,
                        label: svc.name,
                        description: svc.technology ?? '',
                        kind: 'Service',
                    });
                }
                deps.wsBridge.broadcast({ type: 'showSearchPicker', items });
            }
            return;

        case 'codeatlas.resyncEverything':
            // Re-sync in standalone: the file watcher auto-resyncs on save.
            // Without an explicit file change the user-facing button is
            // mostly a no-op, so explain that.
            broadcastToast(deps, 'info', 'Standalone auto-resyncs on every file save. To force a full re-init, restart the @codeatlas/mcp server.');
            return;

        case 'codeatlas.initializeWorkspaceVisuals':
            // Standalone auto-inits on first connect. Re-init would
            // require a server restart — surface that.
            broadcastToast(deps, 'info', 'Workspace already initialised. To re-index from scratch, delete `.codeatlas-sa/state.db` and restart the standalone.');
            return;

        case 'codeatlas.openPrDiff':
            broadcastToast(deps, 'warning', 'PR Diff needs the VS Code extension (uses GitHub auth + git CLI). Run "code ." in this workspace to switch.');
            // #859 — the HomePage button already set `#/pr-diff`; without a
            // graph the SPA hangs on "Loading…". Land the user on a real view.
            handleRequestRoute(deps, { graphId: 'microservice:workspace' });
            return;

        case 'codeatlas.timelineReplay':
            broadcastToast(deps, 'warning', 'Timeline Replay needs the VS Code extension. Run "code ." here to use it.');
            // #859 — same: the button set `#/timeline-replay`; avoid the stuck
            // "Loading…" screen by navigating to system-design.
            handleRequestRoute(deps, { graphId: 'microservice:workspace' });
            return;

        case 'codeatlas.loadCoverage':
            broadcastToast(deps, 'warning', 'Coverage loading needs the VS Code extension (uses the file picker). Run "code ." here, then run "CodeAtlas: Load Coverage".');
            return;

        default:
            deps.log(`[standalone] runCommand: ${msg.command} unsupported in v1`);
            broadcastToast(deps, 'info', `Command "${msg.command}" not yet available in @codeatlas/mcp. Open the workspace in VS Code with the CodeAtlas extension for the full feature set.`);
    }
}

function handleSetLlmConfig(deps: StandaloneHandlerDeps, msg: any): void {
    if (!deps.settings) {
        broadcastToast(deps, 'warning', 'Settings layer not initialised — restart the standalone server.');
        return;
    }
    // The webview sends `{ type: 'setLlmConfig', provider, model, endpoint }`.
    // Map each value to its full settings key and persist. Skip undefined
    // fields so a partial update doesn't clobber the rest.
    const updates: Array<[string, unknown]> = [];
    if (typeof msg.provider === 'string') updates.push(['codeatlas.llmProvider', msg.provider]);
    if (typeof msg.model === 'string') updates.push(['codeatlas.llmModel', msg.model]);
    if (typeof msg.endpoint === 'string') updates.push(['codeatlas.llmEndpoint', msg.endpoint]);
    if (updates.length === 0) {
        broadcastToast(deps, 'info', 'No LLM config changes to apply.');
        return;
    }
    let allOk = true;
    for (const [k, v] of updates) {
        if (!deps.settings.set(k, v)) allOk = false;
    }
    if (allOk) {
        broadcastToast(deps, 'info', `Saved LLM config (${updates.map(([k]) => k.replace('codeatlas.', '')).join(', ')}).`);
        deps.wsBridge.broadcast({ type: 'llmConfigSaved' });
        // Also push a refreshed workspaceInfo so the home-screen badge +
        // LlmConfigSection reflect the new provider/model/endpoint without
        // requiring a file edit + cascade. Without this the UI keeps showing
        // the old default ("openrouter") until something else triggers a
        // workspaceInfo refresh.
        // #835 — same multi-repo-aware counts as the `ready` handshake.
        const counts = computeWorkspaceCounts(deps);
        deps.wsBridge.broadcast({
            type: 'workspaceInfo',
            name: require('path').basename(deps.workspaceRoot),
            workspaceRoot: deps.workspaceRoot,
            fileCount: counts.fileCount,
            apiCount: counts.apiCount,
            serviceCount: counts.serviceCount,
            clusterCount: counts.clusterCount,
            screenCount: counts.screenCount,
            fileGraphCount: counts.fileGraphCount,
            flowGraphCount: counts.flowGraphCount,
            sequenceGraphCount: counts.sequenceGraphCount,
            initialized: counts.fileCount > 0,
            ...authWorkspaceFields(deps),
            hasGitRemote: false,
            gitHubConnected: false,
            editorUriScheme: 'vscode',
            extensionId: 'codeatlas.standalone',
            mcpServerVersion: deps.mcpServerVersion ?? null,
            llmProvider: deps.settings.get<string>('codeatlas.llmProvider'),
            llmModel: deps.settings.get<string>('codeatlas.llmModel'),
            llmEndpoint: deps.settings.get<string>('codeatlas.llmEndpoint'),
            services: counts.services,
            isMultiRepo: !!(deps.multiRepo && deps.multiRepo.repos.length >= 2),
            repos: deps.multiRepo ? deps.multiRepo.repos.map(r => ({
                repoId: r.repoId, name: r.name, rootPath: r.rootPath,
            })) : [],
        });
    } else {
        broadcastToast(deps, 'error', 'Failed to write LLM config — check filesystem permissions on .codeatlas-sa/config.json.');
    }
}

/**
 * UX (2026-06-04) - Test Connection handshake.
 *
 * Reads the saved LLM config, runs `probeLlmConnection` (a 10s
 * AbortController-bounded probe), then broadcasts a single
 * `llmConnectionTestResult` envelope. The webview's
 * `LlmConnectionTestButton` consumes that envelope and renders
 * the success/failure chip with latency.
 */
function handleTestLlmConnection(deps: StandaloneHandlerDeps): void {
    (async () => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { probeLlmConnection } = require('../handlers/llmConnectionProbe');
            const provider = deps.settings?.get<string>('codeatlas.llmProvider') ?? 'openrouter';
            const endpoint = deps.settings?.get<string>('codeatlas.llmEndpoint') ?? '';
            const apiKey = (await deps.secrets?.get('codeatlas.openRouterApiKey')) ?? '';
            const result: { ok: boolean; message: string; latencyMs?: number } =
                await probeLlmConnection({ provider, endpoint, apiKey });
            deps.wsBridge.broadcast({ type: 'llmConnectionTestResult', ...result });
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            deps.log(`[standalone] testLlmConnection failed: ${msg}`);
            deps.wsBridge.broadcast({
                type: 'llmConnectionTestResult',
                ok: false,
                message: `Probe crashed: ${msg.slice(0, 200)}`,
            });
        }
    })();
}

/**
 * Issue #733 — write the `codeatlas.domainLlmRefinementEnabled` setting,
 * echo the new state to the webview, and (if the standalone server
 * supplied a `triggerDomainRefresh` callback) kick off an immediate
 * refinement so the user sees the change without waiting for the next
 * file save. The deterministic heuristic always runs underneath; this
 * toggle only controls whether the LLM enhancement pass runs on top.
 */
function handleSetDomainLlmRefinement(deps: StandaloneHandlerDeps, msg: { enabled?: boolean }): void {
    if (!deps.settings) {
        broadcastToast(deps, 'warning', 'Settings layer not initialised — cannot toggle Domain LLM refinement.');
        return;
    }
    const desired = msg.enabled === true;
    const ok = deps.settings.set('codeatlas.domainLlmRefinementEnabled', desired);
    if (!ok) {
        broadcastToast(deps, 'error', 'Failed to write Domain LLM toggle to settings — check filesystem permissions.');
        return;
    }
    deps.wsBridge.broadcast({ type: 'domainLlmRefinementState', enabled: desired });
    broadcastToast(deps, 'info', desired
        ? 'Domain LLM refinement ON — heuristic graph stays as the source of truth; LLM will enhance names + confidence next time domains rebuild.'
        : 'Domain LLM refinement OFF — only the deterministic heuristic runs.');
    // Best-effort immediate refresh when the toggle goes ON. When OFF we
    // don't auto-rebuild because the heuristic graph is already current.
    // #913 — refined names now PERSIST: they're written to the sqlite `domains`
    // table and `mergeRefinedDomainNames` carries them across every cascade
    // (file save / resync), so the user's enrichment survives reloads + edits
    // instead of reverting to the heuristic.
    if (desired && deps.triggerDomainRefresh) {
        deps.triggerDomainRefresh().then((ids) => {
            deps.log(`[setDomainLlmRefinement] refreshed graphs: ${ids.join(', ')}`);
        }).catch((err: any) => {
            deps.log(`[setDomainLlmRefinement] refresh failed: ${err?.message ?? err}`);
        });
    }
}

/**
 * #851 — PR watcher status for the HomePage card. `refreshPrereqs` checks
 * token + LLM-key presence without polling GitHub, so the card shows
 * accurate prerequisites even while the watcher is OFF.
 */
async function handleGetPrWatcherStatus(deps: StandaloneHandlerDeps): Promise<void> {
    const watcher = deps.prWatcher?.();
    if (!watcher) {
        deps.wsBridge.broadcast({ type: 'prWatcherStatus', status: null });
        return;
    }
    const status = await watcher.refreshPrereqs();
    deps.wsBridge.broadcast({ type: 'prWatcherStatus', status });
}

/**
 * #851 — flip the PR watcher on/off. Persists `codeatlas.prWatcherEnabled`
 * so the state survives a server restart; start() ticks immediately so the
 * first poll result lands on the card within seconds.
 */
async function handleSetPrWatcherEnabled(deps: StandaloneHandlerDeps, msg: { enabled?: boolean }): Promise<void> {
    const watcher = deps.prWatcher?.();
    if (!watcher) {
        broadcastToast(deps, 'warning', 'PR watcher not available on this surface.');
        return;
    }
    const desired = msg.enabled === true;
    if (deps.settings && !deps.settings.set('codeatlas.prWatcherEnabled', desired)) {
        broadcastToast(deps, 'error', 'Failed to persist the PR watcher toggle — check filesystem permissions.');
    }
    if (desired) watcher.start(); else watcher.stop();
    const status = await watcher.refreshPrereqs();
    deps.wsBridge.broadcast({ type: 'prWatcherStatus', status });
    broadcastToast(deps, 'info', desired
        ? 'PR watcher ON — open PRs on this repo will be reviewed and commented automatically.'
        : 'PR watcher OFF — no more automatic PR reviews.');
}

/**
 * Issue #702 / #736 — build the tour from the working snapshot and
 * broadcast it back as `tourSteps`. The builder is pure data-in /
 * data-out + cheap, so we run it inline on every request rather than
 * caching it. Mode defaults to 'codebase'; 'recent' uses the baseline's
 * apiIndex keys as the added-detection seed.
 */
function handleRequestTour(deps: StandaloneHandlerDeps, msg: { mode?: 'codebase' | 'recent'; maxSteps?: number; repoId?: string }): void {
    try {
        // #846c — multi-repo parity: the VSIX serves the repo-qualified
        // workspace meta-tour; the standalone previously built a primary-
        // store tour (30 generic steps vs 89 guided ones live). Use the
        // read-only aggregator when it can supply summaries; fall through
        // to the legacy tour otherwise.
        if (deps.multiRepo && deps.multiRepo.repos.length >= 2 && !msg.repoId) {
            try {
                const agg: any = deps.multiRepo.aggregator;
                if (agg?.listRepos && agg?.getRepoSummary) {
                    const metaSteps = buildWorkspaceMetaTour(agg, deps.workspaceRoot);
                    if (Array.isArray(metaSteps) && metaSteps.length > 0) {
                        deps.wsBridge.broadcast({ type: 'tourSteps', mode: msg.mode === 'recent' ? 'recent' : 'codebase', steps: toLiteSteps(metaSteps) });
                        return;
                    }
                }
            } catch (metaErr: any) {
                deps.log(`[standalone] workspace meta-tour failed (${metaErr?.message ?? metaErr}); falling back to primary-store tour`);
            }
        }
        // #846c — per-repo tour drill (`tour:<repoId>` from the meta-tour).
        let tourStore: SnapshotStore = deps.snapshotStore;
        if (msg.repoId && deps.multiRepo) {
            const hint = String(msg.repoId);
            const matched = deps.multiRepo.repos.find(r => r.repoId === hint || r.name === hint || r.rootPath === hint);
            const subStore = matched ? deps.multiRepo.perRepoStores.get(matched.repoId) : undefined;
            if (subStore) tourStore = subStore;
        }
        const working = tourStore.getWorking();
        const baseline = tourStore.getBaseline();
        const mode = msg.mode === 'recent' ? 'recent' : 'codebase';
        const baselineApiIds = mode === 'recent'
            ? new Set(Object.keys(baseline?.apiIndex ?? {}))
            : undefined;
        const steps = buildTour(working, mode, {
            maxSteps: msg.maxSteps,
            baselineApiIds,
        });
        const lite = toLiteSteps(steps);
        deps.wsBridge.broadcast({ type: 'tourSteps', mode, steps: lite });
    } catch (err: any) {
        deps.log(`[standalone] requestTour failed: ${err?.message ?? err}`);
        broadcastToast(deps, 'error', `Tour build failed: ${(err?.message ?? err).slice(0, 200)}`);
    }
}

function handleRequestExplorerData(deps: StandaloneHandlerDeps): void {
    // UX-50g (2026-06-06) — emit the same ExplorerItem shape the
    // extension host uses (id / label / subtitle / diff / action / repoId)
    // so the webview's `ScopePicker` + `ExplorerSidebar` can group items
    // by repo in multi-repo workspaces. Previously this returned raw
    // ApiRecord / Cluster / filepath arrays which the sidebar couldn't
    // render. Mirrors `buildExplorerData` in `src/extension.ts:1173`.
    //
    // #815 (2026-06-10) — multi-repo aggregation:
    //   • iterate `deps.multiRepo.perRepoStores` and merge each sub-repo's
    //     `services / clusters / apiIndex / files`. Cluster keys are
    //     re-keyed `<id>::<orchKey>` so sub-repos sharing `cluster:model`
    //     don't collapse under `Object.assign` (v97 fix).
    //   • recompute `service.exposedApiCount` from the merged `apiIndex`
    //     so the picker step-1 subtitle reads real counts instead of the
    //     pre-`apiIndex`-population 0 (#809 fix).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    const isMulti = !!(deps.multiRepo && deps.multiRepo.repos.length >= 2);
    let w: any;
    if (isMulti && deps.multiRepo!.perRepoStores.size > 0) {
        const merged: any = { services: {}, clusters: {}, apiIndex: {}, files: {} };
        for (const [orchKey, store] of deps.multiRepo!.perRepoStores.entries()) {
            try {
                const ws: any = store.getWorking();
                Object.assign(merged.services, ws.services ?? {});
                for (const [cid, c] of Object.entries(ws.clusters ?? {})) {
                    merged.clusters[`${cid}::${orchKey}`] = c;
                }
                Object.assign(merged.apiIndex, ws.apiIndex ?? {});
                Object.assign(merged.files, ws.files ?? {});
            } catch (err: any) {
                deps.log(`[standalone explorerData] per-repo merge failed: ${err?.message ?? err}`);
            }
        }
        w = merged;
    } else {
        w = deps.snapshotStore.getWorking();
    }
    const allServices = Object.values(w.services ?? {});
    // #816 (2026-06-10) — in multi-repo mode prefer `multiRepo.repos`
    // (the canonical sub-repo registry from WorkspaceBootstrap) for
    // path → repoId resolution. After #816's Phase 5 sister-fix in
    // syncOrchestrator, per-repo services' rootPaths are scoped to the
    // sub-repo's INTERNAL layout (e.g. `src/DotNetServerless.Lambda`,
    // NOT `aws-dotnet-rest-api-with-dynamodb/src/...`). Falling back to
    // per-service rootPaths would no longer match workspace-relative
    // file paths. The aggregator's `r.rootPath` is the workspace-
    // relative sub-repo dir, so prefix matching works again.
    const repoRootEntries = isMulti && deps.multiRepo!.repos.length > 0
        ? [...deps.multiRepo!.repos]
            .filter(r => r.rootPath)
            .map(r => ({ rootPath: r.rootPath, repoId: r.repoId }))
            .sort((a, b) => b.rootPath.length - a.rootPath.length)
        : allServices
            .filter((s: any) => s?.repoId && s?.rootPath)
            .map((s: any) => ({ rootPath: s.rootPath as string, repoId: s.repoId as string }))
            .sort((a, b) => b.rootPath.length - a.rootPath.length);
    const resolveRepoIdForPath = (fp: string): string | undefined => {
        const relFp = path.isAbsolute(fp) ? path.relative(deps.workspaceRoot, fp) : fp;
        const norm = relFp.replace(/\\/g, '/').replace(/^\.\//, '');
        for (const e of repoRootEntries) {
            const root = e.rootPath.replace(/\\/g, '/').replace(/^\.\//, '');
            if (root === '' || root === '.') continue;
            if (norm === root || norm.startsWith(root + '/')) return e.repoId;
        }
        return undefined;
    };
    // Keep the original alias so the rest of the function (services
    // recompute on the single-repo fallback) compiles unchanged.
    const serviceRootEntries = repoRootEntries;
    // #809 — recompute exposed API count per service rootPath from merged
    // apiIndex. Excludes non-HTTP synthetic methods so jobs/middleware/etc.
    // don't inflate the "HTTP routes exposed" subtitle.
    const NON_HTTP_METHODS = new Set([
        'SIGNAL', 'EVENT_LISTENER', 'EVENT_EMIT', 'AOP_ASPECT', 'AOP_AROUND',
        'AOP_BEFORE', 'AOP_AFTER', 'AOP_AFTERRETURNING', 'AOP_AFTERTHROWING',
        'DI_DEPENDENCY', 'MIDDLEWARE', 'SERVLET_FILTER', 'HANDLER_INTERCEPTOR',
        'DATA_FETCH', 'STATIC_PATHS', 'NETWORK',
    ]);
    const apiCountByRootPath = new Map<string, number>();
    for (const a of Object.values(w.apiIndex ?? {}) as any[]) {
        if (!a || NON_HTTP_METHODS.has(a.method)) continue;
        const fp = a.filePath || '';
        const relFp = path.isAbsolute(fp) ? path.relative(deps.workspaceRoot, fp) : fp;
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
    // #816 (2026-06-10) — translate service.repoId from sub-repo name
    // (what `detectServices` writes) to the canonical hex repoId (what
    // the picker step-1 + workspaceState carry). Pre-#816 the two were
    // out of sync in MCP and the step-2 features filter found 0
    // matches even when the underlying clusters existed.
    const nameToHex = isMulti
        ? new Map(deps.multiRepo!.repos.map(r => [r.name, r.repoId]))
        : new Map<string, string>();
    const translateRepoId = (rid: string | undefined): string | undefined => {
        if (!rid) return undefined;
        return nameToHex.get(rid) ?? rid;
    };
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
    const features = Object.values(w.clusters ?? {}).map((c: any) => ({
        id: c.id, label: c.name || c.label, subtitle: `${(c.files ?? []).length} files`,
        diff: c.diff, action: { type: 'openApiListForCluster', clusterId: c.id, serviceId: c.serviceId || '' },
        repoId: c.serviceId ? serviceIdToRepoId.get(c.serviceId) : undefined,
    }));
    const apis = Object.values(w.apiIndex ?? {}).map((a: any) => ({
        id: a.apiId, label: `${a.method} ${a.route}`, subtitle: a.handlerName,
        diff: a.diff, action: { type: 'openSequenceForApi', apiId: a.apiId },
        repoId: resolveRepoIdForPath(a.filePath),
    }));
    // #816 (2026-06-10) — in multi-repo workspaces, rebuild the picker
    // step-1 `services` slice from `multiRepo.repos` (the canonical sub-
    // repo registry threaded through from `WorkspaceBootstrap`). Pre-#816
    // the slice came from `working.services` which depended on each per-
    // repo state.db carrying the full workspace-services list. Mirrors
    // the extension.ts buildExplorerData fix so MCP standalone behaves
    // identically to the VS Code surface.
    if (isMulti && deps.multiRepo!.repos.length > 0) {
        // Count HTTP-method APIs only (same filter as the #809 recompute
        // above) so picker subtitles match the L1 "N HTTP routes
        // exposed" header on the same sub-repo.
        const apiCountByRepoId = new Map<string, number>();
        for (const a of Object.values(w.apiIndex ?? {}) as any[]) {
            if (!a || NON_HTTP_METHODS.has(a.method)) continue;
            const repoId = resolveRepoIdForPath(a.filePath || '');
            if (!repoId) continue;
            apiCountByRepoId.set(repoId, (apiCountByRepoId.get(repoId) || 0) + 1);
        }
        const newServices = deps.multiRepo!.repos.map(r => {
            const apiCount = apiCountByRepoId.get(r.repoId) ?? 0;
            // Technology refinement: pick the first detected service in
            // the matching per-repo store. Falls back to 'unknown' when
            // the per-repo store hasn't been scanned yet.
            let technology = 'unknown';
            let category: string | undefined;
            try {
                const sub = deps.multiRepo!.perRepoStores.get(r.repoId);
                const subServices = Object.values(sub?.getWorking().services ?? {}) as any[];
                if (subServices[0]?.technology) technology = subServices[0].technology;
                // BUG-CONNECT-4 — label the repo row by its category (backend when
                // it exposes HTTP routes, else the dominant FE/mobile) + a
                // category-aware noun, not the bootstrap 'unknown' technology + a
                // hardcoded 'APIs'.
                category = repoCategoryFromServices(subServices);
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
        services.length = 0;
        services.push(...newServices);
    }
    const files = Object.keys(w.files ?? {}).map((fp: string) => {
        const relPath = path.isAbsolute(fp) ? path.relative(deps.workspaceRoot, fp) : fp;
        return {
            id: fp, label: relPath.split('/').pop() || relPath, subtitle: relPath,
            action: { type: 'openFileDiagram', filePath: fp },
            repoId: resolveRepoIdForPath(fp),
        };
    });
    const functions: any[] = [];
    for (const [fp, rec] of Object.entries(w.files ?? {})) {
        const repoId = resolveRepoIdForPath(fp);
        for (const fn of (rec as any).symbols?.functions ?? []) {
            functions.push({
                id: `${fp}:${fn.name}`, label: fn.name, subtitle: fp.split('/').pop(),
                action: { type: 'openFunctionFlow', filePath: fp, functionName: fn.name },
                repoId,
            });
        }
    }
    deps.wsBridge.broadcast({
        type: 'explorerData',
        services, features, apis, files, functions,
    });
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * #912 — resolve the per-repo SnapshotStore for a `repoId` hint, falling back
 * to the primary store. Mirrors the repo-match used by openFeatureForService
 * (ADR-038): a `repoId` may arrive as the realpath hash, the repo name, or the
 * rootPath. Returns the resolved store + a human repo name for export headings.
 * In single-repo mode (or when no hint matches) it returns the primary store,
 * so Impact + Export behave exactly as before for non-multi-repo workspaces.
 */
function resolveRepoStore(
    deps: StandaloneHandlerDeps,
    repoId?: unknown,
): { store: SnapshotStore; repoName: string } {
    const primaryName = deps.workspaceRoot.split('/').filter(Boolean).pop() ?? 'workspace';
    const hint = repoId == null ? '' : String(repoId);
    if (hint && deps.multiRepo && deps.multiRepo.repos.length >= 2) {
        const matched = deps.multiRepo.repos.find(r =>
            r.repoId === hint || r.name === hint || r.rootPath === hint
            || (r.rootPath && r.rootPath.endsWith('/' + hint))
            || (r.name && r.name.endsWith('/' + hint)));
        const sub = matched ? deps.multiRepo.perRepoStores.get(matched.repoId) : undefined;
        if (matched && sub) {
            return { store: sub, repoName: matched.name ?? matched.rootPath.split('/').filter(Boolean).pop() ?? primaryName };
        }
    }
    return { store: deps.snapshotStore, repoName: primaryName };
}

interface WorkspaceCounts {
    fileCount: number;
    apiCount: number;
    serviceCount: number;
    clusterCount: number;
    screenCount: number;
    fileGraphCount: number;
    flowGraphCount: number;
    sequenceGraphCount: number;
    /** Issue 108 — service list so the SPA can show service-name prefixes
     *  in breadcrumbs for multi-service monorepos. */
    services: Array<{ id: string; name: string; rootPath?: string }>;
}

/**
 * #835 (2026-06-11) — workspace counts for the home stat cards.
 *
 * Single-repo: counts come straight from the primary store's working
 * snapshot. Multi-repo: the primary store covers only ONE sub-repo, so
 * union the per-repo workings through `aggregateMultiRepoCounts` — the
 * SAME resolution the VS Code extension's `buildWorkspaceInfo` uses
 * (including the #831 service dedupe). INVARIANT: home stats and the L1
 * header derive from this one serviceCount on both transports; see ADR-036.
 */
function computeWorkspaceCounts(deps: StandaloneHandlerDeps): WorkspaceCounts {
    if (deps.multiRepo && deps.multiRepo.repos.length >= 2) {
        try {
            // #840 — persisted per-repo stores carry workspace-wide service
            // rows (the aggregator post-init pollution trap); strip rows
            // owned by OTHER repos before aggregating or the SERVICES stat
            // over-counts (339 vs 209 live on the 132-repo fixture). The
            // extension aggregates live in-memory workings and is immune.
            const allRootPaths = new Set(deps.multiRepo.repos.map(r => r.rootPath).filter(Boolean));
            const repoById = new Map(deps.multiRepo.repos.map(r => [r.repoId, r]));
            const workings = [...deps.multiRepo.perRepoStores.entries()].map(([repoId, s]) => {
                try {
                    const own = repoById.get(repoId)?.rootPath ?? '';
                    return stripForeignServiceRows(s.getWorking() as any, own, allRootPaths);
                } catch { return null; }
            }).filter(Boolean) as Array<ReturnType<SnapshotStore['getWorking']>>;
            if (workings.length > 0) {
                const agg = aggregateMultiRepoCounts(workings);
                return {
                    fileCount: agg.fileCount,
                    apiCount: agg.apiCount,
                    serviceCount: agg.serviceCount,
                    clusterCount: agg.clusterCount,
                    screenCount: agg.screenCount,
                    fileGraphCount: agg.fileGraphCount,
                    flowGraphCount: agg.flowGraphCount,
                    sequenceGraphCount: agg.sequenceGraphCount,
                    services: agg.services,
                };
            }
        } catch (err: any) {
            deps.log(`[standalone] multi-repo count aggregation failed (${err?.message ?? err}); falling back to primary store`);
        }
    }
    const working = deps.snapshotStore.getWorking();
    const graphIds = Object.keys(working.graphs ?? {});
    return {
        fileCount: Object.keys(working.files ?? {}).length,
        apiCount: Object.keys(working.apiIndex ?? {}).length,
        serviceCount: Object.keys(working.services ?? {}).length,
        clusterCount: Object.keys(working.clusters ?? {}).length,
        // v2 phase 3 #484 — FE/mobile L2a screen count.
        screenCount: Object.keys(working.screens ?? {}).length,
        fileGraphCount: graphIds.filter((id) => id.startsWith('file:')).length,
        flowGraphCount: graphIds.filter((id) => id.startsWith('flow:')).length,
        sequenceGraphCount: graphIds.filter((id) => id.startsWith('sequence:')).length,
        services: Object.values(working.services ?? {}).map((s: any) => ({ id: s.id, name: s.name, rootPath: s.rootPath })),
    };
}

function pickInitialGraph(deps: StandaloneHandlerDeps): DiagramGraph | null {
    const w = deps.snapshotStore.getWorking();
    // Prefer microservice:workspace; otherwise the first feature:* graph; else any.
    return (w.graphs as Record<string, DiagramGraph>)['microservice:workspace']
        ?? Object.values(w.graphs).find((g: any) => g?.graphId?.startsWith('feature:')) as DiagramGraph | undefined
        ?? Object.values(w.graphs)[0] as DiagramGraph | undefined
        ?? null;
}

/**
 * Issue UX-4 (2026-06-03) — convert the SPA's hash-route shape into the
 * canonical graphId understood by `working.graphs`. Pure function so
 * the mapping is unit-tested alongside `handleRequestRoute` in
 * `src/standalone/__tests__/messageHandler.test.ts`.
 *
 * Mirrors `webview-ui/src/App.tsx:parseHash` — every route the parser
 * emits must produce a graphId here, otherwise the cold deep-link will
 * hang on the SPA "Loading…" state.
 */
function resolveHashRouteToGraphId(
    msg: { route?: string; param?: string; param2?: string },
): string | undefined {
    const route = msg.route;
    if (!route) return undefined;
    if (route === 'system-design') return 'microservice:workspace';
    if (route === 'map') return 'map:workspace';
    if (route === 'domain') return 'domain:workspace';
    if (route === 'health') return 'health:report';
    if (route === 'tour') return msg.param ? `tour:${msg.param}` : 'tour:workspace';
    if (route === 'features') return msg.param ? `feature:${msg.param}` : 'feature:workspace';
    if (route === 'apis' && msg.param) return `api-list:${msg.param}`;
    if (route === 'sequence' && msg.param) return `sequence:${msg.param}`;
    if (route === 'file' && msg.param) return `file:${msg.param}`;
    if (route === 'flow' && msg.param && msg.param2) return `flow:${msg.param}:${msg.param2}`;
    // `api-testing` and `violations` are top-level surfaces, not graphIds;
    // they have their own handlers in the switch (case 'requestRoute' for
    // `route: 'api-testing'`, plus dedicated message types).
    return undefined;
}

function graphLabelFor(graph: DiagramGraph): string {
    const meta = (graph.meta ?? {}) as Record<string, unknown>;
    if (typeof meta.label === 'string') return meta.label;
    if (typeof meta.title === 'string') return meta.title;
    // Issue UX-10 (2026-06-03) — workspace-scope graphs used to fall
    // back to `nodes[0].label`, which for `feature:workspace` returned
    // the first cluster's name (e.g. "article") and made the breadcrumb
    // / window title pretend the user was inside that single cluster.
    // Prefer canonical names for well-known graphIds first; fall back
    // to nodes[0] only when the prefix isn't recognised.
    const id = graph.graphId ?? '';
    if (id === 'microservice:workspace') return 'System Design';
    if (id === 'map:workspace') return 'Knowledge Map';
    if (id === 'domain:workspace') return 'Business Domains';
    if (id === 'tour:workspace') return 'Tour';
    if (id === 'health:report') return 'Health Report';
    if (id === 'feature:workspace') return 'Feature Areas';
    if (id.startsWith('feature:service:')) return `Features: ${id.slice('feature:service:'.length)}`;
    if (id.startsWith('feature:')) return `Features: ${id.slice('feature:'.length)}`;
    if (id.startsWith('api-list:cluster:')) return `APIs: ${id.slice('api-list:cluster:'.length)}`;
    if (id.startsWith('api-list:')) return `APIs: ${id.slice('api-list:'.length)}`;
    const root = (graph.nodes ?? []).find((n: GraphNode) => n.type === 'file' || n.type === 'cluster' || n.type === 'service');
    return root?.label ?? id;
}

function broadcastToast(deps: StandaloneHandlerDeps, level: 'info' | 'warning' | 'error', text: string): void {
    deps.wsBridge.broadcast({ type: 'clientToast', level, text });
}

// #826 — one OverlayService per workspace deps. Keyed weakly so tests with
// fresh deps objects get isolated registries.
const overlayServices = new WeakMap<StandaloneHandlerDeps, import('../core/overlays/overlayService').OverlayService>();
function getOverlayService(deps: StandaloneHandlerDeps): import('../core/overlays/overlayService').OverlayService {
    let svc = overlayServices.get(deps);
    if (!svc) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { OverlayService } = require('../core/overlays/overlayService');
        svc = new OverlayService({
            workspaceRoot: deps.workspaceRoot,
            storageDirName: '.codeatlas-sa',
            getWorking: () => deps.snapshotStore.getWorking(),
            getBaseline: () => deps.snapshotStore.getBaseline(),
            getFileContent: (fp: string) => deps.snapshotStore.getFileContent('working', fp),
            log: deps.log,
        }) as import('../core/overlays/overlayService').OverlayService;
        overlayServices.set(deps, svc);
    }
    return svc;
}

// ─── #547 Shared router (cross-runtime handler modules) ─────────────────
//
// Builds a router pre-registered with handler modules from `src/handlers/`
// that target both runtimes. The HandlerContext satisfies the shared
// interface (with all VS Code-only fields left undefined — those modules
// early-return on the missing `ctx.context` guard). Each migrated module
// uses `ctx.platform.broadcast` / `ctx.platform.getSecret` / etc., so the
// same module runs identically on the extension and standalone.

interface SharedRouter {
    canHandle(type: string): boolean;
    dispatch(msg: any, clientId: string): void;
}

function buildSharedRouter(deps: StandaloneHandlerDeps): SharedRouter {
    // Synthesise a HandlerContext-shaped object. VS Code-specific fields
    // (panelManager, tree views, etc.) stay undefined — migrated handler
    // modules guard on `ctx.context` and no-op when it's missing.
    const platform = createStandalonePlatform({
        wsBridge: deps.wsBridge,
        secrets: deps.secrets ?? ({
            // Fallback no-op secrets store. Used by tests that don't supply
            // one; production always passes a real SecretsStore.
            get: async () => undefined,
            store: async () => undefined,
            delete: async () => undefined,
        } as SecretsStore),
        settings: deps.settings,
    });

    const ctx: HandlerContext = {
        workspaceRoot: deps.workspaceRoot,
        platform,
        snapshotStore: deps.snapshotStore,
        commentStore: deps.commentStore,
        wsBridge: deps.wsBridge,
        // Stub services that some handlers reference but we never invoke on
        // standalone (the registration helpers early-return on missing
        // `ctx.context`, so these are belt-and-suspenders defaults).
        llmNamingService: {} as any,
        notifyBrowser: (level, message) => deps.wsBridge.broadcast({
            type: 'clientToast', level, text: message,
        }),
        log: (m) => deps.log(m),
        // Everything else stays undefined per #547 — the optional fields
        // on HandlerContext make this a valid construction.
    } as HandlerContext;

    const router = createMessageRouter(ctx);

    // Modules registered here run on both runtimes. Each module's
    // register*Handlers function decides per-handler whether to register
    // (handlers that need vscode.workspace.getConfiguration or
    // panelManager.navigatePanel early-return on missing `ctx.context`).
    registerCommentHandlers(router.register, ctx);
    // aiReviewHandlers contributes the snapshotStore-only handlers:
    // requestReviewGuidelines, saveReviewGuidelines, requestAiFindings,
    // searchAiFindings, updateAiFindingStatus, clearFindings. Extension-
    // only paths (requestFullReview / requestSpecificReview / evidence-gate
    // toggles / etc.) skip themselves because `ctx.context` is undefined.
    registerAiReviewHandlers(router.register, ctx);

    // Track which message types the router can handle, so the standalone
    // switch only intercepts when no shared registration exists. We don't
    // expose the router internals; instead we keep a small registry here.
    const handled = new Set<string>([
        // commentHandlers
        'addComment',
        'resolveComment',
        // aiReviewHandlers — cross-runtime subset (round 3 + 4)
        'requestReviewGuidelines',
        'saveReviewGuidelines',
        'requestAiFindings',
        'requestAiFindingsForNode',
        'searchAiFindings',
        'updateAiFindingStatus',
        'clearFindings',
        // #547 round 4 — evidence gate now uses ctx.platform.getSetting/setSetting.
        'requestEvidenceGate',
        'setEvidenceGate',
        // #547 round 5 — full / specific review orchestrators now read
        // LLM config via ctx.platform.getSetting, so they run on both runtimes.
        'requestFullReview',
        'requestSpecificReview',
        'cancelFullReview',
        'cancelAiReview',
    ]);

    return {
        canHandle: (type: string) => handled.has(type),
        dispatch: (msg: any, clientId: string) => router.dispatch(msg, clientId),
    };
}
