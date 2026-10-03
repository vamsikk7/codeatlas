/**
 * frameworksRegistry.test.ts — Issue #703 Phase 1
 *
 * Locks the plugin-registry contract before any per-framework extraction
 * lands. Every claim made in `docs/v2-frontend-mobile-layer-spec.md` §0
 * about non-regression hinges on the registry behaving predictably —
 * these tests pin that down.
 */

import { describe, it, expect } from 'vitest';
import { FrameworkRegistry } from '../frameworks/registry';
import type { FrameworkPlugin } from '../frameworks/types';

function makePlugin(over: Partial<FrameworkPlugin> = {}): FrameworkPlugin {
    return {
        id: 'test',
        name: 'Test',
        languages: ['javascript'],
        patterns: [],
        ...over,
    };
}

describe('FrameworkRegistry', () => {
    it('starts empty', () => {
        const r = new FrameworkRegistry();
        expect(r.size()).toBe(0);
        expect(r.all()).toEqual([]);
        expect(r.getForLanguage('javascript')).toEqual([]);
    });

    it('register() adds a plugin, getById finds it, size goes up', () => {
        const r = new FrameworkRegistry();
        const p = makePlugin({ id: 'express', name: 'Express' });
        r.register(p);
        expect(r.size()).toBe(1);
        expect(r.getById('express')).toBe(p);
        expect(r.getById('missing')).toBeUndefined();
    });

    it('getForLanguage returns plugins for that language in registration order', () => {
        const r = new FrameworkRegistry();
        const express = makePlugin({ id: 'express', languages: ['javascript', 'typescript'] });
        const nestjs = makePlugin({ id: 'nestjs', languages: ['typescript'] });
        const fastapi = makePlugin({ id: 'fastapi', languages: ['python'] });
        r.register(express);
        r.register(nestjs);
        r.register(fastapi);
        expect(r.getForLanguage('javascript').map((p) => p.id)).toEqual(['express']);
        expect(r.getForLanguage('typescript').map((p) => p.id)).toEqual(['express', 'nestjs']);
        expect(r.getForLanguage('python').map((p) => p.id)).toEqual(['fastapi']);
        // Unregistered language returns empty list, not undefined.
        expect(r.getForLanguage('go')).toEqual([]);
    });

    it('getForLanguage returns a copy — mutating the result does not affect the registry', () => {
        const r = new FrameworkRegistry();
        r.register(makePlugin({ id: 'a', languages: ['javascript'] }));
        const first = r.getForLanguage('javascript');
        first.push(makePlugin({ id: 'leak', languages: ['javascript'] }));
        const second = r.getForLanguage('javascript');
        expect(second.map((p) => p.id)).toEqual(['a']);
    });

    it('all() returns plugins in registration order', () => {
        const r = new FrameworkRegistry();
        const order = ['c', 'a', 'b'];
        for (const id of order) r.register(makePlugin({ id }));
        expect(r.all().map((p) => p.id)).toEqual(order);
    });

    it('register() throws on duplicate id', () => {
        const r = new FrameworkRegistry();
        r.register(makePlugin({ id: 'express' }));
        expect(() => r.register(makePlugin({ id: 'express' }))).toThrow(/Duplicate plugin id "express"/);
    });

    it('register() throws when languages is empty', () => {
        const r = new FrameworkRegistry();
        expect(() => r.register(makePlugin({ languages: [] }))).toThrow(/zero languages/);
    });

    it('register() throws when languages is missing entirely', () => {
        const r = new FrameworkRegistry();
        // Force a malformed plugin to verify the runtime guard fires —
        // the type system would normally prevent this, but plugins
        // imported from untyped JS would slip through.
        const bad = makePlugin();
        (bad as unknown as { languages: undefined }).languages = undefined;
        expect(() => r.register(bad)).toThrow(/zero languages/);
    });

    it('_clearForTests resets the registry to empty', () => {
        const r = new FrameworkRegistry();
        r.register(makePlugin({ id: 'a' }));
        r.register(makePlugin({ id: 'b' }));
        r._clearForTests();
        expect(r.size()).toBe(0);
        expect(r.getForLanguage('javascript')).toEqual([]);
        // After clear, ids can be re-registered without conflict.
        expect(() => r.register(makePlugin({ id: 'a' }))).not.toThrow();
    });

    it('singleton from frameworks/index.ts registers one plugin per extracted framework (Phase 2+ contract)', async () => {
        // Per Issue #703 Phase 2 onward — each extracted framework adds
        // one plugin to the singleton at module-load time. This test
        // grows as more frameworks are extracted.
        const { frameworkRegistry } = await import('../frameworks');
        const ids = frameworkRegistry.all().map((p) => p.id).sort();
        // Phase 2 extraction: NestJS only.
        expect(ids).toContain('nestjs');
    });

    it('NestJS plugin (Phase 2) carries the expected patterns and suppression flags', async () => {
        // Lock the contract for the first extracted framework. Future
        // refactors that change pattern shape will tip this test off so
        // the regression is caught at unit-test time instead of via the
        // expensive `verify:real` cycle.
        const { frameworkRegistry } = await import('../frameworks');
        const nestjs = frameworkRegistry.getById('nestjs');
        expect(nestjs).toBeDefined();
        expect(nestjs!.languages.sort()).toEqual(['javascript', 'typescript']);
        // 3 patterns: route decorators (@Get/@Post/...) + class prefix
        // (@Controller) + Terminus @HealthCheck (folded in via PR-9).
        expect(nestjs!.patterns).toHaveLength(3);
        // Every NestJS pattern must declare skipInsideTemplate to preserve
        // the pre-#703 dispatcher suppression behaviour.
        expect(nestjs!.patterns.every((p) => p.skipInsideTemplate === true)).toBe(true);
        // Both patterns are decorator-based (NestJS is a decorator-driven framework).
        expect(nestjs!.patterns.every((p) => !!p.decoratorPattern)).toBe(true);
    });

    it('Bull / BullMQ plugin (Phase 2 PR-3) carries 3 JOB patterns', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const bull = frameworkRegistry.getById('bull');
        expect(bull).toBeDefined();
        expect(bull!.name).toBe('Bull / BullMQ');
        expect(bull!.languages.sort()).toEqual(['javascript', 'typescript']);
        // 3 patterns: Worker constructor + queue.process + NestJS @Process.
        expect(bull!.patterns).toHaveLength(3);
        expect(bull!.patterns.every((p) => p.skipInsideTemplate === true)).toBe(true);
        // Two call patterns + one decorator pattern.
        const callPatternCount = bull!.patterns.filter((p) => !!p.callPattern).length;
        const decoratorPatternCount = bull!.patterns.filter((p) => !!p.decoratorPattern).length;
        expect(callPatternCount).toBe(2);
        expect(decoratorPatternCount).toBe(1);
    });

    it('MQ Consumers plugin (PR-4) carries 4 MQ_CONSUMER patterns across 3 transports', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const mq = frameworkRegistry.getById('mq-consumers');
        expect(mq).toBeDefined();
        expect(mq!.languages.sort()).toEqual(['javascript', 'typescript']);
        // 4 patterns: kafka single-topic + kafka topics-array + amqp + redis pub-sub.
        expect(mq!.patterns).toHaveLength(4);
        expect(mq!.patterns.every((p) => p.skipInsideTemplate === true)).toBe(true);
        expect(mq!.patterns.every((p) => !!p.callPattern)).toBe(true);
    });

    it('MQ Consumers Redis pattern requires ioredis/redis import (gating)', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const mq = frameworkRegistry.getById('mq-consumers')!;
        // The 4th pattern is the Redis pub-sub pattern (generic subscribe).
        const redisPattern = mq.patterns[3];
        const ctxBase = { filePath: 'x.ts', language: 'typescript' as const };

        const noImport = `eventBus.subscribe('channel', handler);`;
        const m1 = /\b(\w+)\s*\.\s*subscribe\s*\(\s*['"]([^'"]+)['"]/g.exec(noImport)!;
        expect(redisPattern.extract(m1, { ...ctxBase, source: noImport })).toBeNull();

        const withImport = `import Redis from 'ioredis';\nsubscriber.subscribe('news', handler);`;
        const m2 = /\b(\w+)\s*\.\s*subscribe\s*\(\s*['"]([^'"]+)['"]/g.exec(withImport)!;
        expect(redisPattern.extract(m2, { ...ctxBase, source: withImport })).toEqual({
            method: 'MQ_CONSUMER', route: 'redis:news', handlerName: 'redis:news',
        });
    });

    it('GraphQL plugin (PR-17) carries 4 patterns with skipInGraphqlTestFile flag for 5 languages', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const gql = frameworkRegistry.getById('graphql');
        expect(gql).toBeDefined();
        expect(gql!.languages.sort()).toEqual(['java', 'javascript', 'kotlin', 'python', 'typescript']);
        // 4 patterns: NestJS @Query/@Mutation/@Subscription, Apollo SDL,
        // resolver-object shorthand, @Resolver class decorator.
        expect(gql!.patterns).toHaveLength(4);
        // EVERY GraphQL pattern must declare skipInGraphqlTestFile — this is
        // the only way to preserve the pre-#703 dispatcher behaviour now that
        // `graphqlPatterns.has(pattern)` returns false.
        expect(gql!.patterns.every((p) => p.skipInGraphqlTestFile === true)).toBe(true);
    });

    it('gRPC plugin (PR-17) carries 3 patterns with skipInComment:false for 4 languages', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const grpc = frameworkRegistry.getById('grpc');
        expect(grpc).toBeDefined();
        // UX-42 (2026-06-05): added 'python' so the Python `add_XxxServicer_to_server`
        // pattern actually runs against .py sources.
        expect(grpc!.languages.sort()).toEqual(['go', 'javascript', 'python', 'typescript']);
        // 3 patterns: proto rpc, Node addService, Python add_XxxServicer_to_server.
        expect(grpc!.patterns).toHaveLength(3);
        // gRPC opts OUT of the default skipInComment behaviour — proto files
        // have doc comments adjacent to rpc declarations that we still want
        // to match.
        expect(grpc!.patterns.every((p) => p.skipInComment === false)).toBe(true);
    });

    it('Single-language plugins (PR-16) are registered per language with correct pattern counts', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const rust = frameworkRegistry.getById('rust');
        const csharp = frameworkRegistry.getById('csharp');
        const php = frameworkRegistry.getById('php');
        const ruby = frameworkRegistry.getById('ruby');
        const swift = frameworkRegistry.getById('swift');
        expect(rust).toBeDefined();
        expect(csharp).toBeDefined();
        expect(php).toBeDefined();
        expect(ruby).toBeDefined();
        expect(swift).toBeDefined();

        expect(rust!.languages).toEqual(['rust']);
        // 8 Rust patterns: Actix #[get], Actix web::resource.route, Actix web::resource.to,
        // Axum .nest, Axum .route, Rocket #[get], Rocket .mount routes!, Rocket Fairings.
        expect(rust!.patterns).toHaveLength(8);

        expect(csharp!.languages).toEqual(['csharp']);
        // 3 C# patterns: [HttpVerb], [Route], app.MapVerb.
        expect(csharp!.patterns).toHaveLength(3);

        expect(php!.languages).toEqual(['php']);
        // 9 PHP patterns: Laravel array controller, Laravel basic, Laravel
        // fluent chain (UX-40: `Route::middleware(...)->get(...)`), Symfony
        // #[Route], Laravel Route::resource, Symfony AsCommand, Symfony
        // Console legacy, Laravel artisan $signature, Laravel ShouldQueue.
        expect(php!.patterns).toHaveLength(9);

        expect(ruby!.languages).toEqual(['ruby']);
        // 9 Ruby patterns: Rails DSL, resources, devise_for, Sinatra,
        // before_action filters, Sidekiq, ActiveJob, Rails migrations, AR callbacks.
        expect(ruby!.patterns).toHaveLength(9);

        expect(swift!.languages).toEqual(['swift']);
        // 1 Swift pattern: Vapor app/router/group.verb(...).
        expect(swift!.patterns).toHaveLength(1);
    });

    it('Go plugin (PR-15) carries 4 patterns and rejects stdlib receivers', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const go = frameworkRegistry.getById('go');
        expect(go).toBeDefined();
        expect(go!.languages).toEqual(['go']);
        // 4 patterns: Gin/Echo uppercase verbs, Chi/Fiber mixed-case, net/http,
        // and the gorilla/mux concatenated-route + .Methods() form (#928).
        expect(go!.patterns).toHaveLength(4);

        // Stdlib receiver rejection (http.Get is NOT a server route).
        const stdlibCtx = { filePath: 'x.go', source: 'http.GET("/u", h)', language: 'go' as const };
        const m1 = /\b(\w+)\s*\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Handle)\s*\(\s*"([^"]*)"/g.exec(stdlibCtx.source)!;
        expect(go!.patterns[0].extract(m1, stdlibCtx)).toBeNull();

        // Real router receiver yields the route.
        const ginSrc = 'router.GET("/users", listUsers)';
        const m2 = /\b(\w+)\s*\.\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Handle)\s*\(\s*"([^"]*)"/g.exec(ginSrc)!;
        expect(go!.patterns[0].extract(m2, { ...stdlibCtx, source: ginSrc })).toEqual({ method: 'GET', route: '/users' });
    });

    it('Java-Spring plugin (PR-14) covers both java and kotlin languages', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const spring = frameworkRegistry.getById('java-spring');
        expect(spring).toBeDefined();
        expect(spring!.languages.sort()).toEqual(['java', 'kotlin']);
        // 19 Spring patterns (Mapping, RequestMapping, JAX-RS GET, @Path,
        // Micronaut, Mapping-bare, WebFlux route, WebFlux RouterFunctions,
        // Aspect, Around/Before/After advice, Filter, HandlerInterceptor,
        // @Scheduled, @Async, @KafkaListener, @RabbitListener,
        // @JmsListener, @StreamListener, @ShellMethod).
        expect(spring!.patterns).toHaveLength(19);
        // Verify the plugin shows up for both languages.
        expect(frameworkRegistry.getForLanguage('java').some((p) => p.id === 'java-spring')).toBe(true);
        expect(frameworkRegistry.getForLanguage('kotlin').some((p) => p.id === 'java-spring')).toBe(true);
    });

    it('Ktor plugin (PR-14) is kotlin-only and carries 5 Ktor-DSL patterns', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const ktor = frameworkRegistry.getById('ktor');
        expect(ktor).toBeDefined();
        expect(ktor!.languages).toEqual(['kotlin']);
        // 5 patterns: routing verb-with-path, Locations API, WebSocket,
        // SSE, path-less verb block.
        expect(ktor!.patterns).toHaveLength(5);
        // The plugin must NOT appear for Java (Ktor is Kotlin-only).
        expect(frameworkRegistry.getForLanguage('java').some((p) => p.id === 'ktor')).toBe(false);
        expect(frameworkRegistry.getForLanguage('kotlin').some((p) => p.id === 'ktor')).toBe(true);
    });

    it('Python plugin (PR-13) carries the Python framework bundle', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const py = frameworkRegistry.getById('python');
        expect(py).toBeDefined();
        expect(py!.languages).toEqual(['python']);
        // 27 patterns covering web routing + Django/DRF + class-based endpoints
        // (#877) + CLI/jobs (incl. @instrumented_task) + ORM hooks + FastAPI
        // @router.api_route explicit-methods route (BUG-HEALTH/api_route).
        expect(py!.patterns).toHaveLength(27); // +1: @router.api_route(methods=[...])
        // None of the Python patterns carry the JS-only template flag.
        expect(py!.patterns.every((p) => !p.skipInsideTemplate)).toBe(true);

        // Smoke-test the Flask/FastAPI decorator.
        const flaskPat = py!.patterns[0];
        const ctx = { filePath: 'app/routes.py', source: "@app.get('/users')\ndef list_users():", language: 'python' as const };
        const m = /@(?:app|router|blueprint|bp)\s*\.\s*(route|get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/gi.exec(ctx.source)!;
        expect(flaskPat.extract(m, ctx)).toEqual({ method: 'GET', route: '/users' });
    });

    it('Meta-frameworks plugin (PR-12) carries 12 file-system-routed patterns', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const mf = frameworkRegistry.getById('meta-frameworks');
        expect(mf).toBeDefined();
        expect(mf!.languages.sort()).toEqual(['javascript', 'typescript']);
        // 6 Next.js (incl. #879 defaultHandler) + 1 Nuxt + 1 Remix + 3 SvelteKit + 1 tRPC = 12.
        expect(mf!.patterns).toHaveLength(12);
        // Meta-framework patterns deliberately have NO skipInsideTemplate
        // flag — pre-#703 they were excluded from the dispatcher's
        // template-literal suppression set, and the extraction preserves
        // that exact behaviour.
        expect(mf!.patterns.every((p) => !p.skipInsideTemplate)).toBe(true);
        expect(mf!.patterns.every((p) => !!p.callPattern)).toBe(true);

        // Smoke-test the Next.js App Router pattern.
        const pat = mf!.patterns[0];
        const ctx = { filePath: 'src/app/api/users/route.ts', source: 'export async function GET() {}', language: 'typescript' as const };
        const m = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/gi.exec(ctx.source)!;
        expect(pat.extract(m, ctx)).toEqual({ method: 'GET', route: '/users', handlerName: 'GET' });
    });

    it('Node HTTP plugin (PR-11) carries the Express/Koa/Fastify catch-all', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const np = frameworkRegistry.getById('node-http');
        expect(np).toBeDefined();
        expect(np!.name).toBe('Node HTTP (Express / Koa / Fastify)');
        expect(np!.languages.sort()).toEqual(['javascript', 'typescript']);
        expect(np!.patterns).toHaveLength(1);
        expect(np!.patterns.every((p) => p.skipInsideTemplate === true)).toBe(true);

        const pat = np!.patterns[0];
        const ctxBase = { filePath: 'x.ts', language: 'typescript' as const };

        // All four binding identifiers extract correctly.
        for (const id of ['router', 'app', 'server', 'fastify']) {
            const src = `${id}.post('/users', handler);`;
            const m = /\b(?:router|app|server|fastify)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi.exec(src)!;
            expect(pat.extract(m, { ...ctxBase, source: src })).toEqual({ method: 'POST', route: '/users' });
        }
    });

    it('Hono plugin (PR-10) carries the one HTTP routing pattern', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const hono = frameworkRegistry.getById('hono');
        expect(hono).toBeDefined();
        expect(hono!.name).toBe('Hono');
        expect(hono!.languages.sort()).toEqual(['javascript', 'typescript']);
        // 1 pattern: app.get/post/put/patch/delete/options/head/all.
        expect(hono!.patterns).toHaveLength(1);
        expect(hono!.patterns.every((p) => p.skipInsideTemplate === true)).toBe(true);
        expect(hono!.patterns.every((p) => !!p.callPattern)).toBe(true);

        // Extraction yields uppercase method + literal route.
        const pat = hono!.patterns[0];
        const ctxBase = { filePath: 'x.ts', language: 'typescript' as const };
        const src = `app.get('/users', handler);`;
        const m = /\bapp\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi.exec(src)!;
        expect(pat.extract(m, { ...ctxBase, source: src })).toEqual({ method: 'GET', route: '/users' });
    });

    it('Node EventEmitter plugin (PR-8) carries 2 patterns and gates on events/EventEmitter signal', async () => {
        const { frameworkRegistry } = await import('../frameworks');
        const ne = frameworkRegistry.getById('node-events');
        expect(ne).toBeDefined();
        expect(ne!.name).toBe('Node EventEmitter');
        expect(ne!.languages.sort()).toEqual(['javascript', 'typescript']);
        // 2 patterns: emitter.on listener + emitter.emit site.
        expect(ne!.patterns).toHaveLength(2);
        expect(ne!.patterns.every((p) => p.skipInsideTemplate === true)).toBe(true);
        expect(ne!.patterns.every((p) => !!p.callPattern)).toBe(true);

        const listener = ne!.patterns[0];
        const emitter = ne!.patterns[1];
        const ctxBase = { filePath: 'x.ts', language: 'typescript' as const };

        // Without the EventEmitter signal, both patterns yield null
        // (this is the gate that stops `socket.on(...)` / `$.on(...)` /
        // DOM listeners from being mis-classified).
        const noSignal = `bus.on('userCreated', (u) => {});`;
        const m1 = /\b(\w+)\s*\.on\s*\(\s*['"]([^'"]+)['"]\s*,/gi.exec(noSignal)!;
        expect(listener.extract(m1, { ...ctxBase, source: noSignal })).toBeNull();

        const noSignal2 = `bus.emit('userCreated', user);`;
        const m2 = /\b(\w+)\s*\.emit\s*\(\s*['"]([^'"]+)['"]/gi.exec(noSignal2)!;
        expect(emitter.extract(m2, { ...ctxBase, source: noSignal2 })).toBeNull();

        // With `events` import: listener pattern emits EVENT_LISTENER.
        const withImport = `import { EventEmitter } from 'events';\nbus.on('userCreated', (u) => {});`;
        const m3 = /\b(\w+)\s*\.on\s*\(\s*['"]([^'"]+)['"]\s*,/gi.exec(withImport)!;
        expect(listener.extract(m3, { ...ctxBase, source: withImport })).toEqual({
            method: 'EVENT_LISTENER', route: 'event:userCreated', handlerName: 'bus',
        });

        // With `extends EventEmitter`: emit pattern emits EVENT_EMIT.
        const withExtends = `class Bus extends EventEmitter {}\nbus.emit('userCreated', user);`;
        const m4 = /\b(\w+)\s*\.emit\s*\(\s*['"]([^'"]+)['"]/gi.exec(withExtends)!;
        expect(emitter.extract(m4, { ...ctxBase, source: withExtends })).toEqual({
            method: 'EVENT_EMIT', route: 'event:userCreated', handlerName: 'bus',
        });
    });

    it('Bull plugin Worker pattern extracts JOB record only when bull/bullmq is imported', async () => {
        // Locks the gating behaviour — without the import guard, every
        // `new Worker('x')` would false-match (node:worker_threads, Web
        // Workers, custom Worker classes, …). The gate is the single
        // most important correctness invariant of this plugin.
        const { frameworkRegistry } = await import('../frameworks');
        const bull = frameworkRegistry.getById('bull')!;
        const workerPattern = bull.patterns.find((p) => p.callPattern?.source.startsWith('new\\s+Worker'))!;
        expect(workerPattern).toBeDefined();

        const ctxBase = { filePath: 'x.ts', language: 'typescript' as const };

        // Without import: extract returns null.
        const noImport = `const w = new Worker('emails', handler);`;
        const noImportMatch = /new\s+Worker\s*\(\s*['"]([^'"]+)['"]/g.exec(noImport)!;
        expect(workerPattern.extract(noImportMatch, { ...ctxBase, source: noImport })).toBeNull();

        // With bullmq import: extract returns a JOB record.
        const withImport = `import { Worker } from 'bullmq';\nconst w = new Worker('emails', handler);`;
        const withImportMatch = /new\s+Worker\s*\(\s*['"]([^'"]+)['"]/g.exec(withImport)!;
        const result = workerPattern.extract(withImportMatch, { ...ctxBase, source: withImport });
        expect(result).toEqual({ method: 'JOB', route: 'queue:emails', handlerName: 'worker:emails' });
    });
});
