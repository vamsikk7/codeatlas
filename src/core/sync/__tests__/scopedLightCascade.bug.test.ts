/**
 * Issue #365 (Round-4 perf) — `SyncOrchestrator.applyDiffCascadeToLiveGraphs`
 * is the "light" cascade that runs after a NON-structural file edit. On polar
 * (3588 sequence graphs) it pegged CPU ~60s because Step 1 re-annotated EVERY
 * sequence graph and the Map/Domain graphs were fully recomposed on every
 * cascade, ignoring the caller-supplied `affectedFiles`.
 *
 * These regression tests assert the SCOPED behaviour:
 *  (a) a single-file edit only refreshes the `sequence:` graphs that REFERENCE
 *      that file (not all of them), and
 *  (b) when no cluster/service diff flips, the Map + Domain graphs are NOT
 *      recomposed (`buildMapGraph` / `detectDomains` never called), while
 *  (c) the FULL path (`affectedFiles === undefined`) still refreshes every
 *      sequence AND rebuilds Map + Domain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spy on the composition-only Map/Domain builders + the Louvain re-cluster so
// we can assert they are skipped on a scoped, no-structural-change cascade.
// They are named imports in syncOrchestrator, so wrap the real modules.
const mapSpy = vi.fn();
const domainDetectSpy = vi.fn();

vi.mock('../../graph/mapGraphBuilder', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../graph/mapGraphBuilder')>();
    return {
        ...actual,
        buildMapGraph: (...args: Parameters<typeof actual.buildMapGraph>) => {
            mapSpy(...args);
            return actual.buildMapGraph(...args);
        },
    };
});

vi.mock('../../analysis/domainAnalyzer', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../analysis/domainAnalyzer')>();
    return {
        ...actual,
        detectDomains: (...args: Parameters<typeof actual.detectDomains>) => {
            domainDetectSpy(...args);
            return actual.detectDomains(...args);
        },
    };
});

import { SnapshotStore } from '../../storage/snapshotStore';
import { SyncOrchestrator } from '../syncOrchestrator';
import { CommentStore } from '../../storage/commentStore';
import type { DiagramGraph } from '../../graph/graphTypes';

function seq(file: string, handler: string): DiagramGraph {
    const partId = `p:${file}`;
    return {
        graphId: `sequence:${file}:${handler}`,
        type: 'sequence',
        nodes: [
            { id: 'client', type: 'participant', label: 'API Client', subtitle: '«actor»', diff: 'unchanged' },
            { id: partId, type: 'participant', label: handler, anchor: { filePath: file, symbol: handler }, diff: 'unchanged' },
        ],
        edges: [
            { id: 'e1', source: 'client', target: partId, edgeType: 'message', label: `${handler}()`, diff: 'unchanged' } as any,
        ],
        anchors: {},
        meta: { filePath: file },
    };
}

function flow(file: string, handler: string, modified: boolean): DiagramGraph {
    return {
        graphId: `flow:${file}:${handler}`,
        type: 'flow',
        nodes: [
            { id: 'n1', type: 'statement', label: 'body', diff: modified ? 'modified' : 'unchanged' },
        ],
        edges: [],
        anchors: {},
        meta: { filePath: file },
    };
}

function fileGraph(file: string): DiagramGraph {
    return {
        graphId: `file:${file}`,
        type: 'file',
        nodes: [{ id: 'f', type: 'file', label: file, diff: 'unchanged' }],
        edges: [],
        anchors: {},
        meta: { filePath: file },
    };
}

const FILES = ['svc/a.py', 'svc/b.py', 'svc/c.py'];

function makeOrch() {
    const store = new SnapshotStore('/tmp/scoped-cascade-ws', { inMemoryOnly: true });
    const orch = new SyncOrchestrator('/tmp/scoped-cascade-ws', store, new CommentStore([]));
    orch.setLogger(() => { /* silence */ });

    // Seed working graphs: one sequence + flow + file per file. Only a.py's
    // flow is modified — the annotation upgrade has real work to do, but the
    // ID-scoping is what we assert on. No clusters → Step 2 rebuilds nothing.
    for (const f of FILES) {
        const handler = 'handler_' + f.replace(/[^a-z]/gi, '');
        store.updateWorkingGraph(`sequence:${f}:${handler}`, seq(f, handler));
        store.updateWorkingGraph(`flow:${f}:${handler}`, flow(f, handler, f === 'svc/a.py'));
        store.updateWorkingGraph(`file:${f}`, fileGraph(f));
    }
    return { store, orch };
}

describe('applyDiffCascadeToLiveGraphs — scoped light cascade (#365)', () => {
    beforeEach(() => { mapSpy.mockClear(); domainDetectSpy.mockClear(); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('(a) scopes Step 1 to sequences that reference the affected file only', () => {
        const { store, orch } = makeOrch();
        const refreshed = orch.applyDiffCascadeToLiveGraphs(new Set(['svc/a.py']));

        const seqIds = refreshed.filter(id => id.startsWith('sequence:'));
        expect(seqIds).toEqual(['sequence:svc/a.py:handler_svcapy']);
        // The b.py / c.py sequences must NOT have been refreshed.
        expect(refreshed.some(id => id.startsWith('sequence:svc/b.py'))).toBe(false);
        expect(refreshed.some(id => id.startsWith('sequence:svc/c.py'))).toBe(false);

        // Correctness: the scoping still produced accurate annotations — a.py's
        // participant is upgraded to 'modified' (its entry-handler flow graph is
        // modified), while the untouched b.py sequence stays 'unchanged'.
        const g = store.getWorking().graphs['sequence:svc/a.py:handler_svcapy'];
        const aPart = g.nodes.find(n => n.type === 'participant' && n.label !== 'API Client');
        expect(aPart?.diff).toBe('modified');
        const gb = store.getWorking().graphs['sequence:svc/b.py:handler_svcbpy'];
        const bPart = gb.nodes.find(n => n.type === 'participant' && n.label !== 'API Client');
        expect(bPart?.diff).toBe('unchanged');
    });

    it('(b) skips Map + Domain recompose when no cluster/service diff flips', () => {
        const { orch } = makeOrch();
        orch.applyDiffCascadeToLiveGraphs(new Set(['svc/a.py']));

        // No clusters were seeded → Step 3 flips nothing → Map/Domain skipped.
        expect(mapSpy).not.toHaveBeenCalled();
        expect(domainDetectSpy).not.toHaveBeenCalled();
    });

    it('(c) the FULL path (no affectedFiles) refreshes all sequences and rebuilds Map + Domain', () => {
        const { orch } = makeOrch();
        const refreshed = orch.applyDiffCascadeToLiveGraphs(undefined);

        const seqIds = refreshed.filter(id => id.startsWith('sequence:')).sort();
        expect(seqIds).toHaveLength(FILES.length);
        for (const f of FILES) {
            expect(seqIds.some(id => id.startsWith(`sequence:${f}:`))).toBe(true);
        }
        // Full path always recomposes the composition graphs.
        expect(mapSpy).toHaveBeenCalledTimes(1);
        expect(domainDetectSpy).toHaveBeenCalledTimes(1);
    });
});
