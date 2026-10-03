/**
 * ws.test.ts — Issue #604 WebSocket client.
 *
 * Spins up a real `ws.WebSocketServer` bound to an ephemeral port,
 * connects via the client under test, and asserts the round-trip
 * shape. Keeps the test hermetic and avoids mocking the `ws` module
 * itself (which would obscure the integration we care about).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { connectWebSocket as _connectWebSocket, type WsConnectArgs } from '../ws';

// Workbench-modeling tests → allow loopback/private dev hosts (#887).
const connectWebSocket = (args: WsConnectArgs) => _connectWebSocket({ allowPrivateHosts: true, ...args });

let server: WebSocketServer;
let port: number;

beforeAll(async () => {
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;

    server.on('connection', (socket, req) => {
        // Echo or scripted response based on URL path.
        const url = req.url ?? '/';
        if (url.startsWith('/echo')) {
            socket.on('message', (data, isBinary) => {
                socket.send(data, { binary: isBinary });
            });
        } else if (url.startsWith('/broadcast-then-close')) {
            socket.send('a');
            socket.send('b');
            socket.send('c');
            setTimeout(() => socket.close(1000, 'done'), 50);
        } else if (url.startsWith('/auth')) {
            const auth = req.headers.authorization ?? '';
            socket.send(auth);
            socket.close(1000, 'done');
        }
    });
});

afterAll(() => {
    server.clients.forEach(c => { try { c.terminate(); } catch { /* noop */ } });
    server.close();
});

describe('connectWebSocket', () => {
    it('rejects non-ws URLs', async () => {
        const out = await connectWebSocket({ url: 'http://localhost/ws' });
        expect(out.error).toMatch(/ws:\/\//);
    });

    it('connects + receives scripted server frames then closes cleanly', async () => {
        const out = await connectWebSocket({
            url: `ws://localhost:${port}/broadcast-then-close`,
            maxDurationMs: 5_000,
        });
        expect(out.endReason).toBe('closed');
        expect(out.messages.map(m => m.payload)).toEqual(['a', 'b', 'c']);
        expect(out.closeCode).toBe(1000);
        expect(out.closeReason).toBe('done');
    });

    it('sends scripted outbound messages and echoes them back', async () => {
        const out = await connectWebSocket({
            url: `ws://localhost:${port}/echo`,
            sendMessages: [
                { payload: 'hello' },
                { payload: 'world', delayMs: 10 },
            ],
            maxMessages: 2,
            maxDurationMs: 5_000,
        });
        expect(out.endReason).toBe('max-messages');
        expect(out.messages.map(m => m.payload)).toEqual(['hello', 'world']);
    });

    it('forwards the Authorization header from bearerToken', async () => {
        const out = await connectWebSocket({
            url: `ws://localhost:${port}/auth`,
            bearerToken: 'tk',
            maxDurationMs: 5_000,
        });
        expect(out.messages[0]?.payload).toBe('Bearer tk');
    });

    it('substitutes env vars in URL', async () => {
        const out = await connectWebSocket({
            url: 'ws://localhost:{{port}}/echo',
            env: { port: String(port) },
            sendMessages: [{ payload: 'env' }],
            maxMessages: 1,
            maxDurationMs: 5_000,
        });
        expect(out.messages[0]?.payload).toBe('env');
    });

    it('aborts via external signal', async () => {
        const ctrl = new AbortController();
        const promise = connectWebSocket({
            url: `ws://localhost:${port}/echo`,
            maxDurationMs: 5_000,
            signal: ctrl.signal,
        });
        setTimeout(() => ctrl.abort(), 20);
        const out = await promise;
        expect(out.endReason).toBe('aborted');
    });
});
