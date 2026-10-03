/**
 * tourPlayback.ts — pure helpers for the client-side tour walkthrough.
 *
 * BUG-EXPLORE-6: once a tour is playing, its ticker auto-advances by posting
 * `requestRoute` for each step's diagram — which hijacks the whole app if the
 * user tries to navigate elsewhere. The tour must STOP the moment the user
 * navigates to a graph the tour didn't request. The tour marks its own pending
 * navigation via `pendingGraphId`, so any `navigateTo` whose graphId differs
 * from that pending target is user-initiated → stop the walkthrough.
 */

export interface TourPlaybackState {
    pendingGraphId: string | null;
}

/**
 * True when an incoming `navigateTo` should CANCEL the active tour playback —
 * i.e. a tour is running and the arriving graph is NOT the one the tour just
 * requested (so the user navigated away themselves).
 */
export function shouldStopTourOnNavigate(
    playback: TourPlaybackState | null | undefined,
    incomingGraphId: string | null | undefined,
): boolean {
    if (!playback) return false;              // no tour → nothing to stop
    return incomingGraphId !== playback.pendingGraphId; // user went somewhere the tour didn't ask for
}
