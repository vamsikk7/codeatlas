/**
 * WebSocketTab.tsx — #745 WebSocket client (2026-06-06).
 *
 * Form + result view for the existing server-side `connectWebSocket`
 * backend. Webview never opens a socket; it posts the URL + outbound
 * frames + caps to the host which runs the round-trip and ships the
 * captured frames + end reason back in a single result message.
 */
import { useState } from 'react';

export interface WebSocketTabResult {
    handshakeStatus?: number;
    messages: Array<{ kind: 'text' | 'binary'; payload: string; elapsedMs: number }>;
    closeCode?: number;
    closeReason?: string;
    endReason: 'closed' | 'timeout' | 'max-messages' | 'error' | 'aborted';
    durationMs: number;
    error?: string;
}

export interface WebSocketTabState {
    status: 'loading' | 'ready' | 'error';
    requestId: string;
    result?: WebSocketTabResult;
    error?: string;
}

export interface WebSocketConnectArgs {
    requestId: string;
    url: string;
    sendMessages: Array<{ payload: string }>;
    maxMessages: number;
}

export interface WebSocketTabProps {
    state?: WebSocketTabState;
    onConnect: (args: WebSocketConnectArgs) => void;
}

export default function WebSocketTab({ state, onConnect }: WebSocketTabProps) {
    const [url, setUrl] = useState('');
    const [framesText, setFramesText] = useState('');
    const [maxMessagesText, setMaxMessagesText] = useState('100');

    const parsedFrames = framesText
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(payload => ({ payload }));

    const maxMessages = Math.max(1, Math.min(1000, parseInt(maxMessagesText, 10) || 100));

    return (
        <div className="ca-api-testing-ws-tab" role="region" aria-label="WebSocket">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label>
                    <span style={{ fontSize: 11, opacity: 0.75 }}>WebSocket URL</span>
                    <input
                        className="ca-api-testing-input"
                        type="url"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="ws://localhost:7000  or  wss://echo.example.com"
                        aria-label="WebSocket URL"
                        spellCheck={false}
                    />
                </label>
                <label>
                    <span style={{ fontSize: 11, opacity: 0.75 }}>Outbound frames (one per line)</span>
                    <textarea
                        className="ca-api-testing-textarea"
                        rows={4}
                        value={framesText}
                        onChange={(e) => setFramesText(e.target.value)}
                        placeholder={'ping\n{"op":"subscribe","channel":"orders"}'}
                        aria-label="Outbound frames (one per line)"
                        spellCheck={false}
                    />
                </label>
                <label>
                    <span style={{ fontSize: 11, opacity: 0.75 }}>Max inbound messages</span>
                    <input
                        className="ca-api-testing-input"
                        type="number"
                        min={1}
                        max={1000}
                        value={maxMessagesText}
                        onChange={(e) => setMaxMessagesText(e.target.value)}
                        aria-label="Max inbound messages"
                        spellCheck={false}
                    />
                </label>
                <button
                    type="button"
                    className="ca-api-testing-send"
                    onClick={() => onConnect({
                        requestId: `ws-${Date.now()}`,
                        url,
                        sendMessages: parsedFrames,
                        maxMessages,
                    })}
                    disabled={state?.status === 'loading' || !url}
                    data-testid="ca-ws-connect-btn"
                >
                    {state?.status === 'loading' ? '⏳ Connecting…' : '🔌 Connect'}
                </button>
                {state?.status === 'error' && (
                    <div role="alert" data-testid="ca-ws-error" style={{ color: 'var(--ca-error, #ef4444)', fontSize: 11 }}>
                        {state.error ?? 'Connection failed.'}
                    </div>
                )}
                {state?.status === 'ready' && state.result && (
                    <div data-testid="ca-ws-result" style={{ border: '1px solid var(--ca-border, #94a3b8)', borderRadius: 4, padding: 6, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div>
                            <strong>{state.result.messages.length} message{state.result.messages.length === 1 ? '' : 's'}</strong>
                            {' · '}
                            <span>End: <code>{state.result.endReason}</code></span>
                            {state.result.closeCode !== undefined && (
                                <> · <span>Close: <code>{state.result.closeCode}</code>{state.result.closeReason ? ` (${state.result.closeReason})` : ''}</span></>
                            )}
                            {' · '}
                            <span>Duration: {state.result.durationMs} ms</span>
                        </div>
                        {state.result.messages.length > 0 && (
                            <details open>
                                <summary>Inbound frames</summary>
                                <ul style={{ margin: '4px 0 0 12px', padding: 0, listStyle: 'none', fontFamily: 'var(--ca-mono, ui-monospace, monospace)', fontSize: 10 }}>
                                    {state.result.messages.map((m, i) => (
                                        <li key={i} style={{ marginBottom: 2 }}>
                                            <span style={{ opacity: 0.6 }}>+{m.elapsedMs}ms</span> · [{m.kind}] {m.payload}
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
