/**
 * screenContentGraphBuilder.ts — v2 phase 4 PR-F (#485 — L2b screen contents — 5 sections + visual inventory).
 *
 * Converts `(ScreenRecord, L2bScreenItem[])` → `DiagramGraph` with id
 * `screen-content:<screenId>`. The L2b panel in the webview reads
 * `meta.screenItems` directly and renders the 5-section layout
 * (Interactions / Data sources / Lifecycle / Nav-in / Nav-out) plus
 * the collapsible Visual elements inventory.
 *
 * The graph carries a placeholder `nodes` + `edges` array so it round-
 * trips through the existing `graphs` storage and broadcast pipeline
 * without needing a parallel `screen-content` graph table. All the
 * data the panel reads lives in `meta.screenItems`.
 */

import type {
    DiagramGraph,
    GraphNode,
    L2bScreenItem,
    ScreenRecord,
} from './graphTypes';

/**
 * Build one screen-content graph for an FE/mobile screen.
 *
 * The graph id is stable across cascade rebuilds (matches
 * `ScreenRecord.screenId`) so the panel can preserve scroll position
 * and selection when items are added/removed/modified.
 */
export function buildScreenContentGraph(
    screen: ScreenRecord,
    items: L2bScreenItem[],
): DiagramGraph {
    const graphId = `screen-content:${screen.screenId}`;
    // One placeholder node per section so the graphs table has a
    // non-empty payload even when a section is empty. The webview
    // doesn't consume `nodes` for this graph type — it reads
    // `meta.screenItems` directly — but the storage layer expects a
    // non-zero nodes array for the standard graph shape.
    const sectionNodes: GraphNode[] = [
        { id: 'sec:interactions', type: 'section' as const, label: 'Interactions', anchor: { filePath: screen.filePath } },
        { id: 'sec:data', type: 'section' as const, label: 'Data sources', anchor: { filePath: screen.filePath } },
        { id: 'sec:lifecycle', type: 'section' as const, label: 'Lifecycle', anchor: { filePath: screen.filePath } },
        { id: 'sec:nav-in', type: 'section' as const, label: 'Navigation in', anchor: { filePath: screen.filePath } },
        { id: 'sec:nav-out', type: 'section' as const, label: 'Navigation out', anchor: { filePath: screen.filePath } },
        { id: 'sec:visual', type: 'section' as const, label: 'Visual elements', anchor: { filePath: screen.filePath } },
    ];
    const anchors: Record<string, { filePath: string }> = {};
    for (const node of sectionNodes) {
        anchors[node.id] = { filePath: screen.filePath };
    }
    return {
        graphId,
        type: 'screen-content',
        nodes: sectionNodes,
        edges: [],
        anchors,
        meta: {
            screenId: screen.screenId,
            serviceId: screen.serviceId,
            routePath: screen.routePath,
            framework: screen.framework,
            filePath: screen.filePath,
            screenItems: items,
            // Per-section counts so the renderer can show "Interactions
            // (3)" headers without re-scanning the items array.
            sectionCounts: countBySection(items),
        } as Record<string, unknown>,
    };
}

function countBySection(items: L2bScreenItem[]): Record<string, number> {
    const counts: Record<string, number> = {
        interactions: 0,
        data: 0,
        lifecycle: 0,
        'nav-in': 0,
        'nav-out': 0,
        visual: 0,
    };
    for (const item of items) {
        if (counts[item.section] !== undefined) counts[item.section]++;
    }
    return counts;
}
