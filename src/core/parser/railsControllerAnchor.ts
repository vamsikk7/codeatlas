/**
 * railsControllerAnchor.ts — #880 (2026-06-26).
 *
 * Rails `resources :x` / `resource :x` routes are detected in `config/routes.rb`,
 * so each generated entry point's `filePath` anchors to **routes.rb** — not the
 * controller that actually handles the request. A PR that edits only
 * `app/controllers/x_controller.rb` therefore matches no entry point (review-pr
 * filters entries by `filePath ∈ changedFiles`), so the controller change goes
 * unreviewed even though the controller IS the handler.
 *
 * This is a snapshot-level resolution pass (like the sequence weaver): for each
 * Rails resource entry, resolve its controller file (`<name>_controller.rb`) from
 * the snapshot's file list and RE-ANCHOR the entry there. It runs deterministically
 * on every snapshot build (init + rebuildFile), so baseline and working re-anchor
 * identically → no diff churn (apiId is recomputed from the controller path, but
 * the same on both sides). It re-anchors existing entries only — the entry COUNT
 * is unchanged (#880 / #873 constraint).
 */

import type { ApiRecord } from '../graph/graphTypes';

/** Rails resource entries carry `handlerName: anonymous@RESOURCE:/<base>#<action>`. */
const RESOURCE_HANDLER_RE = /^anonymous@RESOURCE:\/([^#]*)#(\w+)$/;

/**
 * TICKET-DETECT-3 — explicit routes (`get "job" => "job#index"`, `to: 'x#y'`)
 * carry `handlerName: anonymous@ROUTE:<controller>#<action>`. Unlike a resource
 * name, the controller path here is LITERAL (Rails does not pluralize an
 * explicit reference: `job#index` → `job_controller.rb`).
 */
const EXPLICIT_HANDLER_RE = /^anonymous@ROUTE:([\w/]+)#(\w+)$/;

/** Extract `{ base, action }` from either a resource or an explicit-route handler. */
function parseHandler(handlerName: string): { base: string; action: string } | null {
    const r = RESOURCE_HANDLER_RE.exec(handlerName);
    if (r) return { base: r[1], action: r[2] };
    const e = EXPLICIT_HANDLER_RE.exec(handlerName);
    if (e) return { base: e[1], action: e[2] };
    return null;
}

/** True for a Rails route-declaration file (config/routes.rb or any nested routes.rb). */
function isRoutesFile(filePath: string): boolean {
    return /(^|\/)routes\.rb$/.test(filePath);
}

/**
 * BUG-EXP-10 — Rails controllers are ALWAYS plural, even for a singular
 * `resource :user`. Minimal English pluralizer for resource names (user→users,
 * follow→follows, favorite→favorites, category→categories, box→boxes).
 */
function pluralize(w: string): string {
    if (/[^aeiou]y$/i.test(w)) return w.slice(0, -1) + 'ies';
    if (/(?:s|x|z|ch|sh)$/i.test(w)) return w + 'es';
    return w + 's';
}

/**
 * Re-anchor Rails resource entries declared in a routes file onto their
 * controller. Returns a new apiIndex (re-keyed by the recomputed apiId for any
 * re-anchored entry); non-Rails workspaces and unresolvable entries pass through
 * unchanged. Pure — no I/O, deterministic for a given (apiIndex, files).
 */
export function resolveRailsControllerAnchors(
    apiIndex: Record<string, ApiRecord>,
    files: Iterable<string>,
): Record<string, ApiRecord> {
    // Only ruby controller files are candidates; bail fast on non-Rails repos.
    const controllers = [...files].filter((f) => /_controller\.rb$/.test(f));
    if (controllers.length === 0) return apiIndex;

    let changed = false;
    const out: Record<string, ApiRecord> = {};
    for (const [key, rec] of Object.entries(apiIndex)) {
        const reanchored = tryReanchor(rec, controllers);
        if (reanchored) {
            out[reanchored.apiId] = reanchored;
            changed = true;
        } else {
            out[key] = rec;
        }
    }
    return changed ? out : apiIndex;
}

function tryReanchor(rec: ApiRecord, controllers: string[]): ApiRecord | null {
    if (!isRoutesFile(rec.filePath)) return null;
    const parsed = parseHandler(rec.handlerName);
    if (!parsed) return null;
    const base = parsed.base; // resource path, e.g. 'uploads' / 'admin/uploads' / 'job'
    const action = parsed.action; // e.g. 'create'
    const baseName = base.split('/').pop() || base; // 'uploads' / 'user' / 'job'
    const nsPrefix = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : ''; // 'admin/'

    // BUG-EXP-10 — try the base name as declared AND its plural form. Rails
    // controllers are always plural, so a singular `resource :user` maps to
    // `users_controller.rb`. Already-plural bases (`resources :articles`) match
    // on the first candidate; singular ones (`/user`, `/follow`, `/favorite`)
    // match on the plural. Prefer a namespace-path match, else a basename match.
    const candidateNames = [`${baseName}_controller.rb`, `${pluralize(baseName)}_controller.rb`];
    let controller: string | undefined;
    for (const name of candidateNames) {
        const nsPath = `${nsPrefix}${name}`; // 'admin/uploads_controller.rb'
        controller =
            controllers.find((c) => c.endsWith(`/app/controllers/${nsPath}`) || c === `app/controllers/${nsPath}`)
            ?? controllers.find((c) => c.endsWith(`/${name}`) || c === name);
        if (controller) break;
    }
    if (!controller) return null;

    return {
        ...rec,
        apiId: `${rec.method}:${rec.route}::${controller}::${action}`,
        filePath: controller,
        handlerName: action,
        // TICKET-ANCHOR-1 residual — keep the anchor consistent with the
        // re-anchored filePath (both = the controller). The old span pointed
        // into routes.rb, so drop the stale position fields; downstream jump-to-
        // def resolves by symbol. The route file is preserved in meta.routeDeclFile
        // (reviewContext matches it so a routes.rb change still surfaces the pack).
        anchor: { ...(rec.anchor ?? {}), filePath: controller, symbol: action, span: undefined, lineStart: undefined, lineEnd: undefined },
        meta: {
            ...(rec.meta ?? {}),
            routeDeclFile: rec.filePath, // keep where the route was declared
            railsResource: base,
        },
    };
}
