/**
 * wsBridge.ts
 *
 * WebSocket bridge that serves the CodeAtlas React UI as a standalone webpage.
 * Runs an HTTP server for static files + WebSocket for real-time communication.
 * Uses the same message protocol as VS Code webview panels.
 *
 * Features:
 * - HTTP static file server for webview-ui/dist/
 * - WebSocket server for bidirectional message passing
 * - Ping/pong heartbeat (30s interval) to detect stale connections
 * - Detailed logging to VS Code Output channel
 * - Port auto-increment if default port is busy (up to 5 attempts)
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { parseOAuth2Callback } from './oauth2CallbackParser';

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
};

const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 10000;  // 10 seconds to respond to ping
// TICKET-PERF-2 — tolerate this many consecutive missed pongs before dropping a
// client. A single miss (pong throttled during a heavy init/render or a
// backgrounded tab) previously terminated the socket (~1 interval → the ~45s
// code-1006 drop + reconnect flicker). 2 misses = ~60-90s of true silence.
const MAX_MISSED_PINGS = 2;
const MAX_PORT_ATTEMPTS = 5;

interface AuthCallbackPayload {
    token: string;
    userId: string;
    email: string;
    firstName?: string;
    lastName?: string;
}

interface WsBridgeOptions {
    port: number;
    extensionPath: string;
    messageHandler: (msg: any, clientId: string) => void;
    getInitialData: () => { graphId: string; mode: string; graph: any; label: string } | null;
    log: (msg: string) => void;
    /**
     * Optional handler invoked when the marketing site posts an auth token
     * back to `http://localhost:<port>/auth/callback`. Should resolve `true`
     * on success so the bridge 302s the browser to `/`; `false` keeps the
     * user on an error page.
     */
    onAuthCallback?: (payload: AuthCallbackPayload) => Promise<boolean>;
}

interface ClientState {
    ws: WebSocket;
    id: string;
    alive: boolean;
    /** TICKET-PERF-2 — consecutive heartbeat ticks with no pong. A single miss
     *  (e.g. a pong throttled while the tab is backgrounded or busy rendering a
     *  large init) must NOT drop the connection; we only terminate after
     *  MAX_MISSED_PINGS consecutive misses. */
    missedPings: number;
    connectedAt: number;
    messagesSent: number;
    messagesReceived: number;
}

export class WsBridge {
    private httpServer: http.Server | null = null;
    private wss: WebSocketServer | null = null;
    private clients = new Map<string, ClientState>();
    private clientCounter = 0;
    private port: number;
    private actualPort: number = 0;
    private extensionPath: string;
    private messageHandler: (msg: any, clientId: string) => void;
    private getInitialData: () => { graphId: string; mode: string; graph: any; label: string } | null;
    private log: (msg: string) => void;
    private onAuthCallback: ((payload: AuthCallbackPayload) => Promise<boolean>) | undefined;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private httpRequestCount = 0;

    constructor(opts: WsBridgeOptions) {
        this.port = opts.port;
        this.extensionPath = opts.extensionPath;
        this.messageHandler = opts.messageHandler;
        this.getInitialData = opts.getInitialData;
        this.log = opts.log;
        this.onAuthCallback = opts.onAuthCallback;
    }

    /**
     * Start the HTTP + WebSocket server.
     * Tries up to MAX_PORT_ATTEMPTS ports if the default is busy.
     * Returns the actual port used.
     */
    async start(): Promise<number> {
        const staticRoot = path.join(this.extensionPath, 'webview-ui', 'dist');
        const indexHtml = this.generateIndexHtml();

        this.httpServer = http.createServer((req, res) => {
            this.httpRequestCount++;
            const url = req.url || '/';
            const urlPath = url.split('?')[0];

            // Serve static assets from webview-ui/dist/
            if (urlPath.startsWith('/assets/')) {
                const filePath = path.join(staticRoot, urlPath);
                const status = this.serveFile(filePath, res);
                this.log(`[WsBridge] HTTP ${req.method} ${urlPath} → ${status}`);
                return;
            }

            // #604 (2026-06-06) — OAuth2 callback receiver. When the user
            // launches the Authorization URL flow (built via AuthTab) and
            // signs in, the IdP redirects back to
            // http://localhost:<port>/oauth2/callback?code=…&state=…
            // (or error=…). We parse the redirect, broadcast the result
            // to every connected client so AuthTab can auto-fill the
            // code-exchange form, and reply with a small HTML page that
            // tells the user to switch back to CodeAtlas.
            if (urlPath === '/oauth2/callback') {
                const parsed = parseOAuth2Callback(url);
                if (parsed) {
                    this.broadcast({ type: 'oauth2CallbackReceived', ...parsed });
                    const headline = parsed.ok
                        ? '✓ Authorization captured'
                        : `× ${parsed.error}`;
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${headline}</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}div{text-align:center;padding:24px;border:1px solid #334155;border-radius:8px;max-width:480px}h1{margin:0 0 12px;font-size:18px}p{margin:0;font-size:13px;opacity:.75}</style></head><body><div><h1>${headline}</h1><p>You can close this tab and return to CodeAtlas.</p></div></body></html>`);
                    this.log(`[WsBridge] /oauth2/callback ${parsed.ok ? 'success' : `error=${parsed.error}`} state=${parsed.state ?? '∅'}`);
                    return;
                }
                // Fell through — let the existing SPA fallback handle it.
            }

            // Auth callback — marketing site posts the Clerk token here after
            // the user signs in via http://localhost:<port>/auth/callback.
            // We hand the token off to the extension, then 302 the browser
            // back to `/` so they land on the SPA already authenticated.
            if (urlPath === '/auth/callback') {
                this.handleAuthCallback(req, res, url).catch((err) => {
                    this.log(`[WsBridge] /auth/callback error: ${err?.message ?? err}`);
                    if (!res.writableEnded) {
                        res.writeHead(500, { 'Content-Type': 'text/plain' });
                        res.end('Auth callback failed.');
                    }
                });
                return;
            }

            // SPA fallback — serve index.html for all other paths
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(indexHtml);
            this.log(`[WsBridge] HTTP ${req.method} ${urlPath} → 200 (SPA fallback)`);
        });

        // INVARIANT (ADR-029): permessage-deflate is enabled so large
        // graph pushes (full-snapshot init, multi-tab broadcasts) are
        // compressed at the wire level. Browsers + ws library both
        // negotiate the extension automatically. Threshold + window bits
        // chosen to favor real-world graph payloads (mostly JSON, highly
        // compressible, often >10KB). See Issue 368 — WebSocket bridge has no message size limit or compression.
        this.wss = new WebSocketServer({
            server: this.httpServer,
            perMessageDeflate: {
                // Compress messages larger than 1KB. Smaller frames have
                // diminishing returns and add CPU overhead.
                threshold: 1024,
                // Server-side window/memlevel chosen for moderate CPU /
                // good ratio on JSON. Adjust if profiling shows hotspots.
                zlibDeflateOptions: { level: 6, memLevel: 7 },
                zlibInflateOptions: { chunkSize: 16 * 1024 },
                // Reuse compression context across messages to maximize
                // ratio at the cost of small extra memory per connection.
                serverNoContextTakeover: false,
                clientNoContextTakeover: false,
                // Concurrency limit for compression operations per socket.
                concurrencyLimit: 10,
            },
            verifyClient: (info: { origin?: string; req: { headers: Record<string, string | string[] | undefined> } }) => {
                const origin = info.origin || (info.req.headers['origin'] as string | undefined);
                // Allow: no origin (non-browser clients)
                if (!origin) return true;
                try {
                    const url = new URL(origin);
                    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
                    // Issue 179: Validate port matches our server port
                    const portMatch = !url.port || url.port === String(this.port);
                    return isLocalhost && portMatch;
                } catch {
                    // Invalid origin URL — reject. Common case: malformed
                    // header from an attacker probe.
                    return false;
                }
            },
        });

        this.wss.on('connection', (ws, req) => {
            // Issue 169: Cap max clients to prevent DoS
            const MAX_CLIENTS = 20;
            if (this.clients.size >= MAX_CLIENTS) {
                this.log(`[WsBridge] Rejecting connection — max clients (${MAX_CLIENTS}) reached`);
                ws.close(1013, 'Max clients reached');
                return;
            }
            const clientId = `browser-${++this.clientCounter}`;
            const clientIp = req.socket.remoteAddress || 'unknown';
            const clientState: ClientState = {
                ws,
                id: clientId,
                alive: true,
                missedPings: 0,
                connectedAt: Date.now(),
                messagesSent: 0,
                messagesReceived: 0,
            };
            this.clients.set(clientId, clientState);
            this.log(`[WsBridge] Client connected: ${clientId} from ${clientIp} (${this.clients.size} total)`);

            // Issue 136 — Breadcrumbs accumulate stale history and never reset/138: Don't send lastBrowserNav as initial navigateTo.
            // The client handles routing via hash — it sends requestRoute on mount,
            // which returns the correct diagram. Sending lastBrowserNav here caused
            // stale diagrams to override the hash-based route.
            this.log(`[WsBridge] → ${clientId}: skipping initial navigateTo (client uses hash routing)`);

            // Handle pong responses for heartbeat
            ws.on('pong', () => {
                clientState.alive = true;
                clientState.missedPings = 0; // TICKET-PERF-2 — a live pong clears the miss streak
            });

            ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    clientState.messagesReceived++;
                    this.log(`[WsBridge] ← ${clientId}: ${msg.type}${msg.command ? ` (${msg.command})` : ''}`);
                    // PERF: a handler that blocks the event loop >50ms starves
                    // every other client message behind it. Surface it (this is
                    // how the ~1s cascade-on-every-requestRoute regression was
                    // caught — see needsLiveGraphCascade).
                    const __t0 = Date.now();
                    this.messageHandler(msg, clientId);
                    const __dt = Date.now() - __t0;
                    if (__dt > 50) this.log(`[WsBridge] [perf] handler '${msg.type}' took ${__dt}ms`);
                } catch (err: any) {
                    this.log(`[WsBridge] ← ${clientId}: INVALID MESSAGE — ${err?.message}`);
                }
            });

            ws.on('close', (code, reason) => {
                const duration = Math.round((Date.now() - clientState.connectedAt) / 1000);
                this.log(`[WsBridge] Client disconnected: ${clientId} (code=${code}, reason="${reason || 'none'}", duration=${duration}s, sent=${clientState.messagesSent}, recv=${clientState.messagesReceived}) (${this.clients.size - 1} remaining)`);
                this.clients.delete(clientId);
                ws.removeAllListeners(); // Issue 170: prevent listener leaks
            });

            ws.on('error', (err) => {
                this.log(`[WsBridge] WebSocket error for ${clientId}: ${err.message}`);
                this.clients.delete(clientId);
                ws.removeAllListeners(); // Issue 170: prevent listener leaks
            });
        });

        this.wss.on('error', (err) => {
            this.log(`[WsBridge] WebSocketServer error: ${err.message}`);
        });

        // Start heartbeat timer
        this.startHeartbeat();

        // Try to listen on port, with retry
        return this.tryListen();
    }

    /**
     * Attempt to listen on this.port, incrementing up to MAX_PORT_ATTEMPTS times.
     */
    private tryListen(): Promise<number> {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const tryPort = () => {
                if (attempts >= MAX_PORT_ATTEMPTS) {
                    reject(new Error(`Failed to find an available port after ${MAX_PORT_ATTEMPTS} attempts (tried ${this.port - MAX_PORT_ATTEMPTS + 1}–${this.port})`));
                    return;
                }
                attempts++;
                const currentPort = this.port;

                const onError = (err: NodeJS.ErrnoException) => {
                    if (err.code === 'EADDRINUSE') {
                        this.log(`[WsBridge] Port ${currentPort} in use, trying ${currentPort + 1}`);
                        this.port++;
                        this.httpServer!.removeListener('error', onError);
                        tryPort();
                    } else {
                        reject(err);
                    }
                };

                this.httpServer!.once('error', onError);
                this.httpServer!.listen(currentPort, '127.0.0.1', () => {
                    this.httpServer!.removeListener('error', onError);
                    // When `currentPort === 0` the kernel allocated a free port —
                    // read it from the bound address instead of trusting the
                    // requested value. Tests rely on this for `port: 0` mode.
                    const addr = this.httpServer!.address();
                    const boundPort = typeof addr === 'object' && addr !== null && 'port' in addr
                        ? (addr as { port: number }).port
                        : currentPort;
                    this.actualPort = boundPort;
                    this.log(`[WsBridge] Server started at http://localhost:${this.actualPort} (attempt ${attempts})`);
                    resolve(this.actualPort);
                });
            };
            tryPort();
        });
    }

    /**
     * Ping/pong heartbeat to detect stale connections.
     * Runs every HEARTBEAT_INTERVAL ms. Clients that don't pong within HEARTBEAT_TIMEOUT are terminated.
     */
    private startHeartbeat(): void {
        this.heartbeatTimer = setInterval(() => {
            for (const [clientId, clientState] of this.clients) {
                if (!clientState.alive) {
                    // TICKET-PERF-2 — no pong since the last ping. Tolerate up to
                    // MAX_MISSED_PINGS consecutive misses so one throttled pong
                    // (heavy init/render, backgrounded tab) doesn't drop a live
                    // client. Only terminate once the miss streak hits the cap.
                    clientState.missedPings += 1;
                    if (clientState.missedPings >= MAX_MISSED_PINGS) {
                        const duration = Math.round((Date.now() - clientState.connectedAt) / 1000);
                        this.log(`[WsBridge] Terminating stale client ${clientId} (no pong for ${clientState.missedPings} intervals, connected ${duration}s)`);
                        clientState.ws.terminate();
                        this.clients.delete(clientId);
                        continue;
                    }
                }
                clientState.alive = false;
                try {
                    clientState.ws.ping();
                } catch {
                    this.clients.delete(clientId);
                }
            }
        }, HEARTBEAT_INTERVAL);
    }

    /**
     * Stop the server and close all connections.
     */
    stop(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        const clientCount = this.clients.size;
        for (const [clientId, clientState] of this.clients) {
            try {
                clientState.ws.close(1001, 'Server shutting down');
                this.log(`[WsBridge] Closing client ${clientId}`);
            } catch { /* ignore */ }
        }
        this.clients.clear();
        this.wss?.close();
        this.httpServer?.close();
        this.wss = null;
        this.httpServer = null;
        this.log(`[WsBridge] Server stopped (closed ${clientCount} client(s), served ${this.httpRequestCount} HTTP request(s))`);
    }

    /**
     * INVARIANT: WS frames over this size threshold log a warning so
     * unbounded-payload bugs (huge graph pushes, accidental full-snapshot
     * broadcasts) are visible in the Output channel rather than silently
     * starving slow connections. See ADR-024 / Issue 368 — WebSocket bridge has no message size limit or compression.
     */
    private static readonly LARGE_FRAME_THRESHOLD_BYTES = 256 * 1024;  // 256 KB

    /**
     * Broadcast a message to all connected browser clients.
     */
    broadcast(message: any): void {
        const data = JSON.stringify(message);
        if (data.length > WsBridge.LARGE_FRAME_THRESHOLD_BYTES) {
            this.log(
                `[WsBridge] WARN: large broadcast frame ${(data.length / 1024).toFixed(1)}KB ` +
                `(type=${(message as any).type}, threshold=${WsBridge.LARGE_FRAME_THRESHOLD_BYTES / 1024}KB)`
            );
        }
        let sent = 0;
        let skipped = 0;
        for (const [, clientState] of this.clients) {
            if (clientState.ws.readyState === WebSocket.OPEN) {
                clientState.ws.send(data);
                clientState.messagesSent++;
                sent++;
            } else {
                skipped++;
            }
        }
        if (sent > 0 || skipped > 0) {
            this.log(`[WsBridge] Broadcast ${(message as any).type} → ${sent} client(s)${skipped > 0 ? ` (${skipped} not ready)` : ''}`);
        }
    }

    /**
     * Send a message to a specific client by ID.
     */
    sendTo(clientId: string, message: any): void {
        const clientState = this.clients.get(clientId);
        if (clientState && clientState.ws.readyState === WebSocket.OPEN) {
            const data = JSON.stringify(message);
            if (data.length > WsBridge.LARGE_FRAME_THRESHOLD_BYTES) {
                this.log(
                    `[WsBridge] WARN: large unicast frame ${(data.length / 1024).toFixed(1)}KB ` +
                    `to ${clientId} (type=${(message as any).type})`
                );
            }
            clientState.ws.send(data);
            clientState.messagesSent++;
            this.log(`[WsBridge] → ${clientId}: ${(message as any).type}`);
        } else {
            this.log(`[WsBridge] → ${clientId}: DROPPED ${(message as any).type} (client not ready)`);
        }
    }

    /**
     * Check if any browser clients are connected.
     */
    hasClients(): boolean {
        return this.clients.size > 0;
    }

    /**
     * Check whether a SPECIFIC client id is still connected. Used by flows
     * (e.g. GitHub connect) that originated from a particular tab and want
     * to send results back to that exact tab — falling back to broadcast
     * only when the originating tab has gone away.
     */
    hasClient(clientId: string): boolean {
        return this.clients.has(clientId);
    }

    getPort(): number {
        return this.actualPort || this.port;
    }

    // ─── Internal helpers ────────────────────────────────────────────────

    private sendToClient(clientState: ClientState, message: any): void {
        if (clientState.ws.readyState === WebSocket.OPEN) {
            clientState.ws.send(JSON.stringify(message));
            clientState.messagesSent++;
        }
    }

    /**
     * Process the marketing-site auth callback. Validates required fields,
     * delegates the verify+store work to the extension via `onAuthCallback`,
     * then redirects the browser back to the SPA so the user lands on the
     * diagram view already signed in.
     */
    private async handleAuthCallback(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        rawUrl: string,
    ): Promise<void> {
        const url = new URL(rawUrl, `http://localhost:${this.actualPort}`);
        const token = url.searchParams.get('token') ?? '';
        const userId = url.searchParams.get('userId') ?? '';
        const email = url.searchParams.get('email') ?? '';
        const firstName = url.searchParams.get('firstName') ?? undefined;
        const lastName = url.searchParams.get('lastName') ?? undefined;

        if (!token || !userId || !email) {
            this.log(`[WsBridge] /auth/callback rejected — missing token/userId/email`);
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Auth callback missing required fields (token, userId, email).');
            return;
        }

        if (!this.onAuthCallback) {
            this.log(`[WsBridge] /auth/callback received but no handler registered`);
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Auth handler not ready. Reload the extension and try again.');
            return;
        }

        const ok = await this.onAuthCallback({ token, userId, email, firstName, lastName });
        if (!ok) {
            res.writeHead(401, { 'Content-Type': 'text/html' });
            res.end(
                '<html><body style="font-family:system-ui;padding:24px">' +
                '<h2>Sign-in failed</h2>' +
                '<p>The token returned from CodeAtlas could not be verified. ' +
                'Please close this tab and try again from your editor or browser.</p>' +
                '</body></html>',
            );
            this.log(`[WsBridge] /auth/callback verify failed for ${email}`);
            return;
        }

        res.writeHead(302, { Location: '/' });
        res.end();
        this.log(`[WsBridge] /auth/callback → 302 / for ${email} (auth succeeded)`);
    }

    private serveFile(filePath: string, res: http.ServerResponse): number {
        // Prevent path traversal. #890 — `startsWith(staticRoot)` alone lets a
        // SIBLING directory through (`…/dist-evil/secret` starts with `…/dist`).
        // Require a path-separator boundary (or exact root), matching
        // pathValidator.safeResolve.
        const staticRoot = path.join(this.extensionPath, 'webview-ui', 'dist');
        const resolved = path.resolve(filePath);
        if (resolved !== staticRoot && !resolved.startsWith(staticRoot + path.sep)) {
            res.writeHead(403);
            res.end('Forbidden');
            return 403;
        }

        if (!fs.existsSync(resolved)) {
            res.writeHead(404);
            res.end('Not Found');
            return 404;
        }

        const ext = path.extname(resolved);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const content = fs.readFileSync(resolved);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
        return 200;
    }

    /**
     * Generate an index.html that loads the React app in browser mode.
     * No CSP nonce needed — this is localhost-only.
     */
    private generateIndexHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CodeAtlas</title>
    <link rel="stylesheet" href="/assets/index.css">
    <style>
        body { margin: 0; padding: 0; overflow: hidden; }
        #root { width: 100vw; height: 100vh; }
        .ca-loading { display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;font-size:14px;opacity:0.6; }
    </style>
</head>
<body>
    <div id="root"><div class="ca-loading">Connecting to CodeAtlas...</div></div>
    <script type="module" src="/assets/index.js"></script>
</body>
</html>`;
    }
}
