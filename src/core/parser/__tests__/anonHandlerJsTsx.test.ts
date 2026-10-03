/**
 * anonHandlerJsTsx.test.ts
 *
 * Issue 291: integration coverage for the orchestrator's Path-B Babel
 * fallback that runs when tree-sitter-typescript can't parse JSX in
 * anonymous-handler bodies. Multiple anon handlers in one TSX file should
 * each get their own flow graph.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { setGrammarsDir, resetTreeSitterForTesting } from '../treeSitterParser';
import { SyncOrchestrator } from '../../sync/syncOrchestrator';
import { SnapshotStore } from '../../storage/snapshotStore';
import { CommentStore } from '../../storage/commentStore';

beforeAll(() => {
    resetTreeSitterForTesting();
    setGrammarsDir(path.join(process.cwd(), 'grammars'));
});

describe('anonymous handler resolution: TSX with multiple JSX bodies', () => {
    it('resolves all anonymous handlers in a single TSX file', { timeout: 60_000 }, async () => {
        // Build a tmp workspace with one .tsx file that has 3 anon handlers,
        // each containing JSX in the body. tree-sitter-typescript will fail
        // these; Path-B should pick them up.
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-tsx-'));
        const filePath = path.join(workspace, 'app.tsx');
        const code = `import { Hono } from 'hono';
const app = new Hono();
app.get('/', (c) => c.html(<html lang="en"><head /><body>home</body></html>));
app.get('/about', (c) => c.html(<html lang="en"><body>about</body></html>));
app.post('/submit', async (c) => {
  const body = await c.req.json();
  return c.html(<html lang="en"><body>posted: {body.value}</body></html>);
});
export default app;
`;
        fs.writeFileSync(filePath, code);

        const codeatlasDir = path.join(workspace, '.codeatlas');
        const store = new SnapshotStore(codeatlasDir);
        const sync = new SyncOrchestrator(workspace, store, new CommentStore([]));
        await sync.initialize();

        const w = store.getWorking();
        const flowIds = Object.keys(w.graphs).filter(g => g.startsWith('flow:app.tsx:anonymous@'));
        // All 3 anonymous handlers should be flow-charted via Path-B fallback
        // (because tree-sitter-typescript ERRORs on the JSX inside the body).
        expect(flowIds.length, `flow ids found: ${flowIds.join(', ')}`).toBeGreaterThanOrEqual(3);

        const apis = Object.values(w.apiIndex).filter(a => a.handlerName?.startsWith('anonymous@'));
        for (const api of apis) {
            const expected = `flow:${api.filePath}:${api.handlerName}`;
            expect(flowIds.includes(expected), `missing flow graph for ${api.handlerName}`).toBe(true);
        }

        fs.rmSync(workspace, { recursive: true, force: true });
    });
});
