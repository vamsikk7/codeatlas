/**
 * frameworks/node-events.ts — Node EventEmitter listener + emitter plugin
 * (Issue #703, Phase 2 — seventh per-framework extraction.)
 *
 * Node's built-in `events.EventEmitter` is the foundation for in-process
 * pub-sub across many Node services:
 *
 *   import { EventEmitter } from 'events';
 *   const emitter = new EventEmitter();
 *   emitter.on('userCreated', (user) => { … });
 *   emitter.emit('userCreated', { id: 1 });
 *
 * Two patterns — one for listeners (`emit.on(...)`), one for emit sites
 * (`emit.emit(...)`). The listener emits `EVENT_LISTENER`; the emit site
 * emits `EVENT_EMIT`. Downstream, the L2b Request Hooks section groups
 * both under "Event-driven handlers" so users can see the wiring.
 *
 * Import gating accepts three signals (any one suffices):
 *   1. `import|require ... 'events'` — the Node built-in.
 *   2. `extends EventEmitter` — a class that subclasses the emitter.
 *   3. `new EventEmitter` — direct instantiation site in the file.
 *
 * Without this gate the regex would match every `something.on('x', …)`
 * call shape (which includes Socket.IO, jQuery's `.on('click', …)`, DOM
 * event listeners in browser bundles, etc.). Socket.IO is captured by
 * its own plugin; we want to skip it here so events aren't double-counted.
 * Anchoring on `EVENT_LISTENER` vs `SOCKET_EVENT` method strings is what
 * makes the two patterns distinguishable downstream.
 */

import type { FrameworkPlugin } from './types';

const EMITTER_SIGNAL = /(?:import|require)\s*\(?.*?['"]events['"]|extends\s+EventEmitter|new\s+EventEmitter/i;

export const nodeEventsPlugin: FrameworkPlugin = {
    id: 'node-events',
    name: 'Node EventEmitter',
    languages: ['javascript', 'typescript'],
    patterns: [
        // emitter.on('event', handler)
        {
            callPattern: /\b(\w+)\s*\.on\s*\(\s*['"]([^'"]+)['"]\s*,/gi,
            extract: (m, ctx) => {
                if (!EMITTER_SIGNAL.test(ctx.source)) return null;
                return { method: 'EVENT_LISTENER', route: `event:${m[2]}`, handlerName: m[1] };
            },
            skipInsideTemplate: true,
        },
        // emitter.emit('event', data)
        {
            callPattern: /\b(\w+)\s*\.emit\s*\(\s*['"]([^'"]+)['"]/gi,
            extract: (m, ctx) => {
                if (!EMITTER_SIGNAL.test(ctx.source)) return null;
                return { method: 'EVENT_EMIT', route: `event:${m[2]}`, handlerName: m[1] };
            },
            skipInsideTemplate: true,
        },
    ],
};
