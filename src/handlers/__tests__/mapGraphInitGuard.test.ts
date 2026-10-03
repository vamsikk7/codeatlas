/**
 * mapGraphInitGuard.test.ts — #842 (2026-06-11)
 *
 * Live walkthrough repro (build 120): requesting `#/map` while
 * initialize() was mid-flight rebuilt the Knowledge Map from a
 * half-populated in-memory snapshot — 1 of 6 clusters rendered, and the
 * partial graph was persisted over the complete one. The guard serves
 * the cached copy during the init window (or an UNPERSISTED partial,
 * stamped `meta.partialInit`, when nothing is cached).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('vscode', () => ({
    window: {
        showWarningMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
    },
    workspace: {
        getConfiguration: () => ({ get: () => undefined }),
        workspaceFolders: [{ uri: { fsPath: '/test/workspace' } }],
    },
    commands: { executeCommand: vi.fn() },
    env: { machineId: 't', sessionId: 't', appName: 'Code', uriScheme: 'vscode' },
    version: '1.0.0',
}));

import { makeHarness } from './handlerHarness';
import { buildMapGraphCached } from '../navigationHandlers';

function cachedMap(nodes: number) {
    return {
        graphId: 'map:workspace', type: 'map',
        nodes: Array.from({ length: nodes }, (_, i) => ({ id: `m${i}`, label: `n${i}`, meta: { layer: 'api' } })),
        edges: [], anchors: {}, meta: {},
    };
}

describe('buildMapGraphCached init-window guard (#842)', () => {
    beforeEach(() => vi.clearAllMocks());

    it('serves the cached map (no rebuild, no persist) while init is in flight', () => {
        const h = makeHarness();
        (h.ctx as any).syncOrchestrator = { initInFlight: true };
        const cached = cachedMap(35);
        h.state.working.graphs['map:workspace'] = cached;
        const updates: string[] = [];
        const origUpdate = (h.ctx.snapshotStore as any).updateWorkingGraph;
        (h.ctx.snapshotStore as any).updateWorkingGraph = (id: string, g: any) => { updates.push(id); return origUpdate(id, g); };

        const out = buildMapGraphCached(h.ctx);

        expect(out).toBe(cached);
        expect(updates).not.toContain('map:workspace');
    });

    it('builds an UNPERSISTED partial map stamped meta.partialInit when nothing is cached mid-init', () => {
        const h = makeHarness();
        (h.ctx as any).syncOrchestrator = { initInFlight: true };
        delete h.state.working.graphs['map:workspace'];
        const updates: string[] = [];
        const origUpdate = (h.ctx.snapshotStore as any).updateWorkingGraph;
        (h.ctx.snapshotStore as any).updateWorkingGraph = (id: string, g: any) => { updates.push(id); return origUpdate(id, g); };

        const out = buildMapGraphCached(h.ctx);

        expect(out.meta?.partialInit).toBe(true);
        expect(updates).not.toContain('map:workspace');
    });

    it('rebuilds fresh and persists once init has settled (existing behavior preserved)', () => {
        const h = makeHarness();
        (h.ctx as any).syncOrchestrator = { initInFlight: false };
        h.state.working.graphs['map:workspace'] = cachedMap(35);
        const updates: string[] = [];
        const origUpdate = (h.ctx.snapshotStore as any).updateWorkingGraph;
        (h.ctx.snapshotStore as any).updateWorkingGraph = (id: string, g: any) => { updates.push(id); return origUpdate(id, g); };

        const out = buildMapGraphCached(h.ctx);

        expect(out.meta?.partialInit).toBeUndefined();
        expect(updates).toContain('map:workspace');
    });
});
