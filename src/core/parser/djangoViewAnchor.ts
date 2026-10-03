/**
 * djangoViewAnchor.ts — BUG-EXP-11 (2026-07-12).
 *
 * Django routes are declared in an app's `urls.py`
 * (`path('feed/', ArticlesFeedAPIView.as_view())`), so every generated entry
 * point's `filePath` anchors to **urls.py** — a URLconf with no handler body —
 * not the `views.py` that actually implements the request. Result: EVERY Django
 * endpoint's L3 sequence / L4 file / L5 flow is degenerate (2-participant
 * sequence into urls.py, L4 = just `urlpatterns`), and a PR that edits only
 * `views.py` matches no entry point.
 *
 * Django's near-universal convention is `app/urls.py` ↔ `app/views.py` (or a
 * `app/views/` package). This snapshot-level pass re-anchors each urls.py route
 * onto its sibling `views.py` (the module that defines the handler). Like the
 * Rails controller anchor (railsControllerAnchor.ts) it is:
 *   - **pure** — no I/O, deterministic for a given (apiIndex, files);
 *   - **count-preserving** — re-anchors existing entries, never duplicates;
 *   - **baseline/working symmetric** — runs on every snapshot build, so both
 *     sides re-anchor identically → no diff churn.
 * INCLUDE / migration / signal entries and routes with no sibling views module
 * pass through unchanged.
 */

import type { ApiRecord } from '../graph/graphTypes';

/** True for a Django URLconf file (`urls.py` at any depth). */
function isUrlsFile(filePath: string): boolean {
    return /(^|\/)urls\.py$/.test(filePath);
}

/** Methods that describe a real view handler (not a mount / lifecycle entry). */
const NON_VIEW_METHODS = new Set(['INCLUDE', 'MOUNT', 'DB_MIGRATION', 'DB_SEED', 'SIGNAL', 'MODEL_HOOK']);

export function resolveDjangoViewAnchors(
    apiIndex: Record<string, ApiRecord>,
    files: Iterable<string>,
): Record<string, ApiRecord> {
    const fileSet = files instanceof Set ? files : new Set(files);
    // Bail fast on non-Django workspaces (no urls.py at all).
    let hasUrls = false;
    for (const f of fileSet) { if (isUrlsFile(f)) { hasUrls = true; break; } }
    if (!hasUrls) return apiIndex;

    let changed = false;
    const out: Record<string, ApiRecord> = {};
    for (const [key, rec] of Object.entries(apiIndex)) {
        const reanchored = tryReanchor(rec, fileSet);
        if (reanchored) {
            out[reanchored.apiId] = reanchored;
            changed = true;
        } else {
            out[key] = rec;
        }
    }
    return changed ? out : apiIndex;
}

function tryReanchor(rec: ApiRecord, fileSet: Set<string>): ApiRecord | null {
    if (!isUrlsFile(rec.filePath)) return null;
    if (NON_VIEW_METHODS.has(rec.method)) return null;
    // Handler must be a plain view identifier (CBV class or FBV function).
    if (!/^[A-Za-z_]\w*$/.test(rec.handlerName)) return null;

    // Same-dir `views.py`, else a `views/` package (views/__init__.py). The
    // urls.py → views.py sibling convention is Django-universal.
    const dir = rec.filePath.replace(/urls\.py$/, ''); // 'conduit/apps/articles/'
    const candidates = [`${dir}views.py`, `${dir}views/__init__.py`];
    const viewsFile = candidates.find((c) => fileSet.has(c));
    if (!viewsFile) return null;

    return {
        ...rec,
        apiId: `${rec.method}:${rec.route}::${viewsFile}::${rec.handlerName}`,
        filePath: viewsFile,
        // TICKET-ANCHOR-1 residual — keep the anchor consistent with the
        // re-anchored filePath (both = views.py). The old span pointed into
        // urls.py, so drop the stale position fields (jump-to-def resolves by
        // symbol). The URLconf stays in meta.routeDeclFile (reviewContext matches
        // it so a urls.py change still surfaces the pack).
        anchor: { ...(rec.anchor ?? {}), filePath: viewsFile, symbol: rec.handlerName, span: undefined, lineStart: undefined, lineEnd: undefined },
        meta: {
            ...(rec.meta ?? {}),
            routeDeclFile: rec.filePath, // keep where the route was declared
        },
    };
}
