/**
 * entryPointCounts.ts — TICKET-MOBILE-1.
 *
 * Shared predicates for the landing / picker headline counts so a mobile repo
 * reads a coherent "N APIs · M Screens" instead of counting every `@Composable`
 * SCREEN as an "API". SCREEN (post-reclassify: real navigable screens only) and
 * NAV_ROUTE are UI navigation, not APIs. No-op for backend repos (they have no
 * SCREEN / NAV_ROUTE records).
 */

/** UI-navigation methods that are NOT "APIs" for the headline API count. */
const NON_API_UI_METHODS = new Set(['SCREEN', 'NAV_ROUTE']);

export function isScreenRecord(rec: { method?: string }): boolean {
    return rec.method === 'SCREEN';
}

/** True for records counted under the "APIs" headline (excludes UI navigation). */
export function isHeadlineApiRecord(rec: { method?: string }): boolean {
    return !!rec.method && !NON_API_UI_METHODS.has(rec.method);
}
