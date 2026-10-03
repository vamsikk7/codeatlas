/**
 * BUG-POLAR-21: L5 flow statement boxes render up to 340px wide (FlowNode
 * maxWidth) but the Dagre layout reserved only a fixed default width, so wide
 * sibling branch boxes overlapped (a No-branch statement covered the Yes-branch
 * `ResourceNotFound()` box). Estimating each flow node's width from its content
 * lets Dagre allocate accurate horizontal space so branches don't collide.
 */

export const FLOW_NODE_MIN_WIDTH = 180;
export const FLOW_NODE_MAX_WIDTH = 340;

/**
 * Estimate the rendered width (px) of a flow node from its text — the longest
 * line drives it, clamped to FlowNode's [min,max]. Approximate (≈7px/char + pad)
 * but it only needs to be an upper-bound-ish reservation for the layout, not
 * pixel-perfect; the on-screen box wraps within maxWidth regardless.
 */
export function estimateFlowNodeWidth(text: string | undefined): number {
    const APPROX_CHAR_PX = 7;
    const PADDING_PX = 36;
    const longestLine = String(text ?? '')
        .split('\n')
        .reduce((max, line) => Math.max(max, line.length), 0);
    const estimate = longestLine * APPROX_CHAR_PX + PADDING_PX;
    return Math.max(FLOW_NODE_MIN_WIDTH, Math.min(FLOW_NODE_MAX_WIDTH, estimate));
}
