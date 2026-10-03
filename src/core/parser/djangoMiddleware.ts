/**
 * djangoMiddleware.ts - UX-36 (2026-06-04)
 *
 * Django expresses middleware in three places, only one of which
 * lives in the same file as the route:
 *
 * 1. **Global `MIDDLEWARE = [...]` list in `settings.py`** — every
 *    HTTP request in the app passes through these classes in order
 *    (AuthenticationMiddleware, SessionMiddleware, CsrfViewMiddleware,
 *    custom RateLimitMiddleware, etc.). Cross-file.
 *
 * 2. **Per-view decorators** — `@login_required`,
 *    `@permission_required(...)`, `@user_passes_test(...)`, etc. sit
 *    on the view function. Same-file as the view.
 *
 * 3. **DRF `permission_classes = [IsAuthenticated]`** on viewsets /
 *    APIViews. Same-file as the class.
 *
 * This module owns parsing #1 (cross-file) + producing the merged
 * middleware list. Per-file decorator capture happens in
 * `frameworkDetector.ts:tagDjangoDecorators` (added in the same PR).
 */

import type { ApiRecord } from '../graph/graphTypes';

const GLOBAL_AUTH_RE = /^(?:django\.contrib\.auth\.middleware\.|.*\.)?(Authentication|RemoteUserAuthentication|SessionMiddleware)/;

/**
 * Pure: extract the MIDDLEWARE list from a Django settings.py source.
 * Returns the ordered list of fully-qualified middleware class paths,
 * or an empty array when no MIDDLEWARE block is found.
 *
 * Supports both the `MIDDLEWARE = [...]` assignment and the legacy
 * `MIDDLEWARE_CLASSES = [...]` (pre-Django 1.10) variant.
 */
export function parseDjangoMiddlewareList(settingsSource: string): string[] {
    if (!settingsSource) return [];

    // Match `MIDDLEWARE = [` or `MIDDLEWARE_CLASSES = [` followed by
    // the list contents up to the closing `]`. The list spans multiple
    // lines and contains quoted strings.
    const re = /^[ \t]*MIDDLEWARE(?:_CLASSES)?\s*=\s*\[([\s\S]*?)\][ \t]*$/m;
    const m = settingsSource.match(re);
    if (!m) return [];

    const block = m[1];
    const items: string[] = [];
    // Extract every quoted string entry. Tolerant of comments / blank
    // lines inside the list.
    const strRe = /["']([^"']+)["']/g;
    let s: RegExpExecArray | null;
    while ((s = strRe.exec(block)) !== null) {
        const value = s[1].trim();
        if (!value) continue;
        items.push(value);
    }
    return items;
}

/**
 * Heuristic: which workspace file is the Django settings module?
 * Returns the relative path of the first file whose basename is
 * `settings.py` AND whose content contains a `MIDDLEWARE` block.
 * Prefers files near the workspace root over deeply nested ones.
 *
 * Multiple settings files (`settings/base.py`, `settings/prod.py`)
 * exist in larger projects — for v1 we pick the first match;
 * follow-up could merge across the hierarchy.
 */
export function findDjangoSettingsFile(
    workspaceFiles: ReadonlyMap<string, string>,
): { filePath: string; content: string } | null {
    const candidates: Array<{ filePath: string; content: string; depth: number }> = [];
    for (const [filePath, content] of workspaceFiles) {
        const base = filePath.split('/').pop() ?? '';
        if (base !== 'settings.py' && base !== 'base.py') continue;
        if (!/^\s*MIDDLEWARE(?:_CLASSES)?\s*=\s*\[/m.test(content)) continue;
        candidates.push({ filePath, content, depth: filePath.split('/').length });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.depth - b.depth);
    return candidates[0];
}

/**
 * Cross-file pass: read Django settings.py from the workspace, parse
 * its MIDDLEWARE list, then prepend that list to every Django API's
 * meta.middlewares.
 *
 * "Django API" = an ApiRecord whose filePath ends in `urls.py` /
 * `views.py` / `viewsets.py` OR whose method is among
 * `GET/POST/PUT/PATCH/DELETE` and whose file is under a path that
 * looks like a Django project (heuristic: same dir tree as the
 * settings.py we found).
 *
 * Returns the same apiIndex shape so callers can swap it back into
 * the store via `replaceWorkingApiIndex`.
 */
export function applyDjangoGlobalMiddleware(
    apiIndex: Record<string, ApiRecord>,
    workspaceFiles: ReadonlyMap<string, string>,
): Record<string, ApiRecord> {
    const settings = findDjangoSettingsFile(workspaceFiles);
    if (!settings) return apiIndex;

    const middleware = parseDjangoMiddlewareList(settings.content);
    if (middleware.length === 0) return apiIndex;

    // Render the middleware as bare class names (last `.`-segment) so
    // L3 sequence diagrams don't drown in fully-qualified paths.
    const bareNames = middleware.map(mw => mw.includes('.') ? mw.split('.').pop()! : mw);

    // Scope: the settings.py dir is the project root. Only stamp
    // middleware on APIs whose filePath is under that root. In a
    // multi-app monorepo this avoids polluting non-Django services.
    const projectRoot = settings.filePath.includes('/')
        ? settings.filePath.slice(0, settings.filePath.lastIndexOf('/'))
        : '';
    const inScope = (filePath: string): boolean => {
        if (!projectRoot) return true; // settings.py at workspace root → applies workspace-wide
        return filePath.startsWith(projectRoot + '/') || filePath === projectRoot;
    };

    const patched: Record<string, ApiRecord> = {};
    for (const [apiId, api] of Object.entries(apiIndex)) {
        if (!isDjangoLikeRoute(api) || !inScope(api.filePath)) {
            patched[apiId] = api;
            continue;
        }
        const existing = api.meta?.middlewares ?? [];
        const merged = [...bareNames];
        for (const mw of existing) {
            if (!merged.includes(mw)) merged.push(mw);
        }
        // Auth-derivation: if any global middleware looks auth-shaped, mark required.
        let auth = api.meta?.auth;
        if (!auth) {
            for (const fullName of middleware) {
                if (GLOBAL_AUTH_RE.test(fullName)) {
                    auth = 'required';
                    break;
                }
            }
        }
        patched[apiId] = {
            ...api,
            meta: {
                ...(api.meta ?? {}),
                middlewares: merged,
                ...(auth ? { auth } : {}),
            },
        };
    }
    return patched;
}

function isDjangoLikeRoute(api: ApiRecord): boolean {
    const fp = api.filePath ?? '';
    if (!fp) return false;
    // urls.py / views.py / viewsets.py / api.py are Django conventions.
    if (/\b(urls|views|viewsets|api)\.py$/.test(fp)) return true;
    // Routes whose method is GET/POST/... emitted from a .py file ARE
    // probably Django/Flask/FastAPI — but Django MIDDLEWARE only applies
    // when this file is under a Django project (we already gated by
    // settings.py proximity in the caller).
    if (fp.endsWith('.py') && /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(api.method)) return true;
    return false;
}
