/**
 * Cross-stack "entry point" vocabulary (2026-07).
 *
 * Backend services expose HTTP / RPC / GraphQL "APIs". Frontend & mobile
 * services expose screens, navigation routes, deep links, push handlers and
 * outbound data calls — collectively "entry points", NOT APIs. The internal
 * `ApiRecord` model is unchanged; only the USER-FACING noun adapts based on the
 * service/scope category.
 *
 * Mirror of the webview-side helper (`webview-ui/src/lib/entryPointLabel.ts`) —
 * the two build targets can't import each other, so the tiny decision is kept
 * in sync by hand. Keep them identical.
 */

/** Synthetic methods that mark a record as a frontend/mobile entry point. */
const UI_KIND_METHODS = new Set(['SCREEN', 'NAV_ROUTE', 'NETWORK', 'DI_BINDING']);

export function isFrontendCategory(category: string | null | undefined): boolean {
    return category === 'frontend' || category === 'mobile';
}

/** The user-facing noun for a service/cluster's L2b entry-point list. */
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

/** Convenience: the entry-point noun for a graph, deriving its category. */
export function entryPointsNounForGraph(
    graph: { graphId?: string; meta?: Record<string, any> } | null | undefined,
): 'APIs' | 'Entry Points' {
    return entryPointsNoun(categoryFromGraph(graph));
}
