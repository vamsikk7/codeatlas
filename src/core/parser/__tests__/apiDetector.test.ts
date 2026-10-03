import { describe, it, expect } from 'vitest';
import { detectApis, classifyExternalSystem, detectMountPoints, applyMountPrefixes } from '../apiDetector';
import type { ApiRecord } from '../../graph/graphTypes';

describe('apiDetector', () => {
    describe('detectApis', () => {
        it('should detect Express router.get()', () => {
            const code = `
import express from 'express';
const router = express.Router();

function getUserHandler(req, res) {
  res.json({ id: 1 });
}

router.get("/users/:id", getUserHandler);`;

            const apis = detectApis(code, 'src/api/users.js');

            expect(apis).toHaveLength(1);
            expect(apis[0].method).toBe('GET');
            expect(apis[0].route).toBe('/users/:id');
            expect(apis[0].handlerName).toBe('getUserHandler');
            expect(apis[0].filePath).toBe('src/api/users.js');
        });

        it('should detect app.post()', () => {
            const code = `
const express = require('express');
const app = express();

app.post("/users", function createUser(req, res) {
  res.json({ created: true });
});`;

            const apis = detectApis(code, 'app.js');

            expect(apis).toHaveLength(1);
            expect(apis[0].method).toBe('POST');
            expect(apis[0].route).toBe('/users');
        });

        it('should detect multiple route registrations', () => {
            const code = `
const router = require('express').Router();

router.get("/users", listUsers);
router.post("/users", createUser);
router.put("/users/:id", updateUser);
router.delete("/users/:id", deleteUser);`;

            const apis = detectApis(code, 'routes.js');

            expect(apis).toHaveLength(4);
            expect(apis.map((a) => a.method)).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
        });

        it('should handle arrow function handlers', () => {
            const code = `
router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});`;

            const apis = detectApis(code, 'health.js');

            expect(apis).toHaveLength(1);
            expect(apis[0].method).toBe('GET');
            expect(apis[0].route).toBe('/health');
        });

        it('should not detect non-HTTP method calls', () => {
            const code = `
const db = require('pg');
db.query("SELECT * FROM users");
console.log("hello");`;

            const apis = detectApis(code, 'db.js');

            expect(apis).toHaveLength(0);
        });

        it('should generate correct apiId', () => {
            const code = `router.get("/users", getUsers);`;
            const apis = detectApis(code, 'api.js');

            expect(apis[0].apiId).toBe('GET:/users::api.js::getUsers');
        });

        it('should include anchor spans', () => {
            const code = `router.get("/test", testHandler);`;
            const apis = detectApis(code, 'test.js');

            expect(apis[0].anchor).toBeDefined();
            expect(apis[0].anchor.span).toBeDefined();
            expect(apis[0].anchor.span!.start).toBeGreaterThanOrEqual(0);
            expect(apis[0].anchor.span!.end).toBeGreaterThan(apis[0].anchor.span!.start);
        });

        it('detects routes in TypeScript files with parameter type annotations', () => {
            const code = `
import { Request, Response, Router } from 'express';
const router = Router();
router.post('/users', async (req: Request, res: Response) => {
  res.json({});
});`;
            const apis = detectApis(code, 'src/routes.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].method).toBe('POST');
            expect(apis[0].route).toBe('/users');
        });

        it('detects routes with middleware argument before the handler', () => {
            const code = `router.get('/user', auth.required, async (req, res) => { res.json({}); });`;
            const apis = detectApis(code, 'src/routes.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].method).toBe('GET');
            expect(apis[0].route).toBe('/user');
        });

        it('detects async arrow function handlers', () => {
            const code = `router.post('/articles', async (req, res, next) => { res.json({}); });`;
            const apis = detectApis(code, 'src/routes.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].method).toBe('POST');
        });

        it('gives distinct handler names to GET and PUT on the same route', () => {
            const code = `
router.get('/user', async (req, res) => { res.json({}); });
router.put('/user', async (req, res) => { res.json({}); });`;
            const apis = detectApis(code, 'src/routes.ts');
            expect(apis).toHaveLength(2);
            expect(apis[0].handlerName).not.toBe(apis[1].handlerName);
            expect(apis[0].handlerName).toContain('GET');
            expect(apis[1].handlerName).toContain('PUT');
        });

        it('detects routes with TypeScript types and middleware', () => {
            const code = `
import { NextFunction, Request, Response, Router } from 'express';
import auth from './auth';
const router = Router();
router.get('/user', auth.required, async (req: Request, res: Response, next: NextFunction) => {
  res.json({});
});`;
            const apis = detectApis(code, 'src/auth.controller.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].method).toBe('GET');
            expect(apis[0].route).toBe('/user');
        });

        it('detects all routes in a TypeScript controller file with 4 routes', () => {
            const code = `
import { Request, Response, Router } from 'express';
const router = Router();
router.post('/users', async (req: Request, res: Response) => { res.json({}); });
router.post('/users/login', async (req: Request, res: Response) => { res.json({}); });
router.get('/user', auth.required, async (req: Request, res: Response) => { res.json({}); });
router.put('/user', auth.required, async (req: Request, res: Response) => { res.json({}); });`;
            const apis = detectApis(code, 'src/auth.controller.ts');
            expect(apis).toHaveLength(4);
            expect(apis.map(a => a.method)).toEqual(['POST', 'POST', 'GET', 'PUT']);
            expect(apis.map(a => a.route)).toEqual(['/users', '/users/login', '/user', '/user']);
            const names = apis.map(a => a.handlerName);
            expect(new Set(names).size).toBe(4);
        });

        // Regression: Issue 325 — chained `router.route('/x').get(h).post(h)` form
        // had its method calls skipped because the first arg is a handler, not a
        // route string. Detector now walks back the chain to recover the path
        // from the upstream `.route(path)` call.
        it('detects chained router.route(path).METHOD(handler) registrations', () => {
            const code = `
const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');

router
  .route('/')
  .post(userController.createUser)
  .get(userController.getUsers);

router
  .route('/:userId')
  .get(userController.getUser)
  .patch(userController.updateUser)
  .delete(userController.deleteUser);

module.exports = router;`;
            const apis = detectApis(code, 'src/routes/v1/user.route.js');
            expect(apis).toHaveLength(5);
            // Babel visits outermost CallExpression first, so the chain
            // `.post(h).get(h)` yields .get before .post in the result array.
            expect(new Set(apis.map(a => `${a.method} ${a.route}`))).toEqual(
                new Set([
                    'POST /',
                    'GET /',
                    'GET /:userId',
                    'PATCH /:userId',
                    'DELETE /:userId',
                ]),
            );
        });

        // Regression: routes like `router.post('/login', validate(...), authController.login)`
        // pass a MemberExpression as the final handler argument. The detector previously
        // only recognized Identifier and ArrowFunctionExpression / FunctionExpression
        // shapes, so handlerName fell through as empty string '', and the orchestrator's
        // per-file `handlersSeen` Set deduplicated every route in the file down to a
        // single sequence graph (js-express produced 1 sequence for 14 routes).
        it('extracts handler name from MemberExpression like authController.login', () => {
            const code = `
const router = require('express').Router();
const authController = require('../../controllers/auth.controller');
const validate = require('../../middlewares/validate');
const authValidation = require('../../validations/auth.validation');

router.post('/register', validate(authValidation.register), authController.register);
router.post('/login', validate(authValidation.login), authController.login);
router.post('/logout', validate(authValidation.logout), authController.logout);
`;
            const apis = detectApis(code, 'src/routes/v1/auth.route.js');
            expect(apis).toHaveLength(3);
            expect(apis.map(a => a.handlerName)).toEqual(['register', 'login', 'logout']);
            // Names must be distinct so per-file dedup keeps each route's sequence graph.
            expect(new Set(apis.map(a => a.handlerName)).size).toBe(3);
        });

        // Issue 408: middleware identifiers between route and handler must be
        // captured on ApiRecord.meta so L2b can render auth indicators and L3
        // can insert middleware participants.
        it('captures middleware list on meta.middlewares and derives meta.auth=required', () => {
            const code = `
const router = require('express').Router();
const auth = require('../auth/auth');
router.get('/articles/:slug', auth.required, getArticleBySlug);
`;
            const apis = detectApis(code, 'src/routes/article/article.controller.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].handlerName).toBe('getArticleBySlug');
            expect(apis[0].meta?.middlewares).toEqual(['auth.required']);
            expect(apis[0].meta?.auth).toBe('required');
        });

        it('derives meta.auth=optional from auth.optional middleware', () => {
            const code = `
const router = require('express').Router();
const auth = require('../auth/auth');
router.get('/articles', auth.optional, listArticles);
`;
            const apis = detectApis(code, 'src/routes/article/article.controller.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].meta?.middlewares).toEqual(['auth.optional']);
            expect(apis[0].meta?.auth).toBe('optional');
        });

        it('captures multiple middleware in order', () => {
            const code = `
const router = require('express').Router();
router.post('/admin/users', auth.required, requireRole, validate.body, createUser);
`;
            const apis = detectApis(code, 'src/routes/admin.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].meta?.middlewares).toEqual(['auth.required', 'requireRole', 'validate.body']);
            expect(apis[0].meta?.auth).toBe('required');
        });

        it('routes with no middleware have no meta.auth and no meta.middlewares', () => {
            const code = `
const router = require('express').Router();
router.get('/health', healthHandler);
`;
            const apis = detectApis(code, 'src/health.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].meta?.middlewares).toBeUndefined();
            expect(apis[0].meta?.auth).toBeUndefined();
        });

        it('falls back to JSDoc @auth required when no middleware is present', () => {
            const code = `
const router = require('express').Router();
/**
 * Get user profile.
 * @auth required
 */
router.get('/profile/:id', getProfile);
`;
            const apis = detectApis(code, 'src/routes/profile.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].meta?.auth).toBe('required');
        });

        // Issue 419 follow-up: derive `meta.auth=required` from common
        // non-Express auth-middleware factories (Hono `basicAuth`/`bearerAuth`/
        // `jwt`, Passport `passport.authenticate`, `expressJwt`).
        it('Issue 419: derives meta.auth=required from Hono basicAuth() factory', () => {
            const code = `
const app = new Hono();
app.use('/auth/*', basicAuth({ username: 'x', password: 'y' }));
app.get('/auth/page', basicAuth({ username: 'x', password: 'y' }), (c) => c.text('ok'));
`;
            const apis = detectApis(code, 'src/index.ts');
            const route = apis.find(a => a.route === '/auth/page');
            expect(route?.meta?.auth).toBe('required');
            expect(route?.meta?.middlewares).toContain('basicAuth');
        });

        it('Issue 419: derives meta.auth=required from bearerAuth() factory', () => {
            const code = `
app.get('/protected', bearerAuth({ token: 'abc' }), (c) => c.json({ ok: true }));
`;
            const apis = detectApis(code, 'src/index.ts');
            expect(apis[0].meta?.auth).toBe('required');
        });

        it('Issue 419: derives meta.auth=required from jwt() factory', () => {
            const code = `
app.get('/api/me', jwt({ secret: 'shh' }), (c) => c.json({}));
`;
            const apis = detectApis(code, 'src/index.ts');
            expect(apis[0].meta?.auth).toBe('required');
        });

        // Issue 419 follow-up: Hono mount-level glob propagation.
        // `app.use('/auth/*', basicAuth({...}))` then `app.get('/auth/page', handler)`
        // → route inherits middleware via path-glob match.
        it('Issue 419: Hono mount-level basicAuth propagates to /auth/* routes', () => {
            const code = `
const app = new Hono();
app.use('/auth/*', basicAuth({ username: 'x', password: 'y' }));
app.get('/auth/page', (c) => c.text('protected'));
app.get('/public', (c) => c.text('open'));
`;
            const apis = detectApis(code, 'src/app.ts');
            const authRoute = apis.find(a => a.route === '/auth/page');
            const publicRoute = apis.find(a => a.route === '/public');
            expect(authRoute?.meta?.auth).toBe('required');
            expect(authRoute?.meta?.middlewares).toContain('basicAuth');
            expect(publicRoute?.meta?.auth).toBeUndefined();
        });

        it('Issue 419: mount glob /api/* matches multiple downstream routes', () => {
            const code = `
app.use('/api/*', bearerAuth({ token: 'abc' }));
app.get('/api/users', (c) => c.json([]));
app.post('/api/items', (c) => c.json({}));
app.get('/health', (c) => c.json({ ok: true }));
`;
            const apis = detectApis(code, 'src/index.ts');
            expect(apis.find(a => a.route === '/api/users')?.meta?.auth).toBe('required');
            expect(apis.find(a => a.route === '/api/items')?.meta?.auth).toBe('required');
            expect(apis.find(a => a.route === '/health')?.meta?.auth).toBeUndefined();
        });

        // Issue 419 follow-up: Fastify options-object preHandler/onRequest extraction.
        it('Issue 419: Fastify options-object preHandler captured as middleware', () => {
            const code = `
fastify.get('/users', { preHandler: auth, schema: { tags: ['Users'] } }, async (req, reply) => reply.send([]));
`;
            const apis = detectApis(code, 'src/routes.ts');
            const route = apis.find(a => a.route === '/users');
            expect(route?.meta?.middlewares).toContain('auth');
            expect(route?.meta?.auth).toBe('required');
        });

        it('Issue 419: Fastify options-object onRequest array of middlewares', () => {
            const code = `
fastify.post('/admin', { onRequest: [authRequired, requireAdmin], schema: {} }, async (req, reply) => reply.send({}));
`;
            const apis = detectApis(code, 'src/admin.ts');
            const route = apis.find(a => a.route === '/admin');
            expect(route?.meta?.middlewares).toEqual(expect.arrayContaining(['authRequired', 'requireAdmin']));
            expect(route?.meta?.auth).toBe('required');
        });

        it('Issue 419: Fastify options without middleware hooks does not flag auth', () => {
            const code = `
fastify.get('/items', { schema: { tags: ['Items'] } }, async (req, reply) => reply.send([]));
`;
            const apis = detectApis(code, 'src/items.ts');
            const route = apis.find(a => a.route === '/items');
            expect(route?.meta?.middlewares).toBeUndefined();
            expect(route?.meta?.auth).toBeUndefined();
        });

        // Issue 419 follow-up: Koa-style global auth middleware.
        it('Issue 419: Koa app.use(authMiddleware) propagates to all routes in the file', () => {
            const code = `
const app = new Koa();
app.use(authMiddleware);
const router = new Router();
router.get('/users', listUsers);
router.post('/items', createItem);
`;
            const apis = detectApis(code, 'src/api.ts');
            for (const a of apis) {
                expect(a.meta?.middlewares).toContain('authMiddleware');
                expect(a.meta?.auth).toBe('required');
            }
        });

        it('Issue 419: Koa unrelated middleware (cors, logger) does not flag routes', () => {
            const code = `
app.use(cors());
app.use(logger());
router.get('/users', listUsers);
`;
            const apis = detectApis(code, 'src/api.ts');
            expect(apis[0].meta?.auth).toBeUndefined();
        });

        it('Issue 419: derives meta.auth=required from passport.authenticate', () => {
            const code = `
router.get('/profile', passport.authenticate('jwt', { session: false }), (req, res) => res.json({}));
`;
            const apis = detectApis(code, 'src/profile.ts');
            expect(apis[0].meta?.auth).toBe('required');
            expect(apis[0].meta?.middlewares).toContain('passport.authenticate');
        });

        it('captures middleware invoked as a call expression', () => {
            const code = `
const router = require('express').Router();
router.post('/login', rateLimit({ max: 5 }), login);
`;
            const apis = detectApis(code, 'src/routes/auth.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].meta?.middlewares).toEqual(['rateLimit']);
        });

        // Issue 414: for-loop with a template-literal route emits ONE
        // parameterized record (`/random/:index`) rather than N substituted
        // routes. The `meta.dynamicRange` carries iteration cardinality so
        // renderers can show "25 routes" without cluttering L2b with N rows.
        it('emits ONE parameterized ApiRecord for a constant-bound for-loop with template-literal route', () => {
            const code = `
const router = require('express').Router();
for (let index = 1; index <= 5; index += 1) {
  router.get(\`/random/\${index}\`, (req, res) => res.json({}));
}
`;
            const apis = detectApis(code, 'src/random.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].route).toBe('/random/:index');
            expect(apis[0].method).toBe('GET');
            expect(apis[0].handlerName).toBe('anonymous@GET:/random/:index');
            expect(apis[0].meta?.dynamicRange).toEqual({ var: 'index', from: 1, to: 5, step: 1, count: 5 });
        });

        it('uses const-bound numeric upper bound for the dynamicRange', () => {
            const code = `
const ROUTE_COUNT = 3;
for (let i = 1; i <= ROUTE_COUNT; i++) {
  router.get(\`/r/\${i}\`, (req, res) => res.end());
}
`;
            const apis = detectApis(code, 'src/x.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].route).toBe('/r/:i');
            expect(apis[0].meta?.dynamicRange).toEqual({ var: 'i', from: 1, to: 3, step: 1, count: 3 });
        });

        it('handles `i < N` (exclusive) and `i++` update', () => {
            const code = `
for (let i = 0; i < 4; i++) {
  router.post(\`/p/\${i}\`, (req, res) => res.end());
}
`;
            const apis = detectApis(code, 'src/y.ts');
            expect(apis).toHaveLength(1);
            expect(apis[0].route).toBe('/p/:i');
            expect(apis[0].meta?.dynamicRange).toEqual({ var: 'i', from: 0, to: 3, step: 1, count: 4 });
        });

        it('does not unroll loops whose body has no routing call', () => {
            const code = `for (let i = 0; i < 3; i++) { console.log(i); }`;
            const apis = detectApis(code, 'src/z.ts');
            expect(apis).toHaveLength(0);
        });

        it('does not double-emit when an outer non-template route is also present', () => {
            const code = `
router.get('/static', (req, res) => res.end());
for (let i = 1; i <= 2; i++) {
  router.get(\`/dyn/\${i}\`, (req, res) => res.end());
}
`;
            const apis = detectApis(code, 'src/mix.ts');
            const routes = apis.map(a => a.route).sort();
            expect(routes).toEqual(['/dyn/:i', '/static']);
        });

        it('anchor points at the arrow body, not the call expression, so click-through opens the handler', () => {
            const code = `for (let i = 1; i <= 3; i++) { router.get(\`/x/\${i}\`, (req, res) => { res.json('ok'); }); }`;
            const apis = detectApis(code, 'src/r.ts');
            expect(apis).toHaveLength(1);
            const arrowStart = code.indexOf('(req, res) =>');
            expect(apis[0].anchor.span.start).toBe(arrowStart);
        });

        // Issue 418: Express error-handling middleware — `app.use(<4-arg fn>)`.
        it('detects 4-arg error middleware as MIDDLEWARE with meta.error=true', () => {
            const code = `
const express = require('express');
const app = express();
app.use((err, req, res, next) => {
  res.status(500).json(err.message);
});
`;
            const apis = detectApis(code, 'src/main.ts');
            const errs = apis.filter(a => a.method === 'MIDDLEWARE' && a.meta?.error);
            expect(errs).toHaveLength(1);
            expect(errs[0].route).toBe('/*');
            expect(errs[0].handlerName).toBe('errorHandler');
        });

        // UX-31 (2026-06-04) — Express `app.param('id', loader)` /
        // `router.param('id', loader)` registers a param-loader middleware
        // that runs on every route whose path contains `:id`. Without
        // this detection, sequences for those routes miss a critical
        // pre-handler hop. Pin the behaviour.
        it('UX-31: detects router.param("id", loader) and binds to routes containing :id', () => {
            const code = `
import express from 'express';
const router = express.Router();

function loadUser(req, res, next, id) {
  req.user = { id };
  next();
}

router.param('id', loadUser);

function getUser(req, res) { res.json(req.user); }
function listUsers(req, res) { res.json([]); }

router.get('/users/:id', getUser);
router.get('/users', listUsers);
`;
            const apis = detectApis(code, 'src/users.js');
            const getUser = apis.find(a => a.handlerName === 'getUser');
            const listUsers = apis.find(a => a.handlerName === 'listUsers');
            // The :id route should carry loadUser in its middleware chain.
            expect(getUser?.meta?.middlewares).toContain('loadUser');
            // The non-:id route should NOT carry it.
            expect(listUsers?.meta?.middlewares ?? []).not.toContain('loadUser');
        });

        it('UX-31: multiple param loaders bind to routes with matching params', () => {
            const code = `
const express = require('express');
const router = express.Router();

router.param('userId', loadUser);
router.param('postId', loadPost);

function getPost(req, res) {}
function getUser(req, res) {}

router.get('/users/:userId/posts/:postId', getPost);
router.get('/users/:userId', getUser);
`;
            const apis = detectApis(code, 'src/r.ts');
            const getPost = apis.find(a => a.handlerName === 'getPost');
            const getUser = apis.find(a => a.handlerName === 'getUser');
            // /users/:userId/posts/:postId → both loaders
            expect(getPost?.meta?.middlewares).toEqual(expect.arrayContaining(['loadUser', 'loadPost']));
            // /users/:userId → only loadUser
            expect(getUser?.meta?.middlewares).toContain('loadUser');
            expect(getUser?.meta?.middlewares ?? []).not.toContain('loadPost');
        });

        it('UX-31: router.param does NOT bind when route has no matching :param', () => {
            const code = `
const router = require('express').Router();
router.param('userId', loadUser);
function listAll(req, res) {}
router.get('/all', listAll);
`;
            const apis = detectApis(code, 'src/r.ts');
            const listAll = apis.find(a => a.handlerName === 'listAll');
            expect(listAll?.meta?.middlewares ?? []).not.toContain('loadUser');
        });

        it('detects named function-expression error middleware', () => {
            const code = `
app.use(function handleError(err, req, res, next) {
  res.status(500).end();
});
`;
            const apis = detectApis(code, 'src/main.ts');
            const errs = apis.filter(a => a.method === 'MIDDLEWARE' && a.meta?.error);
            expect(errs).toHaveLength(1);
            expect(errs[0].handlerName).toBe('handleError');
        });

        it('does not flag 3-arg middleware as error middleware', () => {
            const code = `
app.use((req, res, next) => { next(); });
`;
            const apis = detectApis(code, 'src/main.ts');
            // 3-arg use() isn't an error handler and isn't (today) emitted as a route either.
            const errs = apis.filter(a => a.meta?.error);
            expect(errs).toHaveLength(0);
        });

        it('does not flag app.use(prefix, router) as error middleware', () => {
            const code = `
app.use('/api', userRouter);
`;
            const apis = detectApis(code, 'src/main.ts');
            const errs = apis.filter(a => a.meta?.error);
            expect(errs).toHaveLength(0);
        });

        it('chained .route() captures the path even when middleware is interspersed', () => {
            const code = `
const express = require('express');
const auth = require('../middlewares/auth');
const validate = require('../middlewares/validate');
const userValidation = require('../validations/user.validation');
const router = express.Router();

router
  .route('/')
  .post(auth('manageUsers'), validate(userValidation.createUser), createUser);
`;
            const apis = detectApis(code, 'src/routes/v1/user.route.js');
            expect(apis).toHaveLength(1);
            expect(apis[0].method).toBe('POST');
            expect(apis[0].route).toBe('/');
            // Bare-identifier handler is captured as a regression of the chain
            // walk, distinct from middleware identifiers passed earlier.
            expect(apis[0].handlerName).toBe('createUser');
        });
    });

    // #771 (2026-06-06) — Koa middleware-only apps: when a file has zero
    // .get/.post/etc. registrations BUT contains `app.use(async (ctx) => { ctx.body = … })`
    // middleware that writes a response, emit a synthetic catch-all route
    // so the file isn't invisible in the L2b API list.
    describe('Koa middleware-only fallback (#771)', () => {
        it('emits a synthetic ANY * route for app.use((ctx) => ctx.body = …)', () => {
            const code = `
const Koa = require('koa');
const app = new Koa();
app.use(async function(ctx) {
  ctx.body = 'secret';
});
app.listen(3000);
`;
            const apis = detectApis(code, 'app.js');
            expect(apis.length).toBeGreaterThan(0);
            const synthetic = apis.find(a => a.method === 'ANY');
            expect(synthetic).toBeTruthy();
            expect(synthetic?.route).toBe('*');
        });

        it('does NOT emit a synthetic route when the file has any explicit route registrations', () => {
            const code = `
const Koa = require('koa');
const Router = require('koa-router');
const app = new Koa();
const router = new Router();
router.get('/users', (ctx) => { ctx.body = 'list'; });
app.use(router.routes());
app.listen(3000);
`;
            const apis = detectApis(code, 'app.js');
            // Existing detector emits GET /users; the synthetic should be skipped.
            const synthetic = apis.find(a => a.method === 'ANY' && a.route === '*');
            expect(synthetic).toBeFalsy();
        });

        it('does NOT emit a synthetic route when middleware does NOT set ctx.body / ctx.status / ctx.type', () => {
            const code = `
const Koa = require('koa');
const app = new Koa();
app.use(async function(ctx, next) {
  console.log('logging request');
  await next();
});
app.listen(3000);
`;
            const apis = detectApis(code, 'app.js');
            expect(apis.length).toBe(0);
        });

        it('emits a synthetic route for arrow-function middleware that sets ctx.body', () => {
            const code = `
const Koa = require('koa');
const app = new Koa();
app.use(async (ctx) => {
  ctx.body = 'arrow form';
});
app.listen(3000);
`;
            const apis = detectApis(code, 'app.js');
            expect(apis.some(a => a.method === 'ANY' && a.route === '*')).toBe(true);
        });

        it('emits a synthetic route when middleware sets ctx.status without a body', () => {
            const code = `
const Koa = require('koa');
const app = new Koa();
app.use(async (ctx) => {
  ctx.status = 204;
});
app.listen(3000);
`;
            const apis = detectApis(code, 'app.js');
            expect(apis.some(a => a.method === 'ANY' && a.route === '*')).toBe(true);
        });

        it('does NOT emit when the file has no app.use call at all', () => {
            const code = `
const Koa = require('koa');
const app = new Koa();
app.listen(3000);
`;
            const apis = detectApis(code, 'app.js');
            expect(apis).toEqual([]);
        });
    });

    describe('detectMountPoints', () => {
        it('detects app.use with ESM import', () => {
            const code = `
import express from 'express';
import todoRouter from './routes/todos';
const app = express();
app.use('/api/todos', todoRouter);`;
            const mounts = detectMountPoints(code);
            expect(mounts).toHaveLength(1);
            expect(mounts[0].prefix).toBe('/api/todos');
            expect(mounts[0].routerVar).toBe('todoRouter');
            expect(mounts[0].importSource).toBe('./routes/todos');
        });

        it('detects app.use with CJS require', () => {
            const code = `
const express = require('express');
const userRouter = require('./routes/users');
const app = express();
app.use('/users', userRouter);`;
            const mounts = detectMountPoints(code);
            expect(mounts).toHaveLength(1);
            expect(mounts[0].prefix).toBe('/users');
            expect(mounts[0].importSource).toBe('./routes/users');
        });

        it('detects multiple mount points', () => {
            const code = `
import todoRouter from './routes/todos';
import userRouter from './routes/users';
app.use('/api/todos', todoRouter);
app.use('/api/users', userRouter);`;
            const mounts = detectMountPoints(code);
            expect(mounts).toHaveLength(2);
            expect(mounts.map(m => m.prefix)).toContain('/api/todos');
            expect(mounts.map(m => m.prefix)).toContain('/api/users');
        });

        it('ignores non-prefix use() calls (middleware without string first arg)', () => {
            const code = `
app.use(express.json());
app.use(logger);`;
            const mounts = detectMountPoints(code);
            expect(mounts).toHaveLength(0);
        });

        it('returns empty for files with no mount points', () => {
            const code = `
router.get('/health', (req, res) => res.json({ ok: true }));`;
            const mounts = detectMountPoints(code);
            expect(mounts).toHaveLength(0);
        });

        // Issue 417: composite Router().use(child).use(child2) chains followed
        // by a `Router().use('/api', api)` mount should expand to one MountPoint
        // per child with the same prefix.
        it('expands composite Router().use(child).use(child2) chains', () => {
            const code = `
import { Router } from 'express';
import tagsController from './tag/tag.controller';
import articlesController from './article/article.controller';
import authController from './auth/auth.controller';

const api = Router()
  .use(tagsController)
  .use(articlesController)
  .use(authController);

export default Router().use('/api', api);
`;
            const mounts = detectMountPoints(code);
            // 3 child routers under the /api prefix
            const apiMounts = mounts.filter(m => m.prefix === '/api');
            expect(apiMounts).toHaveLength(3);
            const sources = apiMounts.map(m => m.importSource).sort();
            expect(sources).toEqual([
                './article/article.controller',
                './auth/auth.controller',
                './tag/tag.controller',
            ]);
        });

        it('does not unroll a chain that mixes prefixed and unprefixed mounts (lossy)', () => {
            const code = `
import a from './a';
import b from './b';
const api = Router().use(a).use('/path', b);
export default Router().use('/api', api);
`;
            const mounts = detectMountPoints(code);
            // We bail on chains with internal prefixed mounts (safer than guessing).
            // The outer `app.use('/api', api)` produces an empty importSource for `api`,
            // and the internal `.use('/path', b)` is captured as a separate mount.
            const innerMount = mounts.find(m => m.prefix === '/path');
            expect(innerMount).toBeDefined();
            expect(innerMount?.importSource).toBe('./b');
            // The composite expansion is suppressed for this lossy case.
            const apiMounts = mounts.filter(m => m.prefix === '/api');
            expect(apiMounts.every(m => m.importSource === '')).toBe(true);
        });

        it('handles a chained const root mount with both string prefix and routerVar', () => {
            // Inline composite with the final outer mount in the same chain.
            const code = `
import a from './a';
import b from './b';
export default Router().use(a).use(b);
`;
            const mounts = detectMountPoints(code);
            // No outer prefixed mount → no composite expansion needed.
            expect(mounts).toHaveLength(0);
        });
    });

    describe('applyMountPrefixes', () => {
        const makeApi = (route: string, filePath: string, handlerName: string): ApiRecord => ({
            apiId: `GET:${route}::${filePath}::${handlerName}`,
            method: 'GET',
            route,
            handlerName,
            filePath,
            anchor: { filePath },
        });

        it('patches route and apiId when mount point matches', () => {
            const entryCode = `
import todoRouter from './routes/todos';
app.use('/api/todos', todoRouter);`;
            const routerCode = `router.get('/', listTodos);`;

            const apiIndex: Record<string, ApiRecord> = {
                'GET:/::routes/todos.js::listTodos': makeApi('/', 'routes/todos.js', 'listTodos'),
            };
            const fileContents = new Map([
                ['app.js', entryCode],
                ['routes/todos.js', routerCode],
            ]);

            const patched = applyMountPrefixes(apiIndex, fileContents, '/workspace');
            const entries = Object.values(patched);
            expect(entries).toHaveLength(1);
            expect(entries[0].route).toBe('/api/todos');
            expect(entries[0].rawRoute).toBe('/');
            expect(entries[0].apiId).toBe('GET:/api/todos::routes/todos.js::listTodos');
        });

        it('preserves sub-routes correctly', () => {
            const entryCode = `
import userRouter from './routes/users';
app.use('/api/users', userRouter);`;

            const apiIndex: Record<string, ApiRecord> = {
                'GET:/::routes/users.js::listUsers': makeApi('/', 'routes/users.js', 'listUsers'),
                'GET:/:id::routes/users.js::getUser': makeApi('/:id', 'routes/users.js', 'getUser'),
                'POST:/::routes/users.js::createUser': {
                    ...makeApi('/', 'routes/users.js', 'createUser'),
                    method: 'POST',
                    apiId: 'POST:/::routes/users.js::createUser',
                },
            };
            const fileContents = new Map([
                ['app.js', entryCode],
                ['routes/users.js', ''],
            ]);

            const patched = applyMountPrefixes(apiIndex, fileContents, '/workspace');
            const routes = Object.values(patched).map(a => a.route).sort();
            expect(routes).toContain('/api/users');
            expect(routes).toContain('/api/users/:id');
        });

        it('does not re-patch APIs that already have rawRoute set (idempotent)', () => {
            const entryCode = `
import todoRouter from './routes/todos';
app.use('/api/todos', todoRouter);`;

            const alreadyPatched: ApiRecord = {
                ...makeApi('/api/todos', 'routes/todos.js', 'listTodos'),
                rawRoute: '/',
                apiId: 'GET:/api/todos::routes/todos.js::listTodos',
            };
            const apiIndex = { 'GET:/api/todos::routes/todos.js::listTodos': alreadyPatched };
            const fileContents = new Map([
                ['app.js', entryCode],
                ['routes/todos.js', ''],
            ]);

            const patched = applyMountPrefixes(apiIndex, fileContents, '/workspace');
            const entry = Object.values(patched)[0];
            // Should remain /api/todos — not become /api/todos/api/todos
            expect(entry.route).toBe('/api/todos');
        });

        it('leaves APIs untouched when no mount point targets their file', () => {
            const entryCode = `app.use('/api/todos', todoRouter);`; // todoRouter not imported
            const apiIndex: Record<string, ApiRecord> = {
                'GET:/health::app.js::healthCheck': makeApi('/health', 'app.js', 'healthCheck'),
            };
            const fileContents = new Map([['app.js', entryCode]]);

            const patched = applyMountPrefixes(apiIndex, fileContents, '/workspace');
            expect(Object.values(patched)[0].route).toBe('/health');
            expect(Object.values(patched)[0].rawRoute).toBeUndefined();
        });

        it('returns original index unchanged when no files have mount points', () => {
            const apiIndex: Record<string, ApiRecord> = {
                'GET:/health::server.js::health': makeApi('/health', 'server.js', 'health'),
            };
            const fileContents = new Map([
                ['server.js', `app.get('/health', health);`],
            ]);

            const patched = applyMountPrefixes(apiIndex, fileContents, '/workspace');
            expect(patched).toBe(apiIndex); // same reference — no mutation
        });
    });

    describe('classifyExternalSystem', () => {
        it('should classify database imports', () => {
            expect(classifyExternalSystem('pg')).toBe('database');
            expect(classifyExternalSystem('mongoose')).toBe('database');
            expect(classifyExternalSystem('prisma')).toBe('database');
            expect(classifyExternalSystem('sequelize')).toBe('database');
        });

        it('should classify cache imports', () => {
            expect(classifyExternalSystem('redis')).toBe('cache');
            expect(classifyExternalSystem('ioredis')).toBe('cache');
            expect(classifyExternalSystem('valkey')).toBe('cache');
        });

        it('should classify storage imports', () => {
            expect(classifyExternalSystem('aws-sdk/s3')).toBe('storage');
            expect(classifyExternalSystem('@google-cloud/storage')).toBe('storage');
        });

        it('should classify service/HTTP imports', () => {
            expect(classifyExternalSystem('axios')).toBe('service');
            expect(classifyExternalSystem('got')).toBe('service');
        });

        it('should default to module for unknown imports', () => {
            expect(classifyExternalSystem('lodash')).toBe('module');
            expect(classifyExternalSystem('./utils')).toBe('module');
        });
    });
});
