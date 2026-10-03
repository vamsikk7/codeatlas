/**
 * apiTesting/sse/index.ts — Issue #604 Server-Sent Events client.
 *
 * Connect to an SSE endpoint, read the stream until EOF / disconnect /
 * timeout / message cap, and return the accumulated events. Built on
 * Node's global `fetch` (no `eventsource` dep) so it runs in both the
 * extension host and the standalone Node server.
 *
 * The reader follows the SSE wire format from
 * https://html.spec.whatwg.org/multipage/server-sent-events.html:
 *
 *   - Lines starting `data:` accumulate into the next event's data.
 *   - Lines starting `event:` set the event type (defaults to `message`).
 *   - Lines starting `id:` set the event id.
 *   - Lines starting `retry:` are recorded but not acted upon (caller
 *     is responsible for re-subscribing if it wants reconnect).
 *   - A blank line dispatches the current event.
 *
 * Stream termination: the reader stops at the first of
 *   - max event count reached (`maxEvents`, default 100)
 *   - max duration reached (`maxDurationMs`, default 30 s)
 *   - server closes the connection
 *   - explicit abort via `signal`
 *
 * Returns the captured events + termination reason so callers can
 * decide whether to retry.
 */

import { applyEnvVars, applyEnvToRecord } from '../env';
import { assertRequestAllowed } from '../hostGuard';

export interface SseEvent {
    /** Event type (defaults to `'message'`). */
    type: string;
    /** Best-effort decoded data. SSE `data:` lines are concatenated
     *  with `\n`. */
    data: string;
    /** Last-Event-ID associated with the event, when the server sets one. */
    id?: string;
    /** Wall-clock ms since connection start. */
    elapsedMs: number;
}

export type SseEndReason = 'eof' | 'timeout' | 'max-events' | 'aborted' | 'error';

export interface SseStreamResult {
    /** HTTP status from the initial response. 0 when the connection
     *  failed before any response was received. */
    status: number;
    statusText: string;
    headers: Record<string, string>;
    events: SseEvent[];
    endReason: SseEndReason;
    error?: string;
    durationMs: number;
}

export interface SseStreamArgs {
    url: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    bearerToken?: string;
    /** Cap on total events returned. Default 100. */
    maxEvents?: number;
    /** Cap on stream lifetime in ms. Default 30 s; capped at 5 min. */
    maxDurationMs?: number;
    /** External abort signal. */
    signal?: AbortSignal;
    /** #887 — allow loopback/private hosts (NOT metadata/link-local). True for the
     *  user-initiated workbench path; false (default) for the MCP `stream_sse` tool. */
    allowPrivateHosts?: boolean;
}

const MAX_DURATION_HARD_CAP_MS = 5 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_MAX_DURATION_MS = 30_000;

export async function streamSse(args: SseStreamArgs): Promise<SseStreamResult> {
    const env = args.env ?? {};
    const url = applyEnvVars(String(args.url ?? ''), env);
    if (!/^https?:\/\//i.test(url)) {
        return errResult('URL must be absolute (http:// or https://)');
    }
    // #887 — SSRF guard (same policy as the HTTP relay).
    const guard = await assertRequestAllowed(url, { allowPrivate: args.allowPrivateHosts });
    if (!guard.ok) {
        return errResult(`Request refused — ${guard.reason}`);
    }
    const headers: Record<string, string> = applyEnvToRecord(args.headers ?? {}, env);
    if (!headerKeyPresent(headers, 'Accept')) {
        headers['Accept'] = 'text/event-stream';
    }
    if (args.bearerToken && !headerKeyPresent(headers, 'Authorization')) {
        headers['Authorization'] = `Bearer ${applyEnvVars(args.bearerToken, env)}`;
    }

    const maxEvents = Math.max(1, Math.min(1_000, args.maxEvents ?? DEFAULT_MAX_EVENTS));
    const maxDurationMs = Math.min(MAX_DURATION_HARD_CAP_MS, Math.max(1_000, args.maxDurationMs ?? DEFAULT_MAX_DURATION_MS));
    const controller = new AbortController();
    const timeoutId = setTimeout(() => { controller.abort(); }, maxDurationMs);
    if (args.signal) {
        if (args.signal.aborted) controller.abort();
        else args.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const startedAt = Date.now();

    try {
        const res = await fetch(url, {
            method: 'GET',
            headers,
            signal: controller.signal,
        });
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => { respHeaders[k] = v; });
        const events: SseEvent[] = [];
        let endReason: SseEndReason = 'eof';

        if (!res.ok || !res.body) {
            clearTimeout(timeoutId);
            return {
                status: res.status,
                statusText: res.statusText,
                headers: respHeaders,
                events: [],
                endReason: res.ok ? 'eof' : 'error',
                durationMs: Date.now() - startedAt,
                error: res.ok ? undefined : `HTTP ${res.status} ${res.statusText}`,
            };
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let currentData: string[] = [];
        let currentType = 'message';
        let currentId: string | undefined;

        outer: while (true) {
            let chunk: { done: boolean; value?: Uint8Array };
            try {
                chunk = await reader.read();
            } catch (err: any) {
                if (controller.signal.aborted) {
                    endReason = args.signal?.aborted ? 'aborted' : 'timeout';
                } else {
                    endReason = 'error';
                }
                break;
            }
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });

            // Split on `\r\n\r\n` / `\n\n` / `\r\r` per SSE spec. We
            // tolerate any of the three line endings.
            for (;;) {
                const sepIdx = findEventSeparator(buffer);
                if (sepIdx < 0) break;
                const block = buffer.slice(0, sepIdx);
                buffer = buffer.slice(sepIdx + matchedSeparatorLength(buffer, sepIdx));
                const event = parseEventBlock(block, currentData, () => currentType, () => currentId);
                if (event) {
                    events.push({
                        type: event.type,
                        data: event.data,
                        id: event.id,
                        elapsedMs: Date.now() - startedAt,
                    });
                    if (events.length >= maxEvents) {
                        endReason = 'max-events';
                        controller.abort();
                        break outer;
                    }
                }
                // Reset accumulator for the next event.
                currentData = [];
                currentType = 'message';
                currentId = undefined;
            }
        }

        clearTimeout(timeoutId);
        try { reader.releaseLock(); } catch { /* noop */ }
        return {
            status: res.status,
            statusText: res.statusText,
            headers: respHeaders,
            events,
            endReason,
            durationMs: Date.now() - startedAt,
        };
    } catch (err: any) {
        clearTimeout(timeoutId);
        const aborted = controller.signal.aborted;
        return {
            status: 0,
            statusText: '',
            headers: {},
            events: [],
            endReason: aborted ? (args.signal?.aborted ? 'aborted' : 'timeout') : 'error',
            durationMs: Date.now() - startedAt,
            error: err?.message ? String(err.message).slice(0, 500) : String(err).slice(0, 500),
        };
    }
}

// ── helpers ──────────────────────────────────────────────────────────

function findEventSeparator(buf: string): number {
    // Per SSE spec, dispatch on a blank line. Try each terminator in order.
    const candidates = ['\r\n\r\n', '\n\n', '\r\r'];
    let earliest = -1;
    for (const s of candidates) {
        const i = buf.indexOf(s);
        if (i >= 0 && (earliest < 0 || i < earliest)) earliest = i;
    }
    return earliest;
}

function matchedSeparatorLength(buf: string, sepIdx: number): number {
    if (buf.startsWith('\r\n\r\n', sepIdx)) return 4;
    if (buf.startsWith('\n\n', sepIdx)) return 2;
    if (buf.startsWith('\r\r', sepIdx)) return 2;
    return 2;
}

function parseEventBlock(
    block: string,
    accumulatedData: string[],
    currentType: () => string,
    currentId: () => string | undefined,
): { type: string; data: string; id?: string } | null {
    let type = currentType();
    let id = currentId();
    const lines = block.split(/\r\n|\r|\n/);
    for (const rawLine of lines) {
        if (!rawLine) continue;
        if (rawLine.startsWith(':')) continue; // SSE comment line
        const colon = rawLine.indexOf(':');
        const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
        let value = colon < 0 ? '' : rawLine.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') accumulatedData.push(value);
        else if (field === 'event') type = value || 'message';
        else if (field === 'id') id = value || undefined;
        else if (field === 'retry') { /* recorded but ignored; caller decides reconnect */ }
    }
    if (accumulatedData.length === 0 && !id) return null;
    return { type, data: accumulatedData.join('\n'), id };
}

function headerKeyPresent(headers: Record<string, string>, key: string): boolean {
    const lower = key.toLowerCase();
    return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

function errResult(error: string): SseStreamResult {
    return {
        status: 0,
        statusText: '',
        headers: {},
        events: [],
        endReason: 'error',
        durationMs: 0,
        error,
    };
}
