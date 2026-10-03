/**
 * apiTesting/relay/index.ts — Issue #602 Phase 2 transport indirection.
 *
 * The "Relay" is the layer that actually performs an HTTP request on
 * the user's behalf. Two transports exist:
 *
 *   - `extensionHost` — fires from the extension host (or the
 *                       standalone server). The webview never opens
 *                       a socket; instead it sends a `sendRequest`
 *                       postMessage and waits for the response. This
 *                       sidesteps CORS / cookie scope problems that
 *                       direct-from-webview fetches hit.
 *
 *   - `localhostDirect` — direct `fetch()` from inside the browser
 *                       tab. Used only when the user explicitly
 *                       enables it (Phase 4) for testing CORS-aware
 *                       endpoints.
 *
 * Phase 2 ships only the extension-host transport — `executeRequest`
 * below uses Node's global `fetch` (available in Node 18+). Phase 4
 * adds the direct transport. The webview is transport-agnostic — it
 * speaks one shape against `sendRequest` and gets back one shape.
 */

import { applyEnvVars, applyEnvToRecord } from '../env';
import { assertRequestAllowed } from '../hostGuard';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB cap to keep the response sane.
const DEFAULT_TIMEOUT_MS = 30_000;

export interface SendRequestArgs {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    env?: Record<string, string>;
    /** Optional Bearer token — appended as `Authorization: Bearer <token>`
     *  unless `headers.Authorization` is already set. */
    bearerToken?: string;
    /** Optional API-key header value — paired with `apiKeyHeader` name. */
    apiKey?: string;
    apiKeyHeader?: string;
    /** Request timeout in ms. Defaults to 30s; capped at 60s to prevent
     *  the executor pinning a worker indefinitely. */
    timeoutMs?: number;
    /** Issue #604 — GraphQL helper. When set, the relay treats this as
     *  a GraphQL POST: method forced to `POST`, body shaped to
     *  `{ query, variables, operationName }`, `Content-Type` defaulted
     *  to `application/json`. Skip when not a GraphQL endpoint. */
    graphql?: {
        query: string;
        variables?: Record<string, unknown>;
        operationName?: string;
    };
    /** #887 — allow loopback + private hosts (NOT metadata/link-local). True for
     *  the user-initiated workbench Send path; false (default) for agent-invokable
     *  MCP tools, so an injected agent can't drive the server at internal hosts. */
    allowPrivateHosts?: boolean;
}

export interface SendRequestResponse {
    /** Wall-clock duration in ms (parse + network + read). */
    durationMs: number;
    /** HTTP status code, or 0 when the request never completed. */
    status: number;
    statusText: string;
    headers: Record<string, string>;
    /** Best-effort decoded body — UTF-8 text when the response was textual,
     *  otherwise a `[Binary <bytes> bytes]` placeholder. */
    body: string;
    /** Whether the body was truncated to fit `MAX_BODY_BYTES`. */
    truncated: boolean;
    /** Non-null when the executor caught an error before the response
     *  was complete (DNS failure, timeout, abort). */
    error?: string;
}

/**
 * Resolve env vars + auth, fire the request, materialise the
 * response. Pure-Node — no VS Code or DOM dependencies.
 */
export async function executeRequest(args: SendRequestArgs): Promise<SendRequestResponse> {
    const env = args.env ?? {};
    const url = applyEnvVars(String(args.url ?? ''), env);
    if (!/^https?:\/\//i.test(url)) {
        return errResponse('URL must be absolute (http:// or https://)');
    }
    // #887 — SSRF guard: reject cloud-metadata / link-local always, and
    // loopback/private unless the caller opted in (workbench Send path).
    const guard = await assertRequestAllowed(url, { allowPrivate: args.allowPrivateHosts });
    if (!guard.ok) {
        return errResponse(`Request refused — ${guard.reason}`);
    }

    const headers: Record<string, string> = applyEnvToRecord(args.headers ?? {}, env);

    // Issue #604 — GraphQL convenience. Build the canonical POST body
    // before the regular body/content-type path runs.
    let effectiveMethod = args.method;
    let effectiveBody = args.body;
    if (args.graphql && typeof args.graphql.query === 'string') {
        effectiveMethod = 'POST';
        const payload: Record<string, unknown> = { query: applyEnvVars(args.graphql.query, env) };
        if (args.graphql.variables) payload.variables = args.graphql.variables;
        if (args.graphql.operationName) payload.operationName = args.graphql.operationName;
        effectiveBody = JSON.stringify(payload);
        if (!headerKeyPresent(headers, 'Content-Type')) {
            headers['Content-Type'] = 'application/json';
        }
    }

    // Auth precedence: existing Authorization > Bearer > API-key. The
    // intent: the user's explicit header always wins over the convenience
    // fields, so we never silently overwrite what they typed.
    if (args.bearerToken && !headerKeyPresent(headers, 'Authorization')) {
        headers['Authorization'] = `Bearer ${applyEnvVars(args.bearerToken, env)}`;
    }
    if (args.apiKey && args.apiKeyHeader && !headerKeyPresent(headers, args.apiKeyHeader)) {
        headers[args.apiKeyHeader] = applyEnvVars(args.apiKey, env);
    }

    const body = effectiveBody
        ? (args.graphql ? effectiveBody : applyEnvVars(effectiveBody, env))
        : undefined;
    if (body && !headerKeyPresent(headers, 'Content-Type')) {
        // Best-effort default — JSON if it parses, else text/plain.
        try {
            JSON.parse(body);
            headers['Content-Type'] = 'application/json';
        } catch {
            headers['Content-Type'] = 'text/plain';
        }
    }

    const timeoutMs = Math.min(60_000, Math.max(1_000, args.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const startedAt = Date.now();
    try {
        const method = String(effectiveMethod ?? 'GET').toUpperCase();
        const res = await fetch(url, {
            method,
            headers,
            body: methodCanHaveBody(method) ? body : undefined,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const responseHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
            responseHeaders[k] = v;
        });
        const ct = (responseHeaders['content-type'] ?? '').toLowerCase();
        const textual = ct.startsWith('text/')
            || ct.includes('json')
            || ct.includes('xml')
            || ct.includes('javascript')
            || ct.includes('html')
            || ct === ''; // unknown → assume text
        let bodyText = '';
        let truncated = false;
        if (textual) {
            const raw = await res.text();
            if (raw.length > MAX_BODY_BYTES) {
                bodyText = raw.slice(0, MAX_BODY_BYTES);
                truncated = true;
            } else {
                bodyText = raw;
            }
        } else {
            const bytes = await res.arrayBuffer();
            bodyText = `[Binary ${bytes.byteLength} bytes — content-type: ${ct}]`;
        }

        return {
            durationMs: Date.now() - startedAt,
            status: res.status,
            statusText: res.statusText,
            headers: responseHeaders,
            body: bodyText,
            truncated,
        };
    } catch (err: any) {
        clearTimeout(timeoutId);
        const msg = err?.name === 'AbortError'
            ? `Request timed out after ${timeoutMs}ms`
            : String(err?.message ?? err);
        return {
            durationMs: Date.now() - startedAt,
            status: 0,
            statusText: '',
            headers: {},
            body: '',
            truncated: false,
            error: msg,
        };
    }
}

function methodCanHaveBody(method: string): boolean {
    return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function headerKeyPresent(headers: Record<string, string>, key: string): boolean {
    const lower = key.toLowerCase();
    return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

function errResponse(error: string): SendRequestResponse {
    return {
        durationMs: 0,
        status: 0,
        statusText: '',
        headers: {},
        body: '',
        truncated: false,
        error,
    };
}
