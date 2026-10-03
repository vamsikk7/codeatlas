/**
 * seqDeadEnd.ts — honest feedback for L3 (sequence) clicks that have no deeper
 * (L4/L5) navigation target.
 *
 * Some sequence participants and message edges legitimately cannot drill down:
 * external dependencies (npm/pip/maven packages), DB/cache/queue lanes, and
 * receivers the resolver could only match by name have no `flow:`/`file:` graph
 * to open. Previously clicking them was a SILENT no-op (the handler fell through
 * every navigation branch and only sent a selection ping) — indistinguishable
 * from a broken click. These pure predicates + messages let the click surface a
 * short toast instead, so every click does something visible.
 *
 * Pure + framework-free so it is unit-tested directly (mirrors l1ClickAction /
 * impactAction / overlayEmptyToast).
 */

/** A sequence participant can drill (to its L4 file diagram) only if its anchor resolves to a file. */
export function participantHasNoTarget(anchor: any): boolean {
    return !anchor || !anchor.filePath;
}

/**
 * A sequence message edge has a navigable target when ANY of the handler's
 * navigation priorities apply:
 *   1. edge-level anchor with a filePath (→ L5 flow / source),
 *   2. target participant with symbol + filePath (→ L5 flow),
 *   3. target participant with filePath (→ L4 file),
 *   4. a filePath-less edge anchor (host answers with its own info toast).
 * If none apply it is a genuine dead-end and the caller should toast.
 */
export function edgeHasNoTarget(edgeData: any): boolean {
    if (!edgeData) return false; // not a real edge click — leave it alone
    if (edgeData.anchor?.filePath) return false;
    const tp = edgeData.targetParticipant;
    if (tp?.anchor?.symbol && tp?.anchor?.filePath) return false;
    if (tp?.anchor?.filePath) return false;
    if (edgeData.anchor) return false; // filePath-less anchor → handled host-side
    return true;
}

/** Toast text for a dead-end participant click. */
export function participantDeadEndMessage(label?: string): string {
    const who = label && label.trim() ? `"${label.trim()}"` : 'this participant';
    return `No deeper view for ${who} — it isn't resolved to a file in this workspace (external dependency or unresolved call).`;
}

/** Toast text for a dead-end message-edge click. Mirrors the host's edgeClicked info toast. */
export const MESSAGE_DEAD_END_EDGE =
    "No source location for this message — its target couldn't be resolved to a file.";
