/**
 * overlayEmptyToast.ts — BUG-EXPLORE-16.
 *
 * When the user enables a data-backed overlay (Test coverage / Sentry /
 * regression scope) that turns out to have NO source data, the OverlaysPanel
 * shows a small inline hint — but that's a modal sub-label that's easy to miss
 * and gone the moment the panel closes, so the canvas reads as a silent no-op.
 *
 * This pure helper decides whether an incoming `overlayData` message should also
 * raise a canvas-level toast. `overlayData` is only ever requested for ENABLED,
 * non-render-managed (data-backed) overlays, so an `empty: true` payload always
 * means "you turned this on and there's nothing to paint". We toast ONCE per
 * empty episode (guarded by the caller-owned `alreadyShown` set) and re-arm when
 * the overlay later reports data, so navigating between graphs doesn't nag.
 */
export function overlayEmptyToastDecision(
    msg: { overlayId: string; empty: boolean; emptyHint?: string },
    alreadyShown: Set<string>,
): { toast: string | null } {
    if (!msg.empty) {
        // Data arrived (or this overlay was never empty) — re-arm for next time.
        alreadyShown.delete(msg.overlayId);
        return { toast: null };
    }
    if (alreadyShown.has(msg.overlayId)) return { toast: null };
    alreadyShown.add(msg.overlayId);
    return {
        toast: msg.emptyHint && msg.emptyHint.trim().length > 0
            ? msg.emptyHint
            : `No data for the ${msg.overlayId} overlay yet — nothing to paint.`,
    };
}
