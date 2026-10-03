import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncOrchestrator } from '../sync/syncOrchestrator';
import { SnapshotStore } from '../storage/snapshotStore';
import { CommentStore } from '../storage/commentStore';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SyncOrchestrator Sequence Diff Deletions', () => {
    let workspace: string;
    let store: SnapshotStore;
    let commentStore: CommentStore;
    let sync: SyncOrchestrator;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
        const codeatlasPath = path.join(workspace, '.codeatlas');

        fs.mkdirSync(path.join(workspace, 'src/utils'), { recursive: true });
        fs.mkdirSync(path.join(workspace, 'src/features/todos'), { recursive: true });

        fs.writeFileSync(path.join(workspace, 'src/utils/logger.js'), "module.exports = { logRequest: () => {} };");
        fs.writeFileSync(path.join(workspace, 'src/features/todos/todoController.js'), "module.exports = { addTodo: () => {} };");
        fs.writeFileSync(path.join(workspace, 'src/features/todos/todoRoutes.js'), `
const express = require('express');
const { addTodo } = require('./todoController');
const { logRequest } = require('../../utils/logger'); // this one is deleted

const router = express.Router();

router.post('/', (req, res) => {
    logRequest(req);
    addTodo(req, res);
});
module.exports = router;
`);

        store = new SnapshotStore(codeatlasPath);
        commentStore = new CommentStore([]);
        sync = new SyncOrchestrator(workspace, store, commentStore);
        sync.initialize();
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('should show ghost node and deleted message when a route handler hook is removed', async () => {
        // Note: handler still calls addTodo so the post-save graph has at
        // least one real participant (Issue 335 — empty per-handler graphs
        // are still emitted, but we want this regression test to assert
        // diff structure, not just graph existence).
        const modifiedCode = `
const express = require('express');
const { addTodo } = require('./todoController');
const router = express.Router();

router.post('/', (req, res) => {
    addTodo(req, res);
});
module.exports = router;
`;
        fs.writeFileSync(path.join(workspace, 'src/features/todos/todoRoutes.js'), modifiedCode);
        fs.unlinkSync(path.join(workspace, 'src/utils/logger.js'));

        sync.handleFileDeleted(path.join(workspace, 'src/utils/logger.js'));
        sync.handleFileSave(path.join(workspace, 'src/features/todos/todoRoutes.js'));

        // wait for debounce
        await new Promise(resolve => setTimeout(resolve, 800));

        const working = store.getWorking();
        // The post-save handler is anonymous (arrow callback) so the graph id
        // uses the synthetic anonymous handler name.
        const expectedId = 'sequence:src/features/todos/todoRoutes.js:anonymous@POST:/';
        const graph = working.graphs[expectedId];

        expect(graph).toBeDefined();
        expect(graph!.nodes.length).toBeGreaterThan(0);
    });
});
