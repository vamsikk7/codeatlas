/**
 * middlewareTaggers/django.ts — UX-29 Phase 2 (2026-06-05)
 *
 * Per-framework middleware tagger split from `middlewareTaggers.ts`.
 * See sibling files + `./index.ts` for the full set.
 */

import type { ApiRecord, Anchor } from '../../graph/graphTypes';

/**
 * UX-36 (2026-06-04) — Django per-view middleware decorators.
 *
 * Captures:
 *   - `@login_required` / `@permission_required('...')` / `@user_passes_test(...)`
 *     above a view function (FBV).
 *   - `@method_decorator(login_required, name='dispatch')` above a CBV class.
 *   - DRF `permission_classes = [IsAuthenticated, ...]` on a class body.
 *
 * Emits each detected decorator/permission name into the route's
 * `meta.middlewares`. Auth-shaped names (`login_required`, `IsAuthenticated`,
 * `IsAdminUser`, …) also derive `meta.auth = 'required'`.
 */
const DJANGO_AUTH_DECORATORS = /^(?:login_required|permission_required|user_passes_test|IsAuthenticated|IsAdminUser|IsAuthenticatedOrReadOnly|DjangoModelPermissions)$/i;
const DJANGO_VIEW_DECORATOR_RE = /@(\w+)\s*(?:\([^)]*\))?\s*\n/g;

export function tagDjangoViewDecorators(apis: ApiRecord[], source: string): void {
    const httpRoutes: Array<{ offset: number; api: ApiRecord }> = [];
    for (const a of apis) {
        if (!a.filePath || !/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(a.method)) continue;
        const off = a.anchor?.span?.start ?? 0;
        httpRoutes.push({ offset: off, api: a });
    }
    if (httpRoutes.length === 0) return;

    // Pre-collect DRF `permission_classes = [...]` blocks per class. We
    // key them by the class keyword's offset so per-route lookup picks
    // up the nearest enclosing class.
    const permClassesByClass = new Map<number, string[]>();
    const classRe = /^class\s+(\w+)/gm;
    let cm: RegExpExecArray | null;
    while ((cm = classRe.exec(source)) !== null) {
        // Search forward in the class body for `permission_classes = [...]`.
        // Stop at the next top-level statement (dedent / next class / EOF).
        const classStart = cm.index;
        const after = source.slice(classStart, classStart + 4000);
        const pcMatch = after.match(/permission_classes\s*=\s*\[([^\]]*)\]/);
        if (!pcMatch) continue;
        const names: string[] = [];
        const idRe = /([A-Z]\w*)/g;
        let im: RegExpExecArray | null;
        while ((im = idRe.exec(pcMatch[1])) !== null) {
            if (!names.includes(im[1])) names.push(im[1]);
        }
        if (names.length > 0) permClassesByClass.set(classStart, names);
    }

    // For each route, walk backward from the route offset up to 600 chars
    // to find decorators immediately preceding the view function.
    for (const r of httpRoutes) {
        const start = Math.max(0, r.offset - 800);
        const before = source.slice(start, r.offset);
        const decoratorMws: string[] = [];

        // Find decorator names. Decorators in Python sit on lines above
        // the function. Match `@<name>` (with optional `(...)`) at line
        // start, anywhere in the lookback window.
        let dm: RegExpExecArray | null;
        DJANGO_VIEW_DECORATOR_RE.lastIndex = 0;
        while ((dm = DJANGO_VIEW_DECORATOR_RE.exec(before)) !== null) {
            const name = dm[1];
            // Skip the route decorator itself (`@router.get(...)` /
            // `@app.post(...)` — those are MemberExpression-shaped,
            // not bare identifiers, so the \w+ regex captures only
            // the LAST segment. We treat ALL bare decorators as
            // potential middleware; the user gets a clean L3 line
            // for each. Common false-positive filter: `@property`,
            // `@staticmethod`, `@classmethod`, `@functools.wraps`,
            // `@dataclass`. These belong to no-op decorator category.
            if (/^(property|staticmethod|classmethod|wraps|cache|cached_property|dataclass|abstractmethod|override)$/.test(name)) continue;
            // The route decorator is something like `router.get` — the
            // regex captures `get` (after the `.`), but our pattern uses
            // `@<name>` literal. The route is matched by `@<obj>.<method>(...)`
            // form which doesn't start at line beginning when there's an
            // object prefix. So we won't match `router.get` here. We
            // explicitly skip `get/post/put/patch/delete/options/head`
            // (defensive) in case a future decorator shape captures them.
            if (/^(get|post|put|patch|delete|options|head)$/i.test(name)) continue;
            if (!decoratorMws.includes(name)) decoratorMws.push(name);
        }

        // Class-level DRF permission_classes — look for the enclosing
        // `class` keyword before the route.
        const classBeforeRe = /^class\s+\w+/gm;
        let lastClassIdx = -1;
        let lcm: RegExpExecArray | null;
        const sourceBefore = source.slice(0, r.offset);
        while ((lcm = classBeforeRe.exec(sourceBefore)) !== null) {
            lastClassIdx = lcm.index;
        }
        const drfMws: string[] = lastClassIdx >= 0 ? (permClassesByClass.get(lastClassIdx) ?? []) : [];

        const merged = [...decoratorMws, ...drfMws];
        if (merged.length === 0) continue;

        r.api.meta = r.api.meta ?? {};
        const existing = r.api.meta.middlewares ?? [];
        r.api.meta.middlewares = [...existing];
        for (const mw of merged) {
            if (!r.api.meta.middlewares.includes(mw)) r.api.meta.middlewares.push(mw);
        }
        if (!r.api.meta.auth) {
            for (const mw of merged) {
                if (DJANGO_AUTH_DECORATORS.test(mw)) {
                    r.api.meta.auth = 'required';
                    break;
                }
            }
        }
    }
}

