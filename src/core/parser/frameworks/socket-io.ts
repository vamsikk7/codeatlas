/**
 * frameworks/socket-io.ts — Socket.IO event handler plugin
 * (Issue #703, Phase 2 — sixth per-framework extraction.)
 *
 * Socket.IO exposes an EventEmitter-style API:
 *
 *   io.on('connection', (socket) => {
 *     socket.on('message', (msg) => { … });
 *     socket.on('disconnect', () => { … });
 *   });
 *
 * One regex catches both server-side (`io.on(...)`) and per-socket
 * (`socket.on(...)`) registrations, plus the rarer `server.on(...)`
 * shape exposed by `socket.io-client`.
 *
 * Import gating is critical — generic `EventEmitter.on(...)` calls are
 * captured separately by the Node EventEmitter plugin (PR-8) and emit
 * `EVENT_LISTENER`. Without the `socket.io` / `socket.io-client` import
 * guard the regex here would double-match those.
 *
 * Emits `SOCKET_EVENT` records so downstream consumers (the L2b
 * Real-Time section in `ApiListPanel.tsx`) group Socket.IO events
 * separately from generic events and from WS/SSE traffic.
 */

import type { FrameworkPlugin } from './types';

const SOCKET_IO_IMPORT = /(?:from\s+|require\s*\(\s*)['"]socket\.io['"]|(?:from\s+|require\s*\(\s*)['"]socket\.io-client['"]/;

export const socketIoPlugin: FrameworkPlugin = {
    id: 'socket-io',
    name: 'Socket.IO',
    languages: ['javascript', 'typescript'],
    patterns: [
        {
            callPattern: /\b(?:io|socket|server)\s*\.\s*on\s*\(\s*['"]([^'"]+)['"]/g,
            extract: (m, ctx) => {
                if (!SOCKET_IO_IMPORT.test(ctx.source)) return null;
                return { method: 'SOCKET_EVENT', route: `socket:${m[1]}`, handlerName: m[1] };
            },
            skipInsideTemplate: true,
        },
    ],
};
