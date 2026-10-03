/**
 * graphViewMerge.test.ts — #821 (2026-06-10).
 *
 * Pins the ADR-034 ownership contract for the requestRoute graph view in
 * multi-repo mode. The bug this guards against: the workspace store held
 * a STALE copy of `file:api-service/src/services/auth.service.js`
 * (`diff:'unchanged'`) written at init, while the per-repo store held the
 * FRESH post-edit copy (`diff:'modified'`). The pre-#821 merge was
 * workspace-wins-when-non-empty, so the stale copy shadowed the fresh one
 * and the `~ modified` marker never reached the browser (DB-right +
 * UI-wrong, dev-walkthrough 2026-06-10).
 */

import { describe, it, expect } from 'vitest';
import { mergeGraphsForView, isRepoScopedGraphId } from '../graphViewMerge';

const WS = '/ws';

function graph(nodes: Array<Record<string, unknown>>): any {
    return { nodes, edges: [], anchors: {} };
}

describe('#821 — isRepoScopedGraphId', () => {
    it('classifies repo-scoped vs workspace-scoped ids per ADR-034', () => {
        expect(isRepoScopedGraphId('file:api-service/src/a.js', WS)).toBe(true);
        expect(isRepoScopedGraphId('flow:api-service/src/a.js:fn', WS)).toBe(true);
        expect(isRepoScopedGraphId('sequence:api-service/src/a.js:handler', WS)).toBe(true);
        expect(isRepoScopedGraphId('api-list:cluster:auth', WS)).toBe(true);
        expect(isRepoScopedGraphId('feature:service:api', WS)).toBe(true);
        expect(isRepoScopedGraphId('microservice:workspace', WS)).toBe(false);
        expect(isRepoScopedGraphId('map:workspace', WS)).toBe(false);
        expect(isRepoScopedGraphId('feature:workspace', WS)).toBe(false);
        expect(isRepoScopedGraphId('health:report', WS)).toBe(false);
    });
});

describe('#821 — mergeGraphsForView ownership contract', () => {
    it('per-repo FRESH copy replaces the workspace STALE copy for repo-scoped ids (the #821 repro)', () => {
        const gid = 'file:api-service/src/services/auth.service.js';
        const staleWorkspace = graph([{ id: 'n1', label: 'loginUser', diff: 'unchanged' }]);
        const freshPerRepo = graph([{ id: 'n1', label: 'loginUser', diff: 'modified' }]);

        const merged = mergeGraphsForView(
            { [gid]: staleWorkspace },
            [{ [gid]: freshPerRepo }],
            { workspaceRoot: WS },
        );

        expect((merged[gid].nodes as any[])[0].diff).toBe('modified');
    });

    it('workspace copy wins for workspace-scoped ids when non-empty (first-wins preserved)', () => {
        const gid = 'microservice:workspace';
        const workspaceCopy = graph([{ id: 'ws', label: 'workspace-l1' }]);
        const perRepoCopy = graph([{ id: 'pr', label: 'per-repo-l1' }]);

        const merged = mergeGraphsForView(
            { [gid]: workspaceCopy },
            [{ [gid]: perRepoCopy }],
            { workspaceRoot: WS },
        );

        expect((merged[gid].nodes as any[])[0].label).toBe('workspace-l1');
    });

    it('empty-shell workspace copy is filled by per-repo content (UX-56 preserved)', () => {
        const gid = 'domain:workspace';
        const emptyShell = graph([]);
        const populated = graph([{ id: 'd1', label: 'Authenticate users' }]);

        const merged = mergeGraphsForView(
            { [gid]: emptyShell },
            [{ [gid]: populated }],
            { workspaceRoot: WS },
        );

        expect((merged[gid].nodes as any[]).length).toBe(1);
    });

    it('skipKeys are never merged from per-repo stores (UX-53d feature:workspace fold preserved)', () => {
        const gid = 'feature:workspace';
        const perRepoCopy = graph([{ id: 'f1' }]);

        const merged = mergeGraphsForView(
            {},
            [{ [gid]: perRepoCopy }],
            { workspaceRoot: WS, skipKeys: new Set([gid]) },
        );

        expect(merged[gid]).toBeUndefined();
    });

    // #838 (2026-06-11) — the live walkthrough repro: after ONE rebuildFile,
    // the per-repo store holds a `microservice:workspace` graph built from
    // its workspace-polluted snapshot (132 services + infra). The UX-56
    // empty-slot fill let it masquerade as the workspace L1, permanently
    // replacing the aggregator's bucketed skeletal view. Same class as the
    // #819 map:workspace bug. Contract: `microservice:workspace` NEVER
    // fills from per-repo maps — the aggregator owns it; the requestRoute
    // fallback (buildMicroserviceGraphCached) serves the skeletal copy.
    it('#838 — microservice:workspace is never filled from per-repo maps when missing', () => {
        const gid = 'microservice:workspace';
        const polluted = graph([{ id: 'pr1' }, { id: 'pr2' }]);
        const merged = mergeGraphsForView(
            {},
            [{ [gid]: polluted }],
            { workspaceRoot: WS },
        );
        expect(merged[gid]).toBeUndefined();
    });

    it('#838 — microservice:workspace empty-shell workspace copy is NOT filled either', () => {
        const gid = 'microservice:workspace';
        const merged = mergeGraphsForView(
            { [gid]: graph([]) },
            [{ [gid]: graph([{ id: 'pr1' }]) }],
            { workspaceRoot: WS },
        );
        expect((merged[gid].nodes as any[]).length).toBe(0);
    });

    it('repo-scoped keys from DIFFERENT repos coexist (collision-free by path prefix)', () => {
        const a = 'file:api-service/src/a.js';
        const b = 'file:payments-service/src/b.ts';
        const merged = mergeGraphsForView(
            {},
            [
                { [a]: graph([{ id: 'a1' }]) },
                { [b]: graph([{ id: 'b1' }]) },
            ],
            { workspaceRoot: WS },
        );
        expect(merged[a]).toBeDefined();
        expect(merged[b]).toBeDefined();
    });

    it('per-repo copy fills repo-scoped ids missing from the workspace store', () => {
        const gid = 'flow:payments-service/src/app.ts:start';
        const merged = mergeGraphsForView(
            {},
            [{ [gid]: graph([{ id: 'x' }]) }],
            { workspaceRoot: WS },
        );
        expect(merged[gid]).toBeDefined();
    });

    it('later per-repo map wins over earlier for the same repo-scoped key (latest store iterated last)', () => {
        const gid = 'file:api-service/src/a.js';
        const merged = mergeGraphsForView(
            {},
            [
                { [gid]: graph([{ id: 'old', diff: 'unchanged' }]) },
                { [gid]: graph([{ id: 'new', diff: 'modified' }]) },
            ],
            { workspaceRoot: WS },
        );
        expect((merged[gid].nodes as any[])[0].id).toBe('new');
    });
});
