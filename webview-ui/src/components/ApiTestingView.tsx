/**
 * ApiTestingView.tsx — Issue #601 Phase 1 read-only request browser.
 *
 * Top-level surface mounted at the `#/api-testing` route. Renders the
 * `ApiTestingPayload` the extension/standalone sends as `apiTestingData`.
 * No HTTP execution — Phase 1 is purely a "this is what your codebase
 * exposes" view.
 *
 * Layout:
 *   - Header — `🧪 API Testing` title + total endpoint count.
 *   - Left pane — collection tree, auto-grouped by L2a cluster
 *     (collapsible per collection).
 *   - Right pane — selected endpoint preview: method + URL + auth +
 *     middleware chain + inferred path/query/body schemas.
 *
 * Empty state: when `payload.collections === []`, a quiet placeholder
 * directs the user to run Initialize.
 */

import React, { useEffect, useMemo, useState } from 'react';
import ScriptEditor from './ScriptEditor';
import AuthTab from './AuthTab';
import WebSocketTab from './WebSocketTab';
import SseTab from './SseTab';
import { interpretFetchError } from '../lib/interpretFetchError';

export type Method = string;
export interface ApiTestingPathParam { name: string; type?: string; required?: boolean; description?: string; }
export interface ApiTestingQueryParam { name: string; type?: string; required?: boolean; description?: string; }
export interface JsonSchemaLike {
    type?: string;
    properties?: Record<string, JsonSchemaLike>;
    required?: string[];
    items?: JsonSchemaLike;
    enum?: Array<string | number | boolean | null>;
    description?: string;
    nullable?: boolean;
    format?: string;
    example?: unknown;
}
export interface ApiTestingResponseSpec {
    status: number;
    description?: string;
    schema?: JsonSchemaLike;
}
export interface ApiTestingEndpoint {
    id: string;
    method: Method;
    route: string;
    handlerName: string;
    filePath: string;
    auth?: 'required' | 'optional';
    webhook?: boolean;
    webhookProvider?: string;
    pathParams?: ApiTestingPathParam[];
    queryParams?: ApiTestingQueryParam[];
    requestSchema?: {
        kind: 'json' | 'form' | 'multipart' | 'raw';
        schema?: JsonSchemaLike;
        source: 'jsdoc' | 'zod' | 'joi' | 'yup' | 'class-validator' | 'ts-type';
    };
    responseSchema?: ApiTestingResponseSpec[];
    middlewares?: string[];
}
export interface ApiTestingCollection {
    id: string;
    label: string;
    source: 'l2a-cluster' | 'manual';
    endpoints: ApiTestingEndpoint[];
}
export interface ApiTestingPayload {
    totalEndpoints: number;
    collections: ApiTestingCollection[];
}

/**
 * Issue #602 Phase 2 — shape of a `sendRequestResult` response. The
 * server posts this after running the request via the Relay layer.
 */
export interface ApiTestingResponse {
    durationMs: number;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    truncated: boolean;
    error?: string;
}

interface ApiTestingViewProps {
    payload: ApiTestingPayload | null;
    /** Called when the user clicks the file basename — opens the source. */
    onOpenSource?: (filePath: string) => void;
    /** Phase 2 — fire a request. Receives the full args; replies arrive
     *  via the parent's message bridge as `sendRequestResult`. */
    onSendRequest?: (args: {
        requestId: string;
        method: string;
        url: string;
        headers: Record<string, string>;
        body?: string;
        env: Record<string, string>;
        bearerToken?: string;
    }) => void;
    /** Phase 2 — last response keyed by requestId. */
    responses?: Record<string, ApiTestingResponse>;
    /** Phase 3 — open the chain runner modal. */
    onOpenChainRunner?: () => void;
    /** #744 — request an LLM-generated body proposal for an endpoint. */
    onGenerateRequestBody?: (apiId: string, requestId: string) => void;
    /** #744 — proposals received from `generateRequestBodyResult`, keyed by apiId. */
    bodyProposals?: Record<string, GeneratedRequestBodyState>;
    /** #744 (2026-06-06) — request an LLM-composed chain across the
     *  current endpoint collection. The intent is an optional free-text
     *  hint ("smoke login → fetch profile"). One in-flight chain at a
     *  time, so state is a single value (not a map). */
    onGenerateChain?: (requestId: string, intent?: string) => void;
    /** #744 (2026-06-06) — latest chain proposal state. */
    chainProposal?: GeneratedChainState;
    /** #744 (2026-06-06) — request LLM-generated test cases for a single
     *  endpoint. Keyed by apiId so multiple endpoints can have parallel
     *  in-flight requests. */
    onGenerateTestCases?: (apiId: string, requestId: string) => void;
    /** #744 (2026-06-06) — latest test-case proposal per apiId. */
    testCasesProposals?: Record<string, GeneratedTestCasesState>;
    /** #745 — submit a parsed/raw spec for server-side import. */
    onImportApiCollection?: (specText: string, requestId: string) => void;
    /** #745 — latest import result state (loading / ready / error). */
    importState?: ImportApiCollectionState;
    /** #604 (2026-06-06) — fire a portable-format export. The host
     *  formats the collection JSON and replies with a download trigger. */
    onExportApiCollection?: (format: 'postman' | 'hoppscotch' | 'insomnia', requestId: string) => void;
    /** #745 (2026-06-06) — OAuth2 surface. Three callbacks (one per
     *  grant flow) + a single state bag that holds per-flow status. */
    onOAuth2ClientCredentials?: (args: import('./AuthTab').ClientCredentialsArgs) => void;
    onOAuth2BuildAuthorizationUrl?: (args: import('./AuthTab').BuildAuthorizationUrlArgs) => void;
    onOAuth2ExchangeAuthorizationCode?: (args: import('./AuthTab').ExchangeAuthorizationCodeArgs) => void;
    authTabState?: import('./AuthTab').AuthTabState;
    /** #745 (2026-06-06) — WebSocket client. */
    onWsConnect?: (args: import('./WebSocketTab').WebSocketConnectArgs) => void;
    wsTabState?: import('./WebSocketTab').WebSocketTabState;
    /** #745 (2026-06-06) — SSE client. */
    onSseConnect?: (args: import('./SseTab').SseConnectArgs) => void;
    sseTabState?: import('./SseTab').SseTabState;
}

/** #745 — local view-state for an in-flight or recently-completed
 * import request. The actual imported endpoints are merged into the
 * `payload.collections` list at the App.tsx level; this state just
 * tracks loading / success summary / error for the modal UI. */
export interface ImportApiCollectionState {
    status: 'loading' | 'ready' | 'error';
    requestId: string;
    /** Detected format on success. */
    format?: 'openapi' | 'postman' | 'insomnia' | 'unknown';
    /** Endpoint count on success (rolled up across all collections). */
    importedCount?: number;
    /** Error message on failure. */
    error?: string;
}

/** #744 — local view-state for a single generation request: either
 * loading, succeeded (with proposal), or failed (with message). */
export interface GeneratedRequestBodyState {
    status: 'loading' | 'ready' | 'error';
    requestId: string;
    /** Proposed body when status === 'ready'. */
    body?: Record<string, unknown>;
    /** Per-field evidence quotes (LLM-supplied). */
    evidence?: Record<string, string>;
    /** Number of fields dropped by the evidence gate. */
    dropped?: number;
    /** Error message when status === 'error'. */
    error?: string;
}

/** #744 (2026-06-06) — local view-state for a chain composer request.
 *  The `chain` field mirrors `GeneratedChain` from
 *  `core/apiTesting/aiTestGen/generateChain.ts`. */
export interface GeneratedChainState {
    status: 'loading' | 'ready' | 'error';
    requestId: string;
    /** Proposed chain when status === 'ready'. */
    chain?: {
        name: string;
        description?: string;
        steps: Array<{
            id: string;
            method: string;
            url: string;
            extract?: Record<string, { scope: 'json' | 'headers' | 'status'; path: string }>;
        }>;
    };
    /** Recipes dropped by the evidence gate. */
    droppedExtracts?: number;
    /** Error message when status === 'error'. */
    error?: string;
}

/** #744 (2026-06-06) — local view-state for a test-case generation
 *  request. The `cases` array mirrors `GeneratedTestCase` from
 *  `core/apiTesting/aiTestGen/generateTestCases.ts`. */
export interface GeneratedTestCasesState {
    status: 'loading' | 'ready' | 'error';
    requestId: string;
    /** Proposed cases when status === 'ready'. */
    cases?: Array<{
        name: string;
        preconditions?: string;
        request_overrides?: Record<string, unknown>;
        assertions: Array<Record<string, unknown>>;
        evidence: string[];
    }>;
    /** Number of cases the parser/evidence gate dropped. */
    dropped?: number;
    /** Error message when status === 'error'. */
    error?: string;
}

const METHOD_COLOR: Record<string, string> = {
    GET:     'var(--ca-method-get, #5eead4)',
    POST:    'var(--ca-method-post, #93c5fd)',
    PUT:     'var(--ca-method-put, #fbbf24)',
    PATCH:   'var(--ca-method-patch, #c4b5fd)',
    DELETE:  'var(--ca-method-delete, #fda4af)',
};

export default function ApiTestingView({ payload, onOpenSource, onSendRequest, responses, onOpenChainRunner, onGenerateRequestBody, bodyProposals, onGenerateChain, chainProposal, onGenerateTestCases, testCasesProposals, onImportApiCollection, importState, onExportApiCollection, onOAuth2ClientCredentials, onOAuth2BuildAuthorizationUrl, onOAuth2ExchangeAuthorizationCode, authTabState, onWsConnect, wsTabState, onSseConnect, sseTabState }: ApiTestingViewProps) {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    // Issue #602 Phase 2 — workspace-level env vars and a per-endpoint
    // bearer token. Kept local to the view in v1; persistence lands in
    // Phase 2.5 (the sqlite-backed `api-tests.db`).
    const [envText, setEnvText] = useState<string>('base=http://localhost:3000\n');
    const [bearerToken, setBearerToken] = useState<string>('');
    const [bodyDraft, setBodyDraft] = useState<string>('');
    const [headersDraft, setHeadersDraft] = useState<string>('');
    const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
    // UX-23 (2026-06-04): remember the resolved URL of the last Send so
    // the response panel can render a context-aware hint when fetch fails.
    const [lastSentUrl, setLastSentUrl] = useState<string | null>(null);
    // #745 — import modal state.
    const [importModalOpen, setImportModalOpen] = useState(false);
    const [importSpecText, setImportSpecText] = useState('');
    // #745 (2026-06-06) — Auth modal state. Mirrors the import modal
    // open/close pattern; the AuthTab component owns the form values
    // and result rendering.
    const [authModalOpen, setAuthModalOpen] = useState(false);
    // #745 (2026-06-06) — WebSocket + SSE modal state.
    const [wsModalOpen, setWsModalOpen] = useState(false);
    const [sseModalOpen, setSseModalOpen] = useState(false);
    // #604 (2026-06-06) — Export format picker open state.
    const [exportPickerOpen, setExportPickerOpen] = useState(false);

    // Close the import modal on successful import.
    useEffect(() => {
        if (importState?.status === 'ready' && importModalOpen) {
            setImportModalOpen(false);
            setImportSpecText('');
        }
    }, [importState?.status, importState?.requestId]);

    // Auto-select the first endpoint when the payload first arrives.
    useEffect(() => {
        if (!selectedId && payload?.collections?.[0]?.endpoints?.[0]) {
            setSelectedId(payload.collections[0].endpoints[0].id);
        }
    }, [payload, selectedId]);

    const selected = useMemo(() => {
        if (!payload || !selectedId) return null;
        for (const c of payload.collections) {
            for (const ep of c.endpoints) {
                if (ep.id === selectedId) return ep;
            }
        }
        return null;
    }, [payload, selectedId]);

    // Auto-fill the body draft from the selected endpoint's request
    // schema (if any). Lets the user hit Send with a sane starting body
    // without typing it from scratch.
    useEffect(() => {
        if (!selected) { setBodyDraft(''); return; }
        const skel = skeletonFromSchema(selected.requestSchema?.schema);
        setBodyDraft(skel ? JSON.stringify(skel, null, 2) : '');
        setHeadersDraft('');
    }, [selected?.id]);

    // Clear the pending state when a matching response lands.
    useEffect(() => {
        if (pendingRequestId && responses && responses[pendingRequestId]) {
            setPendingRequestId(null);
        }
    }, [pendingRequestId, responses]);

    const lastResponse = selected && responses ? responses[`req:${selected.id}`] : undefined;

    if (!payload || payload.collections.length === 0) {
        return (
            <div className="ca-api-testing" role="main" aria-label="API Testing">
                <div className="ca-api-testing-header">
                    <span className="ca-api-testing-title">🧪 API Testing</span>
                </div>
                <div className="ca-api-testing-empty">
                    <p>No endpoints detected yet.</p>
                    <p className="ca-api-testing-empty-hint">Run Initialize to scan the workspace, then come back.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="ca-api-testing" role="main" aria-label="API Testing">
            <header className="ca-api-testing-header">
                <span className="ca-api-testing-title">🧪 API Testing</span>
                <span className="ca-api-testing-count">{payload.totalEndpoints} endpoint{payload.totalEndpoints === 1 ? '' : 's'}</span>
                <span className="ca-api-testing-readonly" role="status">Phase 3 · chain runner</span>
                {onOpenChainRunner && (
                    <button
                        type="button"
                        className="ca-api-testing-send"
                        onClick={onOpenChainRunner}
                        aria-label="Open chain runner"
                    >
                        ▶ Chain Runner
                    </button>
                )}
                {/* #744 (2026-06-06) — Generate chain. Composes an
                    LLM-proposed multi-step chain from the visible
                    collection. Result lands in `chainProposal` and is
                    rendered next to the Chain Runner button so the user
                    can review + open the runner pre-populated. */}
                {onGenerateChain && (
                    <button
                        type="button"
                        className="ca-api-testing-send"
                        onClick={() => onGenerateChain(`gen-chain-${Date.now()}`)}
                        disabled={chainProposal?.status === 'loading'}
                        aria-label="Generate chain with AI"
                        title="Generate a multi-step chain proposal from these endpoints"
                        data-testid="ca-api-testing-generate-chain-btn"
                    >
                        {chainProposal?.status === 'loading' ? '⏳ Composing…' : '✨ Generate chain'}
                    </button>
                )}
                {/* #744 (2026-06-06) — Chain proposal summary. Renders
                    inline next to the action buttons when a chain has
                    been composed. Click to expand the JSON; the chain
                    runner consumes the same shape. */}
                {chainProposal?.status === 'ready' && chainProposal.chain && (
                    <details
                        className="ca-api-testing-chain-proposal"
                        data-testid="ca-api-testing-chain-proposal"
                        style={{ background: 'var(--ca-surface-hover, #1e293b)', border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 4, padding: '4px 8px', fontSize: 11 }}
                    >
                        <summary>
                            ✨ {chainProposal.chain.name} ({chainProposal.chain.steps.length} step{chainProposal.chain.steps.length === 1 ? '' : 's'})
                            {(chainProposal.droppedExtracts ?? 0) > 0 && (
                                <span style={{ marginLeft: 6, opacity: 0.7 }}>· {chainProposal.droppedExtracts} dropped</span>
                            )}
                        </summary>
                        <pre style={{ fontFamily: 'var(--ca-mono, ui-monospace, monospace)', fontSize: 10, margin: '4px 0 0 0', maxHeight: 200, overflow: 'auto' }}>
                            {JSON.stringify(chainProposal.chain, null, 2)}
                        </pre>
                    </details>
                )}
                {chainProposal?.status === 'error' && (
                    <span role="alert" data-testid="ca-api-testing-chain-error" style={{ color: 'var(--ca-error, #ef4444)', fontSize: 11 }}>
                        {chainProposal.error ?? 'Chain composition failed.'}
                    </span>
                )}
                {/* #745 — Import OpenAPI / Postman / Insomnia. */}
                {onImportApiCollection && (
                    <button
                        type="button"
                        className="ca-api-testing-send"
                        onClick={() => setImportModalOpen(true)}
                        aria-label="Import API collection"
                        data-testid="ca-api-testing-import-btn"
                    >
                        📥 Import
                    </button>
                )}
                {/* #604 (2026-06-06) — Export to Postman/Hoppscotch/Insomnia.
                    The dropdown is a tiny inline list — keeping the
                    surface light avoids another modal for a one-click
                    action. */}
                {onExportApiCollection && (
                    <div style={{ position: 'relative' }}>
                        <button
                            type="button"
                            className="ca-api-testing-send"
                            onClick={() => setExportPickerOpen(v => !v)}
                            aria-label="Export API collection"
                            aria-haspopup="menu"
                            aria-expanded={exportPickerOpen}
                            data-testid="ca-api-testing-export-btn"
                        >
                            📤 Export ▾
                        </button>
                        {exportPickerOpen && (
                            <ul
                                role="menu"
                                style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, padding: 4, listStyle: 'none', background: 'var(--ca-surface, #0f172a)', border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 4, minWidth: 160, zIndex: 50 }}
                            >
                                {(['postman', 'hoppscotch', 'insomnia'] as const).map(fmt => (
                                    <li key={fmt} role="none">
                                        <button
                                            type="button"
                                            role="menuitem"
                                            style={{ width: '100%', textAlign: 'left', padding: '6px 10px', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer' }}
                                            onClick={() => { onExportApiCollection(fmt, `export-${Date.now()}`); setExportPickerOpen(false); }}
                                            data-testid={`ca-api-testing-export-format-${fmt}`}
                                        >
                                            {fmt === 'postman' ? '📮 Postman v2.1' : fmt === 'hoppscotch' ? '🦊 Hoppscotch v1' : '🛏 Insomnia v4'}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
                {/* #745 (2026-06-06) — OAuth2 surface. Opens a modal
                    hosting <AuthTab> with the 3 grant forms. */}
                {onOAuth2ClientCredentials && onOAuth2BuildAuthorizationUrl && onOAuth2ExchangeAuthorizationCode && (
                    <button
                        type="button"
                        className="ca-api-testing-send"
                        onClick={() => setAuthModalOpen(true)}
                        aria-label="Open OAuth2"
                        data-testid="ca-api-testing-auth-btn"
                    >
                        🔐 Auth
                    </button>
                )}
                {/* #745 (2026-06-06) — WebSocket client. */}
                {onWsConnect && (
                    <button
                        type="button"
                        className="ca-api-testing-send"
                        onClick={() => setWsModalOpen(true)}
                        aria-label="Open WebSocket"
                        data-testid="ca-api-testing-ws-btn"
                    >
                        🌐 WS
                    </button>
                )}
                {/* #745 (2026-06-06) — SSE client. */}
                {onSseConnect && (
                    <button
                        type="button"
                        className="ca-api-testing-send"
                        onClick={() => setSseModalOpen(true)}
                        aria-label="Open SSE"
                        data-testid="ca-api-testing-sse-btn"
                    >
                        📡 SSE
                    </button>
                )}
            </header>
            <div className="ca-api-testing-body">
                <aside className="ca-api-testing-tree" aria-label="Collections">
                    {payload.collections.map(collection => (
                        <section key={collection.id} className="ca-api-testing-collection">
                            <button
                                type="button"
                                className="ca-api-testing-collection-header"
                                onClick={() => setCollapsed(prev => ({ ...prev, [collection.id]: !prev[collection.id] }))}
                                aria-expanded={!collapsed[collection.id]}
                            >
                                <span className="ca-api-testing-collection-toggle" aria-hidden="true">
                                    {collapsed[collection.id] ? '▸' : '▾'}
                                </span>
                                <span className="ca-api-testing-collection-label">{collection.label}</span>
                                <span className="ca-api-testing-collection-count">
                                    {collection.endpoints.length}
                                </span>
                            </button>
                            {!collapsed[collection.id] && (
                                <ul className="ca-api-testing-endpoints" role="listbox" aria-label={`${collection.label} endpoints`}>
                                    {collection.endpoints.map(ep => (
                                        <li key={ep.id}>
                                            <button
                                                type="button"
                                                className={`ca-api-testing-endpoint${selectedId === ep.id ? ' selected' : ''}`}
                                                onClick={() => setSelectedId(ep.id)}
                                                role="option"
                                                aria-selected={selectedId === ep.id}
                                                title={`${ep.method} ${ep.route}`}
                                            >
                                                <span
                                                    className="ca-api-testing-method"
                                                    style={{ background: METHOD_COLOR[ep.method] ?? 'var(--ca-surface-hover)' }}
                                                >
                                                    {ep.method}
                                                </span>
                                                <span className="ca-api-testing-route">{ep.route}</span>
                                                {ep.auth === 'required' && (
                                                    <span className="ca-api-testing-auth" title="Auth required" aria-label="Auth required">🔒</span>
                                                )}
                                                {ep.webhook && (
                                                    <span className="ca-api-testing-webhook" title={`Webhook${ep.webhookProvider ? `: ${ep.webhookProvider}` : ''}`} aria-label="Webhook">⚡</span>
                                                )}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    ))}
                </aside>
                <section className="ca-api-testing-preview" aria-label="Endpoint preview">
                    {selected ? (
                        <EndpointPreview
                            endpoint={selected}
                            onOpenSource={onOpenSource}
                            envText={envText}
                            onEnvTextChange={setEnvText}
                            bearerToken={bearerToken}
                            onBearerTokenChange={setBearerToken}
                            bodyDraft={bodyDraft}
                            onBodyDraftChange={setBodyDraft}
                            headersDraft={headersDraft}
                            onHeadersDraftChange={setHeadersDraft}
                            onSend={() => {
                                if (!onSendRequest) return;
                                const env = parseEnvLinesLocal(envText);
                                const headers = parseHeaderLinesLocal(headersDraft);
                                const requestId = `req:${selected.id}`;
                                const resolvedUrl = resolveTemplateUrl(selected.route, env);
                                setPendingRequestId(requestId);
                                setLastSentUrl(resolvedUrl);
                                onSendRequest({
                                    requestId,
                                    method: selected.method,
                                    url: resolvedUrl,
                                    headers,
                                    body: methodCanHaveBody(selected.method) && bodyDraft ? bodyDraft : undefined,
                                    env,
                                    bearerToken: bearerToken || undefined,
                                });
                            }}
                            sending={pendingRequestId === `req:${selected.id}`}
                            response={lastResponse}
                            lastSentUrl={lastSentUrl}
                            onGenerateRequestBody={onGenerateRequestBody}
                            bodyProposal={bodyProposals?.[selected.id]}
                            onGenerateTestCases={onGenerateTestCases}
                            testCasesProposal={testCasesProposals?.[selected.id]}
                        />
                    ) : (
                        <div className="ca-api-testing-empty-pane">Select an endpoint to preview it.</div>
                    )}
                </section>
            </div>
            {/* #745 — Import modal. Lets the user paste an OpenAPI 3.x /
                Swagger 2.0 / Postman v2.1 / Insomnia v4 spec and merge
                it into the current collection list. Server parses + the
                parent component (App.tsx) splices the result into payload. */}
            {importModalOpen && onImportApiCollection && (
                <div
                    className="ca-api-testing-import-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Import API collection"
                    data-testid="ca-api-testing-import-modal"
                    style={{
                        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
                    }}
                >
                    <div
                        style={{
                            background: 'var(--ca-surface, #1f2937)', color: 'var(--ca-text, #e2e8f0)',
                            padding: 16, borderRadius: 6, width: 'min(640px, 92vw)', maxHeight: '80vh',
                            display: 'flex', flexDirection: 'column', gap: 8,
                        }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <strong>📥 Import API collection</strong>
                            <button
                                type="button"
                                onClick={() => { setImportModalOpen(false); setImportSpecText(''); }}
                                aria-label="Close import dialog"
                                data-testid="ca-api-testing-import-cancel"
                            >
                                ✕
                            </button>
                        </div>
                        <p style={{ margin: 0, fontSize: 12, opacity: 0.75 }}>
                            Paste an OpenAPI 3.x / Swagger 2.0 / Postman v2.1 / Insomnia v4 JSON spec. The server auto-detects the format and merges the endpoints into the current collection list.
                        </p>
                        <textarea
                            className="ca-api-testing-textarea"
                            value={importSpecText}
                            onChange={(e) => setImportSpecText(e.target.value)}
                            placeholder='{"openapi": "3.0.0", "paths": {...}}'
                            spellCheck={false}
                            data-testid="ca-api-testing-import-spec"
                            aria-label="API spec JSON"
                            rows={14}
                            style={{ fontFamily: 'var(--ca-mono, ui-monospace, monospace)', fontSize: 11 }}
                        />
                        {importState?.status === 'error' && (
                            <div
                                role="alert"
                                data-testid="ca-api-testing-import-error"
                                style={{ color: 'var(--ca-error, #ef4444)', fontSize: 12 }}
                            >
                                {importState.error ?? 'Import failed.'}
                            </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                            <button
                                type="button"
                                onClick={() => { setImportModalOpen(false); setImportSpecText(''); }}
                                data-testid="ca-api-testing-import-cancel-btn"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    if (!importSpecText.trim()) return;
                                    onImportApiCollection(importSpecText, `import-${Date.now()}`);
                                }}
                                disabled={!importSpecText.trim() || importState?.status === 'loading'}
                                data-testid="ca-api-testing-import-submit"
                            >
                                {importState?.status === 'loading' ? '⏳ Importing…' : 'Import'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* #745 (2026-06-06) — OAuth2 modal. Hosts the AuthTab
                component which carries the 3 grant forms. Dismiss on
                background click or explicit Close. */}
            {authModalOpen && onOAuth2ClientCredentials && onOAuth2BuildAuthorizationUrl && onOAuth2ExchangeAuthorizationCode && (
                <div
                    className="ca-api-testing-modal-backdrop"
                    role="dialog"
                    aria-modal="true"
                    aria-label="OAuth2"
                    data-testid="ca-api-testing-auth-modal"
                    onClick={(e) => { if (e.target === e.currentTarget) setAuthModalOpen(false); }}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
                >
                    <div
                        className="ca-api-testing-modal"
                        style={{ background: 'var(--ca-surface, #0f172a)', border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 6, padding: 16, maxWidth: 560, width: '90%', maxHeight: '85vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <strong>🔐 OAuth2</strong>
                            <button
                                type="button"
                                onClick={() => setAuthModalOpen(false)}
                                aria-label="Close OAuth2"
                                data-testid="ca-api-testing-auth-close"
                            >
                                ✕
                            </button>
                        </div>
                        <AuthTab
                            state={authTabState}
                            onClientCredentials={onOAuth2ClientCredentials}
                            onBuildAuthorizationUrl={onOAuth2BuildAuthorizationUrl}
                            onExchangeAuthorizationCode={onOAuth2ExchangeAuthorizationCode}
                        />
                    </div>
                </div>
            )}

            {/* #745 (2026-06-06) — WebSocket modal. */}
            {wsModalOpen && onWsConnect && (
                <div
                    className="ca-api-testing-modal-backdrop"
                    role="dialog"
                    aria-modal="true"
                    aria-label="WebSocket"
                    data-testid="ca-api-testing-ws-modal"
                    onClick={(e) => { if (e.target === e.currentTarget) setWsModalOpen(false); }}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
                >
                    <div className="ca-api-testing-modal" style={{ background: 'var(--ca-surface, #0f172a)', border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 6, padding: 16, maxWidth: 560, width: '90%', maxHeight: '85vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <strong>🌐 WebSocket</strong>
                            <button type="button" onClick={() => setWsModalOpen(false)} aria-label="Close WebSocket" data-testid="ca-api-testing-ws-close">✕</button>
                        </div>
                        <WebSocketTab state={wsTabState} onConnect={onWsConnect} />
                    </div>
                </div>
            )}

            {/* #745 (2026-06-06) — SSE modal. */}
            {sseModalOpen && onSseConnect && (
                <div
                    className="ca-api-testing-modal-backdrop"
                    role="dialog"
                    aria-modal="true"
                    aria-label="SSE"
                    data-testid="ca-api-testing-sse-modal"
                    onClick={(e) => { if (e.target === e.currentTarget) setSseModalOpen(false); }}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
                >
                    <div className="ca-api-testing-modal" style={{ background: 'var(--ca-surface, #0f172a)', border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 6, padding: 16, maxWidth: 560, width: '90%', maxHeight: '85vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <strong>📡 Server-Sent Events</strong>
                            <button type="button" onClick={() => setSseModalOpen(false)} aria-label="Close SSE" data-testid="ca-api-testing-sse-close">✕</button>
                        </div>
                        <SseTab state={sseTabState} onConnect={onSseConnect} />
                    </div>
                </div>
            )}
        </div>
    );
}

interface EndpointPreviewProps {
    endpoint: ApiTestingEndpoint;
    onOpenSource?: (filePath: string) => void;
    envText: string;
    onEnvTextChange: (s: string) => void;
    bearerToken: string;
    onBearerTokenChange: (s: string) => void;
    bodyDraft: string;
    onBodyDraftChange: (s: string) => void;
    headersDraft: string;
    onHeadersDraftChange: (s: string) => void;
    onSend: () => void;
    sending: boolean;
    response?: ApiTestingResponse;
    /** UX-23: most-recent resolved URL passed through so the response
     *  panel can render context-aware "is your server running?" hints. */
    lastSentUrl?: string | null;
    /** #744 — kick off an LLM-driven body proposal for this endpoint. */
    onGenerateRequestBody?: (apiId: string, requestId: string) => void;
    /** #744 — view-state for the in-flight / latest proposal for this endpoint. */
    bodyProposal?: GeneratedRequestBodyState;
    /** #744 (2026-06-06) — kick off an LLM test-case proposal. */
    onGenerateTestCases?: (apiId: string, requestId: string) => void;
    /** #744 (2026-06-06) — latest test-case proposal for this endpoint. */
    testCasesProposal?: GeneratedTestCasesState;
}

function EndpointPreview({
    endpoint, onOpenSource,
    envText, onEnvTextChange,
    bearerToken, onBearerTokenChange,
    bodyDraft, onBodyDraftChange,
    headersDraft, onHeadersDraftChange,
    onSend, sending, response, lastSentUrl,
    onGenerateRequestBody, bodyProposal,
    onGenerateTestCases, testCasesProposal,
}: EndpointPreviewProps) {
    const fileBasename = endpoint.filePath.split('/').pop() ?? endpoint.filePath;
    return (
        <div className="ca-api-testing-preview-body">
            <div className="ca-api-testing-preview-headline">
                <span
                    className="ca-api-testing-method"
                    style={{ background: METHOD_COLOR[endpoint.method] ?? 'var(--ca-surface-hover)' }}
                >
                    {endpoint.method}
                </span>
                <code className="ca-api-testing-url">{endpoint.route}</code>
                <button
                    type="button"
                    className="ca-api-testing-send"
                    onClick={onSend}
                    disabled={sending}
                    aria-label="Send request"
                    title="Send request"
                >
                    {sending ? 'Sending…' : '▶ Send'}
                </button>
            </div>
            <div className="ca-api-testing-handler">
                <span className="ca-api-testing-handler-label">Handler</span>
                <code>{endpoint.handlerName}</code>
                <button
                    type="button"
                    className="ca-api-testing-file"
                    onClick={() => onOpenSource?.(endpoint.filePath)}
                    title={endpoint.filePath}
                >
                    {fileBasename}
                </button>
            </div>
            {endpoint.middlewares && endpoint.middlewares.length > 0 && (
                <div className="ca-api-testing-section">
                    <h4>Middleware</h4>
                    <ul className="ca-api-testing-middlewares">
                        {endpoint.middlewares.map(mw => (<li key={mw}><code>{mw}</code></li>))}
                    </ul>
                </div>
            )}
            {endpoint.pathParams && endpoint.pathParams.length > 0 && (
                <ParamTable title="Path params" params={endpoint.pathParams} />
            )}
            {endpoint.queryParams && endpoint.queryParams.length > 0 && (
                <ParamTable title="Query params" params={endpoint.queryParams} />
            )}
            {endpoint.requestSchema?.schema && (
                <div className="ca-api-testing-section">
                    <h4>
                        Request body
                        <span className="ca-api-testing-source-chip">{endpoint.requestSchema.source}</span>
                    </h4>
                    <SchemaTable schema={endpoint.requestSchema.schema} />
                </div>
            )}
            {endpoint.responseSchema && endpoint.responseSchema.length > 0 && (
                <div className="ca-api-testing-section">
                    <h4>Responses (inferred)</h4>
                    <ul className="ca-api-testing-responses">
                        {endpoint.responseSchema.map(r => (
                            <li key={r.status}>
                                <span className="ca-api-testing-status">{r.status}</span>
                                {r.description && <span className="ca-api-testing-resp-desc">{r.description}</span>}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* Issue #602 Phase 2 — Send controls live in a single
                expandable "Try it" panel under the schema info. */}
            <div className="ca-api-testing-section ca-api-testing-trypanel">
                <h4>Try it</h4>
                <details className="ca-api-testing-details" open>
                    <summary>Environment variables (one per line, <code>key=value</code>)</summary>
                    <textarea
                        className="ca-api-testing-textarea"
                        rows={3}
                        value={envText}
                        onChange={(e) => onEnvTextChange(e.target.value)}
                        spellCheck={false}
                        aria-label="Environment variables"
                    />
                </details>
                <details className="ca-api-testing-details">
                    <summary>Bearer token (Authorization: Bearer …)</summary>
                    <input
                        className="ca-api-testing-input"
                        type="password"
                        value={bearerToken}
                        onChange={(e) => onBearerTokenChange(e.target.value)}
                        placeholder="paste token or {{token}}"
                        spellCheck={false}
                        aria-label="Bearer token"
                    />
                </details>
                <details className="ca-api-testing-details">
                    <summary>Extra headers (one per line, <code>Name: value</code>)</summary>
                    <textarea
                        className="ca-api-testing-textarea"
                        rows={2}
                        value={headersDraft}
                        onChange={(e) => onHeadersDraftChange(e.target.value)}
                        placeholder="X-Trace: 123"
                        spellCheck={false}
                        aria-label="Request headers"
                    />
                </details>
                {/* #744 (2026-06-06) — Generate test cases. Evidence-
                    gated `generateTestCases` backend; on success, the
                    proposal panel below renders one row per case with
                    name, evidence, and the assertions JSON. */}
                {onGenerateTestCases && (
                    <details className="ca-api-testing-details" open={!!testCasesProposal && testCasesProposal.status !== 'loading'}>
                        <summary>Test cases (AI-generated)</summary>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                            <button
                                type="button"
                                className="ca-api-testing-generate-btn"
                                onClick={() => onGenerateTestCases(endpoint.id, `gen-tests-${endpoint.id}-${Date.now()}`)}
                                disabled={testCasesProposal?.status === 'loading'}
                                aria-label="Generate test cases with AI"
                                title="Generate evidence-gated test cases from this handler's source"
                                data-testid="ca-generate-test-cases-btn"
                            >
                                {testCasesProposal?.status === 'loading' ? '⏳ Generating…' : '✨ Generate test cases'}
                            </button>
                            {testCasesProposal?.status === 'error' && (
                                <span role="alert" data-testid="ca-generate-test-cases-error" style={{ color: 'var(--ca-error, #ef4444)', fontSize: 11 }}>
                                    {testCasesProposal.error ?? 'Failed to generate cases.'}
                                </span>
                            )}
                        </div>
                        {testCasesProposal?.status === 'ready' && testCasesProposal.cases && testCasesProposal.cases.length > 0 && (
                            <div data-testid="ca-generate-test-cases-proposal" role="region" aria-label="Generated test cases" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {(testCasesProposal.dropped ?? 0) > 0 && (
                                    <div style={{ fontSize: 11, opacity: 0.7 }}>
                                        Evidence gate dropped {testCasesProposal.dropped} case{testCasesProposal.dropped === 1 ? '' : 's'}.
                                    </div>
                                )}
                                {testCasesProposal.cases.map((c, i) => (
                                    <div key={i} style={{ border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 4, padding: 6 }}>
                                        <div style={{ fontWeight: 600, fontSize: 12 }}>{c.name}</div>
                                        {c.preconditions && (
                                            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>Pre: {c.preconditions}</div>
                                        )}
                                        {c.evidence && c.evidence.length > 0 && (
                                            <details style={{ marginTop: 4 }}>
                                                <summary style={{ fontSize: 11, opacity: 0.75 }}>Evidence ({c.evidence.length})</summary>
                                                <ul style={{ margin: '4px 0 0 12px', padding: 0, fontSize: 11, fontFamily: 'var(--ca-mono, ui-monospace, monospace)' }}>
                                                    {c.evidence.map((line, ix) => (
                                                        <li key={ix} style={{ opacity: 0.8 }}>{line}</li>
                                                    ))}
                                                </ul>
                                            </details>
                                        )}
                                        <details style={{ marginTop: 4 }}>
                                            <summary style={{ fontSize: 11, opacity: 0.75 }}>Assertions ({c.assertions?.length ?? 0})</summary>
                                            <pre style={{ fontSize: 11, fontFamily: 'var(--ca-mono, ui-monospace, monospace)', margin: '4px 0 0 0' }}>
                                                {JSON.stringify(c.assertions, null, 2)}
                                            </pre>
                                        </details>
                                    </div>
                                ))}
                            </div>
                        )}
                    </details>
                )}
                {methodCanHaveBody(endpoint.method) && (
                    <details className="ca-api-testing-details" open={!!bodyDraft}>
                        <summary>Request body</summary>
                        {/* #744 — ✨ Generate body. Calls the
                            evidence-gated `generateRequestBody`
                            backend; on success, the proposal panel
                            below renders Apply / Cancel. */}
                        {onGenerateRequestBody && (
                            <div className="ca-api-testing-generate-row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                                <button
                                    type="button"
                                    className="ca-api-testing-generate-btn"
                                    onClick={() => onGenerateRequestBody(endpoint.id, `gen-body-${endpoint.id}-${Date.now()}`)}
                                    disabled={bodyProposal?.status === 'loading'}
                                    aria-label="Generate request body with AI"
                                    title="Generate request body with AI (evidence-gated)"
                                    data-testid="ca-generate-body-btn"
                                >
                                    {bodyProposal?.status === 'loading' ? '⏳ Generating…' : '✨ Generate body'}
                                </button>
                                {bodyProposal?.status === 'error' && (
                                    <span
                                        className="ca-api-testing-generate-error"
                                        role="alert"
                                        data-testid="ca-generate-body-error"
                                        style={{ color: 'var(--ca-error, #ef4444)', fontSize: 11 }}
                                    >
                                        {bodyProposal.error ?? 'Failed to generate body.'}
                                    </span>
                                )}
                            </div>
                        )}
                        {bodyProposal?.status === 'ready' && bodyProposal.body && (
                            <div
                                className="ca-api-testing-generate-proposal"
                                data-testid="ca-generate-body-proposal"
                                role="region"
                                aria-label="Generated body proposal"
                                style={{ border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 4, padding: 8, marginBottom: 6 }}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                    <strong style={{ fontSize: 12 }}>
                                        ✨ Proposal
                                        {typeof bodyProposal.dropped === 'number' && bodyProposal.dropped > 0 && (
                                            <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.75 }}>
                                                ({bodyProposal.dropped} field{bodyProposal.dropped === 1 ? '' : 's'} dropped — no evidence)
                                            </span>
                                        )}
                                    </strong>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <button
                                            type="button"
                                            className="ca-api-testing-generate-apply"
                                            data-testid="ca-generate-body-apply"
                                            onClick={() => onBodyDraftChange(JSON.stringify(bodyProposal.body, null, 2))}
                                        >
                                            Apply
                                        </button>
                                    </div>
                                </div>
                                <pre className="ca-api-testing-generate-preview" style={{ margin: 0, fontSize: 11, maxHeight: 160, overflow: 'auto' }}>
                                    {JSON.stringify(bodyProposal.body, null, 2)}
                                </pre>
                                {bodyProposal.evidence && Object.keys(bodyProposal.evidence).length > 0 && (
                                    <details style={{ marginTop: 6 }}>
                                        <summary style={{ fontSize: 11, cursor: 'pointer' }}>Evidence ({Object.keys(bodyProposal.evidence).length} field{Object.keys(bodyProposal.evidence).length === 1 ? '' : 's'})</summary>
                                        <ul style={{ margin: '4px 0 0 16px', padding: 0, fontSize: 11 }}>
                                            {Object.entries(bodyProposal.evidence).map(([field, ev]) => (
                                                <li key={field} style={{ marginBottom: 2 }}>
                                                    <code>{field}</code>: <code style={{ opacity: 0.75 }}>{ev}</code>
                                                </li>
                                            ))}
                                        </ul>
                                    </details>
                                )}
                            </div>
                        )}
                        {/* Issue #603 Phase 3.6 — Monaco editor when
                            `@monaco-editor/react` is installed in
                            webview-ui, plain textarea otherwise. */}
                        <ScriptEditor
                            value={bodyDraft}
                            onChange={onBodyDraftChange}
                            language="json"
                            placeholder='{"key":"value"}'
                            height="180px"
                            aria-label="Request body"
                        />
                    </details>
                )}
            </div>

            {response && <ResponseViewer response={response} requestUrl={lastSentUrl ?? undefined} />}
        </div>
    );
}

function ResponseViewer({ response, requestUrl }: { response: ApiTestingResponse; requestUrl?: string }) {
    const ok = response.status >= 200 && response.status < 300;
    // UX-23 (2026-06-04): when the request failed at the network layer,
    // translate the bare browser error into an actionable hint
    // ("Is your API server running?" / "Couldn't resolve …" / etc.).
    const errorHint = response.error ? interpretFetchError(response.error, requestUrl) : null;
    return (
        <section className="ca-api-testing-section ca-api-testing-response" aria-label="Response">
            <h4>
                Response
                <span className={`ca-api-testing-status${ok ? ' ok' : ' bad'}`}>
                    {response.status > 0 ? `${response.status} ${response.statusText}` : 'failed'}
                </span>
                {response.durationMs > 0 && <span className="ca-api-testing-meta-chip">{response.durationMs} ms</span>}
                {response.truncated && <span className="ca-api-testing-meta-chip">truncated</span>}
            </h4>
            {response.error && (
                <div className="ca-api-testing-response-error">
                    {errorHint && (
                        <div data-testid="ca-fetch-error-hint" style={{ marginBottom: 6 }}>
                            <div style={{ fontWeight: 600, color: 'var(--ca-warning, #d97706)' }}>
                                💡 {errorHint.headline}
                            </div>
                            {errorHint.suggestion && (
                                <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                                    {errorHint.suggestion}
                                </div>
                            )}
                        </div>
                    )}
                    <div style={{ fontFamily: 'var(--ca-mono, ui-monospace, monospace)', fontSize: 11, opacity: 0.85 }}>
                        {response.error}
                    </div>
                </div>
            )}
            {Object.keys(response.headers).length > 0 && (
                <details className="ca-api-testing-details">
                    <summary>Headers ({Object.keys(response.headers).length})</summary>
                    <pre className="ca-api-testing-response-pre">
                        {Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}
                    </pre>
                </details>
            )}
            <details className="ca-api-testing-details" open>
                <summary>Body</summary>
                <pre className="ca-api-testing-response-pre">{prettyBody(response.headers, response.body)}</pre>
            </details>
        </section>
    );
}

function ParamTable({ title, params }: { title: string; params: ApiTestingPathParam[] }) {
    return (
        <div className="ca-api-testing-section">
            <h4>{title}</h4>
            <table className="ca-api-testing-params">
                <thead>
                    <tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr>
                </thead>
                <tbody>
                    {params.map(p => (
                        <tr key={p.name}>
                            <td><code>{p.name}</code></td>
                            <td>{p.type ?? '—'}</td>
                            <td>{p.required ? 'yes' : 'no'}</td>
                            <td>{p.description ?? ''}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function SchemaTable({ schema }: { schema: JsonSchemaLike }) {
    if (schema.type !== 'object' || !schema.properties) {
        return <code className="ca-api-testing-schema-raw">{describeType(schema)}</code>;
    }
    const required = new Set(schema.required ?? []);
    return (
        <table className="ca-api-testing-params">
            <thead>
                <tr><th>Field</th><th>Type</th><th>Required</th><th>Notes</th></tr>
            </thead>
            <tbody>
                {Object.entries(schema.properties).map(([name, prop]) => (
                    <tr key={name}>
                        <td><code>{name}</code></td>
                        <td>{describeType(prop)}</td>
                        <td>{required.has(name) ? 'yes' : 'no'}</td>
                        <td>
                            {prop.description ?? ''}
                            {prop.format ? <span className="ca-api-testing-meta-chip">{prop.format}</span> : null}
                            {prop.example !== undefined ? <span className="ca-api-testing-meta-chip">e.g. {JSON.stringify(prop.example)}</span> : null}
                        </td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function describeType(schema: JsonSchemaLike): string {
    if (!schema) return '—';
    if (schema.enum) return `enum (${schema.enum.length})`;
    if (schema.type === 'array') return `array<${schema.items ? describeType(schema.items) : 'any'}>`;
    if (schema.type === 'object') return 'object';
    if (schema.type) return schema.type;
    return '—';
}

// ─── Phase 2 (#602) helpers ──────────────────────────────────────────

function methodCanHaveBody(method: string): boolean {
    const m = method.toUpperCase();
    return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}

/** Minimal env-line parser — mirrors `src/core/apiTesting/env.ts` so
 *  the webview can resolve `{{var}}` references locally before sending. */
function parseEnvLinesLocal(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!text) return out;
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const key = t.slice(0, eq).trim();
        if (!/^[A-Za-z_$][\w$.-]*$/.test(key)) continue;
        out[key] = t.slice(eq + 1).trim();
    }
    return out;
}

/** Parse `Name: value` lines into a header map. */
function parseHeaderLinesLocal(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!text) return out;
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const colon = t.indexOf(':');
        if (colon < 0) continue;
        const key = t.slice(0, colon).trim();
        const value = t.slice(colon + 1).trim();
        if (key) out[key] = value;
    }
    return out;
}

/** Resolve `{{var}}` in a template URL. Mirrors the server-side
 *  substitution so the user sees what URL the relay will hit. */
function resolveTemplateUrl(route: string, env: Record<string, string>): string {
    let url = route;
    // 1. If the user defines `base=…`, prepend when route is relative.
    if (env.base && !/^https?:\/\//i.test(url)) {
        const sep = url.startsWith('/') ? '' : '/';
        url = `${env.base}${sep}${url}`;
    }
    // 2. Run the `{{var}}` substitution (up to 5 iterations).
    for (let i = 0; i < 5; i++) {
        const next = url.replace(/\{\{\s*([A-Za-z_$][\w$.-]*)\s*\}\}/g, (full, name) => env[name] ?? full);
        if (next === url) break;
        url = next;
    }
    return url;
}

/** Best-effort JSON pretty-print + binary placeholder pass-through. */
function prettyBody(headers: Record<string, string>, body: string): string {
    const ct = (headers['content-type'] ?? '').toLowerCase();
    if (ct.includes('json')) {
        try { return JSON.stringify(JSON.parse(body), null, 2); }
        catch { return body; }
    }
    return body;
}

/** Build a skeleton JSON object from a `JsonSchemaLike`. Used to seed
 *  the request-body textarea on endpoint selection. Returns `null` for
 *  non-object schemas (where there's no meaningful skeleton). */
function skeletonFromSchema(schema?: JsonSchemaLike): unknown {
    if (!schema || schema.type !== 'object' || !schema.properties) return null;
    const out: Record<string, unknown> = {};
    const required = new Set(schema.required ?? []);
    for (const [name, prop] of Object.entries(schema.properties)) {
        if (!required.has(name)) continue;
        out[name] = primitiveSkeleton(prop);
    }
    return out;
}

function primitiveSkeleton(s: JsonSchemaLike): unknown {
    if (s.example !== undefined) return s.example;
    if (s.enum && s.enum.length > 0) return s.enum[0];
    if (s.type === 'string') return '';
    if (s.type === 'number' || s.type === 'integer') return 0;
    if (s.type === 'boolean') return false;
    if (s.type === 'array') return [];
    if (s.type === 'object') return skeletonFromSchema(s) ?? {};
    return '';
}
