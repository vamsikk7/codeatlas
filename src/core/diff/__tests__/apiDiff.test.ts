/**
 * apiDiff.test.ts
 *
 * Tests for API-level diff computation: added, deleted, modified, unchanged.
 * Covers both sequence-graph-based diffs and file-hash fallback (mobile items).
 */

import { describe, it, expect } from 'vitest';
import { computeApiDiff } from '../apiDiff';
import type { ApiRecord, DiagramGraph } from '../../graph/graphTypes';

function makeApi(id: string, filePath: string = 'src/app.ts', method: string = 'GET'): ApiRecord {
    return {
        apiId: id,
        method,
        route: `/${id}`,
        handlerName: id,
        filePath,
        anchor: { filePath, symbol: id, span: { start: 0, end: 1 } },
    };
}

function makeSeqGraph(hasChanges: boolean): DiagramGraph {
    return {
        graphId: 'seq:test',
        type: 'sequence',
        nodes: hasChanges
            ? [{ id: 'n1', type: 'participant', label: 'Test', diff: 'modified' }]
            : [{ id: 'n1', type: 'participant', label: 'Test', diff: 'unchanged' }],
        edges: [],
        anchors: {},
        meta: {},
    };
}

describe('computeApiDiff', () => {
    // ── Added ───────────────────────────────────────────────────
    it('returns "added" when API not in baseline', () => {
        const api = makeApi('getUsers');
        const result = computeApiDiff(api, {}, undefined, undefined, undefined);
        expect(result).toBe('added');
    });

    it('returns "added" even if file hash exists', () => {
        const api = makeApi('getUsers');
        const result = computeApiDiff(api, {}, undefined, 'aaa', 'bbb');
        expect(result).toBe('added');
    });

    // ── Modified via sequence graph ─────────────────────────────
    it('returns "modified" when sequence graph has changed nodes', () => {
        const api = makeApi('getUsers');
        const baseline = { [api.apiId]: api };
        const result = computeApiDiff(api, baseline, makeSeqGraph(true), 'aaa', 'aaa');
        expect(result).toBe('modified');
    });

    it('returns "unchanged" when sequence graph has no changes', () => {
        const api = makeApi('getUsers');
        const baseline = { [api.apiId]: api };
        const result = computeApiDiff(api, baseline, makeSeqGraph(false), 'aaa', 'aaa');
        expect(result).toBe('unchanged');
    });

    // ── Modified via file hash fallback (Issue 84+86) ───────────
    it('returns "modified" when no sequence graph but file hash changed', () => {
        const api = makeApi('HomeScreen', 'lib/screens/home.dart', 'SCREEN');
        const baseline = { [api.apiId]: api };
        const result = computeApiDiff(api, baseline, undefined, 'hash_old', 'hash_new');
        expect(result).toBe('modified');
    });

    it('returns "unchanged" when no sequence graph and file hash same', () => {
        const api = makeApi('HomeScreen', 'lib/screens/home.dart', 'SCREEN');
        const baseline = { [api.apiId]: api };
        const result = computeApiDiff(api, baseline, undefined, 'same_hash', 'same_hash');
        expect(result).toBe('unchanged');
    });

    it('file hash fallback works for NAV_ROUTE items', () => {
        const api = makeApi('settings_route', 'lib/nav.dart', 'NAV_ROUTE');
        const baseline = { [api.apiId]: api };
        const result = computeApiDiff(api, baseline, undefined, 'old', 'new');
        expect(result).toBe('modified');
    });

    it('file hash fallback works for NETWORK items', () => {
        const api = makeApi('fetchTodos', 'lib/api.dart', 'NETWORK');
        const baseline = { [api.apiId]: api };
        const result = computeApiDiff(api, baseline, undefined, 'old', 'new');
        expect(result).toBe('modified');
    });

    it('file hash fallback works for DI_BINDING items', () => {
        const api = makeApi('AppModule', 'app/di/module.kt', 'DI_BINDING');
        const baseline = { [api.apiId]: api };
        const result = computeApiDiff(api, baseline, undefined, 'old', 'new');
        expect(result).toBe('modified');
    });

    // ── Sequence graph is authoritative for endpoints that HAVE one ──
    // BUG-EXP-7 — when an endpoint has a sequence graph and it shows NO
    // changes, the endpoint is unchanged even if the FILE hash changed (a
    // *sibling* endpoint in the same file was edited/added). Previously the
    // file-hash fallback over-marked every route in a touched file `~ MODIFIED`.
    it('sequence graph unchanged + file hash changed → unchanged (per-endpoint precision, BUG-EXP-7)', () => {
        const api = makeApi('handler');
        const baseline = { [api.apiId]: api };
        const result = computeApiDiff(api, baseline, makeSeqGraph(false), 'old', 'new');
        expect(result).toBe('unchanged');
    });

    // ── Edge cases ──────────────────────────────────────────────
    it('missing baseline and working file hashes → unchanged', () => {
        const api = makeApi('handler');
        const baseline = { [api.apiId]: api };
        const result = computeApiDiff(api, baseline, undefined, undefined, undefined);
        expect(result).toBe('unchanged');
    });

    it('only baseline hash exists → unchanged (no comparison possible)', () => {
        const api = makeApi('handler');
        const baseline = { [api.apiId]: api };
        const result = computeApiDiff(api, baseline, undefined, 'old', undefined);
        expect(result).toBe('unchanged');
    });

    // ── Sequence graph with edge diffs ──────────────────────────
    it('returns "modified" when sequence graph has changed edges', () => {
        const api = makeApi('createUser', 'src/api.ts', 'POST');
        const baseline = { [api.apiId]: api };
        const seqGraph: DiagramGraph = {
            graphId: 'seq:test',
            type: 'sequence',
            nodes: [{ id: 'n1', type: 'participant', label: 'Test' }],
            edges: [{ id: 'e1', source: 'n1', target: 'n1', diff: 'added' }],
            anchors: {},
            meta: {},
        };
        const result = computeApiDiff(api, baseline, seqGraph, 'aaa', 'aaa');
        expect(result).toBe('modified');
    });
});
