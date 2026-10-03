/**
 * apiTesting/ws/index.ts — Issue #604 WebSocket client.
 *
 * Open a WS connection to a `ws://` / `wss://` URL, send a scripted
 * sequence of messages, capture incoming frames until disconnect /
 * timeout / message cap, then close and report. Built on the existing
 * `ws` dep (already pulled in by `src/server/wsBridge.ts`), so this
 * lives entirely server-side — the webview never opens a socket.
 *
 * Typical use: smoke-test a WS endpoint, run a chain step that fires
 * a subscribe + asserts an ack arrives, or stream events into env
 * vars via JSONPath extraction on the captured frames.
 *
 * Caps:
 *   - `maxMessages` — default 100. Hard cap 1000.
 *   - `maxDurationMs` — default 30 s. Hard cap 5 min.
 *
 * The implementation lazy-imports `ws` so unit tests can mock it via
 * `vi.doMock`. Production callers get the same `ws` module the rest
 * of the codebase uses.
 */

import { applyEnvVars, applyEnvToRecord } from '../env';
import { assertRequestAllowed } from '../hostGuard';

const MAX_DURATION_HARD_CAP_MS = 5 * 60 * 1000;
const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_DURATION_MS = 30_000;

export interface WsMessageOut {
    /** Send `text` or `binary`. Defaults to `text`. */
    kind?: 'text' | 'binary';
    /** Payload — string for text, base64 for binary. */
    payload: string;
    /** Delay in ms before sending. Default 0 (fire immediately on open). */
    delayMs?: number;
}

export interface WsMessageIn {
    /** Frame kind. */
    kind: 'text' | 'binary';
    /** Decoded payload — utf-8 for text, base64 for binary. */
    payload: string;
    /** Wall-clock ms since connection start. */
    elapsedMs: number;
}

export type WsEndReason = 'closed' | 'timeout' | 'max-messages' | 'error' | 'aborted';

export interface WsConnectArgs {
    url: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    bearerToken?: string;
    /** Optional Sec-WebSocket-Protocol value (subprotocols). */
    subprotocols?: string[];
    /** Outbound message sequence — fired in order with optional delays. */
    sendMessages?: WsMessageOut[];
    /** Cap on total inbound frames captured. */
    maxMessages?: number;
    /** Cap on total session duration. */
    maxDurationMs?: number;
    /** External abort signal. */
    signal?: AbortSignal;
    /** #887 — allow loopback/private hosts (NOT metadata/link-local). True for the
     *  user-initiated workbench path; false (default) for the MCP `connect_websocket` tool. */
    allowPrivateHosts?: boolean;
}

export interface WsConnectResult {
    /** HTTP upgrade status from the handshake, when known. */
    handshakeStatus?: number;
    /** Captured inbound frames. */
    messages: WsMessageIn[];
    /** Close frame code (`1000` = normal, `1006` = abnormal). */
    closeCode?: number;
    closeReason?: string;
    endReason: WsEndReason;
    /** Top-level error message when the session failed to negotiate. */
    error?: string;
    durationMs: number;
}

export async function connectWebSocket(args: WsConnectArgs): Promise<WsConnectResult> {
    const env = args.env ?? {};
    const url = applyEnvVars(String(args.url ?? ''), env);
    if (!/^wss?:\/\//i.test(url)) {
        return errResult('URL must be ws:// or wss://');
    }
    // #887 — SSRF guard (same policy as the HTTP relay).
    const guard = await assertRequestAllowed(url, { allowPrivate: args.allowPrivateHosts });
    if (!guard.ok) {
        return errResult(`Connection refused — ${guard.reason}`);
    }
    const headers: Record<string, string> = applyEnvToRecord(args.headers ?? {}, env);
    if (args.bearerToken && !headerKeyPresent(headers, 'Authorization')) {
        headers['Authorization'] = `Bearer ${applyEnvVars(args.bearerToken, env)}`;
    }

    const maxMessages = Math.max(1, Math.min(1_000, args.maxMessages ?? DEFAULT_MAX_MESSAGES));
    const maxDurationMs = Math.min(MAX_DURATION_HARD_CAP_MS, Math.max(1_000, args.maxDurationMs ?? DEFAULT_MAX_DURATION_MS));

    // Lazy import `ws` so unit tests can mock the module.
    let WebSocket: any;
    try {
        const mod = await import('ws');
        WebSocket = (mod as any).WebSocket ?? (mod as any).default ?? mod;
    } catch (err: any) {
        return errResult(`ws module load failed: ${err?.message ?? err}`);
    }

    const startedAt = Date.now();
    const messages: WsMessageIn[] = [];
    let handshakeStatus: number | undefined;
    let endReason: WsEndReason = 'closed';
    let closeCode: number | undefined;
    let closeReason: string | undefined;
    let error: string | undefined;

    return new Promise<WsConnectResult>((resolve) => {
        const ws = new WebSocket(url, args.subprotocols && args.subprotocols.length > 0 ? args.subprotocols : undefined, {
            headers,
        });

        const finish = (reason: WsEndReason) => {
            endReason = reason;
            try { ws.close(); } catch { /* noop */ }
            cleanup();
            resolve({
                handshakeStatus,
                messages,
                closeCode,
                closeReason,
                endReason,
                error,
                durationMs: Date.now() - startedAt,
            });
        };

        const timeoutId = setTimeout(() => finish('timeout'), maxDurationMs);
        const sendTimeouts: ReturnType<typeof setTimeout>[] = [];

        const cleanup = () => {
            clearTimeout(timeoutId);
            for (const t of sendTimeouts) clearTimeout(t);
            if (args.signal && abortHandler) {
                try { args.signal.removeEventListener('abort', abortHandler); } catch { /* noop */ }
            }
        };

        const abortHandler = args.signal ? () => finish('aborted') : null;
        if (args.signal) {
            if (args.signal.aborted) { finish('aborted'); return; }
            args.signal.addEventListener('abort', abortHandler!, { once: true });
        }

        ws.on('unexpected-response', (_req: any, res: any) => {
            handshakeStatus = res?.statusCode;
            error = `Upgrade rejected (HTTP ${handshakeStatus ?? '?'})`;
            finish('error');
        });

        ws.on('open', () => {
            // Schedule the outbound messages.
            for (const out of args.sendMessages ?? []) {
                const t = setTimeout(() => {
                    try {
                        if (out.kind === 'binary') {
                            ws.send(Buffer.from(out.payload, 'base64'));
                        } else {
                            ws.send(out.payload);
                        }
                    } catch { /* noop */ }
                }, Math.max(0, out.delayMs ?? 0));
                sendTimeouts.push(t);
            }
        });

        ws.on('message', (data: any, isBinary: boolean) => {
            const payload = isBinary
                ? Buffer.from(data).toString('base64')
                : (typeof data === 'string' ? data : Buffer.from(data).toString('utf-8'));
            messages.push({
                kind: isBinary ? 'binary' : 'text',
                payload,
                elapsedMs: Date.now() - startedAt,
            });
            if (messages.length >= maxMessages) finish('max-messages');
        });

        ws.on('close', (code: number, reason: Buffer | string) => {
            closeCode = code;
            closeReason = Buffer.isBuffer(reason) ? reason.toString('utf-8') : (reason || undefined);
            // Only finalize via 'close' when we haven't already finished
            // via timeout / cap / abort.
            if (endReason === 'closed') finish('closed');
        });

        ws.on('error', (err: any) => {
            error = err?.message ? String(err.message).slice(0, 500) : String(err).slice(0, 500);
            // 'close' will follow.
        });
    });
}

function headerKeyPresent(headers: Record<string, string>, key: string): boolean {
    const lower = key.toLowerCase();
    return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

function errResult(error: string): WsConnectResult {
    return {
        messages: [],
        endReason: 'error',
        error,
        durationMs: 0,
    };
}
