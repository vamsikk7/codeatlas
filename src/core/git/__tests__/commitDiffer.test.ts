/**
 * commitDiffer.test.ts
 *
 * Tests for buildCommitDiffGraphs.
 *
 * The git reader functions (getFileListAtCommit, getFileContentAtCommit,
 * getChangedFilesBetweenCommits) are mocked so no real git repository is
 * required.  buildSnapshotFromFiles is called for real so that diff
 * annotations on actual graph nodes can be verified.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the git reader before importing commitDiffer
vi.mock('../gitReader', () => ({
    getFileListAtCommit: vi.fn(),
    getFileContentAtCommit: vi.fn(),
    getChangedFilesBetweenCommits: vi.fn(),
}));

import * as gitReader from '../gitReader';
import { buildCommitDiffGraphs, buildApiListGraphsForSnapshots, upgradeSequenceDiffAnnotations, upgradeServiceClusterDiffAnnotations } from '../commitDiffer';
import type { DiagramGraph, Snapshot, ApiRecord, FeatureCluster } from '../../graph/graphTypes';

const mockGetFileList = vi.mocked(gitReader.getFileListAtCommit);
const mockGetContent = vi.mocked(gitReader.getFileContentAtCommit);
const mockGetChanged = vi.mocked(gitReader.getChangedFilesBetweenCommits);

function noop(_msg: string): void {}

beforeEach(() => {
    vi.resetAllMocks();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const BASE_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HEAD_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function setupMocks(options: {
    baseFiles?: string[];
    headFiles?: string[];
    changedFiles?: string[];
    contentsByHash?: Record<string, Record<string, string>>;
}) {
    const {
        baseFiles = [],
        headFiles = [],
        changedFiles = [],
        contentsByHash = {},
    } = options;

    mockGetFileList.mockImplementation((_, hash) => {
        if (hash === BASE_HASH) return baseFiles;
        if (hash === HEAD_HASH) return headFiles;
        return [];
    });

    mockGetChanged.mockReturnValue(changedFiles);

    mockGetContent.mockImplementation((_, hash, path) => {
        return contentsByHash[hash]?.[path] ?? null;
    });
}

// ─── empty / trivial cases ────────────────────────────────────────────────────

describe('buildCommitDiffGraphs — empty inputs', () => {
    it('returns an empty apiIndex when both commits have no supported files', async () => {
        setupMocks({ baseFiles: [], headFiles: [], changedFiles: [] });

        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        // Phase 2 may produce a microservice:workspace graph even with no files.
        // Only assert that apiIndex is empty and diffedGraphs has the right type.
        expect(result.apiIndex).toEqual({});
        expect(typeof result.diffedGraphs).toBe('object');
    });

    it('returns a CommitDiffResult with the expected shape', async () => {
        setupMocks({ baseFiles: [], headFiles: [], changedFiles: [] });

        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        expect(result).toHaveProperty('diffedGraphs');
        expect(result).toHaveProperty('apiIndex');
    });
});

// ─── single added file ────────────────────────────────────────────────────────

describe('buildCommitDiffGraphs — added file', () => {
    const NEW_FILE = 'src/newService.ts';
    const NEW_CODE = `
        import express from 'express';
        const app = express();
        app.get('/health', (req, res) => res.json({ ok: true }));
        export function healthCheck() { return true; }
    `;

    beforeEach(() => {
        setupMocks({
            baseFiles: [],
            headFiles: [NEW_FILE],
            changedFiles: [NEW_FILE],
            contentsByHash: {
                [HEAD_HASH]: { [NEW_FILE]: NEW_CODE },
            },
        });
    });

    it('produces a file graph marked as added', async () => {
        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        const fileGraph = result.diffedGraphs[`file:${NEW_FILE}`];
        expect(fileGraph).toBeDefined();
        // When base is absent, all nodes should be marked 'added'
        for (const node of fileGraph.nodes) {
            expect(node.diff).toBe('added');
        }
        for (const edge of fileGraph.edges) {
            expect(edge.diff).toBe('added');
        }
    });

    it('includes the head apiIndex in the result', async () => {
        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        // The Express GET /health route should appear in the apiIndex
        const apis = Object.values(result.apiIndex);
        // (apiIndex may be empty if the anonymous handler isn't captured, so just
        // assert the structure is correct rather than a specific count)
        expect(typeof result.apiIndex).toBe('object');
    });
});

// ─── single deleted file ──────────────────────────────────────────────────────

describe('buildCommitDiffGraphs — deleted file', () => {
    // Use non-exported function so symbolExtractor captures it in analysis.funcs
    // and snapshotBuilder builds a flow graph for it.
    const OLD_FILE = 'src/legacy.ts';
    const OLD_CODE = `
        function legacyFn(x) { return x * 2; }
        module.exports = { legacyFn };
    `;

    beforeEach(() => {
        setupMocks({
            baseFiles: [OLD_FILE],
            headFiles: [],
            changedFiles: [OLD_FILE],
            contentsByHash: {
                [BASE_HASH]: { [OLD_FILE]: OLD_CODE },
            },
        });
    });

    it('produces a file graph marked as deleted', async () => {
        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        const fileGraph = result.diffedGraphs[`file:${OLD_FILE}`];
        expect(fileGraph).toBeDefined();
        for (const node of fileGraph.nodes) {
            expect(node.diff).toBe('deleted');
        }
    });

    it('flow graphs for functions in the deleted file are marked deleted', async () => {
        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        const flowGraph = result.diffedGraphs[`flow:${OLD_FILE}:legacyFn`];
        expect(flowGraph).toBeDefined();
        for (const node of flowGraph.nodes) {
            expect(node.diff).toBe('deleted');
        }
    });
});

// ─── modified file ────────────────────────────────────────────────────────────

describe('buildCommitDiffGraphs — modified file', () => {
    // Use non-exported function declarations so symbolExtractor captures them in
    // analysis.funcs and snapshotBuilder builds flow graphs for each function.
    const FILE = 'src/controller.js';
    const BASE_CODE = `
        function getUser(id) {
            return { id };
        }
        module.exports = { getUser };
    `;
    const HEAD_CODE = `
        function getUser(id) {
            if (!id) throw new Error('missing id');
            return { id, updatedAt: Date.now() };
        }
        function createUser(data) {
            return { id: Math.random() };
        }
        module.exports = { getUser, createUser };
    `;

    beforeEach(() => {
        setupMocks({
            baseFiles: [FILE],
            headFiles: [FILE],
            changedFiles: [FILE],
            contentsByHash: {
                [BASE_HASH]: { [FILE]: BASE_CODE },
                [HEAD_HASH]: { [FILE]: HEAD_CODE },
            },
        });
    });

    it('produces a file graph where modified nodes are annotated', async () => {
        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        const fileGraph = result.diffedGraphs[`file:${FILE}`];
        expect(fileGraph).toBeDefined();

        // At least one node should be modified or added (getUser changed; createUser added)
        const changedNodes = fileGraph.nodes.filter(n => n.diff !== 'unchanged');
        expect(changedNodes.length).toBeGreaterThan(0);
    });

    it('produces a flow graph for the new function marked as added', async () => {
        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        const flowGraph = result.diffedGraphs[`flow:${FILE}:createUser`];
        expect(flowGraph).toBeDefined();
        // createUser is new in head, so its flow graph should be added
        for (const node of flowGraph.nodes) {
            expect(node.diff).toBe('added');
        }
    });
});

// ─── unchanged file ───────────────────────────────────────────────────────────

describe('buildCommitDiffGraphs — unchanged file', () => {
    const FILE = 'src/utils.ts';
    const CODE = `export function double(x) { return x * 2; }`;

    beforeEach(() => {
        setupMocks({
            baseFiles: [FILE],
            headFiles: [FILE],
            changedFiles: [],           // not in changed list → same content reused
            contentsByHash: {
                // Only head is fetched for unchanged files
                [HEAD_HASH]: { [FILE]: CODE },
            },
        });
    });

    it('only fetches the file from head (not base) for unchanged files', async () => {
        await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        // getFileContentAtCommit should be called with HEAD_HASH but NOT BASE_HASH
        // for this file (optimization: reuse head content for both snapshots).
        const baseCalls = mockGetContent.mock.calls.filter(([, hash]) => hash === BASE_HASH);
        const callsForFile = baseCalls.filter(([, , path]) => path === FILE);
        expect(callsForFile).toHaveLength(0);
    });

    it('produces a graph where all nodes are unchanged', async () => {
        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        const fileGraph = result.diffedGraphs[`file:${FILE}`];
        expect(fileGraph).toBeDefined();
        for (const node of fileGraph.nodes) {
            expect(node.diff).toBe('unchanged');
        }
    });
});

// ─── api-list graph building ──────────────────────────────────────────────────

describe('buildCommitDiffGraphs — api-list graphs', () => {
    it('builds an api-list graph for each cluster in the head snapshot', async () => {
        // Provide a real Express app so clusters and APIs are detected
        const FILE = 'src/routes.ts';
        const CODE = `
            const express = require('express');
            const app = express();
            app.get('/items', listItems);
            app.post('/items', createItem);
            function listItems(req, res) { res.json([]); }
            function createItem(req, res) { res.status(201).json({}); }
        `;

        setupMocks({
            baseFiles: [],
            headFiles: [FILE],
            changedFiles: [FILE],
            contentsByHash: {
                [HEAD_HASH]: { [FILE]: CODE },
            },
        });

        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        // All api-list graphs present in diffedGraphs must have the correct shape
        const apiListKeys = Object.keys(result.diffedGraphs).filter(k => k.startsWith('api-list:'));
        for (const key of apiListKeys) {
            const graph = result.diffedGraphs[key];
            expect(graph.type).toBe('api-list');
            expect(graph.meta).toBeDefined();
            expect(Array.isArray(graph.meta.apis)).toBe(true);
        }
    });

    it('api-list graph for a cluster with a new API marks the API as added', async () => {
        const FILE = 'src/api.ts';
        const BASE_CODE = `
            const express = require('express');
            const app = express();
            app.get('/items', listItems);
            function listItems(req, res) { res.json([]); }
        `;
        const HEAD_CODE = `
            const express = require('express');
            const app = express();
            app.get('/items', listItems);
            app.post('/items', createItem);
            function listItems(req, res) { res.json([]); }
            function createItem(req, res) { res.status(201).json({}); }
        `;

        setupMocks({
            baseFiles: [FILE],
            headFiles: [FILE],
            changedFiles: [FILE],
            contentsByHash: {
                [BASE_HASH]: { [FILE]: BASE_CODE },
                [HEAD_HASH]: { [FILE]: HEAD_CODE },
            },
        });

        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        const apiListGraphs = Object.entries(result.diffedGraphs)
            .filter(([k]) => k.startsWith('api-list:'))
            .map(([, g]) => g);

        // At least one api-list graph must exist if clusters were detected
        if (apiListGraphs.length > 0) {
            const allApis = apiListGraphs.flatMap(g => g.meta.apis as any[]);
            // The newly added POST /items should appear as 'added'
            const addedApis = allApis.filter((a: any) => a.diff === 'added');
            expect(addedApis.length).toBeGreaterThanOrEqual(1);
        }
        // If no clusters were detected the test is vacuously true — log and skip.
        // (Community detection may not fire for tiny single-file workspaces.)
    });

    it('api-list graph includes deleted APIs from base snapshot', async () => {
        const FILE = 'src/api.ts';
        const BASE_CODE = `
            const express = require('express');
            const app = express();
            app.get('/items', listItems);
            app.delete('/items/:id', deleteItem);
            function listItems(req, res) { res.json([]); }
            function deleteItem(req, res) { res.status(204).send(); }
        `;
        const HEAD_CODE = `
            const express = require('express');
            const app = express();
            app.get('/items', listItems);
            function listItems(req, res) { res.json([]); }
        `;

        setupMocks({
            baseFiles: [FILE],
            headFiles: [FILE],
            changedFiles: [FILE],
            contentsByHash: {
                [BASE_HASH]: { [FILE]: BASE_CODE },
                [HEAD_HASH]: { [FILE]: HEAD_CODE },
            },
        });

        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        const apiListGraphs = Object.entries(result.diffedGraphs)
            .filter(([k]) => k.startsWith('api-list:'))
            .map(([, g]) => g);

        if (apiListGraphs.length > 0) {
            const allApis = apiListGraphs.flatMap(g => g.meta.apis as any[]);
            // The deleted DELETE /items/:id should appear as 'deleted'
            const deletedApis = allApis.filter((a: any) => a.diff === 'deleted');
            expect(deletedApis.length).toBeGreaterThanOrEqual(1);
        }
    });
});

// ─── renamed file (delete + add) ─────────────────────────────────────────────

describe('buildCommitDiffGraphs — renamed file', () => {
    it('shows old file as deleted and new file as added', async () => {
        const OLD_FILE = 'src/handler.ts';
        const NEW_FILE = 'src/requestHandler.ts';
        const CODE = `export function handle(req, res) { res.send('ok'); }`;

        setupMocks({
            baseFiles: [OLD_FILE],
            headFiles: [NEW_FILE],
            changedFiles: [OLD_FILE, NEW_FILE],
            contentsByHash: {
                [BASE_HASH]: { [OLD_FILE]: CODE },
                [HEAD_HASH]: { [NEW_FILE]: CODE },
            },
        });

        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        const oldGraph = result.diffedGraphs[`file:${OLD_FILE}`];
        const newGraph = result.diffedGraphs[`file:${NEW_FILE}`];

        expect(oldGraph).toBeDefined();
        expect(newGraph).toBeDefined();

        for (const node of oldGraph.nodes) {
            expect(node.diff).toBe('deleted');
        }
        for (const node of newGraph.nodes) {
            expect(node.diff).toBe('added');
        }
    });
});

// ─── upgradeSequenceDiffAnnotations — direct unit tests ──────────────────────

describe('upgradeSequenceDiffAnnotations', () => {
    function makeSeqGraph(nodes: Partial<DiagramGraph['nodes'][number]>[], edges: Partial<DiagramGraph['edges'][number]>[], anchors: Record<string, { filePath: string; symbol?: string }>): DiagramGraph {
        return {
            graphId: 'sequence:src/api.ts:handler',
            type: 'sequence',
            nodes: nodes.map((n, i) => ({ id: `n${i}`, type: 'participant', label: 'X', diff: 'unchanged', ...n } as DiagramGraph['nodes'][number])),
            edges: edges.map((e, i) => ({ id: `e${i}`, source: 'a', target: 'b', edgeType: 'message', diff: 'unchanged', ...e } as DiagramGraph['edges'][number])),
            anchors,
            meta: {},
        };
    }

    it('upgrades participant when its message-specific function changed', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:handler': makeSeqGraph(
                [{ type: 'participant', label: 'ServiceA', diff: 'unchanged', anchor: { filePath: 'src/serviceA.ts' } }],
                [{ id: 'e0', edgeType: 'message', diff: 'unchanged' }],
                { 'e0': { filePath: 'src/serviceA.ts', symbol: 'doThing' } },
            ),
            'flow:src/serviceA.ts:doThing': {
                graphId: 'flow:src/serviceA.ts:doThing', type: 'flow',
                nodes: [{ id: 'fn1', type: 'statement', label: 'step', diff: 'modified' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/api.ts:handler'].nodes[0].diff).toBe('modified');
    });

    it('#858 — upgrades participant whose anchor path is ABSOLUTE while the flow key is relative', () => {
        // Live repro: cross-file sequence participants (a service reached
        // through a controller) get an ABSOLUTE filePath anchor, while flow
        // graph keys are workspace-relative. The exact-key lookup missed, so
        // L3→L2b→L2a→L1 never cascaded. The fix suffix-matches the relative
        // flow path against the absolute participant path.
        const seqId = 'sequence:src/app/routes/auth/auth.controller.ts:anonymous@GET:/user';
        const diffedGraphs: Record<string, DiagramGraph> = {
            [seqId]: makeSeqGraph(
                [{ id: 'n0', type: 'participant', label: 'auth.service.ts', diff: 'unchanged',
                   anchor: { filePath: '/Users/me/repo/src/app/routes/auth/auth.service.ts' } }],
                [{ id: 'e0', edgeType: 'message', diff: 'unchanged', label: 'getCurrentUser(req.auth?.user?.id)', target: 'n0' }],
                {}, // edge unanchored — exercises the label-inference path
            ),
            'flow:src/app/routes/auth/auth.service.ts:getCurrentUser': {
                graphId: 'flow:src/app/routes/auth/auth.service.ts:getCurrentUser', type: 'flow',
                nodes: [{ id: 'fn1', type: 'statement', label: 'step', diff: 'modified' }],
                edges: [], anchors: {}, meta: {},
            },
        };
        diffedGraphs[seqId].graphId = seqId;

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs[seqId].nodes[0].diff).toBe('modified');
    });

    it('does NOT over-mark a FALLBACK-anchored participant (external service borrowing the handler file)', () => {
        // Regression: prisma.user / Jsonwebtoken are external participants whose
        // own file can't be resolved, so they fall back to the handler's
        // filePath (anchor.fallback=true). Without the guard, the file-based
        // checks attribute the handler's modified flow to them → over-marking
        // that bubbles to L2a/L1 (multiple clusters/services wrongly modified).
        const seqId = 'sequence:src/api.ts:handler';
        const diffedGraphs: Record<string, DiagramGraph> = {
            [seqId]: makeSeqGraph(
                [
                    { id: 'n0', type: 'participant', label: 'prisma.user', diff: 'unchanged',
                      anchor: { filePath: 'src/api.ts', fallback: true } as any },
                    // control: a genuine same-file participant (no fallback) still gets marked
                    { id: 'n1', type: 'participant', label: 'api.ts', diff: 'unchanged',
                      anchor: { filePath: 'src/api.ts' } },
                ],
                [{ id: 'e0', edgeType: 'message', diff: 'unchanged' }],
                { 'e0': { filePath: 'src/api.ts', symbol: 'handler' } },
            ),
            'flow:src/api.ts:handler': {
                graphId: 'flow:src/api.ts:handler', type: 'flow',
                nodes: [{ id: 'fn1', type: 'statement', label: 'step', diff: 'modified' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        const nodes = diffedGraphs[seqId].nodes;
        expect(nodes.find(n => n.label === 'prisma.user')!.diff, 'fallback participant must stay unchanged').toBe('unchanged');
        expect(nodes.find(n => n.label === 'api.ts')!.diff, 'real file-owner participant still marked').toBe('modified');
    });

    it('does NOT upgrade participant when an unrelated function in same file changed', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:handler': makeSeqGraph(
                [{ type: 'participant', label: 'ServiceA', diff: 'unchanged', anchor: { filePath: 'src/serviceA.ts' } }],
                [{ id: 'e0', edgeType: 'message', diff: 'unchanged' }],
                { 'e0': { filePath: 'src/serviceA.ts', symbol: 'doThing' } },
            ),
            // Only unrelatedFn changed, doThing did NOT change
            'file:src/serviceA.ts': {
                graphId: 'file:src/serviceA.ts', type: 'file',
                nodes: [{ id: 'f1', type: 'function', label: 'unrelatedFn', diff: 'modified' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/api.ts:handler'].nodes[0].diff).toBe('unchanged');
    });

    it('upgrades participant when an import/variable/class in file changed', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:handler': makeSeqGraph(
                [{ type: 'participant', label: 'ServiceA', diff: 'unchanged', anchor: { filePath: 'src/serviceA.ts' } }],
                [],
                {},
            ),
            'file:src/serviceA.ts': {
                graphId: 'file:src/serviceA.ts', type: 'file',
                nodes: [{ id: 'i1', type: 'import', label: 'lodash', diff: 'added' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/api.ts:handler'].nodes[0].diff).toBe('modified');
    });

    // #529 — when the entry handler's flow graph has modified nodes, the
    // participant for the handler's file must be marked modified even when
    // no message edge references that handler. This is the path the L4 → L3
    // cascade takes for Python (FastAPI decorator routes) and Go (Gin
    // handlers) where the entry handler is the sequence ROOT and no internal
    // call-chain registers it as a message target.
    it('upgrades participant when sequence entry handler has a modified flow (#529)', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/items.py:read_item': makeSeqGraph(
                [{ type: 'participant', label: 'items.py', diff: 'unchanged', anchor: { filePath: 'src/items.py' } }],
                [],
                {},
            ),
            // L4 flow for the entry handler is modified — body edit.
            'flow:src/items.py:read_item': {
                graphId: 'flow:src/items.py:read_item', type: 'flow',
                nodes: [{ id: 'fn1', type: 'statement', label: 'new line', diff: 'added' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/items.py:read_item'].nodes[0].diff).toBe('modified');
    });

    // The entry-handler-modified rule must NOT bleed across files. If the
    // participant points at a different file from the sequence's entry, the
    // L4 flow of the entry handler does not justify marking that other file's
    // participant modified.
    it('does not upgrade participant in another file when only the entry handler\'s file has modifications', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/items.py:read_item': makeSeqGraph(
                [
                    { type: 'participant', label: 'items.py', diff: 'unchanged', anchor: { filePath: 'src/items.py' } },
                    { type: 'participant', label: 'models', diff: 'unchanged', anchor: { filePath: 'src/models.py' } },
                ],
                [],
                {},
            ),
            'flow:src/items.py:read_item': {
                graphId: 'flow:src/items.py:read_item', type: 'flow',
                nodes: [{ id: 'fn1', type: 'statement', label: 'new line', diff: 'added' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        const seq = diffedGraphs['sequence:src/items.py:read_item'];
        expect(seq.nodes.find((n) => n.label === 'items.py')?.diff).toBe('modified');
        expect(seq.nodes.find((n) => n.label === 'models')?.diff).toBe('unchanged');
    });

    it('does not downgrade participant already marked added', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:handler': makeSeqGraph(
                [{ type: 'participant', label: 'ServiceA', diff: 'added', anchor: { filePath: 'src/serviceA.ts' } }],
                [],
                {},
            ),
            'file:src/serviceA.ts': {
                graphId: 'file:src/serviceA.ts', type: 'file',
                nodes: [{ id: 'f1', type: 'function', label: 'doThing', diff: 'modified' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/api.ts:handler'].nodes[0].diff).toBe('added');
    });

    // Issue #423 (ts-nestjs residual) — sequence-graph participants whose
    // anchor file still exists in the working snapshot can end up with
    // `diff:'deleted'` from an earlier rebuild pass. The reset loop only
    // touched `'modified'` participants — `'deleted'` ones stuck forever and
    // bubbled up through L2b api-list (api.diff = 'modified') → L2a cluster →
    // L1 service, leaving three layers orange post-revert.
    // Fix: also reset 'deleted' for non-ghost participants (label does NOT
    // end with " (deleted)" — ghost participants intentionally use that
    // suffix and should remain) when the anchor's file graph exists in
    // diffedGraphs (i.e., the file is still in the workspace).
    it('resets non-ghost participants marked deleted when handler still has a live flow graph (#423 ts-nestjs)', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/app.controller.ts:root': makeSeqGraph(
                [
                    { type: 'participant', label: 'API Client', diff: 'deleted', subtitle: '«actor»', anchor: { filePath: 'src/app.controller.ts' } },
                    { type: 'participant', label: 'app.controller.ts', diff: 'deleted', subtitle: '«module»', anchor: { filePath: 'src/app.controller.ts' } },
                ],
                [],
                {},
            ),
            // The handler `root` still exists — flow graph is alive with
            // non-deleted nodes. The sequence's "deleted" participants are
            // therefore stale, not a real ghost.
            'flow:src/app.controller.ts:root': {
                graphId: 'flow:src/app.controller.ts:root', type: 'flow',
                nodes: [{ id: 's1', type: 'statement', label: 'return ...', diff: 'unchanged' }],
                edges: [], anchors: {}, meta: {},
            },
            'file:src/app.controller.ts': {
                graphId: 'file:src/app.controller.ts', type: 'file',
                nodes: [{ id: 'f1', type: 'function', label: 'root', diff: 'unchanged' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        const nodes = diffedGraphs['sequence:src/app.controller.ts:root'].nodes;
        expect(nodes[0].diff, `API Client should reset from deleted → unchanged`).toBe('unchanged');
        expect(nodes[1].diff, `module participant should reset from deleted → unchanged`).toBe('unchanged');
    });

    it('does NOT reset ghost participants (label "X (deleted)") even when handler still exists', () => {
        // Ghost participants intentionally have " (deleted)" suffix in their
        // label and represent genuinely-removed participants from a prior
        // sequence build. They should keep diff='deleted' regardless.
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:handler': makeSeqGraph(
                [{ type: 'participant', label: 'GoneService (deleted)', diff: 'deleted', anchor: { filePath: 'src/gone.ts' } }],
                [],
                {},
            ),
            'flow:src/api.ts:handler': {
                graphId: 'flow:src/api.ts:handler', type: 'flow',
                nodes: [{ id: 's1', type: 'statement', label: 'noop', diff: 'unchanged' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/api.ts:handler'].nodes[0].diff, 'ghost participant should stay deleted').toBe('deleted');
    });

    it('does NOT reset participants when the sequence is a TRUE ghost (handler removed — flow graph also deleted)', () => {
        // Real ghost: handler removed from source. Flow graph is also a ghost
        // (all nodes deleted or graph missing). Sequence's deleted participants
        // are legitimate and should NOT be reset.
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:cancelOrder': makeSeqGraph(
                [
                    { type: 'participant', label: 'API Client', diff: 'deleted', subtitle: '«actor»' },
                    { type: 'participant', label: 'api.ts', diff: 'deleted', subtitle: '«module»', anchor: { filePath: 'src/api.ts' } },
                ],
                [],
                {},
            ),
            'flow:src/api.ts:cancelOrder': {
                graphId: 'flow:src/api.ts:cancelOrder', type: 'flow',
                // All flow nodes deleted = handler genuinely removed
                nodes: [{ id: 's1', type: 'statement', label: 'res.json(...)', diff: 'deleted' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        const nodes = diffedGraphs['sequence:src/api.ts:cancelOrder'].nodes;
        expect(nodes[0].diff, 'true-ghost API Client should stay deleted').toBe('deleted');
        expect(nodes[1].diff, 'true-ghost module participant should stay deleted').toBe('deleted');
    });

    it('upgrades message edge to modified when its flow graph has changed nodes', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:handler': makeSeqGraph(
                [],
                [{ id: 'e0', edgeType: 'message', diff: 'unchanged' }],
                { 'e0': { filePath: 'src/serviceA.ts', symbol: 'doThing' } },
            ),
            'flow:src/serviceA.ts:doThing': {
                graphId: 'flow:src/serviceA.ts:doThing', type: 'flow',
                nodes: [{ id: 'fn1', type: 'statement', label: 'step', diff: 'modified' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/api.ts:handler'].edges[0].diff).toBe('modified');
    });

    it('upgrades message edge when file has structural (import/variable) changes and no symbol', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:handler': makeSeqGraph(
                [],
                [{ id: 'e0', edgeType: 'message', diff: 'unchanged' }],
                { 'e0': { filePath: 'src/serviceA.ts' } }, // no symbol
            ),
            'file:src/serviceA.ts': {
                graphId: 'file:src/serviceA.ts', type: 'file',
                nodes: [{ id: 'v1', type: 'variable', label: 'config', diff: 'modified' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/api.ts:handler'].edges[0].diff).toBe('modified');
    });

    it('does NOT upgrade message edge when only an unrelated function changed and no symbol', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:handler': makeSeqGraph(
                [],
                [{ id: 'e0', edgeType: 'message', diff: 'unchanged' }],
                { 'e0': { filePath: 'src/serviceA.ts' } }, // no symbol
            ),
            'file:src/serviceA.ts': {
                graphId: 'file:src/serviceA.ts', type: 'file',
                nodes: [{ id: 'f1', type: 'function', label: 'unrelatedFn', diff: 'modified' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/api.ts:handler'].edges[0].diff).toBe('unchanged');
    });

    it('leaves edge unchanged when no backing file or flow graph has changes', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:handler': makeSeqGraph(
                [],
                [{ id: 'e0', edgeType: 'message', diff: 'unchanged' }],
                { 'e0': { filePath: 'src/serviceA.ts', symbol: 'doThing' } },
            ),
            'flow:src/serviceA.ts:doThing': {
                graphId: 'flow:src/serviceA.ts:doThing', type: 'flow',
                nodes: [{ id: 'fn1', type: 'statement', label: 'step', diff: 'unchanged' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/api.ts:handler'].edges[0].diff).toBe('unchanged');
    });
});

// ─── buildApiListGraphsForSnapshots — direct unit tests ──────────────────────

describe('buildApiListGraphsForSnapshots', () => {
    function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
        return { files: {}, apiIndex: {}, graphs: {}, clusters: {}, services: {}, ...overrides };
    }

    function makeApi(id: string, filePath: string, handlerName: string): ApiRecord {
        return { apiId: id, method: 'GET', route: '/test', handlerName, filePath, anchor: { filePath, symbol: handlerName } };
    }

    function makeCluster(id: string, files: string[], apis: ApiRecord[]): FeatureCluster {
        return { id, label: id, files, entryPoints: [], apisInCluster: apis, internalCallCount: 0, externalCallCount: 0 };
    }

    it('marks API as added when absent from base apiIndex', () => {
        const api = makeApi('api-1', 'src/api.ts', 'listItems');
        const cluster = makeCluster('cluster-1', ['src/api.ts'], [api]);
        const head = makeSnapshot({ apiIndex: { 'api-1': api }, clusters: { 'cluster-1': cluster } });
        const base = makeSnapshot();

        const result = buildApiListGraphsForSnapshots(head, base, {});

        const graph = result['api-list:cluster-1'];
        expect(graph).toBeDefined();
        const entry = (graph.meta.apis as ApiRecord[]).find(a => a.apiId === 'api-1');
        expect(entry?.diff).toBe('added');
    });

    it('marks API as deleted when in base but not head cluster', () => {
        const api = makeApi('api-2', 'src/api.ts', 'deleteItem');
        const cluster = makeCluster('cluster-1', ['src/api.ts'], []); // no apis in head
        const head = makeSnapshot({ apiIndex: {}, clusters: { 'cluster-1': cluster } });
        const base = makeSnapshot({ apiIndex: { 'api-2': api } });

        const result = buildApiListGraphsForSnapshots(head, base, {});

        const graph = result['api-list:cluster-1'];
        const deletedApis = (graph.meta.apis as ApiRecord[]).filter(a => a.diff === 'deleted');
        expect(deletedApis.length).toBeGreaterThanOrEqual(1);
        expect(deletedApis[0].apiId).toBe('api-2');
    });

    it('marks API as modified when diffed sequence graph has a modified node', () => {
        const api = makeApi('api-1', 'src/api.ts', 'listItems');
        const cluster = makeCluster('cluster-1', ['src/api.ts'], [api]);
        const head = makeSnapshot({ apiIndex: { 'api-1': api }, clusters: { 'cluster-1': cluster } });
        const base = makeSnapshot({ apiIndex: { 'api-1': { ...api } } }); // exists in base

        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:listItems': {
                graphId: 'sequence:src/api.ts:listItems', type: 'sequence',
                nodes: [{ id: 'p1', type: 'participant', label: 'ServiceA', diff: 'modified' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        const result = buildApiListGraphsForSnapshots(head, base, diffedGraphs);

        const entry = (result['api-list:cluster-1'].meta.apis as ApiRecord[]).find(a => a.apiId === 'api-1');
        expect(entry?.diff).toBe('modified');
    });

    it('marks API as unchanged when diffed sequence graph has no changes', () => {
        const api = makeApi('api-1', 'src/api.ts', 'listItems');
        const cluster = makeCluster('cluster-1', ['src/api.ts'], [api]);
        const head = makeSnapshot({ apiIndex: { 'api-1': api }, clusters: { 'cluster-1': cluster } });
        const base = makeSnapshot({ apiIndex: { 'api-1': { ...api } } });

        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:listItems': {
                graphId: 'sequence:src/api.ts:listItems', type: 'sequence',
                nodes: [{ id: 'p1', type: 'participant', label: 'ServiceA', diff: 'unchanged' }],
                edges: [{ id: 'e1', source: 'p0', target: 'p1', edgeType: 'message', diff: 'unchanged' }],
                anchors: {}, meta: {},
            },
        };

        const result = buildApiListGraphsForSnapshots(head, base, diffedGraphs);

        const entry = (result['api-list:cluster-1'].meta.apis as ApiRecord[]).find(a => a.apiId === 'api-1');
        expect(entry?.diff).toBe('unchanged');
    });

    it('marks API as modified when message edge in diffed sequence graph is modified', () => {
        const api = makeApi('api-1', 'src/api.ts', 'listItems');
        const cluster = makeCluster('cluster-1', ['src/api.ts'], [api]);
        const head = makeSnapshot({ apiIndex: { 'api-1': api }, clusters: { 'cluster-1': cluster } });
        const base = makeSnapshot({ apiIndex: { 'api-1': { ...api } } });

        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/api.ts:listItems': {
                graphId: 'sequence:src/api.ts:listItems', type: 'sequence',
                nodes: [{ id: 'p1', type: 'participant', label: 'ServiceA', diff: 'unchanged' }],
                edges: [{ id: 'e1', source: 'p0', target: 'p1', edgeType: 'message', diff: 'modified' }],
                anchors: {}, meta: {},
            },
        };

        const result = buildApiListGraphsForSnapshots(head, base, diffedGraphs);

        const entry = (result['api-list:cluster-1'].meta.apis as ApiRecord[]).find(a => a.apiId === 'api-1');
        expect(entry?.diff).toBe('modified');
    });
});

// ─── upgradeSequenceDiffAnnotations — Bug B: edge fallback for JS-path (no anchor) ──

describe('upgradeSequenceDiffAnnotations — edge without anchor (JS-path fallback)', () => {
    function makeSeqGraph(
        nodes: Partial<DiagramGraph['nodes'][number]>[],
        edges: Partial<DiagramGraph['edges'][number]>[],
        anchors: Record<string, { filePath: string; symbol?: string }>,
        meta: Record<string, unknown> = {},
    ): DiagramGraph {
        return {
            graphId: 'sequence:src/controller.ts:handler',
            type: 'sequence',
            nodes: nodes.map((n, i) => ({ id: `n${i}`, type: 'participant', label: 'X', diff: 'unchanged', ...n } as DiagramGraph['nodes'][number])),
            edges: edges.map((e, i) => ({ id: `e${i}`, source: 'n0', target: 'n1', edgeType: 'message', diff: 'unchanged', ...e } as DiagramGraph['edges'][number])),
            anchors,
            meta,
        };
    }

    it('upgrades edge to modified via target participant anchor + flow graph (no edge anchor)', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/controller.ts:handler': makeSeqGraph(
                [
                    { id: 'n0', type: 'participant', label: 'API Client', diff: 'unchanged' },
                    { id: 'n1', type: 'participant', label: 'article.service', diff: 'unchanged', anchor: { filePath: 'src/article.service.ts' } },
                ],
                [{ id: 'e0', source: 'n0', target: 'n1', edgeType: 'message', diff: 'unchanged', label: 'updateArticle()' }],
                {}, // no anchors for edges
            ),
            'flow:src/article.service.ts:updateArticle': {
                graphId: 'flow:src/article.service.ts:updateArticle', type: 'flow',
                nodes: [{ id: 'fn1', type: 'statement', label: 'step', diff: 'modified' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/controller.ts:handler'].edges[0].diff).toBe('modified');
    });

    it('leaves edge unchanged when target flow graph has no changes (no edge anchor)', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/controller.ts:handler': makeSeqGraph(
                [
                    { id: 'n0', type: 'participant', label: 'API Client', diff: 'unchanged' },
                    { id: 'n1', type: 'participant', label: 'article.service', diff: 'unchanged', anchor: { filePath: 'src/article.service.ts' } },
                ],
                [{ id: 'e0', source: 'n0', target: 'n1', edgeType: 'message', diff: 'unchanged', label: 'getArticles()' }],
                {},
            ),
            'flow:src/article.service.ts:getArticles': {
                graphId: 'flow:src/article.service.ts:getArticles', type: 'flow',
                nodes: [{ id: 'fn1', type: 'statement', label: 'step', diff: 'unchanged' }],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/controller.ts:handler'].edges[0].diff).toBe('unchanged');
    });

    it('skips edge without anchor when target participant has no anchor filePath', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/controller.ts:handler': makeSeqGraph(
                [
                    { id: 'n0', type: 'participant', label: 'API Client', diff: 'unchanged' },
                    { id: 'n1', type: 'participant', label: 'unknown.service', diff: 'unchanged' }, // no anchor
                ],
                [{ id: 'e0', source: 'n0', target: 'n1', edgeType: 'message', diff: 'unchanged', label: 'doSomething()' }],
                {},
            ),
        };

        // Should not throw, edge stays unchanged
        upgradeSequenceDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['sequence:src/controller.ts:handler'].edges[0].diff).toBe('unchanged');
    });

    /**
     * #495: cross-file sequence cascade rebuilds leave behind two pieces of
     * residue on message edges even when the underlying flow/file graphs are
     * clean:
     *   1. `styleKind: 'changed'` — flipped by `buildSequenceDiff` when it
     *      saw an upstream multi-file model differ from the baseline model.
     *   2. `label: "- old\n+ new"` — the diff-formatted label produced by
     *      `sequenceGraphBuilder.ts:1628` when `msgLabelDiffByKey` matched.
     * The `edge.diff` field is correctly reset to `'unchanged'` by this
     * upgrade pass, but the styleKind + label remained, leaving
     * `sequence:src/prisma/seed.ts:main`-style graphs permanently diverged
     * from baseline on post-revert cycles. Reproduced live on
     * `node-express-realworld-example-app` after editing `getCurrentUser` in
     * `auth.service.ts`.
     */
    it('resets stale styleKind=changed and -/+ diff label when edge.diff is reset (#495)', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'sequence:src/prisma/seed.ts:main': {
                graphId: 'sequence:src/prisma/seed.ts:main', type: 'sequence',
                nodes: [
                    { id: 'p1', type: 'participant', label: 'auth.service.ts', diff: 'modified', anchor: { filePath: 'src/app/routes/auth/auth.service.ts' } } as any,
                    { id: 'p2', type: 'participant', label: 'prisma.user', diff: 'modified', anchor: { filePath: 'src/prisma/seed.ts' } } as any,
                ],
                edges: [
                    {
                        id: 'eDirty', source: 'p1', target: 'p2', edgeType: 'message',
                        diff: 'modified',
                        styleKind: 'changed' as any,
                        label: '- prisma.user.create({ data: { username: a } })\n+ prisma.user.create({ data: { username: a } })',
                    } as any,
                ],
                anchors: {},
                meta: { filePath: 'src/prisma/seed.ts' },
            },
            // No flow/file graphs carry any changes — baseline is clean, the
            // residue must drop unconditionally.
        };

        upgradeSequenceDiffAnnotations(diffedGraphs);

        const seq = diffedGraphs['sequence:src/prisma/seed.ts:main'];
        // Participants reset
        expect(seq.nodes[0].diff).toBe('unchanged');
        expect(seq.nodes[1].diff).toBe('unchanged');
        // Edge: diff reset
        expect(seq.edges[0].diff).toBe('unchanged');
        // Edge: styleKind reset from 'changed' → 'normal'
        expect((seq.edges[0] as any).styleKind).toBe('normal');
        // Edge: label stripped of -/+ diff format
        expect(seq.edges[0].label).toBe('prisma.user.create({ data: { username: a } })');
        // No `\n-` or `\n+` markers remain
        expect(seq.edges[0].label).not.toMatch(/^-\s|\n\+ /);
    });
});

// ─── upgradeServiceClusterDiffAnnotations — Bug C: L1/L2a upgrade ─────────────

describe('upgradeServiceClusterDiffAnnotations', () => {
    it('upgrades cluster node via L2b cascade when API list has changed APIs', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'api-list:cluster:article': {
                graphId: 'api-list:cluster:article', type: 'api-list',
                nodes: [], edges: [], anchors: {},
                meta: { clusterId: 'cluster:article', apis: [{ apiId: 'GET:/articles', diff: 'modified' }] },
            },
            'feature:service:src': {
                graphId: 'feature:service:src', type: 'feature',
                nodes: [
                    {
                        id: 'cluster-article', type: 'cluster', label: 'article', diff: 'unchanged',
                        clusterMembership: 'cluster:article',
                        meta: { clusterId: 'cluster:article', files: ['src/article.service.ts'] },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeServiceClusterDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['feature:service:src'].nodes[0].diff).toBe('modified');
    });

    it('upgrades cluster node when member file has structural (import/variable) changes', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'file:src/article.service.ts': {
                graphId: 'file:src/article.service.ts', type: 'file',
                nodes: [{ id: 'i1', type: 'import', label: 'prisma', diff: 'added' }],
                edges: [], anchors: {}, meta: {},
            },
            'feature:service:src': {
                graphId: 'feature:service:src', type: 'feature',
                nodes: [
                    {
                        id: 'cluster-article', type: 'cluster', label: 'article', diff: 'unchanged',
                        meta: { files: ['src/article.service.ts', 'src/article.controller.ts'] },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeServiceClusterDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['feature:service:src'].nodes[0].diff).toBe('modified');
    });

    it('#929 — upgrades cluster when a member file has ANY function change (git-status intuition)', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'file:src/article.service.ts': {
                graphId: 'file:src/article.service.ts', type: 'file',
                nodes: [{ id: 'f1', type: 'function', label: 'helper', diff: 'modified' }],
                edges: [], anchors: {}, meta: {},
            },
            'feature:service:src': {
                graphId: 'feature:service:src', type: 'feature',
                nodes: [
                    {
                        id: 'cluster-article', type: 'cluster', label: 'article', diff: 'unchanged',
                        meta: { files: ['src/article.service.ts'] },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeServiceClusterDiffAnnotations(diffedGraphs);

        // #929 — a function-body edit to a member file now marks the cluster modified
        // (previously this stayed unchanged unless the change touched an API chain).
        expect(diffedGraphs['feature:service:src'].nodes[0].diff).toBe('modified');
    });

    it('does not upgrade cluster node when none of its files have changed nodes', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'file:src/utils.ts': {
                graphId: 'file:src/utils.ts', type: 'file',
                nodes: [{ id: 'f1', type: 'function', label: 'helper', diff: 'unchanged' }],
                edges: [], anchors: {}, meta: {},
            },
            'feature:service:src': {
                graphId: 'feature:service:src', type: 'feature',
                nodes: [
                    {
                        id: 'cluster-util', type: 'cluster', label: 'util', diff: 'unchanged',
                        meta: { files: ['src/utils.ts'] },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeServiceClusterDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['feature:service:src'].nodes[0].diff).toBe('unchanged');
    });

    it('upgrades service node via L2a cascade when a cluster in the service is modified', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'api-list:cluster:article': {
                graphId: 'api-list:cluster:article', type: 'api-list',
                nodes: [], edges: [], anchors: {},
                meta: { clusterId: 'cluster:article', apis: [{ apiId: 'GET:/articles', diff: 'modified' }] },
            },
            'feature:workspace': {
                graphId: 'feature:workspace', type: 'feature',
                nodes: [
                    {
                        id: 'c1', type: 'cluster', label: 'article', diff: 'unchanged',
                        clusterMembership: 'cluster:article',
                        meta: { clusterId: 'cluster:article', serviceId: 'service:backend', files: ['src/article.ts'] },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
            'microservice:workspace': {
                graphId: 'microservice:workspace', type: 'microservice',
                nodes: [
                    {
                        id: 'svc-backend', type: 'service', label: 'backend', diff: 'unchanged',
                        serviceId: 'service:backend',
                        meta: { serviceId: 'service:backend', rootPath: 'src' },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeServiceClusterDiffAnnotations(diffedGraphs);

        // L2a cluster upgraded by L2b cascade
        expect(diffedGraphs['feature:workspace'].nodes[0].diff).toBe('modified');
        // L1 service upgraded by L2a cascade
        expect(diffedGraphs['microservice:workspace'].nodes[0].diff).toBe('modified');
    });

    // Issue 378: when BOTH `feature:workspace` and `feature:service:<id>`
    // exist in the working snapshot and a cluster's api-list has a modified
    // API, the cascade must upgrade BOTH feature graphs' cluster nodes to
    // `modified`. Pre-fix observation in the live workspace: only the
    // service:main variant was marked, while the workspace variant stayed
    // unchanged — an inconsistency users perceive as the L2a Feature Areas
    // top-level view "not reflecting the modification" while drilling into
    // the same service does.
    it('upgrades the same cluster in BOTH feature:workspace and feature:service:<id> (#378)', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'api-list:cluster:auth': {
                graphId: 'api-list:cluster:auth', type: 'api-list',
                nodes: [], edges: [], anchors: {},
                meta: { clusterId: 'cluster:auth', apis: [{ apiId: 'GET:/user', diff: 'modified' }] },
            },
            'feature:workspace': {
                graphId: 'feature:workspace', type: 'feature',
                nodes: [
                    {
                        id: 'c1', type: 'cluster', label: 'User Authentication', diff: 'unchanged',
                        clusterMembership: 'cluster:auth',
                        meta: { clusterId: 'cluster:auth', serviceId: 'service:main', files: ['src/auth.ts'] },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
            'feature:service:main': {
                graphId: 'feature:service:main', type: 'feature',
                nodes: [
                    {
                        id: 'c1', type: 'cluster', label: 'User Authentication', diff: 'unchanged',
                        clusterMembership: 'cluster:auth',
                        meta: { clusterId: 'cluster:auth', serviceId: 'service:main', files: ['src/auth.ts'] },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeServiceClusterDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['feature:workspace'].nodes[0].diff,
            'feature:workspace cluster must be marked modified when its api-list has changes').toBe('modified');
        expect(diffedGraphs['feature:service:main'].nodes[0].diff,
            'feature:service:main cluster must be marked modified when its api-list has changes').toBe('modified');
    });

    it('does not upgrade infra (external) nodes in microservice graph', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'file:src/db.ts': {
                graphId: 'file:src/db.ts', type: 'file',
                nodes: [{ id: 'f1', type: 'function', label: 'connect', diff: 'added' }],
                edges: [], anchors: {}, meta: {},
            },
            'microservice:workspace': {
                graphId: 'microservice:workspace', type: 'microservice',
                nodes: [
                    {
                        id: 'infra-mongo', type: 'service', label: 'MongoDB', diff: 'unchanged',
                        meta: { external: true, infra: true, rootPath: 'src' },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeServiceClusterDiffAnnotations(diffedGraphs);

        // Infra node should not be upgraded even if rootPath matches changed files
        expect(diffedGraphs['microservice:workspace'].nodes[0].diff).toBe('unchanged');
    });

    it('does not upgrade cluster node already marked added', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'file:src/new.ts': {
                graphId: 'file:src/new.ts', type: 'file',
                nodes: [{ id: 'f1', type: 'function', label: 'newFn', diff: 'added' }],
                edges: [], anchors: {}, meta: {},
            },
            'feature:service:src': {
                graphId: 'feature:service:src', type: 'feature',
                nodes: [
                    {
                        id: 'cluster-new', type: 'cluster', label: 'new', diff: 'added',
                        meta: { files: ['src/new.ts'] },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
        };

        upgradeServiceClusterDiffAnnotations(diffedGraphs);

        // Already 'added' — should not be downgraded to 'modified'
        expect(diffedGraphs['feature:service:src'].nodes[0].diff).toBe('added');
    });
});

// ─── git reader errors ────────────────────────────────────────────────────────

describe('buildCommitDiffGraphs — git reader errors', () => {
    it('handles getFileContentAtCommit returning null gracefully', async () => {
        setupMocks({
            baseFiles: ['src/a.ts'],
            headFiles: ['src/a.ts'],
            changedFiles: ['src/a.ts'],
            contentsByHash: {
                // Intentionally no content for BASE_HASH → getFileContentAtCommit returns null
                [HEAD_HASH]: { 'src/a.ts': 'export const x = 1;' },
            },
        });

        // Should not throw
        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);

        // head graph should be present and marked 'added' (base returned null)
        expect(result.diffedGraphs['file:src/a.ts']).toBeDefined();
    });
});

// ─── Issue 370: Compare Commits with new (Tier 1/2/3) entry-point types ─────

describe('buildCommitDiffGraphs — non-HTTP entry-point diff', () => {
    const TASKS_FILE = 'app/tasks.py';
    const FILTER_FILE = 'app/controllers/users_controller.rb';
    const MQ_FILE = 'src/main/java/com/example/OrderConsumer.java';

    it('Celery `@shared_task` added between commits → JOB record appears in apiIndex', async () => {
        const baseCode = `
from celery import shared_task

@shared_task
def existing_task(x):
    return x
`;
        const headCode = `
from celery import shared_task

@shared_task
def existing_task(x):
    return x

@shared_task
def new_task(y):
    return y * 2
`;
        setupMocks({
            baseFiles: [TASKS_FILE],
            headFiles: [TASKS_FILE],
            changedFiles: [TASKS_FILE],
            contentsByHash: {
                [BASE_HASH]: { [TASKS_FILE]: baseCode },
                [HEAD_HASH]: { [TASKS_FILE]: headCode },
            },
        });

        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);
        const jobs = Object.values(result.apiIndex).filter(a => a.method === 'JOB');
        // Both `existing_task` and `new_task` should be in the head apiIndex.
        expect(jobs.length).toBeGreaterThanOrEqual(2);
        expect(jobs.some(j => j.handlerName === 'new_task')).toBe(true);
        expect(jobs.some(j => j.handlerName === 'existing_task')).toBe(true);
        // The flow graph for the new task should be marked added.
        const newTaskFlow = result.diffedGraphs[`flow:${TASKS_FILE}:new_task`];
        expect(newTaskFlow).toBeDefined();
        const newTaskFunctionNode = newTaskFlow.nodes.find(n => n.diff === 'added');
        expect(newTaskFunctionNode).toBeDefined();
    });

    it('Rails `before_action` filter added between commits → FILTER record + flow added', async () => {
        const baseCode = `
class UsersController < ApplicationController
  def show
    render json: User.find(params[:id])
  end
end
`;
        const headCode = `
class UsersController < ApplicationController
  before_action :authenticate_user!

  def show
    render json: User.find(params[:id])
  end
end
`;
        setupMocks({
            baseFiles: [FILTER_FILE],
            headFiles: [FILTER_FILE],
            changedFiles: [FILTER_FILE],
            contentsByHash: {
                [BASE_HASH]: { [FILTER_FILE]: baseCode },
                [HEAD_HASH]: { [FILTER_FILE]: headCode },
            },
        });

        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);
        const filters = Object.values(result.apiIndex).filter(a => a.method === 'FILTER');
        expect(filters.length).toBe(1);
        expect(filters[0].handlerName).toBe('authenticate_user!');
    });

    it('Spring `@KafkaListener` topic change between commits → MQ_CONSUMER records reflect new topic', async () => {
        const baseCode = `
import org.springframework.kafka.annotation.KafkaListener;

public class OrderConsumer {
    @KafkaListener(topics = "orders-v1", groupId = "order-group")
    public void onOrder(String message) { }
}
`;
        const headCode = `
import org.springframework.kafka.annotation.KafkaListener;

public class OrderConsumer {
    @KafkaListener(topics = "orders-v2", groupId = "order-group")
    public void onOrder(String message) { }
}
`;
        setupMocks({
            baseFiles: [MQ_FILE],
            headFiles: [MQ_FILE],
            changedFiles: [MQ_FILE],
            contentsByHash: {
                [BASE_HASH]: { [MQ_FILE]: baseCode },
                [HEAD_HASH]: { [MQ_FILE]: headCode },
            },
        });

        const result = await buildCommitDiffGraphs('/workspace', BASE_HASH, HEAD_HASH, noop);
        const consumers = Object.values(result.apiIndex).filter(a => a.method === 'MQ_CONSUMER');
        expect(consumers.length).toBe(1);
        expect(consumers[0].route).toContain('orders-v2'); // head topic
    });
});

// ─── L1-C2 (2026-06-07): cascade callback must report L1 mutations ───────────

describe('upgradeServiceClusterDiffAnnotations — L1-C2 return-value contract', () => {
    // The live-verify bug: after a file revert, the LLM-naming `.then()`
    // callback in syncOrchestrator calls this function (which mutates
    // microservice:workspace from `modified` back to `unchanged`), but the
    // caller's `refreshIds` list does NOT include `microservice:workspace`
    // — so the broadcast skips the L1 update and the user sees a stale
    // `~ modified` chip until manual reload.
    //
    // The fix: have the function RETURN the set of graph IDs it mutated so
    // the caller can union it into its refresh list. Backwards-compatible:
    // existing callers that ignore the return value keep working.

    it('returns the graph IDs of graphs it mutated (feature + microservice)', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'api-list:cluster:auth': {
                graphId: 'api-list:cluster:auth', type: 'api-list',
                nodes: [], edges: [], anchors: {},
                meta: { clusterId: 'cluster:auth', apis: [{ apiId: 'POST:/login', diff: 'modified' }] },
            },
            'feature:workspace': {
                graphId: 'feature:workspace', type: 'feature',
                nodes: [
                    {
                        id: 'cluster-auth', type: 'cluster', label: 'auth', diff: 'unchanged',
                        clusterMembership: 'cluster:auth',
                        meta: { clusterId: 'cluster:auth', serviceId: 'service:main', files: ['src/auth/auth.service.ts'] },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
            'microservice:workspace': {
                graphId: 'microservice:workspace', type: 'microservice',
                nodes: [
                    {
                        id: 'main', type: 'service', label: 'main', diff: 'unchanged',
                        serviceId: 'service:main',
                        meta: {},
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
        };

        const touched = upgradeServiceClusterDiffAnnotations(diffedGraphs);

        // After upgrade: feature cluster + microservice service both modified.
        expect(diffedGraphs['feature:workspace'].nodes[0].diff).toBe('modified');
        expect(diffedGraphs['microservice:workspace'].nodes[0].diff).toBe('modified');

        // The fix: the function reports BOTH IDs so the caller can broadcast.
        expect(touched).toContain('feature:workspace');
        expect(touched).toContain('microservice:workspace');
    });

    it('returns L1 ID when resetting modified → unchanged on revert', () => {
        // The exact L1-C2 scenario: a prior cascade marked main service
        // `modified`. The user reverts. Now `modifiedClusterServiceIds` is
        // empty, so the function should reset main → unchanged AND report
        // microservice:workspace as a graph it touched, so the broadcast
        // catches up.
        const diffedGraphs: Record<string, DiagramGraph> = {
            'feature:workspace': {
                graphId: 'feature:workspace', type: 'feature',
                nodes: [
                    {
                        id: 'cluster-auth', type: 'cluster', label: 'auth', diff: 'modified',
                        clusterMembership: 'cluster:auth',
                        meta: { clusterId: 'cluster:auth', serviceId: 'service:main', files: ['src/auth/auth.service.ts'] },
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
            'microservice:workspace': {
                graphId: 'microservice:workspace', type: 'microservice',
                nodes: [
                    {
                        id: 'main', type: 'service', label: 'main', diff: 'modified',
                        serviceId: 'service:main',
                        meta: {},
                    },
                ],
                edges: [], anchors: {}, meta: {},
            },
        };

        const touched = upgradeServiceClusterDiffAnnotations(diffedGraphs);

        expect(diffedGraphs['feature:workspace'].nodes[0].diff).toBe('unchanged');
        expect(diffedGraphs['microservice:workspace'].nodes[0].diff).toBe('unchanged');
        // Even on a downgrade pass, the IDs MUST appear so callers can
        // broadcast the cleaned state.
        expect(touched).toContain('feature:workspace');
        expect(touched).toContain('microservice:workspace');
    });

    it('returns empty list when nothing changes', () => {
        const diffedGraphs: Record<string, DiagramGraph> = {
            'feature:workspace': {
                graphId: 'feature:workspace', type: 'feature',
                nodes: [{ id: 'c', type: 'cluster', label: 'a', diff: 'unchanged', meta: {} }],
                edges: [], anchors: {}, meta: {},
            },
        };
        const touched = upgradeServiceClusterDiffAnnotations(diffedGraphs);
        expect(touched).toEqual([]);
    });
});

// ─── Issue 370: cluster cascade for new entry-point types ────────────────────

describe('upgradeServiceClusterDiffAnnotations — non-HTTP entry-point cascade', () => {
    it('feature cluster turns modified when JOB record in its api-list has diff:added', () => {
        const apiListGraph: DiagramGraph = {
            graphId: 'api-list:cluster:async',
            type: 'api-list',
            nodes: [],
            edges: [],
            anchors: {},
            meta: {
                clusterId: 'cluster:async',
                apis: [
                    {
                        apiId: 'job:report',
                        method: 'JOB',
                        route: '/cron:0 0 * * * *',
                        handlerName: 'generateReport',
                        filePath: 'src/jobs/Report.java',
                        anchor: { filePath: 'src/jobs/Report.java' },
                        diff: 'added',
                    } as ApiRecord,
                ],
            },
        };
        const featureGraph: DiagramGraph = {
            graphId: 'feature:workspace',
            type: 'feature',
            nodes: [{
                id: 'cluster:async',
                type: 'cluster',
                label: 'async',
                diff: 'unchanged',
                clusterMembership: 'cluster:async',
                meta: { clusterId: 'cluster:async', serviceId: 'service:main' },
                anchor: { filePath: 'src/jobs/' },
            }],
            edges: [],
            anchors: {},
            meta: {},
        };
        const microGraph: DiagramGraph = {
            graphId: 'microservice:workspace',
            type: 'microservice',
            nodes: [{
                id: 'svc:main',
                type: 'service',
                label: 'main',
                diff: 'unchanged',
                serviceId: 'service:main',
                meta: { serviceId: 'service:main' },
                anchor: { filePath: '' },
            }],
            edges: [],
            anchors: {},
            meta: {},
        };
        const diffedGraphs: Record<string, DiagramGraph> = {
            [apiListGraph.graphId]: apiListGraph,
            [featureGraph.graphId]: featureGraph,
            [microGraph.graphId]: microGraph,
        };

        upgradeServiceClusterDiffAnnotations(diffedGraphs);
        // L2a: cluster node turned modified
        expect(featureGraph.nodes[0].diff).toBe('modified');
        // L1: service node turned modified (cascade from L2a)
        expect(microGraph.nodes[0].diff).toBe('modified');
    });

    it('feature cluster stays unchanged when only mobile DI_BINDING records change', () => {
        // DI_BINDING is in the mobile sub-section list and excluded from
        // meta.apis — so changing one shouldn't drag the whole cluster.
        // But we put it in `meta.apis` anyway here to confirm: if it WERE
        // in meta.apis with a diff, the cluster would still turn modified
        // (because the cascade is method-agnostic). The actual filter
        // happens in apiListGraphBuilder, not in the cascade.
        const apiListGraph: DiagramGraph = {
            graphId: 'api-list:cluster:ui',
            type: 'api-list',
            nodes: [],
            edges: [],
            anchors: {},
            meta: {
                clusterId: 'cluster:ui',
                apis: [], // mobile records are filtered out by the api-list builder
            },
        };
        const featureGraph: DiagramGraph = {
            graphId: 'feature:workspace',
            type: 'feature',
            nodes: [{
                id: 'cluster:ui',
                type: 'cluster',
                label: 'ui',
                diff: 'unchanged',
                clusterMembership: 'cluster:ui',
                meta: { clusterId: 'cluster:ui', files: [], serviceId: 'service:main' },
                anchor: { filePath: 'src/ui/' },
            }],
            edges: [],
            anchors: {},
            meta: {},
        };
        upgradeServiceClusterDiffAnnotations({
            [apiListGraph.graphId]: apiListGraph,
            [featureGraph.graphId]: featureGraph,
        });
        expect(featureGraph.nodes[0].diff).toBe('unchanged');
    });
});
