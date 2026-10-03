/**
 * l1ClickAction.ts — #836 (2026-06-11).
 *
 * Pure decision table for a click on an L1 (microservice) service node.
 * Extracted from App.tsx so the three multi-repo branches are unit-tested:
 *
 *  - cross-repo neighbours re-scope the URL (UX-65, unchanged);
 *  - AWS bucket nodes on the bucketed workspace L1 are groupings, not
 *    services — until per-bucket drill-down lands (skeletalL1 Phase-2
 *    follow-up) the click explains itself instead of dead-ending on an
 *    empty `#/features/aws:<svc>` (#836A);
 *  - feature drills carry the URL scope (`#/system-design/<repo>`) as a
 *    `repoId` hint so colliding bare `service:main` ids resolve to the
 *    repo the user is looking at (#836B); see ADR-038.
 */

export type L1ClickAction =
    | { kind: 'rescope'; hash: string }
    | { kind: 'bucket-toast'; text: string }
    | { kind: 'open-features'; serviceId: string; repoId?: string };

export function resolveL1ClickAction(
    nodeData: { label?: string; meta?: Record<string, unknown> | null },
    locationHash: string,
): L1ClickAction {
    const meta = (nodeData.meta ?? {}) as Record<string, any>;

    const crossRepoTarget = meta.crossRepoTarget as string | undefined;
    if (crossRepoTarget) {
        return { kind: 'rescope', hash: `#/system-design/${crossRepoTarget}` };
    }

    if (meta.awsBucket) {
        const n = Number(meta.patternCount) || 0;
        return {
            kind: 'bucket-toast',
            text: `"${nodeData.label ?? meta.awsBucket}" groups ${n || 'several'} sub-repos — pick one from the Home page to explore its features.`,
        };
    }

    const scopedRepoMatch = locationHash.match(/^#\/system-design\/([^/?]+)/);
    const repoId = (meta.repoId as string | undefined)
        ?? (scopedRepoMatch ? decodeURIComponent(scopedRepoMatch[1]) : undefined);
    return {
        kind: 'open-features',
        serviceId: (meta.serviceId as string | undefined) ?? '',
        ...(repoId ? { repoId } : {}),
    };
}
