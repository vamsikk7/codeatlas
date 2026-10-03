/**
 * functionScopeReceiver.test.ts — UX-32 Phase 4 (2026-06-05).
 *
 * Cross-plugin isolation: two Fastify plugins both use `app` as the
 * function parameter. Without function-scope tracking, `adminPlugin`'s
 * `app.addHook('preHandler', adminAuth)` would leak into `publicPlugin`'s
 * routes too, because both share the receiver name `app` at file scope.
 *
 * The fix: track which function body each `<recv>.use(mw)` /
 * `<recv>.addHook(...)` belongs to, and during route emission only
 * apply middlewares whose function-scope matches the route's
 * function-scope.
 */
import { describe, it, expect } from 'vitest';
import { detectApis } from '../apiDetector';

describe('UX-32 Phase 4 — function-scope receiver isolation', () => {
    it('two plugins both using `app` param: middleware does NOT cross-pollinate', () => {
        const source = `
async function adminPlugin(app) {
    app.addHook('preHandler', adminAuth);
    app.get('/users', listUsers);
}
async function publicPlugin(app) {
    app.addHook('preHandler', rateLimit);
    app.get('/health', healthCheck);
}
const fastify = require('fastify')();
fastify.register(adminPlugin, { prefix: '/admin' });
fastify.register(publicPlugin, { prefix: '/public' });
`;
        const apis = detectApis(source, 'src/plugins.ts');
        const users = apis.find(a => a.route === '/admin/users');
        const health = apis.find(a => a.route === '/public/health');
        expect(users?.meta?.middlewares).toContain('adminAuth');
        expect(users?.meta?.middlewares ?? []).not.toContain('rateLimit');
        expect(health?.meta?.middlewares).toContain('rateLimit');
        expect(health?.meta?.middlewares ?? []).not.toContain('adminAuth');
    });

    it('single plugin with `app` param: same-function middleware still attaches', () => {
        const source = `
async function v1Plugin(app) {
    app.addHook('preHandler', authMw);
    app.get('/users', listUsers);
}
const fastify = require('fastify')();
fastify.register(v1Plugin, { prefix: '/v1' });
`;
        const apis = detectApis(source, 'src/v1.ts');
        const users = apis.find(a => a.route === '/v1/users');
        expect(users?.meta?.middlewares).toContain('authMw');
    });

    it('top-level use() + function-scoped use() do not cross', () => {
        const source = `
const fastify = require('fastify')();
fastify.addHook('preHandler', globalAuth);

async function adminPlugin(app) {
    app.addHook('preHandler', adminAuth);
    app.get('/users', listUsers);
}
fastify.register(adminPlugin, { prefix: '/admin' });

fastify.get('/health', healthCheck);
`;
        const apis = detectApis(source, 'src/mixed.ts');
        const users = apis.find(a => a.route === '/admin/users');
        const health = apis.find(a => a.route === '/health');
        // Admin route gets only adminAuth from its function scope.
        expect(users?.meta?.middlewares).toContain('adminAuth');
        expect(users?.meta?.middlewares ?? []).not.toContain('globalAuth');
        // Health route gets only the top-level globalAuth.
        expect(health?.meta?.middlewares).toContain('globalAuth');
        expect(health?.meta?.middlewares ?? []).not.toContain('adminAuth');
    });
});
