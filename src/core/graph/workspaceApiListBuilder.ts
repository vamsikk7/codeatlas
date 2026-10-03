/**
 * workspaceApiListBuilder.ts — TICKET-UI-1.
 *
 * The "APIs" toolbar button (and the "pick an API" flow/sequence landings) must
 * show EVERY entry point in the workspace, not an incidental single community
 * cluster (`cluster:src` — often 1 of N, making the repo look like it has one
 * API). Both surfaces build the same synthetic `api-list:workspace` graph from
 * the full apiIndex so the VSIX (`toolHandlers.ts`) and the MCP standalone
 * (`messageHandler.ts`) render an identical list — VSIX↔MCP parity by
 * construction rather than two hand-rolled copies that can drift.
 *
 * Buckets mirror `apiListGraphBuilder` (the per-cluster L2b builder) so the
 * ApiListPanel groups HTTP APIs / screens / nav routes / network / DI the same
 * way it does for a cluster list.
 */

import type { ApiRecord, DiagramGraph } from './graphTypes';

/** Methods the L2b panel renders in dedicated (non-"HTTP APIs") sections. */
const SCREEN_METHOD = 'SCREEN';
const NAV_ROUTE_METHOD = 'NAV_ROUTE';
const NETWORK_METHOD = 'NETWORK';
const DI_BINDING_METHOD = 'DI_BINDING';
const NON_HTTP_METHODS = new Set([SCREEN_METHOD, NAV_ROUTE_METHOD, NETWORK_METHOD, DI_BINDING_METHOD]);

export const WORKSPACE_API_LIST_ID = 'api-list:workspace';

/**
 * Build the workspace-wide L2b list, or `null` when the workspace has no entry
 * points yet (caller shows a "run Initialize" toast).
 */
export function buildWorkspaceApiListGraph(
    apiIndex: Record<string, ApiRecord> | undefined,
): DiagramGraph | null {
    const apis = Object.values(apiIndex ?? {});
    if (apis.length === 0) return null;
    return {
        graphId: WORKSPACE_API_LIST_ID,
        type: 'api-list',
        nodes: [],
        edges: [],
        anchors: {},
        meta: {
            clusterId: 'workspace',
            clusterLabel: 'All Workspace APIs',
            apis: apis.filter((a) => !NON_HTTP_METHODS.has(a.method)),
            screens: apis.filter((a) => a.method === SCREEN_METHOD),
            navRoutes: apis.filter((a) => a.method === NAV_ROUTE_METHOD),
            networkCalls: apis.filter((a) => a.method === NETWORK_METHOD),
            diBindings: apis.filter((a) => a.method === DI_BINDING_METHOD),
            files: Array.from(new Set(apis.map((a) => a.filePath).filter(Boolean))),
        },
    } as DiagramGraph;
}
