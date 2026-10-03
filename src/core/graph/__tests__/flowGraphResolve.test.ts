/**
 * flowGraphResolve.test.ts — #861.
 */
import { describe, it, expect } from 'vitest';
import { resolveFlowGraphId } from '../flowGraphResolve';

const JAVA = [
    'flow:src/main/java/.../VetController.java:VetController.showVetList',
    'flow:src/main/java/.../OwnerController.java:OwnerController.initCreationForm',
    'file:src/main/java/.../VetController.java',
];

describe('resolveFlowGraphId (#861)', () => {
    it('exact match returns the id unchanged', () => {
        expect(resolveFlowGraphId(JAVA, 'flow:src/main/java/.../VetController.java:VetController.showVetList'))
            .toBe('flow:src/main/java/.../VetController.java:VetController.showVetList');
    });

    it('resolves a BARE method name to the class-prefixed stored flow id', () => {
        expect(resolveFlowGraphId(JAVA, 'flow:src/main/java/.../VetController.java:showVetList'))
            .toBe('flow:src/main/java/.../VetController.java:VetController.showVetList');
        expect(resolveFlowGraphId(JAVA, 'flow:src/main/java/.../OwnerController.java:initCreationForm'))
            .toBe('flow:src/main/java/.../OwnerController.java:OwnerController.initCreationForm');
    });

    it('does not cross files — a bare name only matches within the same file', () => {
        // showVetList lives in VetController.java; requesting it under
        // OwnerController.java must NOT resolve to VetController's flow.
        expect(resolveFlowGraphId(JAVA, 'flow:src/main/java/.../OwnerController.java:showVetList'))
            .toBeUndefined();
    });

    it('returns undefined when no method matches', () => {
        expect(resolveFlowGraphId(JAVA, 'flow:src/main/java/.../VetController.java:nope')).toBeUndefined();
    });

    it('does not flow-resolve a non-flow id absent from the set', () => {
        expect(resolveFlowGraphId(JAVA, 'sequence:src/main/java/.../VetController.java:showVetList')).toBeUndefined();
    });

    it('leaves JS bare-name flows (no class prefix) working via exact match', () => {
        const js = ['flow:src/auth.service.ts:getCurrentUser'];
        expect(resolveFlowGraphId(js, 'flow:src/auth.service.ts:getCurrentUser'))
            .toBe('flow:src/auth.service.ts:getCurrentUser');
    });

    // TICKET-UI-5 — a Django/DRF class-based view is anchored by CLASS name
    // (`ArticlesFeedAPIView`) but its flow graphs are keyed `Class.method`
    // (`ArticlesFeedAPIView.list`, `.get_queryset`). A bare class request must
    // resolve to the class's PRIMARY handler method so the L3→L5 drill lands on
    // a real flow instead of dead-ending.
    const DRF = [
        'flow:conduit/apps/articles/views.py:ArticlesFeedAPIView.get_queryset',
        'flow:conduit/apps/articles/views.py:ArticlesFeedAPIView.list',
        'flow:conduit/apps/articles/views.py:ArticleViewSet.get_queryset',
        'flow:conduit/apps/articles/views.py:ArticleViewSet.create',
        'flow:conduit/apps/articles/views.py:ArticleViewSet.list',
        'flow:conduit/apps/articles/views.py:ArticleViewSet.retrieve',
    ];
    it('UI-5 — resolves a CLASS name to its primary handler method (list ≻ get_queryset helper)', () => {
        expect(resolveFlowGraphId(DRF, 'flow:conduit/apps/articles/views.py:ArticlesFeedAPIView'))
            .toBe('flow:conduit/apps/articles/views.py:ArticlesFeedAPIView.list');
    });
    it('UI-5 — prefers a DRF action (list) over other methods of the same class', () => {
        expect(resolveFlowGraphId(DRF, 'flow:conduit/apps/articles/views.py:ArticleViewSet'))
            .toBe('flow:conduit/apps/articles/views.py:ArticleViewSet.list');
    });
    it('UI-5 — class→method only within the same file (no cross-file)', () => {
        expect(resolveFlowGraphId(DRF, 'flow:other/views.py:ArticlesFeedAPIView')).toBeUndefined();
    });
    it('UI-5 — a bare-method match still wins over class→method (UI-3 case preserved)', () => {
        // `findComments` is a bare method → must resolve to the bare-keyed flow,
        // NOT get treated as a class prefix.
        const mixed = ['flow:x.ts:findComments', 'flow:x.ts:findComments.helper'];
        expect(resolveFlowGraphId(mixed, 'flow:x.ts:ArticleService.findComments')).toBe('flow:x.ts:findComments');
    });

    it('#863 — resolves a gid built from the route shape ({param,param2:bareMethod})', () => {
        // The extension's route-shape handler constructs `flow:${param}:${param2}`
        // from a manual deep-link; with a bare method it must resolve to the
        // class-prefixed stored id (same contract as the graphId shape).
        const param = 'src/main/java/.../OwnerController.java';
        const param2 = 'initCreationForm'; // bare, as a hand-typed #/flow/... link gives
        const gid = `flow:${param}:${param2}`;
        expect(resolveFlowGraphId(JAVA, gid))
            .toBe('flow:src/main/java/.../OwnerController.java:OwnerController.initCreationForm');
    });
});
