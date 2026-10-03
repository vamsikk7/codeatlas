/**
 * mobileScreenReclassifier.ts — TICKET-MOBILE-1 / DETECT-2 remainder.
 *
 * `mobile/android.ts` emits a `SCREEN` entry point for EVERY `@Composable`
 * function, so a Compose repo massively over-counts screens (kotlin-android:
 * 247 SCREENs, of which only ~31 are real navigable screens — the rest are UI
 * COMPONENTS: `PostCard`, `JumpToBottom`, receiver-shims like `BoxScope`, …).
 * A component is not an architectural entry point and shouldn't get an L3/L4/L5
 * or inflate the screen count.
 *
 * This snapshot-level pass keeps a composable SCREEN only when it is NAVIGABLE:
 *   • it is a NavHost destination target — the composable invoked inside a
 *     `composable(...) { HomeScreen(...) }` / `composable<Route> { Feed() }`
 *     lambda (this is what makes Jetsnack's `Feed`/`Search`/`Profile` — which
 *     don't end in `Screen` — survive); OR
 *   • its name ends in `Screen` (the dominant Compose screen convention).
 * Class-based Activity/Fragment screens (no `meta.composable`) are ALWAYS kept.
 *
 * Runs alongside the Rails/Django/Go anchor passes in SyncOrchestrator Phase
 * 1.5 — BEFORE non-JS sequence graphs (Phase 1B) and feature/api-list graphs
 * (Phase 2) are built, so every downstream surface reflects the reduced set
 * (no orphaned graphs). Pure + count-preserving for non-mobile workspaces.
 */

import type { ApiRecord } from '../graph/graphTypes';

const SCREEN_NAME_RE = /Screen$/;
// A NavHost destination lambda body up to its first `}` (screen destinations
// are the outer call, so this window captures them before any nested content).
// Accepts `composable("route") { }` (string route), `composable<Route> { }`
// (typed route, NO parens) and `composable<Route>("x") { }`.
const COMPOSABLE_DEST_RE = /\bcomposable\s*(?:<[^>]*>|\([^)]*\))\s*(?:\([^)]*\))?\s*\{([^}]*)\}/g;
const PASCAL_CALL_RE = /\b([A-Z]\w+)\s*\(/g;

/** Collect NavHost destination composable names from Kotlin source. */
export function collectComposableNavTargets(sources: Iterable<string>): Set<string> {
    const targets = new Set<string>();
    for (const src of sources) {
        if (!src || !src.includes('composable')) continue;
        COMPOSABLE_DEST_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = COMPOSABLE_DEST_RE.exec(src)) !== null) {
            const body = m[1];
            PASCAL_CALL_RE.lastIndex = 0;
            let c: RegExpExecArray | null;
            while ((c = PASCAL_CALL_RE.exec(body)) !== null) targets.add(c[1]);
        }
    }
    return targets;
}

/**
 * Drop composable SCREEN records that are neither NavHost destinations nor
 * `*Screen`-named (they are UI components, not entry points). Non-composable
 * SCREENs (Activity/Fragment classes) and all other records pass through.
 */
export function reclassifyMobileScreens(
    apiIndex: Record<string, ApiRecord>,
    navTargets: Set<string>,
): Record<string, ApiRecord> {
    let changed = false;
    const out: Record<string, ApiRecord> = {};
    for (const [key, rec] of Object.entries(apiIndex)) {
        if (rec.method === 'SCREEN' && (rec.meta as Record<string, unknown> | undefined)?.composable) {
            const name = rec.handlerName;
            const navigable = navTargets.has(name) || SCREEN_NAME_RE.test(name);
            if (!navigable) { changed = true; continue; } // drop the component
        }
        out[key] = rec;
    }
    return changed ? out : apiIndex;
}
