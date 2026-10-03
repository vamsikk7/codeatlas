/**
 * sse.test.ts — Issue #604 SSE client.
 *
 * We stub `global.fetch` with a constructed `Response` whose body is a
 * `ReadableStream` we control, so the parser is exercised without real
 * network I/O.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { streamSse as _streamSse, type SseStreamArgs } from '../sse';

// Workbench-modeling tests → allow loopback/private dev hosts (#887).
const streamSse = (args: SseStreamArgs) => _streamSse({ allowPrivateHosts: true, ...args });

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(encoder.encode(chunks[i++]));
        },
    });
}

function sseResponse(chunks: string[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
    return new Response(streamFromChunks(chunks), {
        status: init.status ?? 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'text/event-stream', ...(init.headers ?? {}) }),
    });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    fetchMock = vi.fn();
    (global as any).fetch = fetchMock;
});

describe('streamSse', () => {
    it('rejects non-http URLs', async () => {
        const out = await streamSse({ url: '/relative' });
        expect(out.error).toMatch(/absolute/);
    });

    it('parses a basic stream of three `message` events', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([
            'data: hello\n\n',
            'data: world\n\n',
            'data: bye\n\n',
        ]));
        const out = await streamSse({ url: 'http://localhost/sse' });
        expect(out.endReason).toBe('eof');
        expect(out.events.map(e => e.data)).toEqual(['hello', 'world', 'bye']);
        expect(out.events.every(e => e.type === 'message')).toBe(true);
    });

    it('honours `event:` lines for custom event types', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([
            'event: ping\ndata: 1\n\n',
            'event: tick\ndata: 2\n\n',
        ]));
        const out = await streamSse({ url: 'http://localhost/sse' });
        expect(out.events.map(e => e.type)).toEqual(['ping', 'tick']);
    });

    it('honours multi-line `data:` accumulation', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([
            'data: line1\ndata: line2\ndata: line3\n\n',
        ]));
        const out = await streamSse({ url: 'http://localhost/sse' });
        expect(out.events[0].data).toBe('line1\nline2\nline3');
    });

    it('records `id:` per event', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([
            'id: 1\ndata: a\n\n',
            'id: 2\ndata: b\n\n',
        ]));
        const out = await streamSse({ url: 'http://localhost/sse' });
        expect(out.events.map(e => e.id)).toEqual(['1', '2']);
    });

    it('ignores SSE comment lines (starting with `:`)', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([
            ': heartbeat\ndata: real\n\n',
        ]));
        const out = await streamSse({ url: 'http://localhost/sse' });
        expect(out.events).toHaveLength(1);
        expect(out.events[0].data).toBe('real');
    });

    it('stops at `maxEvents`', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([
            'data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n', 'data: 4\n\n',
        ]));
        const out = await streamSse({ url: 'http://localhost/sse', maxEvents: 2 });
        expect(out.endReason).toBe('max-events');
        expect(out.events).toHaveLength(2);
    });

    it('returns an error result when the response is non-2xx', async () => {
        fetchMock.mockResolvedValueOnce(new Response('nope', {
            status: 401, statusText: 'Unauthorized',
            headers: new Headers({ 'content-type': 'text/event-stream' }),
        }));
        const out = await streamSse({ url: 'http://localhost/sse' });
        expect(out.status).toBe(401);
        expect(out.endReason).toBe('error');
    });

    it('adds Bearer token when supplied', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['data: x\n\n']));
        await streamSse({ url: 'http://localhost/sse', bearerToken: 'tk' });
        const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(init.headers.Authorization).toBe('Bearer tk');
    });

    it('substitutes env vars in URL and Bearer token', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse(['data: x\n\n']));
        await streamSse({
            url: '{{base}}/sse',
            bearerToken: '{{token}}',
            env: { base: 'http://localhost', token: 'abc' },
        });
        expect(fetchMock.mock.calls[0][0]).toBe('http://localhost/sse');
        const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(init.headers.Authorization).toBe('Bearer abc');
    });

    it('reports `Accept: text/event-stream` header on the outbound request', async () => {
        fetchMock.mockResolvedValueOnce(sseResponse([]));
        await streamSse({ url: 'http://localhost/sse' });
        const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(init.headers.Accept).toBe('text/event-stream');
    });
});
