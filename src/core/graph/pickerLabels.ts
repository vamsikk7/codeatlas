/**
 * Shared repo/service picker-row label helpers (BUG-CONNECT-4).
 *
 * The scope picker ("Pick a repo to view its system design") and the home
 * explorer slice render one row per repo/service as `<category> · <count> <noun>`.
 * Two defects this module fixes:
 *   1. Rows showed the raw `technology` (often `'unknown'`) where the CATEGORY
 *      (frontend / backend / mobile / docs) belongs.
 *   2. The count noun was hardcoded `'APIs'` even for a FRONTEND/MOBILE repo,
 *      which exposes entry points / screens, not HTTP APIs.
 *
 * Used by both the extension (extension.ts) and the standalone/MCP browser
 * server (messageHandler.ts) so the two surfaces stay in parity by construction.
 */
import type { RepoCategory } from './graphTypes';

/**
 * The user-facing count noun for a picker row. FE/mobile services CONSUME HTTP
 * (screens / data-fetches) so their tally is "entry points"; backends EXPOSE
 * HTTP routes so theirs is "APIs".
 */
export function pickerCountNoun(category: string | null | undefined): 'entry points' | 'APIs' {
    return category === 'frontend' || category === 'mobile' ? 'entry points' : 'APIs';
}

/**
 * The category label for a picker row. Prefer the semantic category; fall back
 * to a meaningful technology, then a neutral `'service'` — never surface the
 * bootstrap sentinel `'unknown'` to the user.
 */
export function pickerCategoryLabel(category: string | null | undefined, technology?: string | null): string {
    if (category && category !== 'unknown' && category !== 'monorepo-parent') return category;
    if (technology && technology !== 'unknown') return technology;
    return 'service';
}

/**
 * The dominant category across a repo's services — the most frequent non-`unknown`,
 * non-`monorepo-parent` category. Used to label a REPO row (which may own several
 * services) from its per-repo service list.
 */
export function dominantCategory(services: Array<{ category?: RepoCategory | string }>): RepoCategory | undefined {
    const counts = new Map<string, number>();
    for (const s of services) {
        const c = s?.category;
        if (!c || c === 'unknown' || c === 'monorepo-parent') continue;
        counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestN = 0;
    for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n; }
    return best as RepoCategory | undefined;
}

/**
 * The category of a REPO from its service list — the label for a picker row that
 * represents a whole sub-repo. A repo that EXPOSES real HTTP routes from any
 * non-frontend service is `backend`, even when those backend services are
 * categorized `unknown` and a stray frontend service (e.g. a react-email
 * templates dir inside a FastAPI backend) would otherwise win a plain
 * frequency vote. Only when nothing exposes HTTP do we fall back to the dominant
 * frontend/mobile category (a pure FE/mobile app consumes rather than exposes).
 */
export function repoCategoryFromServices(
    services: Array<{ category?: RepoCategory | string; exposedApiCount?: number }>,
): RepoCategory | undefined {
    let backendApis = 0;
    for (const s of services) {
        const c = s?.category;
        if (c === 'frontend' || c === 'mobile') continue; // FE/mobile consume, never expose
        backendApis += s?.exposedApiCount ?? 0;
    }
    if (backendApis > 0) return 'backend';
    return dominantCategory(services);
}

/** Build the full `"<category> · <count> <noun>"` subtitle for a picker row. */
export function pickerSubtitle(category: string | null | undefined, technology: string | null | undefined, count: number): string {
    return `${pickerCategoryLabel(category, technology)} · ${count} ${pickerCountNoun(category)}`;
}
