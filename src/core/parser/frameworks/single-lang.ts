/**
 * frameworks/single-lang.ts — Single-language web framework plugins
 * (Issue #703, Phase 2 PR-16.)
 *
 * Bundles five languages whose patterns don't cross language boundaries:
 *   - **rust**  — Actix-web, Axum, Rocket
 *   - **csharp** — ASP.NET Core (Controllers + Minimal API)
 *   - **php** — Laravel, Symfony, Symfony Console
 *   - **ruby** — Rails (route DSL, resources, devise_for, before_action,
 *                ActiveRecord callbacks), Sinatra, Sidekiq, ActiveJob
 *   - **swift** — Vapor
 *
 * Each language gets its own `FrameworkPlugin` object so the registry
 * can iterate plugins per-language deterministically. Keeping them in
 * one file matches how the inline `*_PATTERNS` arrays were grouped in
 * `frameworkDetector.ts` and avoids five trivial plugin files for
 * patterns that have no cross-language sharing potential.
 *
 * Suppression: none of these patterns lived in the pre-#703
 * `jsExpressPatterns` / `graphqlPatterns` / `grpcPatterns` suppression
 * sets, so no flags are applied — the extraction preserves the exact
 * dispatcher behaviour byte-for-byte.
 */

import type { FrameworkPlugin, ExtractResult } from './types';
import { findNearestFunctionName } from '../frameworkDetector';

/**
 * Slice the balanced argument that follows a `.route("path",` match — i.e.
 * everything up to the matching close-paren of the `.route(` call. Depth
 * starts at 1 (we are already inside the route call when this is called).
 * Used to capture the full method-router expression so multi-method Axum
 * routes (`get(a).post(b)`) and Actix app/scope routes (`web::get().to(h)`)
 * can be parsed for EVERY verb, not just the first (BUG-VERIFY-2). Capped
 * to guard against runaway scans on malformed input.
 */
function sliceRouteMethodArg(source: string, start: number): string {
    let depth = 1;
    let i = start;
    const end = Math.min(source.length, start + 600);
    while (i < end && depth > 0) {
        const c = source[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        i++;
    }
    return source.slice(start, depth === 0 ? i - 1 : i);
}

/**
 * Parse every HTTP verb out of a Rust `.route(...)` method-router argument.
 * Handles Axum single/multi-method (`get(root)`, `get(a).post(b)`) and Actix
 * app/scope-level (`web::get().to(handler)`). Returns one ExtractResult per
 * verb. (BUG-VERIFY-2.)
 */
function parseRustRouteVerbs(route: string, arg: string): ExtractResult[] {
    const results: ExtractResult[] = [];
    // `web::` prefix → Actix; handler then lives in a trailing `.to(handler)`.
    // Otherwise Axum, where the handler is the first token inside the verb call.
    const verbRe = /\b(web::)?(get|post|put|patch|delete|head|options)\s*\(([^)]*)\)(?:\s*\.\s*to\s*\(\s*([\w:|]+))?/gi;
    let vm: RegExpExecArray | null;
    while ((vm = verbRe.exec(arg)) !== null) {
        const method = vm[2].toUpperCase();
        const axumInner = (vm[3] ?? '').trim();
        const actixHandler = vm[4] ?? '';
        let handlerName: string;
        if (actixHandler) {
            handlerName = actixHandler.split('::').pop()!.replace(/^[^a-zA-Z_]+/, '');
        } else {
            const id = (axumInner.match(/^[\w:|]+/) || [''])[0];
            handlerName = (!id || id.startsWith('|') || id === 'move' || id === 'async')
                ? `anonymous@${method}:${route}`
                : id.split('::').pop()!.replace(/^[^a-zA-Z_]+/, '');
        }
        results.push({ method, route, handlerName });
    }
    return results;
}

// ── Rust ────────────────────────────────────────────────────────────
export const rustPlugin: FrameworkPlugin = {
    id: 'rust',
    name: 'Rust (Actix-web / Axum / Rocket)',
    languages: ['rust'],
    patterns: [
        // Actix-web: #[get("/path")]
        {
            decoratorPattern: /#\[(get|post|put|patch|delete|head|options)\s*\(\s*"([^"]+)"\s*\)\]/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
        },
        // Actix-web: web::resource("/path").route(web::get().to(handler))
        {
            callPattern: /web::resource\s*\(\s*"([^"]+)"\s*\)\s*\.route\s*\(\s*web::(get|post|put|patch|delete)\s*\(\s*\)\s*\.to\s*\(\s*([\w:|]+)/gi,
            extract: (m) => {
                const method = m[2].toUpperCase();
                const route = m[1];
                const inner = m[3] ?? '';
                if (!inner || inner.startsWith('|')) {
                    return { method, route, handlerName: `anonymous@${method}:${route}` };
                }
                return {
                    method,
                    route,
                    handlerName: inner.split('::').pop()!.replace(/^[^a-zA-Z_]+/, ''),
                };
            },
        },
        // Actix-web direct: web::resource("/path").to(handler)
        {
            callPattern: /web::resource\s*\(\s*"([^"]+)"\s*\)\s*\.to\s*\(\s*([\w:|]+)/gi,
            extract: (m) => {
                const route = m[1];
                const inner = m[2] ?? '';
                if (!inner || inner.startsWith('|')) {
                    return { method: 'GET', route, handlerName: `anonymous@GET:${route}` };
                }
                return {
                    method: 'GET',
                    route,
                    handlerName: inner.split('::').pop()!.replace(/^[^a-zA-Z_]+/, ''),
                };
            },
        },
        // Axum: .nest("/prefix", router_fn())
        {
            callPattern: /\.nest\s*\(\s*"([^"]+)"\s*,\s*([\w:|]+)/g,
            extract: (m) => {
                const route = m[1];
                const inner = m[2] ?? '';
                const handler = inner.startsWith('|') || inner === 'move' || inner === 'async'
                    ? `anonymous@MOUNT:${route}`
                    : inner.split('::').pop()!.replace(/^[^a-zA-Z_]+/, '');
                return { method: 'MOUNT', route, handlerName: handler };
            },
        },
        // Axum: .route("/path", get(handler)) — same-line and multi-line —
        // INCLUDING multi-method chains `.route("/", get(a).post(b).delete(c))`
        // (every verb emitted, not just the first). Also matches Actix
        // app/scope-level `.route("/path", web::get().to(handler))`, whose first
        // arg is a string literal (the `web::resource("/x").route(web::get()…)`
        // form has a non-string first arg and is handled by the patterns above,
        // so there's no double-count). BUG-VERIFY-2.
        {
            callPattern: /\.route\s*\(\s*"([^"]+)"\s*,/gi,
            extract: (m, ctx) => {
                const route = m[1];
                const argStart = (m.index ?? 0) + m[0].length;
                const arg = sliceRouteMethodArg(ctx.source, argStart);
                const verbs = parseRustRouteVerbs(route, arg);
                return verbs.length ? verbs : null;
            },
        },
        // Rocket: #[get("/path")]
        {
            decoratorPattern: /#\[(get|post|put|patch|delete|head|options)\s*\(\s*"([^"]+)"\s*\)\]/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
        },
        // Rocket: .mount("/api", routes![h1, h2, h3])
        // BUG-EXP-17 — one MOUNT per mount() CALL (the structural mount point),
        // NOT one per handler. Every handler in routes![] is already captured by
        // its own #[get]/#[post] decorator, so a MOUNT-per-handler double-counted
        // every endpoint (rust-rocket: MOUNT 102 ≈ shadowing 76 verb handlers).
        // Mirrors Axum's .nest(), which emits one MOUNT per call.
        {
            callPattern: /\.mount\s*\(\s*"([^"]+)"\s*,\s*routes!\s*\[([^\]]*)\]/g,
            extract: (m) => {
                const base = m[1];
                const fns = [...m[2].matchAll(/\b[\w:]+\b/g)].map(x => x[0]).filter(Boolean);
                if (fns.length === 0) return null;
                // Name by the first mounted handler's leaf so repeated mounts at the
                // same base (common in Rocket: several `.mount("/", …)`) stay distinct.
                const first = fns[0].split('::').pop() || 'routes';
                return { method: 'MOUNT', route: base, handlerName: `mount:${first}` };
            },
        },
        // Rocket Fairings: impl Fairing for FooFairing
        {
            callPattern: /impl(?:\s*<[^>]+>)?\s+Fairing\s+for\s+(\w+)/g,
            extract: (m) => ({ method: 'MIDDLEWARE', route: `fairing:${m[1]}`, handlerName: m[1] }),
        },
    ],
};

// ── C# / ASP.NET Core ───────────────────────────────────────────────
export const csharpPlugin: FrameworkPlugin = {
    id: 'csharp',
    name: 'ASP.NET Core (Controllers + Minimal API)',
    languages: ['csharp'],
    patterns: [
        // [HttpGet("/path")] / [HttpPost("/path")] / etc.
        {
            decoratorPattern: /\[(Http(?:Get|Post|Put|Patch|Delete|Head|Options))(?:\s*\(\s*"([^"]+)"\s*\))?\]/gi,
            extract: (m) => ({
                method: m[1].replace('Http', '').toUpperCase(),
                route: m[2] || '/',
            }),
        },
        // [Route("/path")] — class-level [Route] is a controller prefix.
        {
            decoratorPattern: /\[Route\s*\(\s*"([^"]+)"\s*\)\]/gi,
            extract: (m, ctx) => {
                const after = ctx.source.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 200);
                for (const line of after.split('\n').slice(0, 6)) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
                    if (/^(?:public|private|protected|internal|sealed|abstract|static|partial|\s)*class\b/.test(trimmed)) {
                        return null;
                    }
                    break;
                }
                return { method: 'ROUTE', route: m[1] };
            },
        },
        // Minimal API: app.MapGet("/path", handler)
        {
            callPattern: /\b(?:app|builder|endpoints)\s*\.\s*Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
        },
    ],
};

// ── PHP ─────────────────────────────────────────────────────────────
export const phpPlugin: FrameworkPlugin = {
    id: 'php',
    name: 'PHP (Laravel / Symfony / Symfony Console)',
    languages: ['php'],
    patterns: [
        // Laravel: Route::get('/users', [UserController::class, 'index'])
        {
            callPattern: /Route\s*::\s*(get|post|put|patch|delete|options|any|match)\s*\(\s*['"]([^'"]+)['"]\s*,\s*\[\s*\w+::class\s*,\s*['"](\w+)['"]\s*\]/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: m[2], handlerName: m[3] }),
        },
        // Laravel: Route::get('/path', handler) — basic (closure or string controller).
        // Issue #771: also handle the legacy `'Controller@method'` string shape.
        {
            callPattern: /Route\s*::\s*(get|post|put|patch|delete|options|any|match)\s*\(\s*['"]([^'"]+)['"]/gi,
            extract: (m) => {
                const method = m[1].toUpperCase();
                const route = m[2];
                const tail = m.input?.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 100) ?? '';
                if (/^\s*,\s*function\s*\(/.test(tail) || /^\s*,\s*fn\s*\(/.test(tail)) {
                    return { method, route, handlerName: `anonymous@${method}:${route}` };
                }
                // Legacy string-controller syntax: Route::get('/x', 'UserController@show')
                const strCtrl = /^\s*,\s*['"]([\w\\]+)@(\w+)['"]/.exec(tail);
                if (strCtrl) {
                    return { method, route, handlerName: strCtrl[2] };
                }
                return { method, route };
            },
        },
        // UX-40 (2026-06-05) — Laravel fluent chain `Route::middleware(...)->get('/x', ...)`.
        // The verb call is preceded by `->` and the chain starts with `Route::`.
        // We accept the same verb set and walk back at extract-time to confirm
        // a `Route::` precedes within ~400 chars (heuristic for one statement).
        {
            callPattern: /->\s*(get|post|put|patch|delete|options|any|match)\s*\(\s*['"]([^'"]+)['"]/gi,
            extract: (m, ctx) => {
                const before = ctx.source.slice(Math.max(0, (m.index ?? 0) - 400), m.index ?? 0);
                // The chain must start with `Route::` and not be intercepted
                // by a newline + statement terminator (`;`) — otherwise it's
                // a fluent call on a different builder.
                const lastSemi = before.lastIndexOf(';');
                const chainHead = lastSemi >= 0 ? before.slice(lastSemi + 1) : before;
                if (!/Route\s*::/.test(chainHead)) return null;
                return { method: m[1].toUpperCase(), route: m[2] };
            },
        },
        // Symfony: #[Route('/path', methods: ['GET'])] — class-level is prefix; method-level is endpoint.
        {
            decoratorPattern: /#\[Route\s*\(\s*['"]([^'"]+)['"]/gi,
            extract: (m, ctx) => {
                const after = ctx.source.slice(m.index! + m[0].length, m.index! + m[0].length + 400);
                for (const line of after.split('\n').slice(0, 8)) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    if (trimmed.startsWith('#[')) continue;
                    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
                    if (/^[)\],{}\s]+$/.test(trimmed)) continue;
                    if (/^(?:final|abstract|readonly|\s)*class\b/.test(trimmed)) {
                        return null;
                    }
                    break;
                }
                const nearby = ctx.source.slice(m.index!, Math.min(m.index! + 200, ctx.source.length));
                const methodsMatch = nearby.match(/methods\s*:\s*\[([^\]]*)\]/);
                if (methodsMatch) {
                    const methods = [...methodsMatch[1].matchAll(/['"](\w+)['"]/g)].map(x => x[1].toUpperCase());
                    if (methods.length > 0) return { method: methods[0], route: m[1], extraMethods: methods.slice(1) };
                }
                return { method: 'GET', route: m[1] };
            },
        },
        // Laravel: Route::resource('/users', UserController::class) / apiResource
        {
            callPattern: /Route\s*::\s*(?:api)?[Rr]esource\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*(\w+)(?:::class)?)?/gi,
            extract: (m) => ({ method: 'RESOURCE', route: m[1], handlerName: m[2] }),
        },
        // Symfony Console: #[AsCommand(name: "app:foo")] attribute
        {
            decoratorPattern: /#\[AsCommand\s*\(\s*name\s*:\s*['"]([^'"]+)['"]/g,
            extract: (m, ctx) => {
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                return { method: 'CLI_COMMAND', route: `console:${m[1]}`, handlerName: handlerName !== 'handler' ? handlerName : m[1] };
            },
        },
        // Symfony Console legacy: class FooCommand extends Command (no attribute).
        {
            callPattern: /class\s+(\w*Command)\s+extends\s+Command\b/g,
            extract: (m, ctx) => {
                const before = ctx.source.slice(Math.max(0, m.index! - 600), m.index!);
                if (/#\[AsCommand\s*\(/.test(before)) return null;
                return { method: 'CLI_COMMAND', route: `console:${m[1]}`, handlerName: m[1] };
            },
        },
        // Laravel artisan command: protected $signature = 'foo:bar'
        {
            callPattern: /protected\s+\$signature\s*=\s*['"]([^'"]+)['"]/g,
            extract: (m) => {
                const cmdName = m[1].split(/\s+/)[0];
                return { method: 'CLI_COMMAND', route: `artisan:${cmdName}`, handlerName: cmdName };
            },
        },
        // Laravel queue job: class \w+ implements ShouldQueue
        {
            callPattern: /class\s+(\w+)[^{]*?\bimplements\s+(?:[\w\\]+\s*,\s*)*ShouldQueue\b/g,
            extract: (m) => ({ method: 'JOB', route: `queue:${m[1]}`, handlerName: m[1] }),
        },
    ],
};

// ── Ruby ────────────────────────────────────────────────────────────
export const rubyPlugin: FrameworkPlugin = {
    id: 'ruby',
    name: 'Ruby (Rails / Sinatra / Sidekiq / ActiveJob)',
    languages: ['ruby'],
    patterns: [
        // Rails: get '/path', to: 'controller#action' / get "x" => "ctrl#action"
        // / Rails route DSL. TICKET-DETECT-3 — capture the explicit
        // controller#action target (group 3) so railsControllerAnchor can
        // re-anchor the route onto its controller file. The target is optional
        // (bare `get '/x', constraints: …` matches route-only, group 3 empty).
        {
            callPattern: /\b(get|post|put|patch|delete|options|head)\s+['"]([^'"]+)['"]\s*(?:=>|,)\s*(?:to:\s*)?(?:['"]([a-zA-Z0-9_/]+#[a-zA-Z0-9_]+)['"])?/gi,
            extract: (m) => {
                const rec: ExtractResult = { method: m[1].toUpperCase(), route: m[2] };
                if (m[3]) rec.handlerName = `anonymous@ROUTE:${m[3]}`;
                return rec;
            },
        },
        // Rails: resources :users / resource :user with only:/except: modifiers.
        {
            callPattern: /^[ \t]*(resource|resources)\s+:(\w+)([^\n]*)/gm,
            extract: (m) => {
                const isPlural = m[1] === 'resources';
                const name = m[2];
                const tail = m[3] ?? '';
                const onlyMatch = tail.match(/only:\s*\[([^\]]+)\]/);
                const exceptMatch = tail.match(/except:\s*\[([^\]]+)\]/);
                const allowed = (allActions: string[]): string[] => {
                    if (onlyMatch) {
                        const set = new Set(onlyMatch[1].split(',').map(s => s.trim().replace(/^:/, '')));
                        return allActions.filter(a => set.has(a));
                    }
                    if (exceptMatch) {
                        const ex = new Set(exceptMatch[1].split(',').map(s => s.trim().replace(/^:/, '')));
                        return allActions.filter(a => !ex.has(a));
                    }
                    return allActions;
                };
                const pluralActions = ['index', 'new', 'create', 'show', 'edit', 'update', 'destroy'];
                const singularActions = ['new', 'create', 'show', 'edit', 'update', 'destroy'];
                const baseRoute = `/${name}`;
                const idRoute = isPlural ? `/${name}/:id` : `/${name}`;
                const records: ExtractResult[] = [];
                for (const action of allowed(isPlural ? pluralActions : singularActions)) {
                    let method = 'GET';
                    let route = baseRoute;
                    const handlerSuffix = action;
                    switch (action) {
                        case 'index': method = 'GET'; route = baseRoute; break;
                        case 'new': method = 'GET'; route = `${baseRoute}/new`; break;
                        case 'create': method = 'POST'; route = baseRoute; break;
                        case 'show': method = 'GET'; route = idRoute; break;
                        case 'edit': method = 'GET'; route = `${idRoute}/edit`; break;
                        case 'update': method = 'PATCH'; route = idRoute; break;
                        case 'destroy': method = 'DELETE'; route = idRoute; break;
                    }
                    records.push({
                        method,
                        route,
                        handlerName: `anonymous@RESOURCE:${baseRoute}#${handlerSuffix}`,
                    });
                }
                return records.length > 0 ? records : null;
            },
        },
        // Devise: devise_for :users generates ~5 auth routes.
        {
            callPattern: /^[ \t]*devise_for\s+:(\w+)/gm,
            extract: (m) => {
                const base = `/${m[1]}`;
                return [
                    { method: 'POST', route: `${base}/sign_in`, handlerName: 'devise:sign_in' },
                    { method: 'DELETE', route: `${base}/sign_out`, handlerName: 'devise:sign_out' },
                    { method: 'POST', route: `${base}`, handlerName: 'devise:sign_up' },
                    { method: 'POST', route: `${base}/password`, handlerName: 'devise:password' },
                    { method: 'GET', route: `${base}/confirmation`, handlerName: 'devise:confirmation' },
                ];
            },
        },
        // Sinatra: get '/path' do … end / get('/path') { … } / get('/path') do … end
        // Issue #771: also accept the parenthesised form and the brace
        // block form (the canonical Sinatra README uses `get('/') { … }`).
        // The Rails generic pattern above (line ~261) needs a `,` or `=>`
        // after the path so we only match here when followed by `do` /
        // `{` (with optional whitespace) or the `)` of a parens call.
        {
            callPattern: /\b(get|post|put|patch|delete)\s*(?:['"]([^'"]+)['"]|\(\s*['"]([^'"]+)['"]\s*\))\s*(?:do\b|\{)/gi,
            extract: (m) => {
                const method = m[1].toUpperCase();
                const route = m[2] ?? m[3];
                return { method, route, handlerName: `anonymous@${method}:${route}` };
            },
        },
        // Rails controller filters: before_action / after_action / around_action,
        // plus the legacy before_filter / after_filter / around_filter aliases
        // (#878 — discourse and other older Rails apps still use *_filter; the
        // action-only pattern silently missed every filter on those controllers).
        {
            callPattern: /^[ \t]*(before|after|around)_(?:action|filter)\s+:(\w+[!?]?)/gm,
            extract: (m, ctx) => {
                if (!/_controller\.rb$/.test(ctx.filePath)) return null;
                return { method: 'FILTER', route: `${m[1]}_action:${m[2]}`, handlerName: m[2] };
            },
        },
        // Sidekiq workers: class FooWorker; include Sidekiq::Worker
        {
            callPattern: /class\s+(\w+)[\s\S]{0,200}?include\s+Sidekiq::Worker\b/g,
            extract: (m) => ({ method: 'JOB', route: `sidekiq:${m[1]}`, handlerName: m[1] }),
        },
        // ActiveJob: class FooJob < ApplicationJob / < ActiveJob::Base
        {
            callPattern: /class\s+(\w+)\s*<\s*(?:ApplicationJob|ActiveJob::Base)\b/g,
            extract: (m) => ({ method: 'JOB', route: `activejob:${m[1]}`, handlerName: m[1] }),
        },
        // Rails migrations: class FooMigration < ActiveRecord::Migration under db/migrate/
        {
            callPattern: /class\s+(\w+)\s*<\s*ActiveRecord::Migration\b/g,
            extract: (m, ctx) => {
                if (!/(?:^|\/)db\/migrate\//.test(ctx.filePath)) return null;
                return { method: 'DB_MIGRATION', route: `migration:${m[1]}`, handlerName: m[1] };
            },
        },
        // Rails ActiveRecord callbacks under app/models/
        {
            callPattern: /^[ \t]*(before|after|around)_(save|create|update|destroy|validation|commit|rollback|find|initialize|touch)\s+:(\w+[!?]?)/gm,
            extract: (m, ctx) => {
                if (!/(?:^|\/)app\/models\//.test(ctx.filePath)) return null;
                return { method: 'MODEL_HOOK', route: `${m[1]}_${m[2]}:${m[3]}`, handlerName: m[3] };
            },
        },
    ],
};

// ── Swift / Vapor ───────────────────────────────────────────────────
export const swiftPlugin: FrameworkPlugin = {
    id: 'swift',
    name: 'Swift (Vapor)',
    languages: ['swift'],
    patterns: [
        // Vapor: app.get("path") { … } / router.get("path", use: handler) / group.delete(...)
        {
            callPattern: /\b(?:app|router|routes|group)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*"([^"]+)"/gi,
            extract: (m) => {
                const method = m[1].toUpperCase();
                const route = `/${m[2]}`;
                const tail = m.input?.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 200) ?? '';
                if (/^\s*\)?\s*\{/.test(tail)) {
                    return { method, route, handlerName: `anonymous@${method}:${route}` };
                }
                const useMatch = tail.match(/\buse:\s*((?:\w+\.)*\w+)/);
                if (useMatch) {
                    const last = useMatch[1].split('.').pop()!;
                    return { method, route, handlerName: last };
                }
                return { method, route };
            },
        },
    ],
};
