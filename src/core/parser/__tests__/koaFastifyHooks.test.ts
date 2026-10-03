/**
 * koaFastifyHooks.test.ts — UX-32 + UX-33 (2026-06-05).
 *
 * Pin the new behavior for Koa `router.use(mw)` and Fastify
 * `fastify.addHook('onRequest', fn)` — both apply to every route
 * registered on the same receiver in the file.
 */
import { describe, it, expect } from 'vitest';
import { detectApis } from '../apiDetector';

describe('UX-32 — Koa router.use(mw) propagates to every route on the router', () => {
    it('non-auth router.use(mw) lands on every same-receiver route', () => {
        const source = `
import Router from 'koa-router';
const router = new Router();

router.use(loggingMiddleware);
router.use(corsMiddleware);

router.get('/users', listUsers);
router.post('/users', createUser);
`;
        const apis = detectApis(source, 'src/routes.ts');
        const list = apis.find(a => a.method === 'GET' && a.route === '/users');
        const create = apis.find(a => a.method === 'POST' && a.route === '/users');
        expect(list?.meta?.middlewares).toEqual(expect.arrayContaining(['loggingMiddleware', 'corsMiddleware']));
        expect(create?.meta?.middlewares).toEqual(expect.arrayContaining(['loggingMiddleware', 'corsMiddleware']));
    });

    it('UX-32 Phase 2: receiver-aware scoping — a.use(mw) ONLY attaches to a.* routes, not b.*', () => {
        const source = `
const a = new Router();
const b = new Router();

a.use(authMiddleware);
b.use(loggingMiddleware);

a.get('/u', listUsers);
b.get('/v', listOther);
`;
        const apis = detectApis(source, 'src/routes.ts');
        const u = apis.find(r => r.route === '/u');
        const v = apis.find(r => r.route === '/v');
        // After Phase 2, scoping kicks in: each receiver's middlewares
        // attach only to its OWN routes.
        expect(u?.meta?.middlewares ?? []).toContain('authMiddleware');
        expect(u?.meta?.middlewares ?? []).not.toContain('loggingMiddleware');
        expect(v?.meta?.middlewares ?? []).toContain('loggingMiddleware');
        expect(v?.meta?.middlewares ?? []).not.toContain('authMiddleware');
    });

    it('UX-32 Phase 3: inline anonymous middleware gets synthesized as «anonymous@<line>»', () => {
        const source = `
const router = require('koa-router')();
router.use(async (ctx, next) => { await next(); });
router.get('/items', listItems);
`;
        const apis = detectApis(source, 'src/routes.ts');
        const items = apis.find(a => a.route === '/items');
        // The anonymous arrow should produce a label like `anonymous@<line>`.
        const mws = items?.meta?.middlewares ?? [];
        const anon = mws.find(m => m.startsWith('anonymous@'));
        expect(anon).toBeDefined();
    });

    it('UX-32 Phase 3: koa-compose chain unwraps each composed middleware', () => {
        const source = `
const compose = require('koa-compose');
const router = require('koa-router')();
router.use(compose([authMw, logMw, rateLimitMw]));
router.get('/items', listItems);
`;
        const apis = detectApis(source, 'src/routes.ts');
        const items = apis.find(a => a.route === '/items');
        expect(items?.meta?.middlewares).toEqual(expect.arrayContaining(['authMw', 'logMw', 'rateLimitMw']));
    });

    it('UX-32 Phase 2: same-receiver route still gets the chain', () => {
        const source = `
const r = new Router();
r.use(authMw);
r.use(logMw);
r.get('/a', h1);
r.post('/b', h2);
`;
        const apis = detectApis(source, 'src/routes.ts');
        const get = apis.find(a => a.route === '/a');
        const post = apis.find(a => a.route === '/b');
        expect(get?.meta?.middlewares).toEqual(expect.arrayContaining(['authMw', 'logMw']));
        expect(post?.meta?.middlewares).toEqual(expect.arrayContaining(['authMw', 'logMw']));
    });
});

describe('UX-33 — Fastify addHook walker', () => {
    it('fastify.addHook("preHandler", fn) lands on every route in the same file', () => {
        const source = `
const fastify = require('fastify')();

fastify.addHook('preHandler', verifyJwt);
fastify.addHook('onRequest', logRequest);

fastify.get('/items', (req, reply) => reply.send([]));
fastify.post('/items', (req, reply) => reply.send({ ok: true }));
`;
        const apis = detectApis(source, 'src/server.ts');
        const get = apis.find(a => a.method === 'GET' && a.route === '/items');
        const post = apis.find(a => a.method === 'POST' && a.route === '/items');
        expect(get?.meta?.middlewares).toEqual(expect.arrayContaining(['verifyJwt', 'logRequest']));
        expect(post?.meta?.middlewares).toEqual(expect.arrayContaining(['verifyJwt', 'logRequest']));
    });

    it('preSerialization + onResponse hooks ALSO captured (not just request-phase)', () => {
        const source = `
const fastify = require('fastify')();
fastify.addHook('preSerialization', shapeResponse);
fastify.addHook('onResponse', recordMetric);
fastify.get('/foo', (req, reply) => reply.send({}));
`;
        const apis = detectApis(source, 'src/server.ts');
        const foo = apis.find(a => a.route === '/foo');
        expect(foo?.meta?.middlewares).toEqual(expect.arrayContaining(['shapeResponse', 'recordMetric']));
    });

    it('addHook with auth-shaped name also derives meta.auth = required', () => {
        const source = `
const app = require('fastify')();
app.addHook('preHandler', requireAuth);
app.get('/secret', (req, reply) => reply.send({}));
`;
        const apis = detectApis(source, 'src/server.ts');
        const secret = apis.find(a => a.route === '/secret');
        expect(secret?.meta?.middlewares).toContain('requireAuth');
        expect(secret?.meta?.auth).toBe('required');
    });
});
