/**
 * buildFlowGraphForPath.test.ts — TICKET-UI-3 (VSIX side).
 *
 * An L3 sequence-edge anchor carries the CLASS-QUALIFIED symbol
 * (`ArticleService.findComments`) while init stores the flow graph under the
 * BARE method name (`flow:…:findComments`). buildFlowGraphForPath must resolve
 * that mismatch to the PRE-BUILT graph instead of slicing bare method syntax
 * out of source and handing it to the parser (→ "Unexpected token").
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: { workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }] },
    window: { showWarningMessage: vi.fn(), showErrorMessage: vi.fn() },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    commands: { executeCommand: vi.fn() },
}));

import { buildFlowGraphForPath, openFunctionFlowInPanel } from '../navigationHandlers';
import { makeHarness } from './handlerHarness';

describe('TICKET-UI-3 — buildFlowGraphForPath resolves class-qualified → bare flow id', () => {
    it('returns the pre-built bare-keyed flow graph for a class-qualified request (no parse rebuild)', () => {
        const h = makeHarness();
        const bareId = 'flow:src/article/article.service.ts:findComments';
        h.setWorking({
            graphs: {
                [bareId]: { graphId: bareId, type: 'flow', nodes: [{ id: 'n1', type: 'statement', label: 'start' }], edges: [], anchors: {}, meta: {} },
            },
        });
        // The edge anchor gives the CLASS-QUALIFIED name — the exact lookup misses,
        // and a rebuild would slice `findComments(…){…}` (method syntax) and throw.
        const g = buildFlowGraphForPath(h.ctx, 'src/article/article.service.ts', 'ArticleService.findComments');
        expect(g, 'must resolve to the pre-built bare flow graph').toBeTruthy();
        expect(g?.graphId).toBe(bareId);
    });

    it('TICKET-UI-5 — resolves a CLASS name (DRF CBV) to its primary handler method flow', () => {
        const h = makeHarness();
        h.setWorking({
            graphs: {
                'flow:conduit/apps/articles/views.py:ArticlesFeedAPIView.get_queryset': { graphId: 'flow:conduit/apps/articles/views.py:ArticlesFeedAPIView.get_queryset', type: 'flow', nodes: [{ id: 'n', type: 'statement', label: 's' }], edges: [], anchors: {}, meta: {} },
                'flow:conduit/apps/articles/views.py:ArticlesFeedAPIView.list': { graphId: 'flow:conduit/apps/articles/views.py:ArticlesFeedAPIView.list', type: 'flow', nodes: [{ id: 'n', type: 'statement', label: 's' }], edges: [], anchors: {}, meta: {} },
            },
        });
        // The L3 inbound-message anchor carries only the CLASS name.
        const g = buildFlowGraphForPath(h.ctx, 'conduit/apps/articles/views.py', 'ArticlesFeedAPIView');
        expect(g?.graphId, 'class → primary handler method (list ≻ get_queryset)').toBe('flow:conduit/apps/articles/views.py:ArticlesFeedAPIView.list');
    });

    it('TICKET-UI-5 — openFunctionFlowInPanel resolves a NON-JS class name to its method flow BEFORE the language branch', () => {
        const h = makeHarness();
        const listId = 'flow:conduit/apps/articles/views.py:ArticlesFeedAPIView.list';
        h.setWorking({
            graphs: {
                [listId]: { graphId: listId, type: 'flow', nodes: [{ id: 'n', type: 'statement', label: 's' }], edges: [], anchors: {}, meta: {} },
            },
        });
        // views.py is Python (non-JS) — without the resolve-first pre-check this
        // would fall to the tree-sitter builder and try to parse the CLASS as a
        // function. Resolve-first navigates straight to the pre-built .list flow.
        openFunctionFlowInPanel(h.ctx, 'conduit/apps/articles/views.py', 'ArticlesFeedAPIView', 'panel-1');
        const nav = (h.ctx.panelManager as any).navigatePanel.mock.calls;
        expect(nav.length, 'navigated to a flow').toBeGreaterThanOrEqual(1);
        expect(nav[0][1], 'resolved graphId').toBe(listId);
        expect(nav[0][2]).toBe('flow');
    });
});
