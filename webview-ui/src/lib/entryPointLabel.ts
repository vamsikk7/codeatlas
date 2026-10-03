/**
 * Cross-stack "entry point" vocabulary (2026-07).
 *
 * Backend services expose HTTP / RPC / GraphQL "APIs". Frontend & mobile
 * services expose screens, navigation routes, deep links, push handlers and
 * outbound data calls — collectively "entry points", NOT APIs. The internal
 * `ApiRecord` model is unchanged; only the USER-FACING noun adapts based on the
 * current service/scope's category.
 *
 * Mirror of the extension-side helper (`src/core/graph/entryPointLabel.ts`) —
 * the two build targets can't import each other, so the tiny decision is kept
 * in sync by hand. Keep them identical.
 */

/** Synthetic methods that mark a record as a frontend/mobile entry point. */
const UI_KIND_METHODS = new Set(['SCREEN', 'NAV_ROUTE', 'NETWORK', 'DI_BINDING']);

/**
 * Canonical HTTP-verb tab order for the L2b method tabs. Non-HTTP entry-point
 * KINDS (SCREEN / NAV_ROUTE / NETWORK / JOB / …) sort after these, by count.
 * Mirror of `HTTP_VERB_ORDER` in FeatureView (kept in sync by hand — the two
 * views can't share module state without a build-target cycle).
 */
export const HTTP_VERB_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY', 'ROUTE', 'CONTROLLER', 'RESOURCE'];

/** Compact tab labels for non-HTTP entry-point KINDS (mirror FeatureView). */
export const METHOD_TAB_LABEL: Record<string, string> = {
    NAV_ROUTE: 'NAV', MQ_CONSUMER: 'MQ', DI_BINDING: 'DI', CLI_COMMAND: 'CLI',
    MODEL_HOOK: 'HOOK', DB_MIGRATION: 'MIGRATE', DB_SEED: 'SEED', SOCKET_EVENT: 'SOCKET',
    CONTENT_PROVIDER: 'PROVIDER', PUSH_HANDLER: 'PUSH', DEEP_LINK: 'DEEPLINK', NETWORK: 'NET',
};

/**
 * BUG-FE-BACKEND-FILTERS — derive the L2b method-tab set from the KINDS actually
 * present in the scope, instead of a hardcoded HTTP-verb list. A frontend/mobile
 * scope surfaces SCREEN / NAV / NET / DATA_FETCH / LIFECYCLE tabs (never
 * GET/POST/…), a backend scope surfaces the HTTP verbs. HTTP verbs sort first in
 * canonical order; other kinds follow by descending count.
 */
export function orderMethodTabs(methodCounts: Record<string, number>): string[] {
    const present = Object.keys(methodCounts).filter((m) => (methodCounts[m] ?? 0) > 0);
    const http = HTTP_VERB_ORDER.filter((m) => present.includes(m));
    const other = present
        .filter((m) => !HTTP_VERB_ORDER.includes(m))
        .sort((a, b) => (methodCounts[b] - methodCounts[a]) || a.localeCompare(b));
    return [...http, ...other];
}

export function isFrontendCategory(category: string | null | undefined): boolean {
    return category === 'frontend' || category === 'mobile';
}

/** The user-facing noun for a service's L2b entry-point list. */
export function entryPointsNoun(category: string | null | undefined): 'APIs' | 'Entry Points' {
    return isFrontendCategory(category) ? 'Entry Points' : 'APIs';
}

/**
 * Best-effort FE/mobile detection from a graph's meta. Returns 'frontend',
 * 'mobile', 'backend', or undefined (caller treats undefined as backend →
 * "APIs", the safe default). Signals, in priority order:
 *   1. explicit meta.category / meta.serviceCategory
 *   2. FE/mobile screen-content panel (meta.screenItems / `screen-content:` id)
 *   3. populated screens / navRoutes / networkCalls buckets
 *   4. every api record carries a UI-kind method
 */
export function categoryFromGraph(
    graph: { graphId?: string; meta?: Record<string, any> } | null | undefined,
): 'backend' | 'frontend' | 'mobile' | undefined {
    const meta = graph?.meta;
    if (!meta) return undefined;
    const explicit = meta.category ?? meta.serviceCategory;
    if (explicit === 'frontend' || explicit === 'mobile' || explicit === 'backend') return explicit;
    if (meta.screenItems || String(graph?.graphId ?? '').startsWith('screen-content:')) return 'frontend';
    if ((meta.screens?.length ?? 0) > 0 || (meta.navRoutes?.length ?? 0) > 0 || (meta.networkCalls?.length ?? 0) > 0) {
        return 'frontend';
    }
    const apis: Array<{ method?: string }> = Array.isArray(meta.apis) ? meta.apis : [];
    if (apis.length > 0 && apis.every((a) => UI_KIND_METHODS.has(String(a?.method)))) return 'frontend';
    return undefined;
}
