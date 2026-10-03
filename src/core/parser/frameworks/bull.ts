/**
 * frameworks/bull.ts — Bull / BullMQ job queue plugin
 * (Issue #703, Phase 2 — second per-framework extraction).
 *
 * Bull and BullMQ are the dominant Node.js job-queue libraries. Three
 * declaration shapes show up in the wild and all three produce
 * `method: 'JOB'` records that downstream layers (the L1 worker-node
 * computation in #364, the L2b Background-Jobs section in L2b panel)
 * read uniformly.
 *
 *   import { Worker } from 'bullmq';
 *   new Worker('emails', async (job) => { … });          // 1
 *
 *   const queue = new Queue('emails');
 *   queue.process('send', async (job) => { … });          // 2
 *
 *   @Processor('emails')
 *   export class EmailConsumer {
 *     @Process('send') async send(job) { … }              // 3 (NestJS-flavored)
 *   }
 *
 * Patterns 1 + 2 are call-based; #3 is a decorator. All three are gated
 * by a `bull` / `bullmq` import on the file (patterns 1 + 2) — the
 * NestJS decorator (#3) is unambiguous on its own (no real-world library
 * uses `@Process` for anything else inside a NestJS / Bull context).
 *
 * `skipInsideTemplate: true` on every pattern preserves the pre-#703
 * dispatcher behaviour for the JS-style suppression in svelte/docs
 * template-literal snippets.
 */

import type { FrameworkPlugin } from './types';

const BULL_IMPORT = /(?:from\s+|require\s*\(\s*)['"]bullmq['"]|(?:from\s+|require\s*\(\s*)['"]bull['"]/;

export const bullPlugin: FrameworkPlugin = {
    id: 'bull',
    name: 'Bull / BullMQ',
    languages: ['javascript', 'typescript'],
    patterns: [
        // 1. `new Worker('queueName', handler)` — gated by bull/bullmq import
        //    so unrelated Worker classes (node:worker_threads, Web Workers)
        //    don't false-match.
        {
            callPattern: /new\s+Worker\s*\(\s*['"]([^'"]+)['"]/g,
            extract: (m, ctx) => {
                if (!BULL_IMPORT.test(ctx.source)) return null;
                return { method: 'JOB', route: `queue:${m[1]}`, handlerName: `worker:${m[1]}` };
            },
            skipInsideTemplate: true,
        },
        // 2. `queue.process('jobName', handler)` — the legacy Bull API,
        //    also gated by bull/bullmq import. The first regex capture is
        //    the variable name; the second (optional) is the named job. We
        //    use the named job when present and fall back to the variable.
        {
            callPattern: /\b(\w+)\s*\.process\s*\(\s*(?:['"]([^'"]+)['"]\s*,\s*)?/g,
            extract: (m, ctx) => {
                if (!BULL_IMPORT.test(ctx.source)) return null;
                const job = m[2] ?? m[1];
                return { method: 'JOB', route: `job:${job}`, handlerName: m[1] };
            },
            skipInsideTemplate: true,
        },
        // 3. NestJS `@Process('jobName')` — decorator inside a class
        //    annotated with `@Processor('queueName')`. The class-level
        //    decorator is not extracted here (it's metadata, not an
        //    endpoint); only the method-level `@Process` produces a
        //    routable JOB record. When the argument is absent (`@Process()`),
        //    the job is named 'default'.
        {
            decoratorPattern: /@Process\s*\(\s*(?:['"]([^'"]+)['"])?\s*\)/g,
            extract: (m) => ({ method: 'JOB', route: `job:${m[1] ?? 'default'}`, handlerName: m[1] }),
            skipInsideTemplate: true,
        },
    ],
};
