/**
 * SseTab.tsx — #745 SSE client (2026-06-06).
 *
 * Pair to WebSocketTab. URL form + connect button + captured-events
 * panel. Server runs the stream via `streamSse`; webview never opens
 * the connection itself.
 */
import { useState } from 'react';

export interface SseEvent {
    type: string;
    data: string;
    id?: string;
    elapsedMs: number;
}

export interface SseTabResult {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    events: SseEvent[];
    endReason: 'eof' | 'timeout' | 'max-events' | 'aborted' | 'error';
    durationMs: number;
    error?: string;
}

export interface SseTabState {
    status: 'loading' | 'ready' | 'error';
    requestId: string;
    result?: SseTabResult;
    error?: string;
}

export interface SseConnectArgs {
    requestId: string;
    url: string;
    bearerToken?: string;
    maxEvents: number;
}

export interface SseTabProps {
    state?: SseTabState;
    onConnect: (args: SseConnectArgs) => void;
}

export default function SseTab({ state, onConnect }: SseTabProps) {
    const [url, setUrl] = useState('');
    const [maxEventsText, setMaxEventsText] = useState('100');
    const [bearerToken, setBearerToken] = useState('');

    const maxEvents = Math.max(1, Math.min(1000, parseInt(maxEventsText, 10) || 100));

    return (
        <div className="ca-api-testing-sse-tab" role="region" aria-label="SSE">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label>
                    <span style={{ fontSize: 11, opacity: 0.75 }}>SSE URL</span>
                    <input
                        className="ca-api-testing-input"
                        type="url"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="http://localhost:3000/events"
                        aria-label="SSE URL"
                        spellCheck={false}
                    />
                </label>
                <label>
                    <span style={{ fontSize: 11, opacity: 0.75 }}>Bearer token (optional)</span>
                    <input
                        className="ca-api-testing-input"
                        type="password"
                        value={bearerToken}
                        onChange={(e) => setBearerToken(e.target.value)}
                        placeholder="paste token"
                        aria-label="Bearer token (optional)"
                        spellCheck={false}
                    />
                </label>
                <label>
                    <span style={{ fontSize: 11, opacity: 0.75 }}>Max events</span>
                    <input
                        className="ca-api-testing-input"
                        type="number"
                        min={1}
                        max={1000}
                        value={maxEventsText}
                        onChange={(e) => setMaxEventsText(e.target.value)}
                        aria-label="Max events"
                        spellCheck={false}
                    />
                </label>
                <button
                    type="button"
                    className="ca-api-testing-send"
                    onClick={() => onConnect({
                        requestId: `sse-${Date.now()}`,
                        url,
                        bearerToken: bearerToken || undefined,
                        maxEvents,
                    })}
                    disabled={state?.status === 'loading' || !url}
                    data-testid="ca-sse-connect-btn"
                >
                    {state?.status === 'loading' ? '⏳ Connecting…' : '📡 Connect'}
                </button>
                {state?.status === 'error' && (
                    <div role="alert" data-testid="ca-sse-error" style={{ color: 'var(--ca-error, #ef4444)', fontSize: 11 }}>
                        {state.error ?? 'Stream failed.'}
                    </div>
                )}
                {state?.status === 'ready' && state.result && (
                    <div data-testid="ca-sse-result" style={{ border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 4, padding: 6, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div>
                            <strong>{state.result.events.length} event{state.result.events.length === 1 ? '' : 's'}</strong>
                            {' · '}
                            <span>{state.result.status} {state.result.statusText}</span>
                            {' · '}
                            <span>End: <code>{state.result.endReason}</code></span>
                            {' · '}
                            <span>Duration: {state.result.durationMs} ms</span>
                        </div>
                        {state.result.events.length > 0 && (
                            <details open>
                                <summary>Events</summary>
                                <ul style={{ margin: '4px 0 0 12px', padding: 0, listStyle: 'none', fontFamily: 'var(--ca-mono, ui-monospace, monospace)', fontSize: 10 }}>
                                    {state.result.events.map((e, i) => (
                                        <li key={i} style={{ marginBottom: 2 }}>
                                            <span style={{ opacity: 0.6 }}>+{e.elapsedMs}ms</span> · [{e.type}{e.id ? ` #${e.id}` : ''}] {e.data}
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
