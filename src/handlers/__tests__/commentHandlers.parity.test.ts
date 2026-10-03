/**
 * commentHandlers.parity.test.ts — #547: prove `commentHandlers` runs under
 * BOTH the extension's PlatformAdapter (panelManager + wsBridge fanout)
 * and the standalone PlatformAdapter (wsBridge-only). Same module, same
 * code path, two adapters. The webview sees identical broadcasts on both
 * runtimes.
 */
import { describe, it, expect } from 'vitest';
import { registerCommentHandlers } from '../commentHandlers';
import { createMessageRouter } from '../messageRouter';
import type { HandlerContext, PlatformAdapter } from '../handlerContext';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Minimal in-memory SnapshotStore stub. We only need the methods commentHandlers
// touches.
function mkSnapshotStore() {
    const working: any = { files: {}, apiIndex: {}, clusters: {}, services: {}, graphs: {} };
    const saved: any[] = [];
    return {
        getWorking: () => working,
        setComments: (data: any) => { (working as any).comments = data; },
        updateWorkingGraph: (id: string, g: any) => { working.graphs[id] = g; },
        save: () => { saved.push({ ts: Date.now() }); },
        _saved: saved,
        _working: working,
    } as any;
}

function mkCommentStore() {
    const items: any[] = [];
    return {
        add: (rec: any) => {
            const c = {
                ...rec,
                id: `c${items.length + 1}`,
                createdAt: new Date().toISOString(),
                author: 'test',
                resolved: false,
            };
            items.push(c);
            return c;
        },
        resolve: (id: string) => { items.forEach(c => { if (c.id === id) c.resolved = true; }); return true; },
        getAll: () => items.slice(),
        toJSON: () => items.slice(),
        _items: items,
    } as any;
}

function mkBaseCtx(platform: PlatformAdapter): HandlerContext {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
    fs.mkdirSync(path.join(tmpRoot, '.codeatlas'), { recursive: true });
    const logs: string[] = [];
    const ctx = {
        workspaceRoot: tmpRoot,
        platform,
        snapshotStore: mkSnapshotStore(),
        commentStore: mkCommentStore(),
        llmNamingService: {} as any,
        notifyBrowser: (_l: string, msg: string) => { logs.push(`notify: ${msg}`); },
        log: (m: string) => { logs.push(m); },
        // All other fields are now optional per #547 — they stay undefined
        // on the standalone path. Extension would supply them.
    } as any;
    ctx._logs = logs;
    return ctx;
}

function mkExtensionAdapter(): { adapter: PlatformAdapter; broadcasts: any[]; graphUpdates: Array<[string, any]> } {
    // Extension adapter simulation: broadcast goes through BOTH panelManager
    // and wsBridge in production — here we capture the merged stream so we
    // can compare apples-to-apples with the standalone (wsBridge-only).
    const broadcasts: any[] = [];
    const graphUpdates: Array<[string, any]> = [];
    const adapter: PlatformAdapter = {
        broadcast: (m) => broadcasts.push(m),
        updateGraph: (id, g) => { graphUpdates.push([id, g]); broadcasts.push({ type: 'updateGraph', graphId: id, graph: g }); },
        getSecret: async () => undefined,
        setSecret: async () => undefined,
        refreshSidebar: () => undefined,
    };
    return { adapter, broadcasts, graphUpdates };
}

function mkStandaloneAdapter(): { adapter: PlatformAdapter; broadcasts: any[]; graphUpdates: Array<[string, any]> } {
    const broadcasts: any[] = [];
    const graphUpdates: Array<[string, any]> = [];
    const adapter: PlatformAdapter = {
        broadcast: (m) => broadcasts.push(m),
        updateGraph: (id, g) => { graphUpdates.push([id, g]); broadcasts.push({ type: 'updateGraph', graphId: id, graph: g }); },
        getSecret: async () => undefined,
        setSecret: async () => undefined,
        // Standalone has no sidebar — these are no-op stubs.
    };
    return { adapter, broadcasts, graphUpdates };
}

describe('#547 commentHandlers — adapter parity', () => {
    it('addComment broadcasts identically under both adapters', async () => {
        const e = mkExtensionAdapter();
        const s = mkStandaloneAdapter();
        const ctxE = mkBaseCtx(e.adapter);
        const ctxS = mkBaseCtx(s.adapter);
        const routerE = createMessageRouter(ctxE);
        const routerS = createMessageRouter(ctxS);
        registerCommentHandlers(routerE.register, ctxE);
        registerCommentHandlers(routerS.register, ctxS);

        const msg = { type: 'addComment', layer: 'file', targetType: 'node', targetId: 'src/x.ts', body: 'note' };
        routerE.dispatch(msg, 'panel-1');
        routerS.dispatch(msg, 'client-1');
        // Both dispatch paths are async (withErrorHandling wraps in a Promise) —
        // give them a tick to settle.
        await new Promise((r) => setTimeout(r, 50));

        // Both adapters saw the same showComments broadcast shape.
        const showCommentsE = e.broadcasts.filter((b) => b.type === 'showComments');
        const showCommentsS = s.broadcasts.filter((b) => b.type === 'showComments');
        expect(showCommentsE).toHaveLength(1);
        expect(showCommentsS).toHaveLength(1);
        expect(showCommentsE[0].comments).toHaveLength(1);
        expect(showCommentsS[0].comments).toHaveLength(1);
        expect(showCommentsE[0].comments[0].body).toBe('note');
        expect(showCommentsS[0].comments[0].body).toBe('note');

        // Both saw exactly one comment persisted in their respective stores.
        expect((ctxE.commentStore as any)._items).toHaveLength(1);
        expect((ctxS.commentStore as any)._items).toHaveLength(1);
    });

    it('resolveComment broadcasts identically under both adapters', async () => {
        const e = mkExtensionAdapter();
        const s = mkStandaloneAdapter();
        const ctxE = mkBaseCtx(e.adapter);
        const ctxS = mkBaseCtx(s.adapter);

        // Seed each with a comment to resolve.
        (ctxE.commentStore as any).add({ layer: 'file', targetType: 'node', targetId: 'src/x.ts', body: 'a' });
        (ctxS.commentStore as any).add({ layer: 'file', targetType: 'node', targetId: 'src/x.ts', body: 'a' });

        const routerE = createMessageRouter(ctxE);
        const routerS = createMessageRouter(ctxS);
        registerCommentHandlers(routerE.register, ctxE);
        registerCommentHandlers(routerS.register, ctxS);

        routerE.dispatch({ type: 'resolveComment', commentId: 'c1' }, 'panel-1');
        routerS.dispatch({ type: 'resolveComment', commentId: 'c1' }, 'client-1');
        await new Promise((r) => setTimeout(r, 50));

        // Both saw a single showComments broadcast with the resolved entry.
        const showCommentsE = e.broadcasts.filter((b) => b.type === 'showComments');
        const showCommentsS = s.broadcasts.filter((b) => b.type === 'showComments');
        expect(showCommentsE).toHaveLength(1);
        expect(showCommentsS).toHaveLength(1);
        expect(showCommentsE[0].comments[0].resolved).toBe(true);
        expect(showCommentsS[0].comments[0].resolved).toBe(true);
    });

    it('standalone ctx has no commentsProvider — optional chain is a silent no-op', async () => {
        // The extension passes `commentsProvider` to refresh its tree view.
        // The standalone leaves it undefined. Verify the handler still runs
        // to completion without throwing.
        const s = mkStandaloneAdapter();
        const ctxS = mkBaseCtx(s.adapter);
        expect((ctxS as any).commentsProvider).toBeUndefined();
        const router = createMessageRouter(ctxS);
        registerCommentHandlers(router.register, ctxS);

        // Should not throw.
        router.dispatch({ type: 'addComment', layer: 'file', targetType: 'node', targetId: 'x', body: 'b' }, 'c1');
        await new Promise((r) => setTimeout(r, 50));
        // Comment landed in the store, broadcast fired.
        expect((ctxS.commentStore as any)._items).toHaveLength(1);
        expect(s.broadcasts.some((b) => b.type === 'showComments')).toBe(true);
    });
});
