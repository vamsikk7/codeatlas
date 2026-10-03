/**
 * navigate.ts — shared helpers for popover/card → diagram navigation.
 *
 * Mirrors the `graphIdToHash` in App.tsx (kept in sync intentionally; the
 * extraction is opt-in for new feature code so we don't churn the message
 * pipeline). Used by AiReviewFindingsPopover to turn a binding's graphId
 * into a hash route + open the scoped review panel.
 */

import type { AiReviewBinding, AiReviewFinding } from './types';

export function graphIdToHash(graphId: string): string {
    // Guard undefined/empty (BUG-AIREVIEW-BLOCKS-L2NAV): a finding/binding that
    // arrives without a graphId must not throw `graphId.startsWith` here —
    // this runs inside render maps, so a throw crashes the whole diagram.
    if (!graphId) return '#/system-design';
    if (graphId === 'microservice:workspace') return '#/system-design';
    if (graphId === 'feature:workspace') return '#/features';
    if (graphId.startsWith('feature:')) return `#/features/${graphId.slice(8)}`;
    if (graphId.startsWith('api-list:')) return `#/apis/${graphId.slice(9)}`;
    if (graphId.startsWith('sequence:')) return `#/sequence/${graphId.slice(9)}`;
    if (graphId.startsWith('file:')) return `#/file/${graphId.slice(5)}`;
    if (graphId.startsWith('flow:')) {
        const rest = graphId.slice(5);
        const lastColon = rest.lastIndexOf(':');
        if (lastColon > 0) return `#/flow/${rest.slice(0, lastColon)}/${rest.slice(lastColon + 1)}`;
        return `#/flow/${rest}`;
    }
    if (graphId === 'health:report') return '#/health';
    return `#/diagram/${encodeURIComponent(graphId)}`;
}

/**
 * Pick the most specific binding for a finding — flow > file > sequence >
 * api-list > feature > microservice. Deepest layer is the most useful target
 * when the user clicks a finding from the home-page popover.
 */
const LAYER_RANK: Record<string, number> = {
    flow: 1, file: 2, sequence: 3, 'api-list': 4, feature: 5, microservice: 6,
};
export function bestBinding(finding: AiReviewFinding): AiReviewBinding | null {
    if (!finding.bindings || finding.bindings.length === 0) return null;
    return finding.bindings.slice().sort(
        (a, b) => (LAYER_RANK[a.layer] ?? 99) - (LAYER_RANK[b.layer] ?? 99),
    )[0];
}

/**
 * Navigate to the diagram/location that owns a finding. AI review lives only in
 * the home Code Review section now — clicking a finding takes the user to the
 * relevant layer, but no AI-review overlay/panel is opened on the diagram.
 */
export function navigateToFinding(finding: AiReviewFinding): void {
    const binding = bestBinding(finding);
    if (!binding) return;
    try {
        const hash = graphIdToHash(binding.graphId);
        if (typeof window !== 'undefined' && window.location.hash !== hash) {
            window.location.hash = hash;
        }
    } catch { /* noop */ }
}
