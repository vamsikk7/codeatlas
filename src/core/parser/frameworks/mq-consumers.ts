/**
 * frameworks/mq-consumers.ts — Message-queue consumer plugin
 * (Issue #703, Phase 2 — third per-framework extraction; bundles the
 *  three popular Node MQ client libraries that all emit `MQ_CONSUMER`.)
 *
 * Three transport-specific consumer libraries dominate Node MQ work:
 *
 *   - **kafkajs** — `consumer.subscribe({ topic: 'X' })` or
 *     `consumer.subscribe({ topics: ['a','b'] })`. Two call shapes.
 *   - **amqplib** (RabbitMQ) — `channel.consume('queueName', handler)`.
 *   - **node-redis / ioredis pub-sub** — `subscriber.subscribe('channel', …)`.
 *
 * Single-library extractors per file would multiply boilerplate; grouping
 * them here matches the "everything that produces an MQ_CONSUMER record"
 * contract the downstream L1 worker-node logic depends on.
 *
 * Each pattern carries a different prefix in `route` so the L1 / L2b
 * panels can tell consumers apart by transport (kafka: / amqp: / redis:).
 *
 * The Redis subscribe pattern is the riskiest — `subscriber.subscribe`
 * is a generic shape that could false-match (e.g. a custom event-bus's
 * subscribe method). Import gating on `ioredis` / `redis` keeps the
 * match scoped.
 */

import type { FrameworkPlugin } from './types';

const REDIS_IMPORT = /(?:from\s+|require\s*\(\s*)['"]ioredis['"]|(?:from\s+|require\s*\(\s*)['"]redis['"]/;

export const mqConsumersPlugin: FrameworkPlugin = {
    id: 'mq-consumers',
    name: 'Message Queue Consumers (Kafka / RabbitMQ / Redis pub-sub)',
    languages: ['javascript', 'typescript'],
    patterns: [
        // kafkajs single-topic: `consumer.subscribe({ topic: 'X' })`
        {
            callPattern: /\bconsumer\s*\.\s*subscribe\s*\(\s*\{[^}]*topic\s*:\s*['"]([^'"]+)['"]/g,
            extract: (m) => ({ method: 'MQ_CONSUMER', route: `kafka:${m[1]}`, handlerName: `kafka:${m[1]}` }),
            skipInsideTemplate: true,
        },
        // kafkajs topics-array: `consumer.subscribe({ topics: ['a', 'b'] })`
        // Emits one MQ_CONSUMER record per topic in the array.
        {
            callPattern: /\bconsumer\s*\.\s*subscribe\s*\(\s*\{[^}]*topics\s*:\s*\[([^\]]+)\]/g,
            extract: (m) => {
                const topics = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
                if (topics.length === 0) return null;
                return topics.map((t) => ({ method: 'MQ_CONSUMER', route: `kafka:${t}`, handlerName: `kafka:${t}` }));
            },
            skipInsideTemplate: true,
        },
        // amqplib RabbitMQ: `channel.consume('queueName', handler)`. No
        // import gating — `channel.consume` is amqplib-specific enough
        // that a generic `channel` variable name with `.consume(...)` is
        // overwhelmingly amqplib in real codebases.
        {
            callPattern: /\bchannel\s*\.\s*consume\s*\(\s*['"]([^'"]+)['"]/g,
            extract: (m) => ({ method: 'MQ_CONSUMER', route: `amqp:${m[1]}`, handlerName: `amqp:${m[1]}` }),
            skipInsideTemplate: true,
        },
        // Generic Redis pub-sub: `subscriber.subscribe('channel', handler)`
        // Gated by ioredis / redis import — without the gate this regex
        // matches any `X.subscribe(...)` call, which is too broad.
        {
            callPattern: /\b(\w+)\s*\.\s*subscribe\s*\(\s*['"]([^'"]+)['"]/g,
            extract: (m, ctx) => {
                if (!REDIS_IMPORT.test(ctx.source)) return null;
                return { method: 'MQ_CONSUMER', route: `redis:${m[2]}`, handlerName: `redis:${m[2]}` };
            },
            skipInsideTemplate: true,
        },
    ],
};
