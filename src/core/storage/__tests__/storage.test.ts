import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SnapshotStore } from '../snapshotStore';
import { CommentStore } from '../commentStore';
import type { Anchor } from '../../graph/graphTypes';

describe('SnapshotStore', () => {
    let tmpDir: string;
    let store: SnapshotStore;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeatlas-store-'));
        store = new SnapshotStore(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should create default state', () => {
        const state = store.getState();

        expect(state.version).toBe(1);
        expect(state.workspaceRoot).toBe(tmpDir);
        expect(state.baseline).toBeDefined();
        expect(state.working).toBeDefined();
        expect(state.comments).toEqual([]);
    });

    it('should save and load state', async () => {
        await store.load();
        store.updateWorkingFile('src/app.js', {
            path: 'src/app.js', hash: 'abc123', mtime: 1000,
            symbols: { functions: [], variables: [], imports: [] },
        });
        store.save();

        const newStore = new SnapshotStore(tmpDir);
        const loaded = await newStore.load();

        expect(loaded.working.files['src/app.js']).toBeDefined();
        expect(loaded.working.files['src/app.js'].hash).toBe('abc123');
    });

    it('should set baseline from working', () => {
        store.updateWorkingFile('test.js', {
            path: 'test.js', hash: 'xyz', mtime: 2000,
            symbols: { functions: [], variables: [], imports: [] },
        });
        store.setBaselineFromWorking();

        expect(store.getBaseline().files['test.js']).toBeDefined();
        expect(store.getBaseline().files['test.js'].hash).toBe('xyz');
    });

    it('should reset working snapshot', () => {
        store.updateWorkingFile('test.js', {
            path: 'test.js', hash: 'xyz', mtime: 2000,
            symbols: { functions: [], variables: [], imports: [] },
        });
        store.resetWorking();

        expect(Object.keys(store.getWorking().files)).toHaveLength(0);
    });

    it('should update and retrieve API records', () => {
        store.updateWorkingApi('GET:/users', {
            apiId: 'GET:/users', method: 'GET', route: '/users',
            handlerName: 'getUsers', filePath: 'routes.js',
            anchor: { filePath: 'routes.js' },
        });

        expect(store.getWorking().apiIndex['GET:/users']).toBeDefined();
        expect(store.getWorking().apiIndex['GET:/users'].method).toBe('GET');
    });

    it('should handle load with missing file', async () => {
        const state = await store.load();
        expect(state.version).toBe(1);
    });

    it('should create storage directory', async () => {
        await store.load();
        store.save();
        const storageDir = path.join(tmpDir, '.codeatlas');
        expect(fs.existsSync(storageDir)).toBe(true);
    });
});

describe('CommentStore', () => {
    let commentStore: CommentStore;

    beforeEach(() => {
        commentStore = new CommentStore();
    });

    it('should add a comment', () => {
        const comment = commentStore.add({
            layer: 'file', targetType: 'node', targetId: 'n1',
            anchor: { filePath: 'src/app.js', symbol: 'foo' },
            body: 'Consider refactoring this function',
        });

        expect(comment.id).toBeDefined();
        expect(comment.status).toBe('open');
        expect(comment.body).toBe('Consider refactoring this function');
    });

    it('should get all comments', () => {
        commentStore.add({ layer: 'file', targetType: 'node', targetId: 'n1', anchor: { filePath: '' }, body: 'Comment 1' });
        commentStore.add({ layer: 'flow', targetType: 'edge', targetId: 'e1', anchor: { filePath: '' }, body: 'Comment 2' });

        expect(commentStore.getAll()).toHaveLength(2);
    });

    it('should filter by layer', () => {
        commentStore.add({ layer: 'file', targetType: 'node', targetId: 'n1', anchor: { filePath: '' }, body: 'File comment' });
        commentStore.add({ layer: 'flow', targetType: 'edge', targetId: 'e1', anchor: { filePath: '' }, body: 'Flow comment' });
        commentStore.add({ layer: 'file', targetType: 'node', targetId: 'n2', anchor: { filePath: '' }, body: 'File comment 2' });

        expect(commentStore.getByLayer('file')).toHaveLength(2);
        expect(commentStore.getByLayer('flow')).toHaveLength(1);
    });

    it('should resolve a comment', () => {
        const comment = commentStore.add({
            layer: 'file', targetType: 'node', targetId: 'n1', anchor: { filePath: '' }, body: 'Fix this',
        });

        expect(commentStore.resolve(comment.id)).toBe(true);
        expect(commentStore.getAll()[0].status).toBe('resolved');
    });

    it('should reopen a resolved comment', () => {
        const comment = commentStore.add({
            layer: 'file', targetType: 'node', targetId: 'n1', anchor: { filePath: '' }, body: 'Fix this',
        });
        commentStore.resolve(comment.id);
        commentStore.reopen(comment.id);

        expect(commentStore.getAll()[0].status).toBe('open');
    });

    it('should delete a comment', () => {
        const comment = commentStore.add({
            layer: 'file', targetType: 'node', targetId: 'n1', anchor: { filePath: '' }, body: 'Delete me',
        });

        expect(commentStore.delete(comment.id)).toBe(true);
        expect(commentStore.getAll()).toHaveLength(0);
    });

    it('should filter open and resolved separately', () => {
        const c1 = commentStore.add({ layer: 'file', targetType: 'node', targetId: 'n1', anchor: { filePath: '' }, body: 'Open' });
        const c2 = commentStore.add({ layer: 'file', targetType: 'node', targetId: 'n2', anchor: { filePath: '' }, body: 'Resolved' });
        commentStore.resolve(c2.id);

        expect(commentStore.getOpen()).toHaveLength(1);
        expect(commentStore.getResolved()).toHaveLength(1);
    });

    it('should re-anchor comments by exact span', () => {
        commentStore.add({
            layer: 'file', targetType: 'node', targetId: 'old_n1',
            anchor: { filePath: 'app.js', span: { start: 10, end: 50 } },
            body: 'Test',
        });

        const newAnchors = new Map<string, Anchor>();
        newAnchors.set('new_n1', { filePath: 'app.js', span: { start: 10, end: 50 } });

        const orphaned = commentStore.reanchor(newAnchors);

        expect(orphaned).toHaveLength(0);
        expect(commentStore.getAll()[0].targetId).toBe('new_n1');
    });

    it('should re-anchor by symbol name', () => {
        commentStore.add({
            layer: 'file', targetType: 'node', targetId: 'old_n1',
            anchor: { filePath: 'app.js', symbol: 'fetchUsers', span: { start: 100, end: 200 } },
            body: 'Test',
        });

        const newAnchors = new Map<string, Anchor>();
        newAnchors.set('new_n1', { filePath: 'app.js', symbol: 'fetchUsers', span: { start: 120, end: 220 } });

        const orphaned = commentStore.reanchor(newAnchors);

        expect(orphaned).toHaveLength(0);
        expect(commentStore.getAll()[0].targetId).toBe('new_n1');
    });

    it('should mark orphaned comments', () => {
        commentStore.add({
            layer: 'file', targetType: 'node', targetId: 'old_n1',
            anchor: { filePath: 'deleted.js', symbol: 'gone', span: { start: 1, end: 10 } },
            body: 'Orphaned',
        });

        const newAnchors = new Map<string, Anchor>();
        newAnchors.set('new_n1', { filePath: 'app.js', symbol: 'fetchUsers' });

        const orphaned = commentStore.reanchor(newAnchors);

        expect(orphaned).toHaveLength(1);
    });

    it('should serialize to JSON', () => {
        commentStore.add({ layer: 'file', targetType: 'node', targetId: 'n1', anchor: { filePath: '' }, body: 'JSON test' });
        const json = commentStore.toJSON();

        expect(json).toHaveLength(1);
        expect(json[0].body).toBe('JSON test');
    });

    // Issue #403 regression — anchor map collapse across graphs.
    describe('reanchor with namespaced map keys (Issue #403)', () => {
        it('namespaced keys with cross-graph nodeId collision resolves to the correct anchor', () => {
            // Comment was originally on L4 file:graph node_21 (getCurrentUser).
            commentStore.add({
                layer: 'file', targetType: 'node', targetId: 'node_21',
                anchor: { filePath: 'auth.service.ts', symbol: 'getCurrentUser' },
                body: 'lives on getCurrentUser',
            });

            // After resync: both L4 file:graph AND L3 sequence:graph have a
            // `node_21`. With a flat Map, the L3 entry would clobber L4 and
            // the reanchor would silently move the comment to the L3 node.
            // With namespaced keys, both anchors coexist.
            const newAnchors = new Map<string, Anchor>();
            newAnchors.set('file:auth.service.ts::node_21', { filePath: 'auth.service.ts', symbol: 'getCurrentUser' });
            newAnchors.set('sequence:auth.controller.ts:get::node_21', { filePath: 'auth.controller.ts', symbol: 'getCurrentUser-handler' });

            const orphaned = commentStore.reanchor(newAnchors);
            expect(orphaned).toHaveLength(0);

            const c = commentStore.getAll()[0];
            // Strategy 2b (filePath:symbol) should win — auth.service.ts +
            // getCurrentUser uniquely identifies the L4 entry.
            expect(c.anchor?.filePath).toBe('auth.service.ts');
            expect(c.anchor?.symbol).toBe('getCurrentUser');
            // The raw targetId must NOT carry the namespace prefix.
            expect(c.targetId).toBe('node_21');
            expect(c.targetId.includes('::')).toBe(false);
        });

        it('legacy un-namespaced keys still work (backwards compat)', () => {
            commentStore.add({
                layer: 'file', targetType: 'node', targetId: 'old_n1',
                anchor: { filePath: 'app.js', symbol: 'fetchUsers', span: { start: 10, end: 50 } },
                body: 'legacy',
            });
            const newAnchors = new Map<string, Anchor>();
            newAnchors.set('new_n1', { filePath: 'app.js', symbol: 'fetchUsers', span: { start: 10, end: 50 } });
            const orphaned = commentStore.reanchor(newAnchors);
            expect(orphaned).toHaveLength(0);
            expect(commentStore.getAll()[0].targetId).toBe('new_n1');
        });

        it('Strategy 2b correctly picks the L4 anchor even when L3 entry has same filePath but different symbol', () => {
            commentStore.add({
                layer: 'file', targetType: 'node', targetId: 'node_21',
                anchor: { filePath: 'foo.ts', symbol: 'targetFn' },
                body: 'should land on targetFn, not somethingElse',
            });
            const newAnchors = new Map<string, Anchor>();
            // L3 entry inserted first
            newAnchors.set('sequence:foo.ts:bar::node_21', { filePath: 'foo.ts', symbol: 'somethingElse' });
            // L4 entry inserted second
            newAnchors.set('file:foo.ts::node_21', { filePath: 'foo.ts', symbol: 'targetFn' });
            commentStore.reanchor(newAnchors);
            const c = commentStore.getAll()[0];
            expect(c.anchor?.symbol).toBe('targetFn');
            expect(c.targetId).toBe('node_21');
        });
    });
});
