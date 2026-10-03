/**
 * platform.test.ts — verifies the standalone PlatformAdapter implements the
 * cross-runtime surface handler modules rely on (#547 — HandlerContext standalone-compatible via PlatformAdapter).
 */
import { describe, it, expect, vi } from 'vitest';
import { createStandalonePlatform } from '../platform';
import type { WsBridge } from '../../server/wsBridge';
import type { SecretsStore } from '../secrets';

function fakeBridge(): { bridge: WsBridge; broadcasts: any[] } {
    const broadcasts: any[] = [];
    const bridge = {
        broadcast: (m: any) => { broadcasts.push(m); },
        hasClients: () => true,
    } as unknown as WsBridge;
    return { bridge, broadcasts };
}

function fakeSecrets(): { secrets: SecretsStore; reads: string[]; writes: Array<[string, string]> } {
    const reads: string[] = [];
    const writes: Array<[string, string]> = [];
    const store = new Map<string, string>();
    const secrets: SecretsStore = {
        get: async (key) => { reads.push(key); return store.get(key); },
        store: async (key, value) => { writes.push([key, value]); store.set(key, value); },
        delete: async (key) => { store.delete(key); },
    };
    return { secrets, reads, writes };
}

describe('createStandalonePlatform', () => {
    it('broadcasts to every connected client when present', () => {
        const w = fakeBridge();
        const s = fakeSecrets();
        const p = createStandalonePlatform({ wsBridge: w.bridge, secrets: s.secrets });
        p.broadcast({ type: 'hello', v: 1 });
        expect(w.broadcasts).toEqual([{ type: 'hello', v: 1 }]);
    });

    it('skips broadcast when no clients connected', () => {
        const broadcasts: any[] = [];
        const bridge = {
            broadcast: (m: any) => { broadcasts.push(m); },
            hasClients: () => false,
        } as unknown as WsBridge;
        const s = fakeSecrets();
        const p = createStandalonePlatform({ wsBridge: bridge, secrets: s.secrets });
        p.broadcast({ type: 'lost' });
        expect(broadcasts).toEqual([]);
    });

    it('updateGraph emits a typed updateGraph envelope', () => {
        const w = fakeBridge();
        const s = fakeSecrets();
        const p = createStandalonePlatform({ wsBridge: w.bridge, secrets: s.secrets });
        const fakeGraph = { graphId: 'file:x.ts', nodes: [], edges: [], meta: {} } as any;
        p.updateGraph('file:x.ts', fakeGraph);
        expect(w.broadcasts).toEqual([{ type: 'updateGraph', graphId: 'file:x.ts', graph: fakeGraph }]);
    });

    it('getSecret + setSecret route through the SecretsStore', async () => {
        const w = fakeBridge();
        const s = fakeSecrets();
        const p = createStandalonePlatform({ wsBridge: w.bridge, secrets: s.secrets });

        await p.setSecret('codeatlas.openRouterApiKey', 'sk-test-123');
        expect(s.writes).toEqual([['codeatlas.openRouterApiKey', 'sk-test-123']]);

        const v = await p.getSecret('codeatlas.openRouterApiKey');
        expect(v).toBe('sk-test-123');
        expect(s.reads).toContain('codeatlas.openRouterApiKey');
    });

    it('sidebar reveal methods are no-op (standalone has no sidebar)', () => {
        const w = fakeBridge();
        const s = fakeSecrets();
        const p = createStandalonePlatform({ wsBridge: w.bridge, secrets: s.secrets });
        // None of these should throw or produce side effects on the wsBridge.
        p.refreshSidebar?.();
        p.revealApi?.('GET:/users');
        p.revealService?.('service:backend');
        p.revealCluster?.('cluster:auth');
        expect(w.broadcasts).toEqual([]);
    });

    it('a handler module wired against the adapter works on both runtimes', () => {
        // Synthesise the kind of platform call a future handler module would
        // make and verify it travels through the adapter unchanged.
        const w = fakeBridge();
        const s = fakeSecrets();
        const p = createStandalonePlatform({ wsBridge: w.bridge, secrets: s.secrets });

        // Future shared handler logic: broadcast a status change.
        function emitFindingUpdated(adapter = p) {
            adapter.broadcast({ type: 'aiFindingUpdated', finding: { id: 'f1', status: 'resolved' } });
        }
        emitFindingUpdated();
        emitFindingUpdated();
        expect(w.broadcasts).toHaveLength(2);
        expect(w.broadcasts[0].finding.id).toBe('f1');
    });
});
