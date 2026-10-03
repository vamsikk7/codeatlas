import * as path from 'path';
import { parseJSAuto } from './jsParser';
import { parseJSCached } from './astCache';
import { srcText, normalizeSpace } from './symbolExtractor';
import type { ApiRecord } from '../graph/graphTypes';
import _traverse from '@babel/traverse';

const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

/**
 * Detect Express/Koa/Fastify style API route registrations in JavaScript code.
 * Uses heuristic matching on common routing patterns.
 */
export function detectApis(code: string, filePath: string): ApiRecord[] {
    // INVARIANT (ADR-022): full-file parses route through the AST cache.
    const ast = parseJSCached(code, filePath);
    const apis: ApiRecord[] = [];

    // Issue 419 follow-up: Hono / Express mount-level middleware propagation.
    // Walk `<obj>.use('<glob>', middleware1, middleware2, …)` calls FIRST so
    // we can match later route registrations against their path globs and
    // inherit the auth middleware. Globs match `/path/*` against `/path/...`
    // and `/path/something` patterns.
    const mountMiddlewares: Array<{ matcher: RegExp; mws: string[] }> = collectMountMiddlewares(ast);

    // Issue 419 follow-up: Koa-style global auth middleware. When a file
    // contains `app.use(<authMiddleware>)` WITHOUT a path arg before any
    // routes (Koa's chain pattern), every subsequent route in this file
    // inherits the middleware. Only triggers when the middleware identifier
    // is one of the known auth names — we don't want every `app.use(cors())`
    // to flag routes as auth.required.
    //
    // UX-32 Phase 4 (2026-06-05): list of {receiver, mw, scope}. Scope
    // is the enclosing function body span (or null for top-level), used
    // to keep two plugins both using `app` from cross-pollinating.
    const globalAuthEntries: ScopedMiddleware[] = collectGlobalAuthMiddleware(ast);

    // UX-31 (2026-06-04): Express `router.param('paramName', loaderFn)`
    // registers a middleware that runs whenever a route in the same
    // router has `:paramName` in its path. Collect the bindings here
    // and apply per-route below so a `GET /users/:id` route picks up
    // the `loadUser` loader as a middleware participant in L3.
    const paramLoaders: Map<string, string[]> = collectParamLoaders(ast);

    // UX-33 Phase 3 (2026-06-05): Fastify register-with-prefix bubble.
    // `fastify.register(v1Plugin, { prefix: '/v1' })` — every route
    // declared inside `v1Plugin`'s body should resolve to `/v1/<route>`.
    // Collects `Array<{ start, end, prefix }>` ranges of plugin function
    // bodies plus the prefix to apply; route emission below checks if
    // the route's source offset falls inside any range and prepends.
    const fastifyRegisterPrefixes: Array<{ start: number; end: number; prefix: string }> = collectFastifyRegisterPrefixes(ast);

    // UX-32 (2026-06-05): Koa-style `router.use(mw)` for NON-auth middleware.
    // The existing `globalAuthMws` collector only captures auth-shaped names
    // so generic middleware (logging, cors, validation) is dropped.
    //
    // UX-33 (2026-06-05): Fastify `<recv>.addHook('phase', fn)` lifecycle
    // hooks. `addHook` is the plugin-level analog of route-options-object
    // hooks (preHandler / onRequest / preSerialization / onResponse / etc.).
    //
    // UX-32 Phase 4 (2026-06-05): receiver- AND function-scope aware
    // middleware entries. Each carries `{receiver, mw, scope}` where
    // `scope` is the enclosing function body span or null for top-level.
    // The route loop filters on BOTH receiver match AND scope match so
    // two plugins both using `app` as their param don't bleed across.
    const routerScopeEntries: ScopedMiddleware[] = collectRouterScopeAndHookMiddleware(ast);

    // UX-32 Phase 2 follow-up: scoping ONLY makes sense when the
    // `.use(mw)` receiver is itself a route receiver. The Koa pattern
    //   const app = new Koa();
    //   app.use(authMw);
    //   const router = new Router();
    //   router.get('/users', ...);
    // has `app` as the .use receiver but `router` as the route
    // receiver — strict scoping would drop authMw on the floor. Build
    // the set of route receivers up-front so the route loop can
    // distinguish "scoped router middleware" from "app-level chain
    // middleware".
    const routeReceivers = new Set<string>();
    traverse(ast, {
        CallExpression(p: any) {
            const c = p.node.callee;
            if (c?.type !== 'MemberExpression') return;
            const verb = c.property?.name?.toLowerCase();
            if (!verb || !HTTP_METHODS.has(verb)) return;
            if (c.object?.type === 'Identifier') routeReceivers.add(c.object.name);
        },
    });

    traverse(ast, {
        // Issue 414: constant-bound `for (let i = N; i <= M; i++)` loops that
        // register routes with template-literal paths interpolating the loop
        // variable emit ONE parameterized ApiRecord per route registration —
        // not N records. The route uses Express-style `:<loopVar>` syntax so
        // the handler can be opened from L2b / L3 click-throughs (the anchor
        // points at the shared arrow body). A `meta.dynamicRange` carries the
        // start/end/step so consumers can show "25 routes" in tooltips.
        ForStatement(forPath: any) {
            const stmt = forPath.node;
            if (stmt.init?.type !== 'VariableDeclaration' || stmt.init.declarations?.length !== 1) return;
            const decl = stmt.init.declarations[0];
            if (decl.id?.type !== 'Identifier') return;
            const loopVar: string = decl.id.name;
            const startVal = evalNumericLiteral(decl.init, ast);
            if (startVal === null) return;
            const test = stmt.test;
            if (test?.type !== 'BinaryExpression') return;
            if (test.left?.type !== 'Identifier' || test.left.name !== loopVar) return;
            let inclusive: boolean;
            if (test.operator === '<=') inclusive = true;
            else if (test.operator === '<') inclusive = false;
            else return;
            const endVal = evalNumericLiteral(test.right, ast);
            if (endVal === null) return;
            const step = parseLoopStep(stmt.update, loopVar);
            if (step === null || step <= 0 || step > 1000) return;
            const totalRaw = inclusive
                ? Math.floor((endVal - startVal) / step) + 1
                : Math.floor((endVal - 1 - startVal) / step) + 1;
            if (totalRaw <= 0) return;
            const lastVal = inclusive ? endVal : endVal - 1;

            forPath.traverse({
                CallExpression(innerPath: any) {
                    const c = innerPath.node;
                    if (c.callee?.type !== 'MemberExpression') return;
                    const method = c.callee.property?.name?.toLowerCase();
                    if (!method || !HTTP_METHODS.has(method)) return;
                    const args = c.arguments || [];
                    if (args.length < 2) return;
                    const routeArg = args[0];
                    if (routeArg.type !== 'TemplateLiteral') return;
                    // Build parameterized route: substitute the loop variable
                    // with `:<loopVar>`; any other interpolation expression bails
                    // (we'd need a name for it and we don't trust the heuristic).
                    let paramRoute = '';
                    let ok = true;
                    for (let i = 0; i < routeArg.quasis.length; i++) {
                        paramRoute += routeArg.quasis[i].value.raw;
                        if (i < routeArg.expressions.length) {
                            const ex = routeArg.expressions[i];
                            if (ex?.type === 'Identifier' && ex.name === loopVar) {
                                paramRoute += `:${loopVar}`;
                            } else {
                                ok = false; break;
                            }
                        }
                    }
                    if (!ok) return;
                    if (!paramRoute.startsWith('/') && paramRoute !== '*') return;

                    const handlerArg = args[args.length - 1];
                    let handlerName = '';
                    let arrowNode: any = null;
                    if (handlerArg.type === 'Identifier') {
                        handlerName = handlerArg.name;
                    } else if (handlerArg.type === 'ArrowFunctionExpression' || handlerArg.type === 'FunctionExpression') {
                        handlerName = handlerArg.id?.name || `anonymous@${method.toUpperCase()}:${paramRoute}`;
                        arrowNode = handlerArg;
                    } else if (handlerArg.type === 'MemberExpression' && handlerArg.property?.type === 'Identifier') {
                        handlerName = handlerArg.property.name;
                    }
                    const apiId = `${method.toUpperCase()}:${paramRoute}::${filePath}::${handlerName}`;
                    // Anchor at the arrow body if inline, else at the call site,
                    // so navigation lands on something meaningful.
                    const anchorSpan = arrowNode
                        ? { start: arrowNode.start ?? 0, end: arrowNode.end ?? 0 }
                        : { start: c.start ?? 0, end: c.end ?? 0 };
                    apis.push({
                        apiId,
                        method: method.toUpperCase(),
                        route: paramRoute,
                        handlerName,
                        filePath,
                        anchor: {
                            filePath,
                            symbol: handlerName,
                            span: anchorSpan,
                        },
                        meta: {
                            dynamicRange: { var: loopVar, from: startVal, to: lastVal, step, count: totalRaw },
                        },
                    });
                    // Skip the outer CallExpression visitor on this same node so
                    // it doesn't try to emit an empty-route record for the
                    // interpolated template literal.
                    innerPath.skip();
                },
            });
        },
        CallExpression(path: any) {
            const node = path.node;
            const callee = node.callee;

            // Issue 418: Express error-handling middleware — `app.use(fn)` where
            // `fn` is a 4-arg `(err, req, res, next) => …`. Express dispatches on
            // arity (4 = error handler), so we match on parameter count, not the
            // first param's name. Emit as method=MIDDLEWARE + meta.error=true so
            // the L2b "Request Hooks" section renders it with a distinct marker.
            if (
                callee.type === 'MemberExpression' &&
                callee.property?.type === 'Identifier' &&
                callee.property.name === 'use'
            ) {
                const args = node.arguments || [];
                const candidate = args[args.length - 1];
                if (
                    candidate &&
                    (candidate.type === 'ArrowFunctionExpression' || candidate.type === 'FunctionExpression') &&
                    Array.isArray(candidate.params) &&
                    candidate.params.length === 4
                ) {
                    const handlerName = candidate.id?.name || 'errorHandler';
                    const route = '/*';
                    const apiId = `MIDDLEWARE:${route}::${filePath}::${handlerName}`;
                    apis.push({
                        apiId,
                        method: 'MIDDLEWARE',
                        route,
                        handlerName,
                        filePath,
                        anchor: {
                            filePath,
                            symbol: handlerName,
                            span: { start: node.start ?? 0, end: node.end ?? 0 },
                        },
                        meta: { error: true },
                    });
                    return;
                }
            }

            // Match patterns: router.get("/path", handler), app.post("/path", handler), etc.
            if (callee.type === 'MemberExpression') {
                const method = callee.property?.name?.toLowerCase();
                if (!method || !HTTP_METHODS.has(method)) return;

                const args = node.arguments || [];
                if (args.length < 1) return;

                // First argument is normally the route string. Express also allows
                // the chained form `router.route('/x').post(h).get(h)` where the
                // path lives on the upstream `.route(path)` call and the method
                // call's first arg is the handler. Detect both shapes.
                const routeArg = args[0];
                let route = '';
                let handlerStartIndex = 1;
                if (routeArg.type === 'StringLiteral') {
                    route = routeArg.value;
                } else if (routeArg.type === 'TemplateLiteral' && routeArg.quasis?.length === 1) {
                    route = routeArg.quasis[0].value.raw;
                } else {
                    // Walk back the call chain looking for a `.route('/x')` ancestor.
                    route = findChainedRoutePath(callee.object);
                    handlerStartIndex = 0;
                }
                if (!route) return;
                if (args.length < handlerStartIndex + 1) return;

                // Issue 349: route literal must look like an HTTP path (start
                // with `/` or `*`, or be a wildcard `*`). Without this guard,
                // `storage.put("value", value)` and similar storage / cache
                // method calls match because `put` is in HTTP_METHODS but the
                // first arg is just a key name like "value" — not a route.
                if (!route.startsWith('/') && route !== '*') return;

                // UX-33 Phase 3 (2026-06-05): apply Fastify register() prefix
                // when this route lives inside a plugin function body that
                // was registered with `{ prefix: '/v1' }`. The plugin range
                // table from `collectFastifyRegisterPrefixes` is checked
                // against the route call's offset.
                const routeOffsetForPrefix = node.start ?? 0;
                for (const r of fastifyRegisterPrefixes) {
                    if (routeOffsetForPrefix >= r.start && routeOffsetForPrefix <= r.end) {
                        route = combinePaths(r.prefix, route);
                        break;
                    }
                }

                // Last argument is the handler
                const handlerArg = args[args.length - 1];
                let handlerName = '';

                if (handlerArg.type === 'Identifier') {
                    handlerName = handlerArg.name;
                    // Issue 350 follow-through: if the identifier resolves to a
                    // `const X = isDev ? a() : b()` style runtime conditional in
                    // the same module (no own function body to flow-extract,
                    // value comes from external factory call), skip emitting
                    // the api entirely. Otherwise the click-through opens an
                    // empty L3 / L5 view.
                    if (isOpaqueExternalConst(path, handlerArg.name)) return;
                } else if (
                    handlerArg.type === 'ArrowFunctionExpression' ||
                    handlerArg.type === 'FunctionExpression'
                ) {
                    handlerName = handlerArg.id?.name || `anonymous@${method.toUpperCase()}:${route}`;
                } else if (handlerArg.type === 'MemberExpression') {
                    // e.g., `router.post('/login', authController.login)` — extract the
                    // method name. Without this branch, handlerName stayed empty,
                    // and the orchestrator's per-file `handlersSeen` dedup collapsed
                    // every route in the file into a single sequence graph (Issue:
                    // js-express produced 1 sequence for 14 routes).
                    if (handlerArg.property?.type === 'Identifier' && typeof handlerArg.property.name === 'string') {
                        handlerName = handlerArg.property.name;
                    }
                }

                const apiId = `${method.toUpperCase()}:${route}::${filePath}::${handlerName}`;

                // Issue 408: capture middleware arguments sitting between the route and handler.
                // Express pattern: router.METHOD(path, mw1, mw2, ..., handler). Every Identifier
                // / MemberExpression in between is a middleware. We store the source identifier
                // (e.g. `auth.required`, `auth.optional`) so L2b can render auth indicators and
                // L3 can later insert middleware participants.
                const middlewares: string[] = [];
                for (let i = handlerStartIndex; i < args.length - 1; i++) {
                    const arg = args[i];
                    // Issue 419 follow-up: Fastify options-object pattern.
                    // `fastify.get('/path', { preHandler: auth, schema: …, onRequest: [a, b] }, handler)`.
                    // Walk the object's properties for known middleware-hook keys and extract
                    // each Identifier / Array-of-Identifiers / CallExpression callee.
                    if (arg?.type === 'ObjectExpression') {
                        const objMws = extractFastifyOptionsMiddleware(arg);
                        middlewares.push(...objMws);
                        continue;
                    }
                    const mwSrc = stringifyMiddlewareArg(arg);
                    if (mwSrc) middlewares.push(mwSrc);
                }

                // Issue 419 follow-up: Hono mount-level middleware propagation.
                // `app.use('/auth/*', basicAuth({...}))` precedes a route, e.g.
                // `app.get('/auth/page', handler)`. The route's path matches the
                // mount glob, so the middleware applies to it implicitly.
                for (const m of mountMiddlewares) {
                    if (m.matcher.test(route)) {
                        for (const mw of m.mws) if (!middlewares.includes(mw)) middlewares.push(mw);
                    }
                }

                // UX-32 Phase 2 (2026-06-05): identify the THIS route's
                // receiver so the scoping decision below can compare
                // against `.use(mw)` receivers.
                const routeReceiver = (callee?.object?.type === 'Identifier' ? callee.object.name : '') as string;

                // UX-32 Phase 4 (2026-06-05): identify the route's
                // enclosing function body so middlewares in a
                // DIFFERENT plugin function don't apply (even when
                // both share the receiver name `app`).
                const routeScope = getEnclosingFunctionScope(path);

                // Decide whether a scoped middleware entry applies to
                // THIS route. Three pass conditions:
                //   1. Receiver match: entry's receiver IS this route's
                //      receiver, OR the entry's receiver is at app-level
                //      (not in routeReceivers — covers `app.use(mw)` +
                //      routes on a separate `router` Koa pattern).
                //   2. Scope match: entry's scope is null (top-level —
                //      applies anywhere), OR the entry's scope start ===
                //      this route's scope start (same function body).
                const scopedApplies = (entry: ScopedMiddleware): boolean => {
                    const isAppLevel = !routeReceivers.has(entry.receiver);
                    const receiverOk = isAppLevel || entry.receiver === routeReceiver;
                    if (!receiverOk) return false;
                    if (entry.scope === null) return true;
                    if (routeScope && entry.scope.start === routeScope.start) return true;
                    return false;
                };

                // Issue 419 follow-up: Koa-style global auth middleware applies
                // to every route in the file (chain semantics).
                // UX-32 Phase 4 (2026-06-05): scoped per-entry now.
                for (const entry of globalAuthEntries) {
                    if (!scopedApplies(entry)) continue;
                    if (!middlewares.includes(entry.mw)) middlewares.push(entry.mw);
                }

                // UX-32 + UX-33 (2026-06-05) + Phase 4: router.use(non-auth-mw)
                // + fastify.addHook('phase', fn) with receiver + scope filter.
                for (const entry of routerScopeEntries) {
                    if (!scopedApplies(entry)) continue;
                    if (!middlewares.includes(entry.mw)) middlewares.push(entry.mw);
                }

                // UX-31: Express `router.param('id', loader)` binds the
                // loader to every route in the file whose path contains
                // `:id` (or matches the same param name). Prepend so the
                // loader appears BEFORE other middlewares in the L3
                // sequence — Express runs param loaders ahead of the
                // route's middleware chain.
                for (const [paramName, loaders] of paramLoaders) {
                    const paramRegex = new RegExp(`:${paramName}(?:[/$]|$)`);
                    if (paramRegex.test(route)) {
                        for (const loader of loaders) {
                            if (!middlewares.includes(loader)) middlewares.unshift(loader);
                        }
                    }
                }

                // Derive auth flag from middleware names OR from a leading JSDoc `@auth <kind>`.
                // Issue 419 follow-up: also recognise common auth-middleware
                // factories from other JS frameworks (Hono, Passport, etc.) —
                // their presence on a route is unambiguous evidence of `required` auth.
                let auth: 'required' | 'optional' | undefined;
                for (const mw of middlewares) {
                    if (
                        /(?:^|\.)auth\.required$/i.test(mw)
                        // Bare `auth`, `authRequired`, `authMiddleware` (common Express/Fastify/Koa idioms)
                        || /^auth$/i.test(mw)
                        || /^authRequired$/i.test(mw)
                        || /^authMiddleware$/i.test(mw)
                        || /^requireAuth$/i.test(mw)
                        || /^isAuthenticated$/i.test(mw)
                        || /^ensureAuth(?:enticated)?$/i.test(mw)
                        // Hono factories: basicAuth, bearerAuth, jwt, jwtAuth
                        || /^basicAuth$/i.test(mw)
                        || /^bearerAuth$/i.test(mw)
                        || /^jwt(?:Auth)?$/i.test(mw)
                        // Passport-style: passport.authenticate(...)
                        || /(?:^|\.)passport\.authenticate$/i.test(mw)
                        // express-jwt: jwt({...}).unless(...)
                        || /^expressJwt$/i.test(mw)
                        || /^koaJwt$/i.test(mw)
                    ) {
                        auth = 'required';
                        break;
                    }
                    if (/(?:^|\.)auth\.optional$/i.test(mw) || /^optionalAuth$/i.test(mw)) {
                        auth = 'optional';
                    }
                }
                if (!auth) {
                    // Babel typically attaches leading comments to the wrapping
                    // ExpressionStatement, not the inner CallExpression — walk
                    // up the path to find them.
                    let commentsHost: any = node;
                    let p: any = path;
                    while (p && !commentsHost?.leadingComments?.length) {
                        p = p.parentPath;
                        if (!p) break;
                        commentsHost = p.node;
                    }
                    const jsdocAuth = parseJsDocAuth(commentsHost?.leadingComments);
                    if (jsdocAuth) auth = jsdocAuth;
                }

                const meta: ApiRecord['meta'] = {};
                if (middlewares.length > 0) meta.middlewares = middlewares;
                if (auth) meta.auth = auth;

                apis.push({
                    apiId,
                    method: method.toUpperCase(),
                    route,
                    handlerName,
                    filePath,
                    anchor: {
                        filePath,
                        symbol: handlerName,
                        span: { start: node.start ?? 0, end: node.end ?? 0 },
                    },
                    ...(Object.keys(meta).length > 0 ? { meta } : {}),
                });
            }
        },
    });

    // #771 (2026-06-06) — Koa middleware-only fallback. When the file
    // has zero explicit routes but contains `app.use(async (ctx) => …)`
    // middleware that writes a response (sets `ctx.body`/`ctx.status`/
    // `ctx.type`), synthesise a catch-all route so the handler still
    // surfaces in L2b. Detection is conservative — pure pass-through
    // middleware (logging, auth, await next()) does NOT get a route.
    if (apis.length === 0) {
        const synthetic = detectKoaMiddlewareOnlyRoute(ast, filePath);
        if (synthetic) apis.push(synthetic);
    }

    return apis;
}

/**
 * #771 (2026-06-06) — synthesise a Koa middleware-only route.
 *
 * Walks every `<recv>.use(<fn>)` call where `<fn>` is an arrow or
 * function expression that writes one of `ctx.body`, `ctx.status`, or
 * `ctx.type`. The first matching function becomes the file's handler
 * — Koa apps that string multiple middleware together (logging,
 * auth, response) reach this point with the response middleware
 * landing last, so we pick the LAST matching call as the canonical
 * handler.
 *
 * Returns null when no qualifying middleware is found.
 */
function detectKoaMiddlewareOnlyRoute(ast: any, filePath: string): ApiRecord | null {
    let lastMatch: { line: number; start: number; end: number } | null = null;

    function bodyWritesResponse(node: any): boolean {
        if (!node) return false;
        let found = false;
        const walk = (n: any): void => {
            if (!n || typeof n !== 'object' || found) return;
            if (n.type === 'AssignmentExpression') {
                const left = n.left;
                if (left?.type === 'MemberExpression'
                    && left.object?.type === 'Identifier'
                    && left.object.name === 'ctx'
                    && left.property?.type === 'Identifier'
                    && ['body', 'status', 'type'].includes(left.property.name)) {
                    found = true;
                    return;
                }
            }
            for (const key of Object.keys(n)) {
                if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
                const v = (n as any)[key];
                if (Array.isArray(v)) v.forEach(walk);
                else if (v && typeof v === 'object') walk(v);
            }
        };
        walk(node);
        return found;
    }

    traverse(ast, {
        CallExpression(p: any) {
            const callee = p.node.callee;
            if (callee?.type !== 'MemberExpression') return;
            if (callee.property?.name !== 'use') return;
            const args = p.node.arguments ?? [];
            if (args.length === 0) return;
            const fn = args[0];
            if (fn?.type !== 'ArrowFunctionExpression' && fn?.type !== 'FunctionExpression') return;
            if (!bodyWritesResponse(fn.body)) return;
            const line = fn.loc?.start?.line ?? 0;
            lastMatch = {
                line,
                start: p.node.start ?? 0,
                end: p.node.end ?? 0,
            };
        },
    });

    if (!lastMatch) return null;
    const handlerName = `anonymous@${(lastMatch as any).line}`;
    return {
        apiId: `ANY:*::${filePath}::${handlerName}`,
        method: 'ANY',
        route: '*',
        handlerName,
        filePath,
        anchor: {
            filePath,
            symbol: handlerName,
            span: { start: (lastMatch as any).start, end: (lastMatch as any).end },
        },
    };
}

/**
 * Issue 350 follow-through: detect when `<id>` in `app.all("*", <id>)` is
 * a `const`/`let`/`var` whose initializer is an opaque-external — a
 * conditional or call that returns a function we can't statically resolve
 * (`const remixHandler = isDev ? a() : b()`). For these, no flow graph can
 * be produced; emitting the api leaves an empty L3 / L5 click-through.
 */
function isOpaqueExternalConst(traversalPath: any, name: string): boolean {
    const program = traversalPath.scope?.getProgramParent?.()?.block;
    if (!program?.body) return false;
    let opaque = false;
    for (const stmt of program.body) {
        if (stmt.type !== 'VariableDeclaration') continue;
        for (const d of stmt.declarations ?? []) {
            if (d.id?.type !== 'Identifier' || d.id.name !== name) continue;
            const init = d.init;
            if (!init) continue;
            // Conditional with at least one CallExpression branch — runtime-resolved.
            if (init.type === 'ConditionalExpression') {
                const branchIsCall = (b: any) =>
                    b?.type === 'CallExpression' ||
                    (b?.type === 'AwaitExpression' && b.argument?.type === 'CallExpression');
                if (branchIsCall(init.consequent) || branchIsCall(init.alternate)) {
                    opaque = true;
                }
            }
            // `const x = factoryCall(...)` where factoryCall is imported — also
            // opaque (we can't see inside the factory).
            if (init.type === 'CallExpression' && init.callee?.type === 'Identifier') {
                opaque = true;
            }
        }
    }
    // Also walk up for nested-function const declarations (ts-remix has the
    // declaration inside `async function run() { ... }`).
    let scope = traversalPath.scope;
    while (scope) {
        const binding = scope.bindings?.[name];
        if (binding && binding.path?.node?.type === 'VariableDeclarator') {
            const init = binding.path.node.init;
            if (init?.type === 'ConditionalExpression') {
                const branchIsCall = (b: any) =>
                    b?.type === 'CallExpression' ||
                    (b?.type === 'AwaitExpression' && b.argument?.type === 'CallExpression');
                if (branchIsCall(init.consequent) || branchIsCall(init.alternate)) {
                    opaque = true;
                    break;
                }
            }
            if (init?.type === 'CallExpression' && init.callee?.type === 'Identifier') {
                opaque = true;
                break;
            }
        }
        scope = scope.parent;
    }
    return opaque;
}

/**
 * For Express-style chained route registration:
 *   router.route('/x').get(h).post(h)
 * Walk back the MemberExpression/CallExpression chain rooted at `node` and
 * return the string path passed to the nearest `.route(...)` call, or '' if
 * none is found.
 */
function findChainedRoutePath(node: any): string {
    let cur = node;
    while (cur) {
        if (cur.type === 'CallExpression') {
            const c = cur.callee;
            if (c?.type === 'MemberExpression' && c.property?.name === 'route') {
                const a = cur.arguments?.[0];
                if (a?.type === 'StringLiteral') return a.value;
                if (a?.type === 'TemplateLiteral' && a.quasis?.length === 1) {
                    return a.quasis[0].value.raw;
                }
                return '';
            }
            cur = c?.object;
        } else if (cur.type === 'MemberExpression') {
            cur = cur.object;
        } else {
            return '';
        }
    }
    return '';
}

const HTTP_METHODS = new Set([
    'get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all',
]);

/**
 * Issue 419 follow-up — Hono / Express mount-level middleware propagation.
 *
 * Walks the AST looking for `<obj>.use('<path-glob>', mw1, mw2, …)` calls
 * where the first arg is a string literal starting with `/`. For each, builds
 * a regex matcher derived from the glob — `/auth/*` → `^/auth(/.*)?$` — and
 * captures the middleware identifiers (Identifier / MemberExpression /
 * CallExpression). Later route registrations whose `route` matches the glob
 * inherit these middlewares.
 *
 * Bails on app-level middleware (no path arg) since those apply globally and
 * we don't want every route flagged auth=required just because the file
 * registers a CORS plugin.
 */
function collectMountMiddlewares(ast: any): Array<{ matcher: RegExp; mws: string[] }> {
    const out: Array<{ matcher: RegExp; mws: string[] }> = [];
    traverse(ast, {
        CallExpression(p: any) {
            const callee = p.node.callee;
            if (callee?.type !== 'MemberExpression') return;
            if (callee.property?.name !== 'use') return;
            const args = p.node.arguments || [];
            if (args.length < 2) return;
            const pathArg = args[0];
            if (pathArg?.type !== 'StringLiteral') return;
            const glob = pathArg.value;
            if (!glob.startsWith('/') && glob !== '*') return;
            const mws: string[] = [];
            for (let i = 1; i < args.length; i++) {
                const a = args[i];
                if (a?.type === 'ObjectExpression') {
                    // Skip — `app.use('/path', { ... })` is config, not middleware.
                    continue;
                }
                const src = stringifyMiddlewareArg(a);
                if (src) mws.push(src);
            }
            if (mws.length === 0) return;
            // Convert glob to a matcher: `/auth/*` matches `/auth` and `/auth/anything`.
            // `*` (bare wildcard) matches any path.
            let pattern: string;
            if (glob === '*') {
                pattern = '^/.*$';
            } else {
                const cleaned = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
                pattern = '^' + cleaned.replace(/\\\*/g, '.*') + '(?:/.*)?$';
            }
            out.push({ matcher: new RegExp(pattern), mws });
        },
    });
    return out;
}

/**
 * Issue 419 follow-up — Koa-style global auth middleware detection.
 *
 * Pattern: `app.use(<authMiddleware>)` WITHOUT a path arg. Affects every
 * subsequent route in the file. Only counts middleware whose name matches a
 * known auth pattern (`auth`, `requireAuth`, `passport.authenticate`,
 * `jwt`, etc.) so unrelated middleware (cors, bodyparser, logger) doesn't
 * flag every route as auth.required.
 */
const KNOWN_AUTH_MW_NAMES = /^(?:auth|authRequired|requireAuth|isAuthenticated|jwtAuth|jwt|passport(?:\.authenticate)?|koaJwt|ensureAuth|ensureAuthenticated|sessionAuth|authMiddleware)$/i;

/**
 * UX-31 (2026-06-04) - Express param-loader middleware collector.
 *
 * Pattern: `router.param('id', loadUser)` (or `app.param(...)`). The
 * second argument is the loader function — runs whenever any route in
 * this router has `:id` in its path. The loader signature is
 * `(req, res, next, value)` (4 args; the 4th is the param value).
 *
 * Returns a map of paramName → loader-name array. Multiple loaders
 * for the same param ARE allowed (Express runs them in registration
 * order), so the value is an array, not a single string.
 */
function collectParamLoaders(ast: any): Map<string, string[]> {
    const out = new Map<string, string[]>();
    traverse(ast, {
        CallExpression(p: any) {
            const callee = p.node.callee;
            if (callee?.type !== 'MemberExpression') return;
            if (callee.property?.name !== 'param') return;
            const args = p.node.arguments || [];
            if (args.length < 2) return;
            const nameArg = args[0];
            const loaderArg = args[1];
            const paramName =
                nameArg?.type === 'StringLiteral' ? nameArg.value :
                nameArg?.type === 'TemplateLiteral' && nameArg.quasis?.length === 1 ? nameArg.quasis[0].value.raw :
                '';
            if (!paramName) return;
            const loaderName = stringifyMiddlewareArg(loaderArg);
            if (!loaderName) return;
            // Sanity: skip when the param name itself looks like a route
            // path (`'/users'`) — that's a malformed call and shouldn't
            // pollute the loader map. Param names are bare identifiers.
            if (/[/.{}\[\]]/.test(paramName)) return;
            const existing = out.get(paramName) ?? [];
            if (!existing.includes(loaderName)) existing.push(loaderName);
            out.set(paramName, existing);
        },
    });
    return out;
}

/**
 * UX-32 + UX-33 (2026-06-05). Collects:
 *   - `<recv>.use(mw)` for ALL receivers (Koa router.use, etc.) when
 *     the argument is a non-auth identifier (auth names are already
 *     picked up by `collectGlobalAuthMiddleware`).
 *   - `<recv>.addHook('phase', fn)` Fastify lifecycle hooks.
 *
 * File-scope: every collected mw applies to every route detected in
 * the same file. Receiver-aware scoping (only routes registered on
 * `router` get `router.use(mw)`) is a follow-up.
 */
const FASTIFY_HOOK_PHASES = new Set([
    'onRequest', 'preParsing', 'preValidation', 'preHandler',
    'preSerialization', 'onSend', 'onResponse', 'onError',
    'onTimeout', 'onReady', 'onClose', 'onRoute', 'onRegister',
]);

/**
 * UX-32 Phase 4 (2026-06-05) — function-scope helper.
 *
 * For a babel `NodePath`, return the enclosing function body's
 * `{start, end}` range, or `null` when the node is at module top-level.
 * Used to keep two plugins that both name their param `app` from
 * cross-pollinating each other's middleware.
 */
function getEnclosingFunctionScope(p: any): { start: number; end: number } | null {
    const fnPath = typeof p.getFunctionParent === 'function' ? p.getFunctionParent() : null;
    const body = fnPath?.node?.body;
    if (!body || typeof body.start !== 'number' || typeof body.end !== 'number') return null;
    return { start: body.start, end: body.end };
}

export interface ScopedMiddleware {
    receiver: string;
    mw: string;
    /** Enclosing function body range, or null when at module top-level. */
    scope: { start: number; end: number } | null;
}

function collectRouterScopeAndHookMiddleware(ast: any): ScopedMiddleware[] {
    // UX-32 Phase 4 (2026-06-05) — list of {receiver, mw, scope} entries
    // so the route loop can pick only the middlewares whose scope
    // matches the route's enclosing function (or whose scope is null =
    // top-level, which applies anywhere).
    const out: ScopedMiddleware[] = [];
    const push = (receiver: string, name: string, scope: { start: number; end: number } | null) => {
        if (!name) return;
        // Dedup on the (receiver, mw, scopeKey) triple so the same source
        // call doesn't accumulate duplicates.
        const scopeKey = scope ? `${scope.start}:${scope.end}` : 'top';
        if (out.some((e) => e.receiver === receiver && e.mw === name && (e.scope ? `${e.scope.start}:${e.scope.end}` : 'top') === scopeKey)) return;
        out.push({ receiver, mw: name, scope });
    };
    traverse(ast, {
        CallExpression(p: any) {
            const callee = p.node.callee;
            if (callee?.type !== 'MemberExpression') return;
            const verb = callee.property?.name;
            if (verb !== 'use' && verb !== 'addHook') return;
            const args = p.node.arguments || [];
            if (args.length === 0) return;

            // Identify the receiver. We only support bare `Identifier`
            // receivers — that covers the canonical `router.use(...)` /
            // `app.use(...)` / `fastify.addHook(...)` shapes. Complex
            // receivers fall under the global pseudo-key for backward
            // compatibility (route loop also catches `''`).
            const receiver = callee.object?.type === 'Identifier' ? callee.object.name : '';
            const scope = getEnclosingFunctionScope(p);

            // `<recv>.addHook('phase', fn)` — first arg must be a known phase
            // string, second arg is the middleware fn ref.
            if (verb === 'addHook') {
                if (args.length < 2) return;
                const phaseArg = args[0];
                const phase = phaseArg?.type === 'StringLiteral' ? phaseArg.value
                    : phaseArg?.type === 'TemplateLiteral' && phaseArg.quasis?.length === 1 ? phaseArg.quasis[0].value.raw
                    : '';
                if (!FASTIFY_HOOK_PHASES.has(phase)) return;
                const src = stringifyMiddlewareArg(args[1]);
                if (src) push(receiver, src, scope);
                return;
            }

            // `<recv>.use(mw)` — single-arg, non-string. The auth-shaped
            // names are also picked up by collectGlobalAuthMiddleware;
            // we collect EVERYTHING here so non-auth middleware is also
            // visible. Skip path-string mounts (handled by collectMountMiddlewares).
            if (args.length !== 1) return;
            const arg = args[0];
            if (arg?.type === 'StringLiteral') return;
            // UX-32 Phase 3 (2026-06-05): `<recv>.use(compose([a, b, c]))` —
            // unwrap each composed middleware. The compose() wrapper is
            // opaque to the L3 renderer; users actually care about the
            // constituent middlewares it composes.
            const composed = unwrapKoaComposeArg(arg);
            if (composed && composed.length > 0) {
                for (const src of composed) push(receiver, src, scope);
                return;
            }
            const src = stringifyMiddlewareArg(arg);
            if (src) push(receiver, src, scope);
        },
    });
    return out;
}

function collectGlobalAuthMiddleware(ast: any): ScopedMiddleware[] {
    // UX-32 Phase 4 (2026-06-05) — list of {receiver, mw, scope}.
    // Same shape as `collectRouterScopeAndHookMiddleware` so route-loop
    // filtering treats both identically. Auth-shaped names only.
    const out: ScopedMiddleware[] = [];
    traverse(ast, {
        CallExpression(p: any) {
            const callee = p.node.callee;
            if (callee?.type !== 'MemberExpression') return;
            if (callee.property?.name !== 'use') return;
            const args = p.node.arguments || [];
            // No-arg or single-arg .use() with a non-string first arg = global middleware.
            if (args.length !== 1) return;
            const arg = args[0];
            // Skip path-string mounts — those are handled by collectMountMiddlewares.
            if (arg?.type === 'StringLiteral') return;
            const src = stringifyMiddlewareArg(arg);
            if (!src) return;
            // Only flag known auth-shaped names.
            const bare = src.includes('.') ? src.split('.').pop()! : src;
            if (KNOWN_AUTH_MW_NAMES.test(src) || KNOWN_AUTH_MW_NAMES.test(bare)) {
                const receiver = callee.object?.type === 'Identifier' ? callee.object.name : '';
                const scope = getEnclosingFunctionScope(p);
                const scopeKey = scope ? `${scope.start}:${scope.end}` : 'top';
                if (!out.some((e) => e.receiver === receiver && e.mw === src && (e.scope ? `${e.scope.start}:${e.scope.end}` : 'top') === scopeKey)) {
                    out.push({ receiver, mw: src, scope });
                }
            }
        },
    });
    return out;
}

/**
 * Issue 419 follow-up — Fastify options-object middleware extraction.
 *
 * Fastify routes commonly accept an options object as the second argument:
 *   `fastify.get('/path', { preHandler: auth, schema: {...}, onRequest: [a, b] }, handler)`
 * Walk the object's properties looking for known middleware-hook keys
 * (preHandler, onRequest, preValidation, preParsing, preSerialization,
 * onResponse, onError) and extract each value as a middleware name.
 */
function extractFastifyOptionsMiddleware(objNode: any): string[] {
    const MIDDLEWARE_HOOK_KEYS = new Set([
        'preHandler', 'onRequest', 'preValidation', 'preParsing',
        'preSerialization', 'onResponse', 'onError', 'onSend',
    ]);
    const out: string[] = [];
    for (const prop of (objNode.properties ?? [])) {
        if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue;
        const keyName = prop.key?.type === 'Identifier' ? prop.key.name
            : prop.key?.type === 'StringLiteral' ? prop.key.value : '';
        if (!MIDDLEWARE_HOOK_KEYS.has(keyName)) continue;
        const value = prop.value;
        if (!value) continue;
        if (value.type === 'ArrayExpression') {
            for (const el of (value.elements ?? [])) {
                const src = stringifyMiddlewareArg(el);
                if (src) out.push(src);
            }
        } else {
            const src = stringifyMiddlewareArg(value);
            if (src) out.push(src);
        }
    }
    return out;
}

/**
 * Issue 414: resolve a literal numeric value or a top-level
 * `const NAME = <NumericLiteral>` identifier reference.
 */
function evalNumericLiteral(node: any, ast: any): number | null {
    if (!node) return null;
    if (node.type === 'NumericLiteral') return node.value;
    if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'NumericLiteral') {
        return -node.argument.value;
    }
    if (node.type === 'Identifier') {
        const body = ast?.program?.body || [];
        for (const stmt of body) {
            let s = stmt;
            if (s.type === 'ExportNamedDeclaration' && s.declaration) s = s.declaration;
            if (s.type !== 'VariableDeclaration') continue;
            for (const d of (s.declarations ?? [])) {
                if (d.id?.type === 'Identifier' && d.id.name === node.name) {
                    if (d.init?.type === 'NumericLiteral') return d.init.value;
                    if (d.init?.type === 'UnaryExpression' && d.init.operator === '-' && d.init.argument?.type === 'NumericLiteral') {
                        return -d.init.argument.value;
                    }
                }
            }
        }
    }
    return null;
}

/**
 * Issue 414: parse a for-loop update clause to a numeric step. Supports:
 *   i++, ++i, i += K, i = i + K  (where K is a NumericLiteral). Returns null
 * if the clause is anything else.
 */
function parseLoopStep(update: any, loopVar: string): number | null {
    if (!update) return null;
    if (update.type === 'UpdateExpression' && update.argument?.type === 'Identifier' && update.argument.name === loopVar) {
        if (update.operator === '++') return 1;
        if (update.operator === '--') return -1;
    }
    if (update.type === 'AssignmentExpression' && update.left?.type === 'Identifier' && update.left.name === loopVar) {
        if (update.operator === '+=' && update.right?.type === 'NumericLiteral') return update.right.value;
        if (update.operator === '-=' && update.right?.type === 'NumericLiteral') return -update.right.value;
        if (update.operator === '=' && update.right?.type === 'BinaryExpression') {
            const r = update.right;
            if (r.operator === '+' && r.left?.type === 'Identifier' && r.left.name === loopVar && r.right?.type === 'NumericLiteral') {
                return r.right.value;
            }
        }
    }
    return null;
}

/**
 * Issue 414: evaluate a TemplateLiteral expression with the loop variable
 * substituted. Supports the loop variable itself, numeric/string literals,
 * and simple binary arithmetic / concat on the loop variable.
 */
function evalExprWithLoopVar(node: any, loopVar: string, val: number): number | string | null {
    if (!node) return null;
    if (node.type === 'Identifier' && node.name === loopVar) return val;
    if (node.type === 'NumericLiteral') return node.value;
    if (node.type === 'StringLiteral') return node.value;
    if (node.type === 'TemplateLiteral' && node.quasis?.length === 1 && node.expressions.length === 0) {
        return node.quasis[0].value.raw;
    }
    if (node.type === 'BinaryExpression') {
        const l = evalExprWithLoopVar(node.left, loopVar, val);
        const r = evalExprWithLoopVar(node.right, loopVar, val);
        if (l === null || r === null) return null;
        if (node.operator === '+') return (typeof l === 'string' || typeof r === 'string') ? String(l) + String(r) : (l as number) + (r as number);
        if (typeof l === 'number' && typeof r === 'number') {
            switch (node.operator) {
                case '-': return l - r;
                case '*': return l * r;
                case '/': return r === 0 ? null : l / r;
                case '%': return r === 0 ? null : l % r;
            }
        }
    }
    return null;
}

/**
 * Stringify a middleware AST node. Supports:
 *   - Identifier: `requireAuth` → "requireAuth"
 *   - MemberExpression: `auth.required` → "auth.required"
 *   - CallExpression returning middleware: `validate('body')` → "validate"
 * Returns '' for nodes we can't represent.
 */
/**
 * UX-33 Phase 3 (2026-06-05) — collect Fastify register-with-prefix
 * function-body ranges.
 *
 * Pattern:
 *   fastify.register(v1Plugin, { prefix: '/v1' });
 *   async function v1Plugin(app) { app.get('/users', ...) }
 *
 * Returns an array of `{ start, end, prefix }` covering the body of
 * each plugin function so the route emitter can check whether a
 * route's source offset falls inside one and prepend the prefix.
 *
 * Inline forms also supported:
 *   fastify.register(async (app) => { app.get('/users', ...) }, { prefix: '/v1' });
 */
function collectFastifyRegisterPrefixes(ast: any): Array<{ start: number; end: number; prefix: string }> {
    const ranges: Array<{ start: number; end: number; prefix: string }> = [];

    // First, build a name → function-body-range map so we can resolve
    // identifier args in `register(name, …)`.
    const fnBodiesByName = new Map<string, { start: number; end: number }>();
    traverse(ast, {
        FunctionDeclaration(p: any) {
            const name = p.node.id?.name;
            if (!name || !p.node.body) return;
            fnBodiesByName.set(name, {
                start: p.node.body.start ?? 0,
                end: p.node.body.end ?? 0,
            });
        },
        VariableDeclarator(p: any) {
            const id = p.node.id;
            const init = p.node.init;
            if (!id || id.type !== 'Identifier' || !init) return;
            if (init.type !== 'ArrowFunctionExpression' && init.type !== 'FunctionExpression') return;
            const body = init.body;
            if (!body) return;
            fnBodiesByName.set(id.name, {
                start: body.start ?? 0,
                end: body.end ?? 0,
            });
        },
    });

    // Now find every `register(...)` call.
    traverse(ast, {
        CallExpression(p: any) {
            const callee = p.node.callee;
            if (callee?.type !== 'MemberExpression') return;
            if (callee.property?.name !== 'register') return;
            const args = p.node.arguments || [];
            if (args.length < 2) return;
            const pluginArg = args[0];
            const optsArg = args[1];
            if (!optsArg || optsArg.type !== 'ObjectExpression') return;

            // Extract `prefix` from options object.
            let prefix = '';
            for (const prop of optsArg.properties ?? []) {
                if (prop.type !== 'ObjectProperty' && prop.type !== 'Property') continue;
                const keyName = prop.key?.type === 'Identifier' ? prop.key.name
                    : prop.key?.type === 'StringLiteral' ? prop.key.value : '';
                if (keyName !== 'prefix') continue;
                if (prop.value?.type === 'StringLiteral') {
                    prefix = prop.value.value;
                } else if (prop.value?.type === 'TemplateLiteral' && prop.value.quasis?.length === 1) {
                    prefix = prop.value.quasis[0].value.raw;
                }
                break;
            }
            if (!prefix) return;
            // Normalise: ensure leading `/`, strip trailing.
            if (!prefix.startsWith('/')) prefix = '/' + prefix;
            prefix = prefix.replace(/\/+$/, '');
            if (!prefix) return;

            // Resolve plugin body range.
            let body: { start: number; end: number } | undefined;
            if (pluginArg.type === 'ArrowFunctionExpression' || pluginArg.type === 'FunctionExpression') {
                if (pluginArg.body) {
                    body = { start: pluginArg.body.start ?? 0, end: pluginArg.body.end ?? 0 };
                }
            } else if (pluginArg.type === 'Identifier') {
                body = fnBodiesByName.get(pluginArg.name);
            }
            if (!body) return;
            ranges.push({ start: body.start, end: body.end, prefix });
        },
    });
    return ranges;
}

function stringifyMiddlewareArg(n: any): string {
    if (!n) return '';
    if (n.type === 'Identifier') return n.name || '';
    if (n.type === 'MemberExpression') {
        const obj = stringifyMiddlewareArg(n.object);
        const prop = n.property?.type === 'Identifier' ? n.property.name : '';
        if (obj && prop) return `${obj}.${prop}`;
        return prop || obj || '';
    }
    if (n.type === 'CallExpression') {
        return stringifyMiddlewareArg(n.callee);
    }
    // UX-32 Phase 3 (2026-06-05) — inline anonymous middleware. Express /
    // Koa / Fastify all accept `app.use(async (ctx, next) => ...)` and
    // similar inline functions. There's no identifier to reference, so
    // we synthesize a label keyed on the source line. The L3 renderer
    // treats this like any other middleware identifier.
    if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') {
        const line = n.loc?.start?.line ?? 0;
        return `anonymous@${line}`;
    }
    return '';
}

/**
 * UX-32 Phase 3 (2026-06-05) — koa-compose chain unwrapping.
 *
 * `compose([authMw, logMw, rateLimitMw])` produces a single middleware
 * function that runs the three composed middlewares in order. The
 * outer `compose(...)` is opaque to `stringifyMiddlewareArg` (which
 * returns the callee name `compose`). Unwrap the array literal arg
 * to surface each constituent middleware as a separate participant.
 *
 * Returns the array of constituent names or `null` when the arg
 * doesn't match the `compose([...])` shape.
 */
function unwrapKoaComposeArg(n: any): string[] | null {
    if (!n || n.type !== 'CallExpression') return null;
    const callee = n.callee;
    if (!callee) return null;
    const calleeName = callee.type === 'Identifier' ? callee.name
        : callee.type === 'MemberExpression' && callee.property?.type === 'Identifier' ? callee.property.name
        : '';
    if (calleeName !== 'compose') return null;
    const args = n.arguments ?? [];
    if (args.length === 0) return null;
    // First arg must be an ArrayExpression — `compose([a, b, c])`.
    const arr = args[0];
    if (arr.type !== 'ArrayExpression') return null;
    const out: string[] = [];
    for (const el of arr.elements ?? []) {
        const src = stringifyMiddlewareArg(el);
        if (src) out.push(src);
    }
    return out;
}

/**
 * Parse a JSDoc-style `@auth required|optional|none` from a route's leading
 * comments. Returns 'required' / 'optional' / undefined ('none' or absent).
 */
function parseJsDocAuth(leadingComments: any[] | undefined | null): 'required' | 'optional' | undefined {
    if (!leadingComments || leadingComments.length === 0) return undefined;
    for (const c of leadingComments) {
        const value: string = c?.value ?? '';
        const m = value.match(/@auth\s+(required|optional|none)\b/i);
        if (m) {
            const v = m[1].toLowerCase();
            if (v === 'required') return 'required';
            if (v === 'optional') return 'optional';
            return undefined;
        }
    }
    return undefined;
}

/**
 * Mount point found in a JS/TS entry file.
 * e.g. `app.use('/api/todos', todoRouter)` → { prefix: '/api/todos', routerVar: 'todoRouter' }
 */
export interface MountPoint {
    prefix: string;
    routerVar: string;
    importSource: string; // resolved import source for the router variable
}

/**
 * Scan a JS/TS file for `something.use('/prefix', routerVar)` calls and map each
 * router variable back to its import source.
 */
export function detectMountPoints(code: string): MountPoint[] {
    let ast: any;
    try {
        ast = parseJSAuto(code);
    } catch {
        return [];
    }

    // Build local→importSource map from require() / import statements
    const importMap = new Map<string, string>(); // localName → importSource
    // Issue 417: composite routers — `const api = Router().use(child1).use(child2);`
    // builds a parent router whose children are imported sub-routers. When a
    // later `app.use('/api', api)` is found, `api` itself isn't an import
    // (importSource lookup fails), but its children are. Track local var →
    // list of child importSources so applyMountPrefixes can expand.
    const compositeMap = new Map<string, string[]>(); // localName → child importSources

    traverse(ast, {
        ImportDeclaration(p: any) {
            const src: string = p.node.source?.value ?? '';
            for (const spec of p.node.specifiers ?? []) {
                const local: string = spec.local?.name ?? '';
                if (local) importMap.set(local, src);
            }
        },
        VariableDeclarator(p: any) {
            // const todoRouter = require('./routes/todos')
            const init = p.node.init;
            if (!init || init.type !== 'CallExpression') return;
            const callee = init.callee;
            if (callee.type === 'Identifier' && callee.name === 'require') {
                const arg = init.arguments?.[0];
                if (!arg || arg.type !== 'StringLiteral') return;
                const localName: string = p.node.id?.name ?? '';
                if (localName) importMap.set(localName, arg.value);
            }
        },
    });

    // Pass 2: composite-router detection.
    //   const X = Router().use(c1).use(c2)…       (no-prefix chain, children = imports)
    //   const X = SomeRouter().use(c1, …).use(c2) (variant)
    // Walk every VariableDeclarator whose init is a CallExpression chain ending
    // in `.use(<Identifier>)`. Walk back the chain, collecting each `.use(<Id>)`
    // arg. The chain's root must terminate at a `Router()` call (Express
    // convention) or a `<Identifier>()` factory — accept anything to stay
    // permissive. Pattern intentionally rejects mounted prefixed children
    // (`.use('/p', c)` — handled separately by the mount-point pass below).
    traverse(ast, {
        VariableDeclarator(p: any) {
            const init = p.node.init;
            if (!init || init.type !== 'CallExpression') return;
            if (p.node.id?.type !== 'Identifier') return;
            const local = p.node.id.name;
            const children: string[] = [];
            let cur: any = init;
            while (cur && cur.type === 'CallExpression') {
                const c = cur.callee;
                if (c?.type === 'MemberExpression' && c.property?.name === 'use') {
                    const args = cur.arguments || [];
                    const lastArg = args[args.length - 1];
                    // Skip prefixed mounts like `.use('/prefix', c)` — those
                    // are handled by the mount detection below; the unprefixed
                    // form `.use(c)` is the composition signal.
                    const firstArg = args[0];
                    if (firstArg?.type === 'StringLiteral' && firstArg.value.startsWith('/')) {
                        // It's a prefixed mount inside the chain — not a pure composition.
                        // Don't unroll this chain as composite.
                        return;
                    }
                    if (lastArg?.type === 'Identifier') {
                        const src = importMap.get(lastArg.name);
                        if (src) children.push(src);
                    }
                    cur = c.object;
                } else {
                    break;
                }
            }
            if (children.length > 0) {
                compositeMap.set(local, children.reverse());
            }
        },
    });

    const mounts: MountPoint[] = [];

    traverse(ast, {
        CallExpression(p: any) {
            const node = p.node;
            const callee = node.callee;
            if (callee.type !== 'MemberExpression') return;
            if (callee.property?.name !== 'use') return;

            const args = node.arguments ?? [];
            if (args.length < 2) return;

            // Pattern: app.use('/prefix', routerVar) or app.use('/prefix', middleware, routerVar)
            // First arg must be a string literal prefix
            const prefixArg = args[0];
            if (prefixArg.type !== 'StringLiteral') return;
            const prefix: string = prefixArg.value;
            if (!prefix.startsWith('/')) return;

            // Last arg should be a router variable (Identifier)
            const routerArg = args[args.length - 1];
            if (routerArg.type !== 'Identifier') return;
            const routerVar: string = routerArg.name;

            const importSource = importMap.get(routerVar) ?? '';
            const compositeChildren = compositeMap.get(routerVar);
            // Issue 417: composite routers — emit one MountPoint per child so
            // applyMountPrefixes patches every sub-router file with the parent's prefix.
            if (!importSource && compositeChildren && compositeChildren.length > 0) {
                for (const childSrc of compositeChildren) {
                    mounts.push({ prefix, routerVar, importSource: childSrc });
                }
                return;
            }
            mounts.push({ prefix, routerVar, importSource });
        },
    });

    return mounts;
}

/**
 * Join a mount prefix and a route path, avoiding double slashes.
 * combinePaths('/api/todos', '/') → '/api/todos'
 * combinePaths('/api/todos', '/list') → '/api/todos/list'
 */
function combinePaths(prefix: string, route: string): string {
    const p = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const r = route.startsWith('/') ? route : '/' + route;
    return p + (r === '/' ? '' : r) || '/';
}

/**
 * Given the full apiIndex from a snapshot and all JS file records (path → content),
 * detect mount points in each file and patch the `route` and `apiId` of sub-router
 * APIs to include their mount prefix.
 *
 * Returns a new apiIndex with patched entries (originals not mutated).
 * Idempotent: APIs that already have `rawRoute` set are not re-prefixed.
 *
 * @param apiIndex   Working snapshot apiIndex (may contain stale rawRoute-less entries)
 * @param fileContents  Map of relativePath → source code for JS/TS files
 * @param workspaceRoot  Workspace root used to resolve relative import paths
 */
export function applyMountPrefixes(
    apiIndex: Record<string, ApiRecord>,
    fileContents: Map<string, string>,
    workspaceRoot: string,
): Record<string, ApiRecord> {
    // Build file→[mount] map by scanning every JS/TS file for app.use() calls
    // Map: routerAbsoluteRelPath → prefix[]
    const filePrefixes = new Map<string, string[]>();

    for (const [relPath, code] of fileContents.entries()) {
        const mounts = detectMountPoints(code);
        for (const mount of mounts) {
            if (!mount.importSource) continue;
            // Resolve importSource relative to relPath's directory
            const dir = relPath.includes('/') ? relPath.substring(0, relPath.lastIndexOf('/')) : '';
            let resolved = mount.importSource;

            if (resolved.startsWith('.')) {
                // Relative import — normalise to workspace-relative path
                const joined = dir ? dir + '/' + resolved : resolved;
                resolved = path.normalize(joined).replace(/\\/g, '/');
                // Strip leading ./
                resolved = resolved.replace(/^\.\//, '');
            }

            // Try common extensions
            const candidates = [
                resolved,
                resolved + '.js',
                resolved + '.ts',
                resolved + '/index.js',
                resolved + '/index.ts',
            ];
            for (const candidate of candidates) {
                if (fileContents.has(candidate)) {
                    const existing = filePrefixes.get(candidate) ?? [];
                    if (!existing.includes(mount.prefix)) {
                        existing.push(mount.prefix);
                    }
                    filePrefixes.set(candidate, existing);
                    break;
                }
            }
        }
    }

    if (filePrefixes.size === 0) return apiIndex; // nothing to do

    const patched: Record<string, ApiRecord> = {};

    for (const [apiId, api] of Object.entries(apiIndex)) {
        const prefixes = filePrefixes.get(api.filePath);
        if (!prefixes || prefixes.length === 0 || api.rawRoute !== undefined) {
            // No mount or already patched — keep as-is
            patched[apiId] = api;
            continue;
        }

        // Apply the first (or only) matching prefix
        const prefix = prefixes[0];
        const newRoute = combinePaths(prefix, api.route);
        const newApiId = `${api.method}:${newRoute}::${api.filePath}::${api.handlerName}`;

        patched[newApiId] = {
            ...api,
            apiId: newApiId,
            route: newRoute,
            rawRoute: api.route,
        };
    }

    return patched;
}

/**
 * Classify an import source or variable name as an external system type.
 */
export function classifyExternalSystem(nameOrPath: string): string {
    const v = (nameOrPath || '').toLowerCase();

    if (['mongoose', 'sequelize', 'prisma', 'typeorm', 'knex', 'pg', 'mysql', 'mongodb'].some((k) => v.includes(k))) {
        return 'database';
    }
    if (['redis', 'ioredis', 'memcached', 'valkey'].some((k) => v.includes(k))) {
        return 'cache';
    }
    if (['s3', 'gcs', 'storage', 'bucket', 'minio', 'blob', 'azure/storage'].some((k) => v.includes(k))) {
        return 'storage';
    }
    if (['axios', 'fetch', 'got', 'request', 'grpc', 'amqplib', 'kafka', 'sns', 'sqs'].some((k) => v.includes(k))) {
        return 'service';
    }

    return 'module';
}

/**
 * Multi-language API detection dispatch.
 * Uses Babel-based detection for JS/TS, frameworkDetector for all other languages.
 */
export function detectApisForFile(code: string, filePath: string): ApiRecord[] {
    // UX-24 / UX-25 (2026-06-04) — IaC YAML routes. AWS SAM templates
    // (`template.yaml`/`.yml`) and Serverless Framework configs
    // (`serverless.yml`/`.yaml`) declare HTTP routes that the
    // framework detectors can't see. Route them to the dedicated
    // YAML extractors BEFORE the language detector runs (otherwise
    // `detectLanguage` returns 'yaml' which the framework detector
    // ignores → 0 routes detected).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isSamTemplatePath, parseSamTemplate } = require('./samRouteExtractor');
    if (isSamTemplatePath(filePath)) {
        return parseSamTemplate(code, filePath);
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isServerlessFrameworkPath, parseServerlessFrameworkTemplate } = require('./serverlessFrameworkRouteExtractor');
    if (isServerlessFrameworkPath(filePath)) {
        return parseServerlessFrameworkTemplate(code, filePath);
    }

    const { detectLanguage } = require('./treeSitterParser');
    const language = detectLanguage(filePath);

    // JS/TS: use existing Babel-based detector
    if (!language || language === 'javascript' || language === 'typescript') {
        return detectApis(code, filePath);
    }

    // All other languages: use framework detector
    const { detectFrameworkApis } = require('./frameworkDetector');
    return detectFrameworkApis(code, filePath, language);
}
