/**
 * The automatic LLM cluster-naming pass must respect the user's explicit
 * `codeatlas.llmNaming` opt-in — NOT merely whether an LLM provider is
 * `configure()`d (which is also true for on-demand NL queries).
 *
 * Regression: a globally-selected `ollama`/`custom` provider made
 * `llmNamingService.isConfigured` true, so `nameClusters` fired on EVERY init
 * (and cascade), spamming `[LLM] nameCluster failed: ollama request failed:
 * fetch failed` when the local endpoint wasn't running — even though the user
 * never turned naming on.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SyncOrchestrator } from '../syncOrchestrator';
import { SnapshotStore } from '../../storage/snapshotStore';
import { CommentStore } from '../../storage/commentStore';

const tmp: string[] = [];
afterEach(() => {
    while (tmp.length) {
        try { fs.rmSync(tmp.pop()!, { recursive: true, force: true }); } catch { /* */ }
    }
});

function makeWorkspace(): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'llmgate-'));
    tmp.push(ws);
    fs.writeFileSync(path.join(ws, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(ws, 'app.js'), `
const express = require('express');
const app = express();
app.get('/api/health', (req, res) => res.send('ok'));
app.post('/api/items', (req, res) => res.json({}));
module.exports = app;
`);
    return ws;
}

function mockNamingService() {
    const nameClusters = vi.fn(async (clusters: any) => clusters);
    const service = { isConfigured: true, nameClusters, setLogger() { /* */ } } as any;
    return { service, nameClusters };
}

describe('automatic LLM naming respects the codeatlas.llmNaming opt-in', () => {
    it('does NOT call nameClusters on init when naming is disabled (provider configured for NL queries only)', async () => {
        const ws = makeWorkspace();
        const store = new SnapshotStore(ws);
        const sync = new SyncOrchestrator(ws, store, new CommentStore([]));
        sync.setLogger(() => { /* */ });
        const { service, nameClusters } = mockNamingService();
        sync.setLlmNamingService(service);
        // llmNamingEnabled defaults to false — user never opted in.

        await store.load();
        await sync.initialize();

        expect(nameClusters).not.toHaveBeenCalled();
    });

    it('DOES call nameClusters on init once the user explicitly enables naming', async () => {
        const ws = makeWorkspace();
        const store = new SnapshotStore(ws);
        const sync = new SyncOrchestrator(ws, store, new CommentStore([]));
        sync.setLogger(() => { /* */ });
        const { service, nameClusters } = mockNamingService();
        sync.setLlmNamingService(service);
        sync.setLlmNamingEnabled(true);

        await store.load();
        await sync.initialize();

        expect(nameClusters).toHaveBeenCalled();
    });
});
