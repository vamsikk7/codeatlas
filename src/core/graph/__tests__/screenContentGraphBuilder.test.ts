/**
 * screenContentGraphBuilder.test.ts — v2 phase 4 PR-F.
 *
 * Locks the contract for the per-screen L2b graph:
 *   1. The graph id matches `screen-content:<screenId>` so the
 *      DiagramView router and the App.tsx hash-route mapper can both
 *      find the panel from a stable URL.
 *   2. `meta.screenItems` is the full item list (the panel reads it
 *      directly — graph nodes/edges are placeholders).
 *   3. `meta.sectionCounts` mirrors the section bucket sizes so the
 *      panel can render "(N)" header counters without re-iterating.
 *   4. Empty input (zero items) still produces a valid graph payload
 *      so the panel can render the "no items detected yet" state
 *      instead of crashing on a missing graph entry.
 */

import { describe, it, expect } from 'vitest';
import { buildScreenContentGraph } from '../screenContentGraphBuilder';
import type { ScreenRecord, L2bScreenItem } from '../graphTypes';

function mkScreen(over: Partial<ScreenRecord> & { screenId: string }): ScreenRecord {
    return {
        serviceId: 'service:web',
        routePath: '/',
        framework: 'nextjs-app',
        filePath: 'apps/web/app/page.tsx',
        anchor: { filePath: 'apps/web/app/page.tsx', lineStart: 1, lineEnd: 1 },
        ...over,
    };
}

function mkItem(over: Partial<L2bScreenItem> & { itemId: string; section: L2bScreenItem['section']; kind: string }): L2bScreenItem {
    return {
        screenId: 'screen:service:web:/',
        label: 'placeholder',
        filePath: 'apps/web/app/page.tsx',
        anchor: { filePath: 'apps/web/app/page.tsx', lineStart: 1, lineEnd: 1 },
        ...over,
    };
}

describe('buildScreenContentGraph', () => {
    it('graph id is stable and prefixed `screen-content:`', () => {
        const screen = mkScreen({ screenId: 'screen:service:web:/home' });
        const graph = buildScreenContentGraph(screen, []);
        expect(graph.graphId).toBe('screen-content:screen:service:web:/home');
        expect(graph.type).toBe('screen-content');
    });

    it('meta carries screen identity + screenItems + sectionCounts', () => {
        const screen = mkScreen({ screenId: 's', routePath: '/login', framework: 'remix' });
        const items: L2bScreenItem[] = [
            mkItem({ itemId: 'interactions:fp:a', section: 'interactions', kind: 'interaction:click' }),
            mkItem({ itemId: 'interactions:fp:b', section: 'interactions', kind: 'interaction:submit' }),
            mkItem({ itemId: 'data:fp:useQuery', section: 'data', kind: 'data:hook' }),
            mkItem({ itemId: 'nav-out:fp:/home', section: 'nav-out', kind: 'nav-out:link' }),
        ];
        const graph = buildScreenContentGraph(screen, items);
        const meta = graph.meta as Record<string, unknown>;
        expect(meta.screenId).toBe('s');
        expect(meta.routePath).toBe('/login');
        expect(meta.framework).toBe('remix');
        expect(meta.screenItems).toEqual(items);
        expect(meta.sectionCounts).toEqual({
            interactions: 2,
            data: 1,
            lifecycle: 0,
            'nav-in': 0,
            'nav-out': 1,
            visual: 0,
        });
    });

    it('empty items still produces a valid graph (panel can render empty-state)', () => {
        const graph = buildScreenContentGraph(mkScreen({ screenId: 'empty' }), []);
        expect(graph.nodes.length).toBe(6);          // 6 section header placeholders
        expect(graph.edges).toEqual([]);
        expect((graph.meta as { screenItems: L2bScreenItem[] }).screenItems).toEqual([]);
        // Every section count is 0 — but the keys are present so the
        // renderer never has to default-undefined check.
        const counts = (graph.meta as { sectionCounts: Record<string, number> }).sectionCounts;
        expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    });

    it('items in an unrecognised section are NOT counted (defensive)', () => {
        const screen = mkScreen({ screenId: 's' });
        const items = [
            mkItem({ itemId: 'a', section: 'interactions', kind: 'interaction:click' }),
            { ...mkItem({ itemId: 'b', section: 'interactions', kind: 'x' }), section: 'bogus' } as unknown as L2bScreenItem,
        ];
        const graph = buildScreenContentGraph(screen, items);
        const counts = (graph.meta as { sectionCounts: Record<string, number> }).sectionCounts;
        // Only the well-known section counts increment; the bogus one
        // is dropped silently. This guards against snapshot-format
        // drift writing untyped section strings.
        expect(counts.interactions).toBe(1);
        expect(Object.keys(counts).sort()).toEqual(['data', 'interactions', 'lifecycle', 'nav-in', 'nav-out', 'visual']);
    });

    it('anchors map covers every section node so jump-to-definition works', () => {
        const screen = mkScreen({ screenId: 's', filePath: 'apps/web/Login.tsx' });
        const graph = buildScreenContentGraph(screen, []);
        // Every section node id maps to an anchor pointing at the
        // screen file — clicking any header lands the user on the
        // declaring file even when the section has zero items.
        for (const node of graph.nodes) {
            expect(graph.anchors[node.id]).toBeDefined();
            expect(graph.anchors[node.id].filePath).toBe('apps/web/Login.tsx');
        }
    });
});
