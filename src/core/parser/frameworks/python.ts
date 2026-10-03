/**
 * frameworks/python.ts — Python web/CLI/ORM framework plugins
 * (Issue #703, Phase 2 PR-13 — single-language bundle.)
 *
 * Bundles the full Python pattern set from `PYTHON_PATTERNS` in
 * `frameworkDetector.ts`: Flask, FastAPI, Django, Django REST Framework,
 * Starlette, Celery, Click, Typer, Alembic, SQLAlchemy.
 *
 * Why one file rather than ten? Most are small (1-3 patterns each) and
 * they all share two helpers (`findNearestFunctionName` from the
 * detector module; no path-helper needed). A per-framework split would
 * create ten one-pattern files that all import the same helper and
 * register in sequence — net negative readability. The plugin can still
 * be split later if any of these subsystems grow.
 *
 * Pattern coverage (25 patterns total):
 *
 *   Web routing:
 *     - Flask/FastAPI `@app.route('/path')` / `@app.get('/path')`
 *     - FastAPI/generic `@router.get('/path')`
 *     - FastAPI/Starlette `@app.websocket('/ws')`
 *     - Starlette `Route('/path', endpoint, methods=[...])` (call form)
 *     - Starlette `WebSocketRoute('/path', handler)`
 *     - FastAPI `Depends(...)` → DI_DEPENDENCY
 *
 *   Django + DRF:
 *     - `path('url/', SomeView.as_view())` CBV
 *     - `path('url/', some_func)` FBV (last identifier in dotted chain;
 *       skips `admin.site.urls` URLConf aggregators)
 *     - `re_path(r'^url/$', SomeView.as_view())` / `url(...)` CBV
 *     - `re_path` / `url` FBV (same prefix-chain skip)
 *     - `router.register(r'prefix', ViewSet)` → RESOURCE
 *     - `path('prefix/', include('app.urls'))` → INCLUDE
 *     - DRF `@api_view(['GET','POST'])` (extraMethods fan-out)
 *     - DRF `@action(methods=['post'], url_path=...)` (extraMethods)
 *     - DRF `@action(detail=True/False, url_path=...)` — no-methods form
 *     - Django middleware classes (`process_request` / `process_view`)
 *     - Django `@receiver(post_save, sender=Model)` → SIGNAL
 *     - Django management commands (`class Command(BaseCommand)` under
 *       `management/commands/`)
 *     - Django migrations (`class Migration(migrations.Migration)` under
 *       any "migrations/" directory, excluding alembic).
 *
 *   CLI + jobs:
 *     - Celery `@shared_task` / `@app.task` / `@celery.task` / `@task`
 *       (gated by celery import)
 *     - Click `@click.command()` / `@click.group()`
 *     - Typer `@app.command()` (gated by typer import)
 *     - Alembic `def upgrade()` / `def downgrade()` (under
 *       `alembic/versions/` or `migrations/versions/`)
 *
 *   ORM hooks:
 *     - SQLAlchemy `event.listen(target, 'before_insert', fn)` call form
 *     - SQLAlchemy `@event.listens_for(Target, 'before_insert')`
 *       decorator form (both gated by sqlalchemy import)
 *
 * Suppression: Python patterns are not affected by the
 * `jsExpressPatterns` template-literal suppression (that set is empty
 * for non-JS languages anyway). No flags needed — preserves the exact
 * pre-#703 behaviour.
 */

import type { FrameworkPlugin } from './types';
import { findNearestFunctionName } from '../frameworkDetector';

/**
 * Normalize a Django `re_path`/`url`/`include` regex into a display route:
 * drop the `^`/`$` anchors ONLY. BUG-EXP-19 — the previous
 * `.replace(/\\/g, '')` stripped EVERY backslash, corrupting regex character
 * classes (`[-\w]+`→`[-w]+`, `[\d]+`→`[d]+`, `\w+`→`w+`). Backslashes are part
 * of the pattern and must survive.
 */
function djangoRegexRoute(raw: string): string {
    return `/${raw.replace(/[\^$]/g, '')}`;
}

export const pythonPlugin: FrameworkPlugin = {
    id: 'python',
    name: 'Python (Django / FastAPI / Flask / Starlette / DRF / Celery / SQLAlchemy)',
    languages: ['python'],
    patterns: [
        // Flask/FastAPI: @app.route('/path'), @app.get('/path')
        {
            decoratorPattern: /@(?:app|router|blueprint|bp)\s*\.\s*(route|get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/gi,
            extract: (m) => ({
                method: m[1] === 'route' ? 'GET' : m[1].toUpperCase(),
                route: m[2],
            }),
        },
        // FastAPI: @router.api_route('/path', methods=['GET','POST']) — the explicit-
        // methods route form. Previously unmatched, so these handlers were missing from
        // the apiIndex (invisible in L2b AND wrongly flagged dead by health analysis).
        {
            decoratorPattern: /@(?:app|router|blueprint|bp)\s*\.\s*api_route\s*\(\s*['"]([^'"]+)['"][^)]*?methods\s*=\s*\[([^\]]+)\]/gi,
            extract: (m) => {
                const methods = [...m[2].matchAll(/['"](\w+)['"]/g)].map((x) => x[1].toUpperCase());
                if (methods.length === 0) return null;
                return { method: methods[0], route: m[1], extraMethods: methods.slice(1) };
            },
        },
        // DRF: @api_view(['GET', 'POST', ...])
        {
            decoratorPattern: /@api_view\s*\(\s*\[([^\]]+)\]/gi,
            extract: (m) => {
                const methods = [...m[1].matchAll(/['"](\w+)['"]/g)].map(x => x[1].toUpperCase());
                if (methods.length === 0) return null;
                return { method: methods[0], route: '/', extraMethods: methods.slice(1) };
            },
        },
        // DRF: @action(detail=True, methods=['post'])
        {
            decoratorPattern: /@action\s*\([^)]*methods\s*=\s*\[([^\]]+)\][^)]*\)/gi,
            extract: (m, ctx) => {
                const methods = [...m[1].matchAll(/['"](\w+)['"]/g)].map(x => x[1].toUpperCase());
                if (methods.length === 0) return null;
                let route = '/';
                const urlPathMatch = m[0].match(/url_path\s*=\s*['"]([^'"]+)['"]/);
                if (urlPathMatch) {
                    route = `/${urlPathMatch[1]}`;
                } else {
                    const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                    if (handlerName !== 'handler') {
                        route = `/${handlerName.replace(/_/g, '-')}`;
                    }
                }
                return { method: methods[0], route, extraMethods: methods.slice(1) };
            },
        },
        // Django: path('url/', SomeView.as_view()) — CBV
        {
            callPattern: /\bpath\s*\(\s*['"]([^'"]*)['"]\s*,\s*(?:\w+\.)*(\w+)\.as_view\s*\(\s*\)/gi,
            extract: (m) => ({ method: 'GET', route: `/${m[1]}`, handlerName: m[2] }),
        },
        // Django: path('url/', views.some_func) / path('url/', some_func) — FBV.
        // #898 — capture the FULL dotted prefix chain so `path('admin/', admin.site.urls)`
        // (the admin-site aggregator, not a view) is skipped — same guard the re_path
        // FBV pattern below already carries. Without it the FBV matched `handler="site"`
        // and emitted a phantom `GET /admin/` on nearly every Django urls.py.
        {
            callPattern: /\bpath\s*\(\s*['"]([^'"]*)['"]\s*,\s*((?:\w+\.)*)(?!as_view\b)(\w+)\b(?!\.\w)(?!\.as_view)/gi,
            extract: (m) => {
                const prefix = m[2] ?? '';
                const handler = m[3];
                if (handler === 'urls' && (prefix.match(/\./g) ?? []).length >= 2) return null;
                return { method: 'GET', route: `/${m[1]}`, handlerName: handler };
            },
        },
        // Django: re_path / url with .as_view() — CBV
        {
            callPattern: /\b(?:re_path|url)\s*\(\s*r?['"]([^'"]*)['"]\s*,\s*(?:\w+\.)*(\w+)\.as_view\s*\(\s*\)/gi,
            extract: (m) => ({
                method: 'GET',
                route: djangoRegexRoute(m[1]),
                handlerName: m[2],
            }),
        },
        // Django: re_path / url — FBV. Skips `admin.site.urls` aggregator shape.
        {
            callPattern: /\b(?:re_path|url)\s*\(\s*r?['"]([^'"]*)['"]\s*,\s*((?:\w+\.)*)(?!as_view\b)(\w+)\b(?!\.\w)(?!\.as_view)/gi,
            extract: (m) => {
                const prefix = m[2] ?? '';
                const handler = m[3];
                if (handler === 'urls' && (prefix.match(/\./g) ?? []).length >= 2) return null;
                return {
                    method: 'GET',
                    route: djangoRegexRoute(m[1]),
                    handlerName: handler,
                };
            },
        },
        // DRF router: router.register(r'prefix', ViewSet)
        {
            callPattern: /\brouter\.register\s*\(\s*r?['"]([^'"]*)['"]\s*,\s*(\w+)/gi,
            extract: (m) => ({ method: 'RESOURCE', route: `/${m[1]}`, handlerName: m[2] }),
        },
        // Django: path('prefix/', include('app.urls')) — URLConf aggregator
        {
            callPattern: /\b(?:path|re_path|url)\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*include\s*\(\s*['"]([^'"]+)['"]/g,
            extract: (m) => ({
                method: 'INCLUDE',
                route: djangoRegexRoute(m[1]),
                handlerName: m[2],
            }),
        },
        // FastAPI/generic router: @router.get('/path')
        {
            decoratorPattern: /@router\s*\.\s*(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/gi,
            extract: (m) => ({ method: m[1].toUpperCase(), route: m[2] }),
        },
        // FastAPI/Starlette: @app.websocket('/ws') or @router.websocket('/ws')
        {
            decoratorPattern: /@(?:app|router)\s*\.\s*websocket\s*\(\s*['"]([^'"]+)['"]/gi,
            extract: (m) => ({ method: 'WS', route: m[1] }),
        },
        // Starlette: Route('/path', endpoint=handler, methods=[...])
        {
            callPattern: /\bRoute\s*\(\s*['"]([^'"]+)['"]/gi,
            extract: (m, ctx) => {
                const nearby = ctx.source.slice(m.index!, Math.min(m.index! + 200, ctx.source.length));
                const methodsMatch = nearby.match(/methods\s*=\s*\[([^\]]*)\]/);
                if (methodsMatch) {
                    const methods = [...methodsMatch[1].matchAll(/['"](\w+)['"]/g)].map(x => x[1].toUpperCase());
                    if (methods.length > 0) return { method: methods[0], route: m[1], extraMethods: methods.slice(1) };
                }
                return { method: 'GET', route: m[1] };
            },
        },
        // Starlette: WebSocketRoute('/path', handler)
        {
            callPattern: /\bWebSocketRoute\s*\(\s*['"]([^'"]+)['"]/gi,
            extract: (m) => ({ method: 'WS', route: m[1] }),
        },
        // Django middleware (process_request / process_response / process_view / process_exception / __call__)
        {
            callPattern: /\bclass\s+(\w+Middleware)\b[^:]*:[\s\S]{0,500}?def\s+(process_request|process_response|process_view|process_exception|__call__)\s*\(/gi,
            extract: (m) => ({ method: 'MIDDLEWARE', route: '/*', handlerName: m[1] }),
        },
        // Django signals: @receiver(post_save, sender=Model)
        {
            decoratorPattern: /@receiver\s*\(\s*(\w+)(?:\s*,\s*sender\s*=\s*(\w+))?\s*\)/gi,
            extract: (m, ctx) => {
                const signal = m[1];
                const sender = m[2] ?? 'Any';
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                return { method: 'SIGNAL', route: `${signal}:${sender}`, handlerName };
            },
        },
        // DRF @action(detail=...) with no methods (defaults to GET)
        {
            decoratorPattern: /@action\s*\(\s*detail\s*=\s*(True|False)(?:\s*,\s*url_path\s*=\s*['"]([^'"]+)['"])?\s*\)/gi,
            extract: (m, ctx) => {
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                const urlPath = m[2] ?? handlerName.replace(/_/g, '-');
                return { method: 'GET', route: `/${urlPath}` };
            },
        },
        // #877 — Class-based HTTP endpoints (Django REST APIView and Sentry's
        // endpoint hierarchy: `class FooEndpoint(OrganizationEndpoint)`, often
        // decorated `@region_silo_endpoint` / `@control_silo_endpoint`). The
        // URL is wired in urls.py via `path(...)`, so the class carries no path
        // string — we synthesize a stable route from the class name and emit
        // one entry point per HTTP-verb handler method. GATED on a
        // `def <verb>(self, request …)` signature so non-HTTP `*Endpoint`
        // classes (and ORM/strategy classes) never match.
        {
            callPattern: /class\s+(\w+)\s*\(\s*[^)]*Endpoint[^)]*\)\s*:/g,
            extract: (m, ctx) => {
                const className = m[1];
                const bodyStart = (m.index ?? 0) + m[0].length;
                // #902 — bound the verb scan to THIS class's actual body: find the
                // NEXT class declaration in the full source first, then scope to
                // [bodyStart, nextClass). The old fixed `slice(bodyStart, +4000)`
                // both MISSED a verb method past 4000 chars (Sentry's large
                // endpoint files) and could never see the real class boundary
                // beyond that window. One regex exec from `bodyStart` is cheap and
                // the verb scan is now linear in the true class span.
                const nextClassRe = /\nclass\s+\w+/g;
                nextClassRe.lastIndex = bodyStart;
                const nm = nextClassRe.exec(ctx.source);
                const scopeEnd = nm ? nm.index : ctx.source.length;
                const scope = ctx.source.slice(bodyStart, scopeEnd);
                const verbs = [...new Set(
                    [...scope.matchAll(/\n[ \t]+(?:async\s+)?def\s+(get|post|put|patch|delete|head|options)\s*\(\s*self\s*,\s*request\b/gi)]
                        .map((x) => x[1].toUpperCase())
                )];
                if (verbs.length === 0) return null; // not an HTTP endpoint
                const route = '/' + className.replace(/Endpoint$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
                return { method: verbs[0], route, handlerName: className, extraMethods: verbs.slice(1) };
            },
        },
        // #877 — Sentry-style background tasks: `@instrumented_task(name="…") def fn(…)`.
        // Sentry's Celery wrapper; the generic Celery pattern below requires a
        // celery import + `@shared_task`/`.task`, which `@instrumented_task` is not.
        // Bounded look-ahead to the `def` tolerates multi-line / nested-paren args.
        {
            decoratorPattern: /@instrumented_task\b[\s\S]{0,400}?\n[ \t]*def\s+(\w+)/g,
            extract: (m) => ({ method: 'JOB', route: `task:${m[1]}`, handlerName: m[1] }),
        },
        // BUG-POLAR-12: FastAPI `Depends(provider)` was emitted as a first-class
        // DI_DEPENDENCY "entry point" with route `depends:<name>`. On a real app
        // (polar) that produced 283 `/depends:*` pseudo-routes — ~34% of the 827
        // "entry points" — inflating the headline count and cluttering L2a/L2b with
        // rows that are DI wiring, not user-facing endpoints. A `Depends()` target
        // is infrastructure; it's no longer registered as an entry point. (The DI
        // relationship still surfaces in the L3 sequence via the real call chain.)
        // Celery: @shared_task / @app.task / @celery.task / bare @task (celery-import-gated)
        {
            decoratorPattern: /@(?:shared_task|(?:\w+\.)?(?:task|celery_task))(?:\s*\(\s*[^)]*\))?\s*\n\s*def\s+(\w+)/g,
            extract: (m, ctx) => {
                if (!/from\s+celery|import\s+celery|@shared_task/.test(ctx.source)) return null;
                return { method: 'JOB', route: `celery:${m[1]}`, handlerName: m[1] };
            },
        },
        // Django management commands: class Command(BaseCommand) under management/commands/
        {
            callPattern: /class\s+Command\s*\(\s*(?:\w+\.)?BaseCommand\s*\)/g,
            extract: (_m, ctx) => {
                if (!/(?:^|\/)management\/commands\//.test(ctx.filePath)) return null;
                const cmdName = ctx.filePath.split('/').pop()?.replace(/\.py$/, '') || 'command';
                return { method: 'CLI_COMMAND', route: `manage:${cmdName}`, handlerName: cmdName };
            },
        },
        // Click: @click.command / @click.group
        {
            decoratorPattern: /@click\.(?:command|group)\s*\([^)]*\)\s*\n(?:[ \t]*@[^\n]*\n)*[ \t]*def\s+(\w+)/g,
            extract: (m) => ({ method: 'CLI_COMMAND', route: `cli:${m[1]}`, handlerName: m[1] }),
        },
        // Typer: @app.command() (typer-import-gated)
        {
            decoratorPattern: /@(\w+)\.command\s*\([^)]*\)\s*\n(?:[ \t]*@[^\n]*\n)*[ \t]*def\s+(\w+)/g,
            extract: (m, ctx) => {
                if (!/from\s+typer|import\s+typer/.test(ctx.source)) return null;
                return { method: 'CLI_COMMAND', route: `cli:${m[2]}`, handlerName: m[2] };
            },
        },
        // Alembic: def upgrade() under alembic/versions/ or migrations/versions/.
        // BUG-EXP-1: match ONLY `upgrade` (the canonical forward migration). Matching
        // `downgrade` too emitted a SECOND DB_MIGRATION record per file with an identical
        // `migration:<fileName>` route, double-counting every Alembic migration.
        {
            callPattern: /def\s+(upgrade)\s*\(\s*\)/g,
            extract: (m, ctx) => {
                if (!/(?:^|\/)(?:alembic\/versions|migrations\/versions)\//.test(ctx.filePath)) return null;
                const fileName = ctx.filePath.split('/').pop()?.replace(/\.py$/, '') || 'migration';
                return { method: 'DB_MIGRATION', route: `migration:${fileName}`, handlerName: m[1] };
            },
        },
        // Django: class Migration(migrations.Migration) under */migrations/
        {
            callPattern: /class\s+Migration\s*\(\s*migrations\.Migration\s*\)/g,
            extract: (_m, ctx) => {
                if (!/(?:^|\/)migrations\//.test(ctx.filePath)) return null;
                if (/\/(?:alembic|versions)\//.test(ctx.filePath)) return null;
                const fileName = ctx.filePath.split('/').pop()?.replace(/\.py$/, '') || 'migration';
                return { method: 'DB_MIGRATION', route: `django:${fileName}`, handlerName: 'Migration' };
            },
        },
        // SQLAlchemy: event.listen(target, 'before_insert', fn) — call form
        {
            callPattern: /\bevent\s*\.\s*listen\s*\(\s*\w+\s*,\s*['"]([^'"]+)['"]\s*,\s*(\w+)/g,
            extract: (m, ctx) => {
                if (!/import\s+sqlalchemy|from\s+sqlalchemy/.test(ctx.source)) return null;
                return { method: 'MODEL_HOOK', route: `sqlalchemy:${m[1]}`, handlerName: m[2] };
            },
        },
        // SQLAlchemy: @event.listens_for(Target, 'before_insert') — decorator form
        {
            decoratorPattern: /@event\.listens_for\s*\(\s*\w+\s*,\s*['"]([^'"]+)['"]/g,
            extract: (m, ctx) => {
                if (!/import\s+sqlalchemy|from\s+sqlalchemy/.test(ctx.source)) return null;
                const handlerName = findNearestFunctionName(ctx.source, m.index!, ctx.language);
                return { method: 'MODEL_HOOK', route: `sqlalchemy:${m[1]}`, handlerName };
            },
        },
    ],
};
