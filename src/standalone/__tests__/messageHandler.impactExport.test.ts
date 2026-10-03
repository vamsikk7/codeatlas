/**
 * messageHandler.impactExport.test.ts — #912
 *
 * Per-repo scoping for Impact + Export. Pre-#912 both ran workspace-wide
 * (always `deps.snapshotStore`); now a `repoId` resolves the matching sub-repo
 * store. Pins:
 *   1. requestArchitectureExport({repoId}) reads the picked sub-repo's store
 *      (not the primary) and ships `architectureExportResult` to the client.
 *   2. requestImpact({repoId,filePath}) analyses against the picked store.
 *   3. No repoId ⇒ primary store (single-repo behaviour unchanged).
 */
import { describe, it, expect, vi } from 'vitest';
import { createStandaloneMessageHandler } from '../messageHandler';
import type { SnapshotStore } from '../../core/storage/snapshotStore';
import type { CommentStore } from '../../core/storage/commentStore';
import type { WsBridge } from '../../server/wsBridge';

/* eslint-disable @typescript-eslint/no-explicit-any */

function mkBridge() {
    const broadcasts: any[] = [];
    const sent: Array<{ clientId: string; msg: any }> = [];
    return {
        broadcasts,
        sent,
        wsBridge: {
            broadcast: vi.fn((m: any) => broadcasts.push(m)),
            sendTo: vi.fn((c: string, m: any) => sent.push({ clientId: c, msg: m })),
            hasClients: () => true,
        } as unknown as WsBridge,
    };
}

function mkStore(snap: any): { store: SnapshotStore; getWorking: any } {
    const getWorking = vi.fn(() => snap);
    const store = {
        getWorking,
        getBaseline: () => snap,
        getFileContent: () => undefined,
    } as unknown as SnapshotStore;
    return { store, getWorking };
}

function mkDeps(perRepoStores: Map<string, SnapshotStore>, repos: any[]) {
    const { broadcasts, sent, wsBridge } = mkBridge();
    const primary = perRepoStores.values().next().value!;
    return {
        broadcasts, sent, wsBridge,
        snapshotStore: primary,
        commentStore: {} as unknown as CommentStore,
        log: () => {},
        workspaceRoot: '/ws',
        multiRepo: { aggregator: {} as any, perRepoStores, repos },
    };
}

const snap = (extra: any = {}) => ({ services: {}, apiIndex: {}, clusters: {}, files: {}, graphs: {}, ...extra });

describe('#912 — per-repo Impact + Export scoping', () => {
    it('requestArchitectureExport({repoId}) reads the picked sub-repo store + ships the result', async () => {
        const alpha = mkStore(snap({ services: { 'svc:alpha': { id: 'svc:alpha', name: 'alpha-svc' } } }));
        const beta = mkStore(snap({ services: { 'svc:beta': { id: 'svc:beta', name: 'beta-svc' } } }));
        const stores = new Map<string, SnapshotStore>([['alpha', alpha.store], ['beta', beta.store]]);
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: '/ws/alpha' },
            { repoId: 'beta', name: 'beta', rootPath: '/ws/beta' },
        ];
        const deps = mkDeps(stores, repos);
        alpha.getWorking.mockClear(); beta.getWorking.mockClear();

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestArchitectureExport', repoId: 'beta' }, 'c1');

        const result = deps.sent.find(s => s.msg.type === 'downloadFile');
        expect(result, 'export should be delivered via downloadFile to the requesting client').toBeTruthy();
        expect(result!.clientId).toBe('c1');
        expect(result!.msg.filename).toBe('beta-architecture.md');
        expect(result!.msg.mimeType).toBe('text/markdown');
        expect(typeof result!.msg.content).toBe('string');
        expect(result!.msg.content.length).toBeGreaterThan(0);
        // The BETA store was read, NOT alpha.
        expect(beta.getWorking).toHaveBeenCalled();
        expect(alpha.getWorking).not.toHaveBeenCalled();
    });

    it('requestArchitectureExport with no repoId falls back to the primary store + workspace name', async () => {
        const primary = mkStore(snap());
        const stores = new Map<string, SnapshotStore>([['only', primary.store]]);
        const deps = mkDeps(stores, [{ repoId: 'only', name: 'only', rootPath: '/ws/only' }]);
        primary.getWorking.mockClear();

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestArchitectureExport' }, 'c1');

        const result = deps.sent.find(s => s.msg.type === 'downloadFile');
        expect(result).toBeTruthy();
        // Primary store + basename of workspaceRoot ('/ws' → 'ws').
        expect(result!.msg.filename).toBe('ws-architecture.md');
        expect(primary.getWorking).toHaveBeenCalled();
    });

    it('requestImpact({repoId,filePath}) analyses against the picked sub-repo store', async () => {
        const alpha = mkStore(snap({ files: { 'alpha/a.ts': { symbols: { functions: [] } } } }));
        const beta = mkStore(snap({ files: { 'beta/b.ts': { symbols: { functions: [] } } } }));
        const stores = new Map<string, SnapshotStore>([['alpha', alpha.store], ['beta', beta.store]]);
        const repos = [
            { repoId: 'alpha', name: 'alpha', rootPath: '/ws/alpha' },
            { repoId: 'beta', name: 'beta', rootPath: '/ws/beta' },
        ];
        const deps = mkDeps(stores, repos);
        alpha.getWorking.mockClear(); beta.getWorking.mockClear();

        const h = createStandaloneMessageHandler(deps as any);
        await h.handle({ type: 'requestImpact', filePath: 'beta/b.ts', repoId: 'beta' }, 'c1');

        // Impact broadcast fired + the BETA store was the one read.
        expect(deps.broadcasts.some(m => m.type === 'showImpact')).toBe(true);
        expect(beta.getWorking).toHaveBeenCalled();
        expect(alpha.getWorking).not.toHaveBeenCalled();
    });
});
