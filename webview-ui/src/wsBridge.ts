/**
 * wsBridge.ts
 *
 * Browser-side WebSocket adapter for CodeAtlas standalone mode.
 * Replaces VS Code's `window.vscodeApi` with a WebSocket-backed shim.
 *
 * Features:
 * - Auto-reconnect with exponential backoff (1s → 10s max)
 * - Message queue: buffers outgoing messages while disconnected, flushes on reconnect
 * - Detailed console logging for debugging (visible in browser DevTools → Console)
 * - Connection status events dispatched to window for UI indicators
 *
 * Self-initializing: only activates in real browsers (not VS Code webviews).
 * Import this file as a side-effect before mounting the React app.
 */

(function initWsBridge() {
    // Only activate in real browser — VS Code webviews have acquireVsCodeApi
    if (typeof window === 'undefined') return;
    if (typeof (window as any).acquireVsCodeApi === 'function') return;

    const LOG_PREFIX = '[CodeAtlas WS]';
    const port = window.location.port || '7742';
    const wsUrl = `ws://${window.location.hostname || 'localhost'}:${port}`;

    let ws: WebSocket | null = null;
    let reconnectAttempts = 0;
    let messagesSent = 0;
    let messagesReceived = 0;
    // BUG-WS-RECONNECT-STORM — the single pending reconnect timer. Tracking it
    // is what enforces the "at most one reconnect loop" invariant: every
    // scheduleReconnect() collapses into this one slot, so overlapping close /
    // error events can no longer each spawn their own setTimeout(connect) chain.
    // The old code kept no handle, so a server restart that raced the backoff
    // seeded a second loop; the two loops then cross-triggered and multiplied
    // into thousands of concurrent retries (observed: ~3900 attempts firing in
    // the same second), which froze the tab and made every navigation crawl.
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_RECONNECT_DELAY = 10000;
    const MAX_QUEUE_SIZE = 100;

    // Message queue for outgoing messages while disconnected
    const pendingQueue: string[] = [];

    // Buffer for incoming messages that arrive before React mounts.
    // The WS connection can establish and receive data faster than React's
    // useEffect runs, so we buffer and replay once React signals readiness.
    let incomingReady = false;
    const incomingBuffer: any[] = [];

    type ConnectionState = 'disconnected' | 'connecting' | 'connected';
    let state: ConnectionState = 'disconnected';

    function log(msg: string) {
        console.log(`${LOG_PREFIX} ${msg}`);
    }

    function warn(msg: string) {
        console.warn(`${LOG_PREFIX} ${msg}`);
    }

    function updateState(newState: ConnectionState) {
        const prev = state;
        state = newState;
        if (prev !== newState) {
            log(`State: ${prev} → ${newState}`);
        }
        window.dispatchEvent(new CustomEvent('ws-status', { detail: newState }));
    }

    function flushQueue() {
        if (pendingQueue.length === 0) return;
        log(`Flushing ${pendingQueue.length} queued message(s)`);
        while (pendingQueue.length > 0 && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(pendingQueue.shift()!);
            messagesSent++;
        }
    }

    /**
     * BUG-WS-RECONNECT-STORM — fully retire the current socket before we
     * abandon the reference. Detaching the handlers FIRST is the critical step:
     * a socket whose `onclose` still points at our handler will, when it
     * eventually fires (server-restart races deliver a late close AFTER the next
     * connect already ran), call scheduleReconnect() and fork a second loop.
     * Nulling the handlers makes any late event from a stale socket inert, so
     * exactly one socket is ever alive and only its lifecycle drives reconnects.
     */
    function teardownSocket() {
        if (!ws) return;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        try {
            ws.close();
        } catch {
            /* already closing/closed — nothing to do */
        }
        ws = null;
    }

    function connect() {
        // STORM GUARD: if a socket is already establishing or live, that attempt
        // owns the lifecycle — never open a parallel one. Otherwise tear the old
        // one down completely so its late onclose can't seed a second loop.
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
            return;
        }
        teardownSocket();

        updateState('connecting');
        log(`Connecting to ${wsUrl} (attempt ${reconnectAttempts + 1})`);

        try {
            ws = new WebSocket(wsUrl);
        } catch (err) {
            warn(`Failed to create WebSocket: ${err}`);
            scheduleReconnect();
            return;
        }

        ws.onopen = () => {
            // A pending reconnect timer is now moot — cancel it so a queued
            // retry can't tear down the connection we just established.
            if (reconnectTimer !== null) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            // Capture before we reset the counter below — a non-zero count
            // means this open follows a prior drop (a genuine reconnect),
            // not the very first connection.
            const wasReconnect = reconnectAttempts > 0;
            updateState('connected');
            log(`Connected successfully${reconnectAttempts > 0 ? ` after ${reconnectAttempts} retries` : ''}`);
            // Issue #754: clear the stuck banner once we've reconnected.
            if (reconnectAttempts >= 3) {
                window.dispatchEvent(new CustomEvent('ws-stuck-cleared'));
            }
            reconnectAttempts = 0;

            // Flush any queued outgoing messages (including React's 'ready')
            flushQueue();

            // BUG-VERIFY-1: after a genuine reconnect the server may have been
            // restarted under us — e.g. `code -r` switched the VS Code workspace
            // folder, tearing down the old WsBridge and binding a new one for a
            // different repo. The server only pushes workspaceInfo in response to
            // the mount handshake (`ready`), which React sends once on mount and
            // never again. Signal the reconnect so the App re-runs the handshake;
            // the fresh workspaceInfo then trips maybeReloadOnWorkspaceSwitch and
            // clears the stale previous-workspace state. A same-workspace blip is
            // harmless — the guard no-ops when the workspaceRoot is unchanged.
            if (wasReconnect) {
                window.dispatchEvent(new CustomEvent('ws-reconnected'));
            }
        };

        ws.onmessage = (event) => {
            try {
                // Issue 190: Reject oversized messages to prevent OOM
                if (typeof event.data === 'string' && event.data.length > 10 * 1024 * 1024) {
                    console.warn('[CodeAtlas WS] Message too large:', event.data.length, 'bytes — dropped');
                    return;
                }
                const data = JSON.parse(event.data);
                messagesReceived++;
                if (incomingReady) {
                    // React handler is registered — dispatch immediately
                    window.dispatchEvent(new MessageEvent('message', { data }));
                } else {
                    // Buffer until React signals readiness
                    incomingBuffer.push(data);
                }
            } catch (err) {
                warn(`Failed to parse incoming message: ${err}`);
            }
        };

        ws.onclose = (event) => {
            log(`Connection closed (code=${event.code}, reason="${event.reason || 'none'}", clean=${event.wasClean})`);
            log(`Session stats: ${messagesSent} sent, ${messagesReceived} received`);
            updateState('disconnected');
            scheduleReconnect();
        };

        ws.onerror = (event) => {
            warn(`WebSocket error (readyState=${ws?.readyState})`);
            // onclose will fire after onerror — reconnect handled there
        };
    }

    function scheduleReconnect() {
        // STORM GUARD (BUG-WS-RECONNECT-STORM): at most ONE pending reconnect at
        // a time. Concurrent callers — an `onerror` racing its `onclose`, a
        // stale socket's late close, a construct-failure retry — all collapse
        // into the single in-flight timer instead of each stacking a fresh
        // setTimeout(connect). This is the invariant that stops the loop count
        // from ever growing beyond one.
        if (reconnectTimer !== null) return;
        // Backoff: 1s, 2s, 4s, 8s, 10s, 10s... (capped at MAX_RECONNECT_DELAY)
        const uncapped = 1000 * Math.pow(2, reconnectAttempts);
        const delay = Math.min(uncapped, MAX_RECONNECT_DELAY);
        reconnectAttempts++;
        log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
        // Issue #754: after 3 consecutive failed reconnect attempts the
        // browser tab is almost certainly stale (typical cause: VS Code
        // restarted and the prior session's client id is rejected). The
        // bridge keeps retrying but the user has no signal beyond a
        // silent console warning every ~11s. Emit a `ws-stuck` event so
        // App.tsx can render a prominent banner with a Reload button.
        if (reconnectAttempts >= 3) {
            window.dispatchEvent(new CustomEvent('ws-stuck', {
                detail: { attempts: reconnectAttempts },
            }));
        }
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    }

    function flushIncomingBuffer() {
        if (incomingReady) return;
        incomingReady = true;
        if (incomingBuffer.length > 0) {
            log(`Replaying ${incomingBuffer.length} buffered incoming message(s)`);
            for (const data of incomingBuffer) {
                window.dispatchEvent(new MessageEvent('message', { data }));
            }
            incomingBuffer.length = 0;
        }
    }

    // Shim window.vscodeApi with WebSocket transport
    (window as any).vscodeApi = {
        postMessage: (msg: any) => {
            const data = JSON.stringify(msg);

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(data);
                messagesSent++;
            } else {
                // Queue the message for when connection is restored
                if (pendingQueue.length < MAX_QUEUE_SIZE) {
                    pendingQueue.push(data);
                    if (pendingQueue.length === 1) {
                        log(`Queuing messages (connection not ready, state=${state})`);
                    }
                } else {
                    warn(`Message queue full (${MAX_QUEUE_SIZE}), dropping: ${msg.type}`);
                }
            }
        },
        getState: () => ({}),
        setState: () => {},
        // Called by React once its message handler is registered
        flushIncoming: flushIncomingBuffer,
        // Synchronous read of current WS connection state (for initializing React state)
        getConnectionState: () => state,
    };

    // Mark that we're in browser mode (not VS Code webview)
    (window as any).__codeAtlasBrowserMode = true;

    // Issue #780: page-side observer hook for the live-verify skill.
    // The skill's step 9.3 snippet used to wrap `window.codeatlasBridge.onMessage`
    // to capture `updateGraph` / `timelineReplayStep` graphIds as the
    // browser saw them. That symbol was removed when the bridge was
    // refactored, so the snippet silently no-ops. This replacement
    // exposes an opt-in observer the skill can call from Chrome MCP:
    //
    //   window.__codeAtlasInstallObserver();
    //   // ... trigger replay or edit
    //   [...window.__codeAtlasObserver].sort();
    //
    // Default behaviour: no listener registered, no overhead. Calling
    // the installer twice is a no-op (idempotent).
    (window as any).__codeAtlasInstallObserver = function installObserver() {
        const w = window as any;
        if (w.__codeAtlasObserverInstalled) return w.__codeAtlasObserver;
        const seen = new Set<string>();
        w.__codeAtlasObserver = seen;
        w.__codeAtlasObserverInstalled = true;
        window.addEventListener('message', (ev: MessageEvent) => {
            const m = ev.data;
            if (!m || typeof m !== 'object') return;
            if (m.type === 'updateGraph' && typeof m.graphId === 'string') seen.add(m.graphId);
            if (m.type === 'timelineReplayStep' && m.step?.graphId) seen.add(m.step.graphId);
        });
        return seen;
    };

    log(`Initializing browser bridge (target: ${wsUrl})`);
    connect();
})();

// Module marker — required so TypeScript treats this as a module (not a script)
export {};
