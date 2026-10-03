/**
 * navLoader.ts — page-level navigation loading indicator (UX-PAGE-LOADER).
 *
 * When a user clicks a node/row/breadcrumb that navigates to the next diagram
 * layer, there is a gap (server round-trip + render) during which the stale
 * page stays on screen — the user clicks and "nothing happens" until the next
 * layer is ready. A transient overlay during that gap fixes the perceived
 * unresponsiveness.
 *
 * IMPORTANT: the overlay must NOT appear during replay playback (commit-timeline
 * or working-changes replay auto-advances step-by-step; a loader flashing on
 * every auto-step would be jarring). Replay is signalled by a non-null
 * `replayState` (L5 function replay HUD) or `timelineReplay` (commit replay).
 */

/**
 * Decide whether to render the navigation loader overlay.
 * @param navPending  a manual navigation was dispatched and its render hasn't landed
 * @param replayActive true when ANY replay (function or commit-timeline) is active
 */
export function shouldShowNavLoader(navPending: boolean, replayActive: boolean): boolean {
    if (replayActive) return false; // never during replay auto-stepping
    return navPending;
}

/**
 * True when either replay mechanism is active. Callers pass the two App-level
 * replay states; kept here so the exclusion rule lives with the loader logic.
 */
export function isReplayActive(replayState: unknown, timelineReplay: unknown): boolean {
    return replayState != null || timelineReplay != null;
}
