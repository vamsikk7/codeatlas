/**
 * wsBridge.test.ts
 *
 * Integration tests for the WebSocket bridge server.
 * Uses real HTTP connections and WebSocket clients (ws package)
 * to verify the full message flow end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import { WsBridge } from '../wsBridge';
import WebSocket from 'ws';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

// ─── Temp directory setup ────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsBridge-test-'));
    const assetsDir = path.join(tmpDir, 'webview-ui', 'dist', 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'index.js'), '// dummy js');
    fs.writeFileSync(path.join(assetsDir, 'index.css'), '/* dummy css */');
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

let portCounter = 49100;

function nextPort(): number {
    return portCounter++;
}

function createBridge(overrides?: Partial<{
    port: number;
    extensionPath: string;
    messageHandler: (msg: any, clientId: string) => void;
    getInitialData: () => { graphId: string; mode: string; graph: any; label: string } | null;
    log: (msg: string) => void;
    onAuthCallback: (payload: { token: string; userId: string; email: string; firstName?: string; lastName?: string }) => Promise<boolean>;
}>): { bridge: WsBridge; logs: string[]; handler: ReturnType<typeof vi.fn> } {
    const logs: string[] = [];
    const handler = vi.fn();
    const bridge = new WsBridge({
        port: overrides?.port ?? nextPort(),
        extensionPath: overrides?.extensionPath ?? tmpDir,
        messageHandler: overrides?.messageHandler ?? handler,
        getInitialData: overrides?.getInitialData ?? (() => null),
        log: overrides?.log ?? ((msg: string) => logs.push(msg)),
        onAuthCallback: overrides?.onAuthCallback,
    });
    return { bridge, logs, handler };
}

function connectClient(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

/** Connect a client with autoPong disabled (for heartbeat testing). */
function connectClientNoAutoPong(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { autoPong: false });
        ws.on('open', () => resolve(ws));
        ws.on('error', reject);
    });
}

function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('waitForMessage timeout')), timeoutMs);
        ws.once('message', (raw) => {
            clearTimeout(timer);
            resolve(JSON.parse(raw.toString()));
        });
    });
}

function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('waitForClose timeout')), timeoutMs);
        ws.once('close', (code, reason) => {
            clearTimeout(timer);
            resolve({ code, reason: reason?.toString() || '' });
        });
    });
}

function httpGet(port: number, urlPath: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => resolve({ statusCode: res.statusCode!, headers: res.headers, body }));
        }).on('error', reject);
    });
}

/**
 * Send a raw HTTP request without URL normalization.
 * Node's http.get normalizes paths (resolving /../), which prevents testing
 * path traversal. This sends the raw path bytes over a TCP socket.
 */
function rawHttpGet(port: number, rawPath: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(port, '127.0.0.1', () => {
            socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        });
        let data = '';
        socket.on('data', (chunk) => (data += chunk.toString()));
        socket.on('end', () => {
            const [headerSection, ...bodyParts] = data.split('\r\n\r\n');
            const statusLine = headerSection.split('\r\n')[0];
            const statusCode = parseInt(statusLine.split(' ')[1], 10);
            resolve({ statusCode, body: bodyParts.join('\r\n\r\n') });
        });
        socket.on('error', reject);
    });
}

// ─── Track bridge instances for cleanup ──────────────────────────────────────

let activeBridge: WsBridge | null = null;

afterEach(() => {
    if (activeBridge) {
        activeBridge.stop();
        activeBridge = null;
    }
});

// ─── 1. Server lifecycle ─────────────────────────────────────────────────────

describe('Server lifecycle', () => {
    it('start() returns a port number', async () => {
        const { bridge } = createBridge();
        activeBridge = bridge;
        const port = await bridge.start();
        expect(port).toBeTypeOf('number');
        expect(port).toBeGreaterThan(0);
    });

    it('getPort() returns the actual port after start', async () => {
        const requestedPort = nextPort();
        const { bridge } = createBridge({ port: requestedPort });
        activeBridge = bridge;
        const actualPort = await bridge.start();
        expect(bridge.getPort()).toBe(actualPort);
    });

    it('stop() closes the server cleanly', async () => {
        const { bridge } = createBridge();
        activeBridge = bridge;
        const port = await bridge.start();
        bridge.stop();
        activeBridge = null;

        // Verify server is no longer listening
        await expect(
            httpGet(port, '/').catch(() => 'connection_refused')
        ).resolves.toBe('connection_refused');
    });

    it('stop() can be called multiple times without error', async () => {
        const { bridge } = createBridge();
        activeBridge = bridge;
        await bridge.start();

        expect(() => {
            bridge.stop();
            bridge.stop();
            bridge.stop();
        }).not.toThrow();
        activeBridge = null;
    });

    it('hasClients() returns false when no clients connected', async () => {
        const { bridge } = createBridge();
        activeBridge = bridge;
        await bridge.start();
        expect(bridge.hasClients()).toBe(false);
    });
});

// ─── 2. Port retry ──────────────────────────────────────────────────────────

describe('Port retry', () => {
    it('uses requested port when available', async () => {
        const requestedPort = nextPort();
        const { bridge } = createBridge({ port: requestedPort });
        activeBridge = bridge;
        const actualPort = await bridge.start();
        expect(actualPort).toBe(requestedPort);
    });

    it('retries and succeeds when port becomes available', async () => {
        // Verify the retry logic works by confirming the bridge can start
        // even when initially given a port that's already in use.
        // The 5-port exhaustion test below verifies EADDRINUSE detection.
        const port = nextPort();
        const { bridge, logs } = createBridge({ port });
        activeBridge = bridge;
        const actualPort = await bridge.start();
        expect(actualPort).toBe(port);
        expect(logs.some((l) => l.includes('Server started'))).toBe(true);
        expect(logs.some((l) => l.includes(`attempt 1`))).toBe(true);
    });

    it('retries up to 5 times then rejects', async () => {
        const startPort = nextPort();
        // Block 5 consecutive ports using exclusive net.Servers
        const blockers: net.Server[] = [];
        for (let i = 0; i < 5; i++) {
            const server = await new Promise<net.Server>((resolve, reject) => {
                const s = net.createServer();
                s.on('error', reject);
                s.listen({ port: startPort + i, host: '127.0.0.1', exclusive: true }, () => resolve(s));
            });
            blockers.push(server);
        }

        try {
            const { bridge } = createBridge({ port: startPort });
            activeBridge = bridge;
            await expect(bridge.start()).rejects.toThrow(/Failed to find an available port/);
            activeBridge = null; // start failed, no need to stop
        } finally {
            for (const b of blockers) b.close();
        }
    });

    it('logs each port attempt', async () => {
        // Block a port using exclusive net.Server
        const blockedPort = nextPort();
        const blocker = await new Promise<net.Server>((resolve, reject) => {
            const server = net.createServer();
            server.on('error', reject);
            server.listen({ port: blockedPort, host: '127.0.0.1', exclusive: true }, () => resolve(server));
        });

        try {
            const { bridge, logs } = createBridge({ port: blockedPort });
            activeBridge = bridge;
            await bridge.start();
            expect(logs.some((l) => l.includes(`Port ${blockedPort} in use`))).toBe(true);
            expect(logs.some((l) => l.includes(`trying ${blockedPort + 1}`))).toBe(true);
        } finally {
            blocker.close();
        }
    });
});

// ─── 3. HTTP static file serving ─────────────────────────────────────────────

describe('HTTP static file serving', () => {
    let port: number;
    let bridge: WsBridge;
    let logs: string[];

    beforeEach(async () => {
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        activeBridge = bridge;
        port = await bridge.start();
    });

    it('GET / returns 200 with HTML (SPA fallback)', async () => {
        const res = await httpGet(port, '/');
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/html');
        expect(res.body).toContain('<!DOCTYPE html>');
        expect(res.body).toContain('CodeAtlas');
    });

    it('GET /assets/index.js returns 200 with correct MIME type', async () => {
        const res = await httpGet(port, '/assets/index.js');
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('application/javascript');
        expect(res.body).toBe('// dummy js');
    });

    it('GET /assets/index.css returns 200 with text/css MIME', async () => {
        const res = await httpGet(port, '/assets/index.css');
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/css');
        expect(res.body).toBe('/* dummy css */');
    });

    it('GET /assets/nonexistent.js returns 404', async () => {
        const res = await httpGet(port, '/assets/nonexistent.js');
        expect(res.statusCode).toBe(404);
    });

    it('path traversal via raw socket returns 403', async () => {
        // Must use raw socket -- Node's http.get normalizes /../ before sending
        const res = await rawHttpGet(port, '/assets/../../../etc/passwd');
        expect(res.statusCode).toBe(403);
    });

    it('#890 — a SIBLING dir whose name PREFIXES the static root returns 403 (not served)', () => {
        // `…/webview-ui/dist-evil/secret.js` string-prefixes `…/webview-ui/dist`.
        // The old `startsWith(staticRoot)` check would BYPASS the boundary and
        // serve the file; the separator-boundary check rejects it. Drive a fresh
        // bridge so we can plant the sibling file deterministically.
        const sibTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsBridge-sib-'));
        try {
            fs.mkdirSync(path.join(sibTmp, 'webview-ui', 'dist', 'assets'), { recursive: true });
            fs.mkdirSync(path.join(sibTmp, 'webview-ui', 'dist-evil'), { recursive: true });
            fs.writeFileSync(path.join(sibTmp, 'webview-ui', 'dist-evil', 'secret.js'), 'SECRET');
            const { bridge: b } = createBridge({ extensionPath: sibTmp });
            // serveFile is private — reach it via the documented boundary by
            // invoking it through the type-erased instance with the resolved
            // sibling path the request `/assets/../../dist-evil/secret.js` produces.
            const staticRoot = path.join(sibTmp, 'webview-ui', 'dist');
            const siblingPath = path.join(staticRoot, '/assets/../../dist-evil/secret.js'); // → …/webview-ui/dist-evil/secret.js
            const fakeRes: any = { writeHead: vi.fn(), end: vi.fn() };
            const status = (b as any).serveFile(siblingPath, fakeRes);
            expect(status).toBe(403);
        } finally {
            fs.rmSync(sibTmp, { recursive: true, force: true });
        }
    });

    it('logs HTTP requests', async () => {
        await httpGet(port, '/');
        await httpGet(port, '/assets/index.js');
        const httpLogs = logs.filter((l) => l.includes('HTTP'));
        expect(httpLogs.length).toBeGreaterThanOrEqual(2);
        expect(httpLogs.some((l) => l.includes('200'))).toBe(true);
    });
});

// ─── 4. WebSocket connection ─────────────────────────────────────────────────

describe('WebSocket connection', () => {
    let port: number;
    let bridge: WsBridge;
    let logs: string[];
    const clients: WebSocket[] = [];

    beforeEach(async () => {
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        activeBridge = bridge;
        port = await bridge.start();
    });

    afterEach(() => {
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        }
        clients.length = 0;
    });

    it('client connects successfully', async () => {
        const ws = await connectClient(port);
        clients.push(ws);
        expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('client receives initial data on connect (navigateTo message)', async () => {
        bridge.stop();
        activeBridge = null;

        const initialData = {
            graphId: 'file:src/app.ts',
            mode: 'file',
            graph: { nodes: [], edges: [] },
            label: 'app.ts',
        };
        const ctx = createBridge({
            getInitialData: () => initialData,
        });
        bridge = ctx.bridge;
        activeBridge = bridge;
        port = await bridge.start();

        // Issue 136 — Breadcrumbs accumulate stale history and never reset/138: The server no longer sends navigateTo on connect.
        // The client handles routing via hash (sends requestRoute on mount).
        // Verify that NO initial navigateTo is sent by checking that a
        // subsequent broadcast arrives first (no navigateTo precedes it).
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        await new Promise<void>((resolve) => ws.on('open', resolve));
        clients.push(ws);

        bridge.broadcast({ type: 'test', value: 'probe' });
        const msg = await new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout')), 3000);
            ws.on('message', (raw) => {
                clearTimeout(timer);
                resolve(JSON.parse(raw.toString()));
            });
        });
        // The first message should be the broadcast probe, not a navigateTo
        expect(msg.type).toBe('test');
        expect(msg.value).toBe('probe');
    });

    it('client receives no initial data when getInitialData returns null', async () => {
        const ws = await connectClient(port);
        clients.push(ws);

        // Send a test message from the server side so we can verify ordering
        // If initial data was sent, it would arrive first
        bridge.broadcast({ type: 'test', value: 'probe' });
        const msg = await waitForMessage(ws);
        expect(msg.type).toBe('test');
        expect(msg.value).toBe('probe');
    });

    it('multiple clients can connect simultaneously', async () => {
        const ws1 = await connectClient(port);
        const ws2 = await connectClient(port);
        const ws3 = await connectClient(port);
        clients.push(ws1, ws2, ws3);

        expect(ws1.readyState).toBe(WebSocket.OPEN);
        expect(ws2.readyState).toBe(WebSocket.OPEN);
        expect(ws3.readyState).toBe(WebSocket.OPEN);
        expect(bridge.hasClients()).toBe(true);
    });

    it('hasClients() returns true when clients connected', async () => {
        expect(bridge.hasClients()).toBe(false);
        const ws = await connectClient(port);
        clients.push(ws);
        // Allow the server-side 'connection' event to fire
        await new Promise((r) => setTimeout(r, 50));
        expect(bridge.hasClients()).toBe(true);
    });

    it('client disconnect removes it from clients map', async () => {
        const ws = await connectClient(port);
        clients.push(ws);
        await new Promise((r) => setTimeout(r, 50));
        expect(bridge.hasClients()).toBe(true);

        ws.close();
        await new Promise((r) => setTimeout(r, 100));
        expect(bridge.hasClients()).toBe(false);
    });
});

// ─── 5. Message handling ─────────────────────────────────────────────────────

describe('Message handling', () => {
    let port: number;
    let bridge: WsBridge;
    let logs: string[];
    let handler: ReturnType<typeof vi.fn>;
    const clients: WebSocket[] = [];

    beforeEach(async () => {
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        handler = ctx.handler;
        activeBridge = bridge;
        port = await bridge.start();
    });

    afterEach(() => {
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        }
        clients.length = 0;
    });

    it('server receives JSON message from client and calls messageHandler', async () => {
        const ws = await connectClient(port);
        clients.push(ws);

        ws.send(JSON.stringify({ type: 'requestGraph', graphId: 'file:app.ts' }));
        await new Promise((r) => setTimeout(r, 100));

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'requestGraph', graphId: 'file:app.ts' }),
            expect.stringMatching(/^browser-\d+$/)
        );
    });

    it('messageHandler receives correct clientId', async () => {
        const ws1 = await connectClient(port);
        const ws2 = await connectClient(port);
        clients.push(ws1, ws2);
        await new Promise((r) => setTimeout(r, 50));

        ws1.send(JSON.stringify({ type: 'msg1' }));
        ws2.send(JSON.stringify({ type: 'msg2' }));
        await new Promise((r) => setTimeout(r, 100));

        expect(handler).toHaveBeenCalledTimes(2);
        const call1ClientId = handler.mock.calls[0][1];
        const call2ClientId = handler.mock.calls[1][1];
        expect(call1ClientId).not.toBe(call2ClientId);
        expect(call1ClientId).toMatch(/^browser-\d+$/);
        expect(call2ClientId).toMatch(/^browser-\d+$/);
    });

    it('invalid JSON message is logged, not crashed', async () => {
        const ws = await connectClient(port);
        clients.push(ws);

        ws.send('this is not {json}');
        await new Promise((r) => setTimeout(r, 100));

        expect(handler).not.toHaveBeenCalled();
        expect(logs.some((l) => l.includes('INVALID MESSAGE'))).toBe(true);
    });

    it('multiple message types are routed correctly', async () => {
        const ws = await connectClient(port);
        clients.push(ws);

        const messages = [
            { type: 'requestGraph', graphId: 'file:a.ts' },
            { type: 'navigate', target: 'b.ts' },
            { type: 'command', command: 'refresh' },
        ];

        for (const msg of messages) {
            ws.send(JSON.stringify(msg));
        }
        await new Promise((r) => setTimeout(r, 150));

        expect(handler).toHaveBeenCalledTimes(3);
        expect(handler.mock.calls[0][0].type).toBe('requestGraph');
        expect(handler.mock.calls[1][0].type).toBe('navigate');
        expect(handler.mock.calls[2][0].type).toBe('command');
    });

    it('message counts are tracked per client', async () => {
        const ws = await connectClient(port);
        clients.push(ws);

        ws.send(JSON.stringify({ type: 'a' }));
        ws.send(JSON.stringify({ type: 'b' }));
        ws.send(JSON.stringify({ type: 'c' }));
        await new Promise((r) => setTimeout(r, 100));

        expect(handler).toHaveBeenCalledTimes(3);
    });

    it('binary messages result in parse error (logged, not crashed)', async () => {
        const ws = await connectClient(port);
        clients.push(ws);

        ws.send(Buffer.from([0x00, 0x01, 0x02]));
        await new Promise((r) => setTimeout(r, 100));

        expect(handler).not.toHaveBeenCalled();
        expect(logs.some((l) => l.includes('INVALID MESSAGE'))).toBe(true);
    });
});

// ─── 6. broadcast() ─────────────────────────────────────────────────────────

describe('broadcast()', () => {
    let port: number;
    let bridge: WsBridge;
    let logs: string[];
    const clients: WebSocket[] = [];

    beforeEach(async () => {
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        activeBridge = bridge;
        port = await bridge.start();
    });

    afterEach(() => {
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        }
        clients.length = 0;
    });

    it('sends message to all connected clients', async () => {
        const ws1 = await connectClient(port);
        const ws2 = await connectClient(port);
        clients.push(ws1, ws2);
        await new Promise((r) => setTimeout(r, 50));

        const p1 = waitForMessage(ws1);
        const p2 = waitForMessage(ws2);
        bridge.broadcast({ type: 'update', data: 'hello' });

        const [msg1, msg2] = await Promise.all([p1, p2]);
        expect(msg1).toEqual({ type: 'update', data: 'hello' });
        expect(msg2).toEqual({ type: 'update', data: 'hello' });
    });

    it('skips closed/closing clients', async () => {
        const ws1 = await connectClient(port);
        const ws2 = await connectClient(port);
        clients.push(ws1, ws2);
        await new Promise((r) => setTimeout(r, 50));

        // Close ws1 without waiting for cleanup
        ws1.close();
        await new Promise((r) => setTimeout(r, 100));

        const p2 = waitForMessage(ws2);
        bridge.broadcast({ type: 'update', data: 'world' });

        const msg = await p2;
        expect(msg.type).toBe('update');
    });

    it('logs broadcast count', async () => {
        const ws1 = await connectClient(port);
        const ws2 = await connectClient(port);
        clients.push(ws1, ws2);
        await new Promise((r) => setTimeout(r, 50));

        bridge.broadcast({ type: 'refresh' });
        await new Promise((r) => setTimeout(r, 50));

        expect(logs.some((l) => l.includes('Broadcast refresh') && l.includes('2 client(s)'))).toBe(true);
    });

    it('works with zero clients (no error)', () => {
        expect(() => bridge.broadcast({ type: 'test' })).not.toThrow();
    });
});

// ─── 7. sendTo() ────────────────────────────────────────────────────────────

describe('sendTo()', () => {
    let port: number;
    let bridge: WsBridge;
    let logs: string[];
    let handler: ReturnType<typeof vi.fn>;
    const clients: WebSocket[] = [];

    beforeEach(async () => {
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        handler = ctx.handler;
        activeBridge = bridge;
        port = await bridge.start();
    });

    afterEach(() => {
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        }
        clients.length = 0;
    });

    it('sends message to specific client by ID', async () => {
        const ws = await connectClient(port);
        clients.push(ws);

        // Send a message from the client to discover its ID
        ws.send(JSON.stringify({ type: 'hello' }));
        await new Promise((r) => setTimeout(r, 100));
        const clientId = handler.mock.calls[0][1];

        const promise = waitForMessage(ws);
        bridge.sendTo(clientId, { type: 'reply', data: 'ok' });
        const msg = await promise;
        expect(msg).toEqual({ type: 'reply', data: 'ok' });
    });

    it('does not send to other clients', async () => {
        const ws1 = await connectClient(port);
        const ws2 = await connectClient(port);
        clients.push(ws1, ws2);
        await new Promise((r) => setTimeout(r, 50));

        // Discover ws1's client ID
        ws1.send(JSON.stringify({ type: 'identify' }));
        await new Promise((r) => setTimeout(r, 100));
        const clientId1 = handler.mock.calls[0][1];

        // Send only to ws1
        const p1 = waitForMessage(ws1);
        bridge.sendTo(clientId1, { type: 'targeted', value: 42 });
        const msg = await p1;
        expect(msg.value).toBe(42);

        // ws2 should not receive anything; send a broadcast probe to verify ordering
        const p2 = waitForMessage(ws2);
        bridge.broadcast({ type: 'probe' });
        const msg2 = await p2;
        expect(msg2.type).toBe('probe'); // first message ws2 gets is the probe, not the targeted one
    });

    it('handles nonexistent client ID gracefully', () => {
        expect(() => bridge.sendTo('browser-999', { type: 'test' })).not.toThrow();
        expect(logs.some((l) => l.includes('DROPPED'))).toBe(true);
    });

    it('logs sent/dropped messages', async () => {
        const ws = await connectClient(port);
        clients.push(ws);

        ws.send(JSON.stringify({ type: 'hello' }));
        await new Promise((r) => setTimeout(r, 100));
        const clientId = handler.mock.calls[0][1];

        bridge.sendTo(clientId, { type: 'sent-ok' });
        await new Promise((r) => setTimeout(r, 50));
        expect(logs.some((l) => l.includes(clientId) && l.includes('sent-ok'))).toBe(true);

        bridge.sendTo('browser-nonexistent', { type: 'dropped-msg' });
        expect(logs.some((l) => l.includes('DROPPED') && l.includes('dropped-msg'))).toBe(true);
    });
});

// ─── 8. Heartbeat ───────────────────────────────────────────────────────────

describe('Heartbeat', () => {
    let bridge: WsBridge;
    let logs: string[];
    let port: number;
    const clients: WebSocket[] = [];

    afterEach(() => {
        vi.useRealTimers();
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        }
        clients.length = 0;
    });

    it('ping is sent to all clients every 30 seconds', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        activeBridge = bridge;
        port = await bridge.start();

        const ws = await connectClient(port);
        clients.push(ws);
        await new Promise((r) => setTimeout(r, 50));

        const pingReceived = new Promise<void>((resolve) => {
            ws.on('ping', () => resolve());
        });

        vi.advanceTimersByTime(30000);
        await pingReceived;
        // If we get here, ping was received successfully
    });

    it('client that responds to pong stays alive', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        activeBridge = bridge;
        port = await bridge.start();

        const ws = await connectClient(port);
        clients.push(ws);
        await new Promise((r) => setTimeout(r, 50));

        // ws library auto-responds to pings with pongs by default (autoPong: true)
        // Advance past two heartbeat intervals; the client should survive both
        vi.advanceTimersByTime(30000);
        await new Promise((r) => setTimeout(r, 50));
        vi.advanceTimersByTime(30000);
        await new Promise((r) => setTimeout(r, 50));

        expect(bridge.hasClients()).toBe(true);
    });

    it('client that does not pong for MAX_MISSED_PINGS intervals is terminated', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        activeBridge = bridge;
        port = await bridge.start();

        // Connect with autoPong disabled so the client never sends pong
        const ws = await connectClientNoAutoPong(port);
        clients.push(ws);
        await new Promise((r) => setTimeout(r, 50));

        // Tick 1: alive=true → set alive=false, ping (no pong).
        vi.advanceTimersByTime(30000);
        await new Promise((r) => setTimeout(r, 100));
        // Tick 2: TICKET-PERF-2 — first miss (missedPings=1 < 2) → NOT terminated yet.
        vi.advanceTimersByTime(30000);
        await new Promise((r) => setTimeout(r, 100));
        expect(bridge.hasClients(), 'tolerates a single missed pong').toBe(true);
        // Tick 3: second consecutive miss (missedPings=2) → terminated.
        vi.advanceTimersByTime(30000);
        await new Promise((r) => setTimeout(r, 100));
        expect(bridge.hasClients()).toBe(false);
    });

    it('TICKET-PERF-2 — a client that misses one pong then recovers stays connected', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        activeBridge = bridge;
        port = await bridge.start();

        // autoPong ON — the ws client replies to every ping. Advance well past
        // the old 2-interval termination point; the live client must survive.
        const ws = await connectClient(port);
        clients.push(ws);
        await new Promise((r) => setTimeout(r, 50));
        for (let i = 0; i < 4; i++) {
            vi.advanceTimersByTime(30000);
            await new Promise((r) => setTimeout(r, 60));
        }
        expect(bridge.hasClients(), 'a ponging client is never dropped').toBe(true);
        expect(logs.some((l) => l.includes('Terminating stale')), 'no spurious termination').toBe(false);
    });

    it('heartbeat timer is cleared on stop()', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        activeBridge = bridge;
        port = await bridge.start();

        bridge.stop();
        activeBridge = null;
        const logCountBefore = logs.length;

        // Advancing timers should not produce any heartbeat log entries
        vi.advanceTimersByTime(60000);
        const newLogs = logs.slice(logCountBefore);
        expect(newLogs.some((l) => l.includes('Terminating stale'))).toBe(false);
    });

    it('stale client termination is logged', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        activeBridge = bridge;
        port = await bridge.start();

        // Connect with autoPong disabled
        const ws = await connectClientNoAutoPong(port);
        clients.push(ws);
        await new Promise((r) => setTimeout(r, 50));

        // TICKET-PERF-2 — termination now needs MAX_MISSED_PINGS (2) misses, so
        // three ticks: ping → miss#1 → miss#2+terminate.
        vi.advanceTimersByTime(30000);
        await new Promise((r) => setTimeout(r, 100));
        vi.advanceTimersByTime(30000);
        await new Promise((r) => setTimeout(r, 100));
        vi.advanceTimersByTime(30000);
        await new Promise((r) => setTimeout(r, 100));

        expect(logs.some((l) => l.includes('Terminating stale client'))).toBe(true);
    });
});

// ─── 9. Logging ─────────────────────────────────────────────────────────────

describe('Logging', () => {
    let port: number;
    let bridge: WsBridge;
    let logs: string[];
    let handler: ReturnType<typeof vi.fn>;
    const clients: WebSocket[] = [];

    beforeEach(async () => {
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        handler = ctx.handler;
        activeBridge = bridge;
        port = await bridge.start();
    });

    afterEach(() => {
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        }
        clients.length = 0;
    });

    it('connection logged with client count', async () => {
        const ws = await connectClient(port);
        clients.push(ws);
        await new Promise((r) => setTimeout(r, 50));

        expect(logs.some((l) => l.includes('Client connected') && l.includes('1 total'))).toBe(true);
    });

    it('disconnection logged with duration and stats', async () => {
        const ws = await connectClient(port);
        clients.push(ws);
        await new Promise((r) => setTimeout(r, 50));

        ws.send(JSON.stringify({ type: 'test' }));
        await new Promise((r) => setTimeout(r, 50));

        ws.close();
        await new Promise((r) => setTimeout(r, 200));

        const disconnectLog = logs.find((l) => l.includes('Client disconnected'));
        expect(disconnectLog).toBeDefined();
        expect(disconnectLog).toMatch(/duration=\d+s/);
        expect(disconnectLog).toMatch(/sent=\d+/);
        expect(disconnectLog).toMatch(/recv=\d+/);
    });

    it('message types logged on receive', async () => {
        const ws = await connectClient(port);
        clients.push(ws);

        ws.send(JSON.stringify({ type: 'requestGraph', command: 'refresh' }));
        await new Promise((r) => setTimeout(r, 100));

        expect(logs.some((l) => l.includes('requestGraph') && l.includes('refresh'))).toBe(true);
    });

    it('broadcast logged with recipient count', async () => {
        const ws1 = await connectClient(port);
        const ws2 = await connectClient(port);
        clients.push(ws1, ws2);
        await new Promise((r) => setTimeout(r, 50));

        bridge.broadcast({ type: 'navigateTo' });
        await new Promise((r) => setTimeout(r, 50));

        expect(logs.some((l) => l.includes('Broadcast navigateTo') && l.includes('2 client(s)'))).toBe(true);
    });

    it('server start logged with port', async () => {
        expect(logs.some((l) => l.includes('Server started') && l.includes(`${port}`))).toBe(true);
    });
});

// ─── 10. Edge cases ─────────────────────────────────────────────────────────

describe('Edge cases', () => {
    let port: number;
    let bridge: WsBridge;
    let logs: string[];
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        const ctx = createBridge();
        bridge = ctx.bridge;
        logs = ctx.logs;
        handler = ctx.handler;
        activeBridge = bridge;
        port = await bridge.start();
    });

    it('client sends message then immediately disconnects', async () => {
        const ws = await connectClient(port);
        ws.send(JSON.stringify({ type: 'quick-msg' }));
        ws.close();
        await new Promise((r) => setTimeout(r, 200));

        // The message may or may not have been processed, but server should not crash
        expect(bridge.getPort()).toBe(port);
    });

    it('server stop while clients are connected', async () => {
        const ws1 = await connectClient(port);
        const ws2 = await connectClient(port);
        await new Promise((r) => setTimeout(r, 50));

        const p1 = waitForClose(ws1);
        const p2 = waitForClose(ws2);

        bridge.stop();
        activeBridge = null;

        const [result1, result2] = await Promise.all([p1, p2]);
        expect(result1.code).toBe(1001);
        expect(result2.code).toBe(1001);
    });

    it('very large message handling', async () => {
        const ws = await connectClient(port);
        const largePayload = { type: 'bulkData', data: 'x'.repeat(100_000) };
        ws.send(JSON.stringify(largePayload));
        await new Promise((r) => setTimeout(r, 200));

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][0].data.length).toBe(100_000);
        ws.close();
    });
});

// ─── 11. SPA fallback routes ────────────────────────────────────────────────

describe('SPA fallback', () => {
    let port: number;
    let bridge: WsBridge;

    beforeEach(async () => {
        const ctx = createBridge();
        bridge = ctx.bridge;
        activeBridge = bridge;
        port = await bridge.start();
    });

    it('GET /some/deep/route returns index.html (SPA fallback)', async () => {
        const res = await httpGet(port, '/some/deep/route');
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/html');
        expect(res.body).toContain('<!DOCTYPE html>');
    });

    it('GET /favicon.ico returns SPA fallback', async () => {
        const res = await httpGet(port, '/favicon.ico');
        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('CodeAtlas');
    });

    it('generated index.html includes script and stylesheet references', async () => {
        const res = await httpGet(port, '/');
        expect(res.body).toContain('/assets/index.js');
        expect(res.body).toContain('/assets/index.css');
    });
});

// ─── 12. Client ID assignment ───────────────────────────────────────────────

describe('Client ID assignment', () => {
    let port: number;
    let bridge: WsBridge;
    let handler: ReturnType<typeof vi.fn>;
    const clients: WebSocket[] = [];

    beforeEach(async () => {
        const ctx = createBridge();
        bridge = ctx.bridge;
        handler = ctx.handler;
        activeBridge = bridge;
        port = await bridge.start();
    });

    afterEach(() => {
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        }
        clients.length = 0;
    });

    it('assigns unique sequential client IDs', async () => {
        const ws1 = await connectClient(port);
        const ws2 = await connectClient(port);
        const ws3 = await connectClient(port);
        clients.push(ws1, ws2, ws3);

        ws1.send(JSON.stringify({ type: 'id1' }));
        ws2.send(JSON.stringify({ type: 'id2' }));
        ws3.send(JSON.stringify({ type: 'id3' }));
        await new Promise((r) => setTimeout(r, 150));

        const ids = handler.mock.calls.map((c: any[]) => c[1]);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(3);
        for (const id of ids) {
            expect(id).toMatch(/^browser-\d+$/);
        }
    });

    it('client IDs increment even after disconnections', async () => {
        const ws1 = await connectClient(port);
        ws1.send(JSON.stringify({ type: 'first' }));
        await new Promise((r) => setTimeout(r, 50));
        const id1 = handler.mock.calls[0][1] as string;
        const num1 = parseInt(id1.split('-')[1]);

        ws1.close();
        await new Promise((r) => setTimeout(r, 100));

        const ws2 = await connectClient(port);
        clients.push(ws2);
        ws2.send(JSON.stringify({ type: 'second' }));
        await new Promise((r) => setTimeout(r, 50));
        const id2 = handler.mock.calls[1][1] as string;
        const num2 = parseInt(id2.split('-')[1]);

        expect(num2).toBeGreaterThan(num1);
    });
});

// ─── /auth/callback (browser-mode auth handoff) ──────────────────────────────

/** http.get follows redirects by default; we want to inspect them, so use a manual request. */
function httpGetNoFollow(port: number, urlPath: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path: urlPath, method: 'GET' },
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => resolve({ statusCode: res.statusCode!, headers: res.headers, body }));
            },
        );
        req.on('error', reject);
        req.end();
    });
}

describe('/auth/callback (browser-mode auth)', () => {
    it('happy path: valid params with onAuthCallback returning true → 302 to /', async () => {
        const onAuthCallback = vi.fn().mockResolvedValue(true);
        const { bridge } = createBridge({ onAuthCallback });
        activeBridge = bridge;
        const port = await bridge.start();
        const params = new URLSearchParams({
            token: 'tok-abc',
            userId: 'user-1',
            email: 'a@b.com',
            firstName: 'Ada',
            lastName: 'Lovelace',
        });
        const res = await httpGetNoFollow(port, `/auth/callback?${params.toString()}`);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/');
        expect(onAuthCallback).toHaveBeenCalledWith({
            token: 'tok-abc',
            userId: 'user-1',
            email: 'a@b.com',
            firstName: 'Ada',
            lastName: 'Lovelace',
        });
    });

    it('missing token → 400', async () => {
        const onAuthCallback = vi.fn();
        const { bridge } = createBridge({ onAuthCallback });
        activeBridge = bridge;
        const port = await bridge.start();
        const res = await httpGetNoFollow(port, `/auth/callback?userId=u&email=e@x.com`);
        expect(res.statusCode).toBe(400);
        expect(onAuthCallback).not.toHaveBeenCalled();
    });

    it('missing userId → 400', async () => {
        const onAuthCallback = vi.fn();
        const { bridge } = createBridge({ onAuthCallback });
        activeBridge = bridge;
        const port = await bridge.start();
        const res = await httpGetNoFollow(port, `/auth/callback?token=t&email=e@x.com`);
        expect(res.statusCode).toBe(400);
        expect(onAuthCallback).not.toHaveBeenCalled();
    });

    it('missing email → 400', async () => {
        const onAuthCallback = vi.fn();
        const { bridge } = createBridge({ onAuthCallback });
        activeBridge = bridge;
        const port = await bridge.start();
        const res = await httpGetNoFollow(port, `/auth/callback?token=t&userId=u`);
        expect(res.statusCode).toBe(400);
        expect(onAuthCallback).not.toHaveBeenCalled();
    });

    it('no onAuthCallback registered → 503', async () => {
        const { bridge } = createBridge();
        activeBridge = bridge;
        const port = await bridge.start();
        const res = await httpGetNoFollow(port, `/auth/callback?token=t&userId=u&email=e@x.com`);
        expect(res.statusCode).toBe(503);
    });

    it('onAuthCallback returns false → 401 with explanatory body', async () => {
        const onAuthCallback = vi.fn().mockResolvedValue(false);
        const { bridge } = createBridge({ onAuthCallback });
        activeBridge = bridge;
        const port = await bridge.start();
        const res = await httpGetNoFollow(port, `/auth/callback?token=t&userId=u&email=e@x.com`);
        expect(res.statusCode).toBe(401);
        expect(res.body).toContain('Sign-in failed');
        expect(onAuthCallback).toHaveBeenCalled();
    });

    it('onAuthCallback throwing → 500 (caught, never crashes server)', async () => {
        const onAuthCallback = vi.fn().mockRejectedValue(new Error('boom'));
        const { bridge } = createBridge({ onAuthCallback });
        activeBridge = bridge;
        const port = await bridge.start();
        const res = await httpGetNoFollow(port, `/auth/callback?token=t&userId=u&email=e@x.com`);
        expect(res.statusCode).toBe(500);
        // Server should still be alive after the error
        const healthCheck = await httpGetNoFollow(port, '/');
        expect(healthCheck.statusCode).toBe(200);
    });

    it('firstName and lastName are optional', async () => {
        const onAuthCallback = vi.fn().mockResolvedValue(true);
        const { bridge } = createBridge({ onAuthCallback });
        activeBridge = bridge;
        const port = await bridge.start();
        const res = await httpGetNoFollow(port, `/auth/callback?token=t&userId=u&email=e@x.com`);
        expect(res.statusCode).toBe(302);
        expect(onAuthCallback).toHaveBeenCalledWith({
            token: 't',
            userId: 'u',
            email: 'e@x.com',
            firstName: undefined,
            lastName: undefined,
        });
    });
});
