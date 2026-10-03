/**
 * fastifyRegisterPrefix.test.ts — UX-33 Phase 3 (2026-06-05).
 *
 * Fastify plugin registration with prefix:
 *   async function v1Plugin(app) {
 *     app.get('/users', listUsers);
 *   }
 *   fastify.register(v1Plugin, { prefix: '/v1' });
 *
 * The route `/users` inside v1Plugin should resolve to `/v1/users`
 * once the prefix bubbles. Without this, every Fastify app using
 * register-with-prefix renders the un-prefixed paths in L2b.
 *
 * Cross-plugin isolation: when two plugins both name their param
 * `app`, middleware shouldn't cross-pollinate.
 */
import { describe, it, expect } from 'vitest';
import { detectApis } from '../apiDetector';

describe('UX-33 Phase 3 — Fastify register() prefix bubble', () => {
    it('routes inside register(plugin, { prefix: "/v1" }) get the prefix', () => {
        const source = `
async function v1Plugin(app) {
    app.get('/users', listUsers);
    app.post('/users', createUser);
}
const fastify = require('fastify')();
fastify.register(v1Plugin, { prefix: '/v1' });
`;
        const apis = detectApis(source, 'src/v1.ts');
        const list = apis.find(a => a.method === 'GET');
        const create = apis.find(a => a.method === 'POST');
        expect(list?.route).toBe('/v1/users');
        expect(create?.route).toBe('/v1/users');
    });

    it('plugin without prefix → routes stay un-prefixed', () => {
        const source = `
async function noPrefixPlugin(app) {
    app.get('/foo', handler);
}
const fastify = require('fastify')();
fastify.register(noPrefixPlugin);
`;
        const apis = detectApis(source, 'src/np.ts');
        const foo = apis.find(a => a.route === '/foo');
        expect(foo).toBeDefined();
    });

    it('two plugins with different prefixes route correctly', () => {
        const source = `
async function adminPlugin(app) {
    app.get('/users', listUsers);
}
async function publicPlugin(app) {
    app.get('/health', health);
}
const fastify = require('fastify')();
fastify.register(adminPlugin, { prefix: '/admin' });
fastify.register(publicPlugin, { prefix: '/public' });
`;
        const apis = detectApis(source, 'src/plugins.ts');
        const users = apis.find(a => a.route === '/admin/users');
        const health = apis.find(a => a.route === '/public/health');
        expect(users).toBeDefined();
        expect(health).toBeDefined();
    });
});
