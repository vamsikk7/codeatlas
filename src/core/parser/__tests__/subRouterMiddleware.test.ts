/**
 * subRouterMiddleware.test.ts — UX-31 Phase 3 (2026-06-05).
 *
 * Express sub-router pattern:
 *   const r = Router();
 *   r.use(authMw);
 *   r.use(rateLimitMw);
 *   r.get('/users', listUsers);
 *   r.post('/users', createUser);
 *   app.use('/api', r);
 *
 * The middleware attached to `r` (sub-router) should appear on every
 * route registered on `r`. Phase 2's receiver-aware scoping already
 * handles the `r.use(mw)` → `r.get(...)` propagation in the same
 * file. This Phase 3 test pins that behavior — and also confirms the
 * mount path (`app.use('/api', r)`) doesn't pollute or block scoping.
 */
import { describe, it, expect } from 'vitest';
import { detectApis } from '../apiDetector';

describe('UX-31 Phase 3 — sub-router middleware bubble-up', () => {
    it('r.use(mw) + r.get(...) → routes carry mw', () => {
        const source = `
import { Router } from 'express';
const r = Router();
r.use(authMw);
r.use(rateLimitMw);
r.get('/users', listUsers);
r.post('/users', createUser);

const app = require('express')();
app.use('/api', r);
`;
        const apis = detectApis(source, 'src/routes.ts');
        const list = apis.find(a => a.method === 'GET' && a.route.endsWith('/users'));
        const create = apis.find(a => a.method === 'POST' && a.route.endsWith('/users'));
        expect(list?.meta?.middlewares).toEqual(expect.arrayContaining(['authMw', 'rateLimitMw']));
        expect(create?.meta?.middlewares).toEqual(expect.arrayContaining(['authMw', 'rateLimitMw']));
    });

    it('mount with prefix bubbles BOTH the prefix AND the sub-router middleware', () => {
        const source = `
import { Router } from 'express';
const r = Router();
r.use(authMw);
r.get('/secret', handler);

const app = require('express')();
app.use('/api', r);
`;
        const apis = detectApis(source, 'src/routes.ts');
        // After applyMountPrefixes (Phase 1.5) the route would become /api/secret.
        // detectApis emits the un-prefixed form; we just check the middleware lands.
        const secret = apis.find(a => a.method === 'GET' && /secret/.test(a.route));
        expect(secret?.meta?.middlewares).toContain('authMw');
    });

    it('sub-router middleware does NOT bleed to routes on a sibling router (UX-32 Phase 2 regression)', () => {
        const source = `
import { Router } from 'express';
const a = Router();
const b = Router();
a.use(authA);
b.use(authB);
a.get('/u', handler);
b.get('/v', handler);
`;
        const apis = detectApis(source, 'src/routes.ts');
        const u = apis.find(r => r.route === '/u');
        const v = apis.find(r => r.route === '/v');
        expect(u?.meta?.middlewares).toContain('authA');
        expect(u?.meta?.middlewares ?? []).not.toContain('authB');
        expect(v?.meta?.middlewares).toContain('authB');
        expect(v?.meta?.middlewares ?? []).not.toContain('authA');
    });
});
