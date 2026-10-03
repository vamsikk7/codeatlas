import { describe, it, expect } from 'vitest';
import { computeEntryPointHandlerHash, computeReviewDelta, entryPointKey } from '../reviewDelta';
import type { AiReviewEntryCursor } from '../../storage/snapshotStore';

function api(over: any = {}) {
    return {
        apiId: 'a',
        method: 'GET',
        route: '/api/users',
        handlerName: 'findAll',
        filePath: 'src/users.ts',
        anchor: { filePath: 'src/users.ts', span: { start: 10, end: 50 } },
        ...over,
    };
}

function snapshot(files: Record<string, { hash: string }>, apiIndex: Record<string, any> = {}) {
    return { files, apiIndex } as any;
}

describe('entryPointKey', () => {
    it('uppercases method and concatenates with route', () => {
        expect(entryPointKey({ method: 'post', route: '/x' })).toBe('POST:/x');
        expect(entryPointKey({ method: 'GET', route: '' } as any)).toBe('GET:');
    });
});

describe('computeEntryPointHandlerHash', () => {
    it('produces a 12-char hex digest', () => {
        const h = computeEntryPointHandlerHash(api(), snapshot({ 'src/users.ts': { hash: 'abc123' } }));
        expect(h).toMatch(/^[0-9a-f]{12}$/);
    });

    it('is deterministic across calls', () => {
        const snap = snapshot({ 'src/users.ts': { hash: 'abc123' } });
        const h1 = computeEntryPointHandlerHash(api(), snap);
        const h2 = computeEntryPointHandlerHash(api(), snap);
        expect(h1).toBe(h2);
    });

    it('changes when file hash changes', () => {
        const before = computeEntryPointHandlerHash(api(), snapshot({ 'src/users.ts': { hash: 'v1' } }));
        const after = computeEntryPointHandlerHash(api(), snapshot({ 'src/users.ts': { hash: 'v2' } }));
        expect(before).not.toBe(after);
    });

    it('changes when route or method changes', () => {
        const snap = snapshot({ 'src/users.ts': { hash: 'h' } });
        const a = computeEntryPointHandlerHash(api({ method: 'POST' }), snap);
        const b = computeEntryPointHandlerHash(api({ method: 'GET' }), snap);
        expect(a).not.toBe(b);
    });

    it('changes when the handler span shifts', () => {
        const snap = snapshot({ 'src/users.ts': { hash: 'h' } });
        const a = computeEntryPointHandlerHash(api({ anchor: { filePath: 'src/users.ts', span: { start: 10, end: 50 } } }), snap);
        const b = computeEntryPointHandlerHash(api({ anchor: { filePath: 'src/users.ts', span: { start: 60, end: 100 } } }), snap);
        expect(a).not.toBe(b);
    });

    it('treats missing file as empty hash (still deterministic)', () => {
        const h = computeEntryPointHandlerHash(api({ filePath: 'src/missing.ts' }), snapshot({}));
        expect(h).toMatch(/^[0-9a-f]{12}$/);
    });
});

describe('computeReviewDelta', () => {
    const guidelinesHash = 'gh1';

    function makeApi(method: string, route: string, filePath: string, apiId?: string) {
        return api({
            method,
            route,
            filePath,
            apiId: apiId ?? `${method}:${route}::${filePath}::${method.toLowerCase()}`,
            anchor: { filePath, span: { start: 0, end: 10 } },
        });
    }

    function makeCursor(apiId: string, entryPointId: string, hash: string, gh = guidelinesHash): AiReviewEntryCursor {
        return {
            apiId,
            entryPointId,
            handlerHash: hash,
            guidelinesHash: gh,
            baselineKind: 'git',
            baselineRef: 'abc1234',
            reviewedAt: 1,
        };
    }

    it('treats every entry as changed when cursor table is empty', () => {
        const a1 = makeApi('GET', '/users', 'src/u.ts');
        const a2 = makeApi('POST', '/users', 'src/u.ts');
        const snap = snapshot({ 'src/u.ts': { hash: 'h1' } }, { [a1.apiId]: a1, [a2.apiId]: a2 });
        const delta = computeReviewDelta({ snapshot: snap, cursors: {}, guidelinesHash });
        expect(delta.changed.map(entryPointKey).sort()).toEqual(['GET:/users', 'POST:/users']);
        expect(delta.reused).toEqual([]);
        expect(delta.deletedCursors).toEqual([]);
        expect(delta.deletedFindings).toEqual([]);
    });

    it('marks an entry as reused when cursor matches', () => {
        const a1 = makeApi('GET', '/users', 'src/u.ts');
        const snap = snapshot({ 'src/u.ts': { hash: 'h1' } }, { [a1.apiId]: a1 });
        const hash = computeEntryPointHandlerHash(a1, snap);
        const cursors = { [a1.apiId]: makeCursor(a1.apiId, 'GET:/users', hash) };
        const delta = computeReviewDelta({ snapshot: snap, cursors, guidelinesHash });
        expect(delta.changed).toEqual([]);
        expect(delta.reused).toEqual([a1.apiId]);
    });

    it('marks an entry as changed when the file hash drifts', () => {
        const a1 = makeApi('GET', '/users', 'src/u.ts');
        const snapV1 = snapshot({ 'src/u.ts': { hash: 'h1' } }, { [a1.apiId]: a1 });
        const hashV1 = computeEntryPointHandlerHash(a1, snapV1);
        const snapV2 = snapshot({ 'src/u.ts': { hash: 'h2' } }, { [a1.apiId]: a1 });
        const cursors = { [a1.apiId]: makeCursor(a1.apiId, 'GET:/users', hashV1) };
        const delta = computeReviewDelta({ snapshot: snapV2, cursors, guidelinesHash });
        expect(delta.changed.map((a) => a.apiId)).toEqual([a1.apiId]);
        expect(delta.reused).toEqual([]);
    });

    it('marks an entry as changed when guidelines hash drifts', () => {
        const a1 = makeApi('GET', '/users', 'src/u.ts');
        const snap = snapshot({ 'src/u.ts': { hash: 'h1' } }, { [a1.apiId]: a1 });
        const hash = computeEntryPointHandlerHash(a1, snap);
        const cursors = { [a1.apiId]: makeCursor(a1.apiId, 'GET:/users', hash, 'old-guidelines') };
        const delta = computeReviewDelta({ snapshot: snap, cursors, guidelinesHash: 'new-guidelines' });
        expect(delta.changed.map((a) => a.apiId)).toEqual([a1.apiId]);
    });

    it('returns vanished cursors in `deletedCursors` AND their orphaned entryPointId in `deletedFindings`', () => {
        const a1 = makeApi('GET', '/users', 'src/u.ts');
        const snap = snapshot({ 'src/u.ts': { hash: 'h1' } }, { [a1.apiId]: a1 });
        const hash = computeEntryPointHandlerHash(a1, snap);
        const cursors = {
            [a1.apiId]: makeCursor(a1.apiId, 'GET:/users', hash),
            'GET:/old-route::src/gone.ts::dead': makeCursor('GET:/old-route::src/gone.ts::dead', 'GET:/old-route', 'whatever'),
        };
        const delta = computeReviewDelta({ snapshot: snap, cursors, guidelinesHash });
        expect(delta.reused).toEqual([a1.apiId]);
        expect(delta.deletedCursors).toEqual(['GET:/old-route::src/gone.ts::dead']);
        // The orphan's entryPointId is no longer in any live api → findings get dropped.
        expect(delta.deletedFindings).toEqual(['GET:/old-route']);
    });

    it('applies scopeFilter before partitioning', () => {
        const a1 = makeApi('GET', '/users', 'src/u.ts');
        const a2 = makeApi('POST', '/users', 'src/u.ts');
        (a2 as any).diff = 'modified';
        const snap = snapshot({ 'src/u.ts': { hash: 'h1' } }, { [a1.apiId]: a1, [a2.apiId]: a2 });
        const delta = computeReviewDelta({
            snapshot: snap,
            cursors: {},
            guidelinesHash,
            scopeFilter: (api) => (api as any).diff === 'modified',
        });
        expect(delta.changed.map(entryPointKey)).toEqual(['POST:/users']);
    });

    it('mixes scenarios — typical realistic case (1 changed, 2 reused, 1 deleted)', () => {
        const reusedA = makeApi('GET', '/users', 'src/u.ts');
        const reusedB = makeApi('POST', '/users', 'src/u.ts');
        const changedC = makeApi('GET', '/auth', 'src/auth.ts');
        const snap = snapshot(
            { 'src/u.ts': { hash: 'h1' }, 'src/auth.ts': { hash: 'auth-v2' } },
            { [reusedA.apiId]: reusedA, [reusedB.apiId]: reusedB, [changedC.apiId]: changedC },
        );
        const reusedAHash = computeEntryPointHandlerHash(reusedA, snap);
        const reusedBHash = computeEntryPointHandlerHash(reusedB, snap);
        const cursors = {
            [reusedA.apiId]: makeCursor(reusedA.apiId, 'GET:/users', reusedAHash),
            [reusedB.apiId]: makeCursor(reusedB.apiId, 'POST:/users', reusedBHash),
            // changedC's cursor records the pre-edit hash, so it's now stale.
            [changedC.apiId]: makeCursor(changedC.apiId, 'GET:/auth', 'pre-edit-hash'),
            // deletedD's route no longer exists in apiIndex.
            'DELETE:/dead::src/dead.ts::gone': makeCursor('DELETE:/dead::src/dead.ts::gone', 'DELETE:/dead', 'anything'),
        };
        const delta = computeReviewDelta({ snapshot: snap, cursors, guidelinesHash });
        expect(delta.changed.map(entryPointKey)).toEqual(['GET:/auth']);
        expect(new Set(delta.reused)).toEqual(new Set([reusedA.apiId, reusedB.apiId]));
        expect(delta.deletedCursors).toEqual(['DELETE:/dead::src/dead.ts::gone']);
        expect(delta.deletedFindings).toEqual(['DELETE:/dead']);
    });

    // ── #606-SYNTHETIC — multi-file synthetic-method collision tests ──
    describe('synthetic-method collisions (#606-SYNTHETIC)', () => {
        // Two `useMutation()` call sites in two different files. Both have
        // method=NETWORK and route=mutation — same `entryPointKey` — but
        // distinct `apiId` because the id format includes file path.
        const sharedKey = 'NETWORK:mutation';
        const aA = api({
            apiId: 'NETWORK:mutation::frontend/src/A.tsx::useMutation',
            method: 'NETWORK', route: 'mutation', handlerName: 'useMutation',
            filePath: 'frontend/src/A.tsx',
            anchor: { filePath: 'frontend/src/A.tsx', span: { start: 100, end: 110 } },
        });
        const aB = api({
            apiId: 'NETWORK:mutation::frontend/src/B.tsx::useMutation',
            method: 'NETWORK', route: 'mutation', handlerName: 'useMutation',
            filePath: 'frontend/src/B.tsx',
            anchor: { filePath: 'frontend/src/B.tsx', span: { start: 200, end: 210 } },
        });

        it('partitions colliding synthetic entries independently by apiId', () => {
            // Snapshot: file A edited (hash drift), file B unchanged.
            const snapAfter = snapshot(
                { 'frontend/src/A.tsx': { hash: 'A-v2' }, 'frontend/src/B.tsx': { hash: 'B-v1' } },
                { [aA.apiId]: aA, [aB.apiId]: aB },
            );
            // Cursors recorded BEFORE the edit — hash A was 'A-v1'.
            const preEditSnapA = snapshot({ 'frontend/src/A.tsx': { hash: 'A-v1' }, 'frontend/src/B.tsx': { hash: 'B-v1' } });
            const cursors = {
                [aA.apiId]: makeCursor(aA.apiId, sharedKey, computeEntryPointHandlerHash(aA, preEditSnapA)),
                [aB.apiId]: makeCursor(aB.apiId, sharedKey, computeEntryPointHandlerHash(aB, snapAfter)),
            };
            const delta = computeReviewDelta({ snapshot: snapAfter, cursors, guidelinesHash });
            // Only A is changed; B is reused — even though they share entry_point_id.
            expect(delta.changed.map((a) => a.apiId)).toEqual([aA.apiId]);
            expect(delta.reused).toEqual([aB.apiId]);
            expect(delta.deletedCursors).toEqual([]);
        });

        it('one synthetic call site removed: cursor drops but findings survive because sibling still claims the entry_point_id', () => {
            // Snapshot: A removed; B still present.
            const snapAfter = snapshot(
                { 'frontend/src/B.tsx': { hash: 'B-v1' } },
                { [aB.apiId]: aB },
            );
            const cursors = {
                [aA.apiId]: makeCursor(aA.apiId, sharedKey, 'whatever'),
                [aB.apiId]: makeCursor(aB.apiId, sharedKey, computeEntryPointHandlerHash(aB, snapAfter)),
            };
            const delta = computeReviewDelta({ snapshot: snapAfter, cursors, guidelinesHash });
            // A's cursor is dropped; B's cursor stays.
            expect(delta.deletedCursors).toEqual([aA.apiId]);
            // The shared `NETWORK:mutation` entry_point_id is STILL claimed by B,
            // so findings for that key MUST survive (don't appear in deletedFindings).
            expect(delta.deletedFindings).toEqual([]);
            expect(delta.reused).toEqual([aB.apiId]);
        });

        it('all synthetic call sites with the same key removed: both the cursor AND the finding for that entry_point_id are dropped', () => {
            // Both A and B removed; nothing left with `NETWORK:mutation`.
            const snapAfter = snapshot({}, {});
            const cursors = {
                [aA.apiId]: makeCursor(aA.apiId, sharedKey, 'x'),
                [aB.apiId]: makeCursor(aB.apiId, sharedKey, 'y'),
            };
            const delta = computeReviewDelta({ snapshot: snapAfter, cursors, guidelinesHash });
            expect(new Set(delta.deletedCursors)).toEqual(new Set([aA.apiId, aB.apiId]));
            // No live api claims the key anymore → findings get dropped exactly once.
            expect(delta.deletedFindings).toEqual([sharedKey]);
        });

        it('edit to one synthetic site does NOT push siblings into `changed` (the pre-#606-SYNTHETIC failure mode)', () => {
            // Three useMutation call sites — A edited, B + C untouched. With
            // the old `method:route` key, B or C would have been pulled into
            // changed depending on which cursor's hash was stamped last.
            // With the apiId-keyed cursor, each is tracked independently.
            const aC = api({
                apiId: 'NETWORK:mutation::frontend/src/C.tsx::useMutation',
                method: 'NETWORK', route: 'mutation', handlerName: 'useMutation',
                filePath: 'frontend/src/C.tsx',
                anchor: { filePath: 'frontend/src/C.tsx', span: { start: 50, end: 60 } },
            });
            const snapAfter = snapshot(
                { 'frontend/src/A.tsx': { hash: 'A-v2' }, 'frontend/src/B.tsx': { hash: 'B-v1' }, 'frontend/src/C.tsx': { hash: 'C-v1' } },
                { [aA.apiId]: aA, [aB.apiId]: aB, [aC.apiId]: aC },
            );
            const preEditA = snapshot({ 'frontend/src/A.tsx': { hash: 'A-v1' }, 'frontend/src/B.tsx': { hash: 'B-v1' }, 'frontend/src/C.tsx': { hash: 'C-v1' } });
            const cursors = {
                [aA.apiId]: makeCursor(aA.apiId, sharedKey, computeEntryPointHandlerHash(aA, preEditA)),
                [aB.apiId]: makeCursor(aB.apiId, sharedKey, computeEntryPointHandlerHash(aB, snapAfter)),
                [aC.apiId]: makeCursor(aC.apiId, sharedKey, computeEntryPointHandlerHash(aC, snapAfter)),
            };
            const delta = computeReviewDelta({ snapshot: snapAfter, cursors, guidelinesHash });
            expect(delta.changed.map((a) => a.apiId)).toEqual([aA.apiId]);
            expect(new Set(delta.reused)).toEqual(new Set([aB.apiId, aC.apiId]));
        });
    });
});
