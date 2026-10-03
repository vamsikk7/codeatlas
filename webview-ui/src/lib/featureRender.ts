/**
 * BUG-POLAR-16: the "Entry Points" cluster map is unreadable once a feature
 * graph has many clusters (polar/server = 137 tiny boxes). The persisted render
 * preference could land a fresh deep-link straight on that illegible map.
 *
 * `resolveFeatureRenderDefault` is applied ONLY to the INITIAL render mode: a
 * dense feature graph defaults to the readable "List" view even if 'map' was
 * persisted. The user can still switch to Entry Points explicitly (the toggle
 * sets the mode directly, bypassing this resolver), so no one is locked out of
 * the map — dense graphs just don't OPEN on it.
 */

/** Above this cluster count the Entry-Points map is too dense to read. */
export const DENSE_FEATURE_CLUSTER_THRESHOLD = 60;

export function resolveFeatureRenderDefault(
    persisted: 'list' | 'map',
    clusterCount: number,
    threshold: number = DENSE_FEATURE_CLUSTER_THRESHOLD,
): 'list' | 'map' {
    if (persisted === 'map' && clusterCount > threshold) return 'list';
    return persisted;
}
