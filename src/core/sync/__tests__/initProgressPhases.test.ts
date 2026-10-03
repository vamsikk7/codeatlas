/**
 * #918 part (a) — the orchestrator's init must emit ≥3 distinct NAMED phases
 * (not a bare progress fraction) so the home page can render a phase
 * breadcrumb. This pins the named-phase contract the webview consumes.
 */
import { describe, it, expect, afterEach } from 'vitest';
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

describe('#918 — init emits named phases', () => {
    it('initialize() emits ≥3 distinct named phases with messages', async () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'initphases-'));
        tmp.push(ws);
        fs.writeFileSync(path.join(ws, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
        fs.writeFileSync(path.join(ws, 'app.js'), `
const express = require('express');
const app = express();
app.get('/api/health', (req, res) => res.send('ok'));
app.post('/api/items', (req, res) => res.json({}));
module.exports = app;
`);

        const store = new SnapshotStore(ws);
        const sync = new SyncOrchestrator(ws, store, new CommentStore([]));
        sync.setLogger(() => { /* silence */ });

        const phases: string[] = [];
        const messages: string[] = [];
        sync.onProgress((phase, _progress, message) => {
            phases.push(phase);
            messages.push(message);
        });

        await store.load();
        await sync.initialize();

        const distinct = new Set(phases);
        expect(distinct.size, `phases seen: ${JSON.stringify([...distinct])}`).toBeGreaterThanOrEqual(3);
        // The canonical named phases must all appear.
        for (const named of ['scanning', 'parsing', 'building']) {
            expect(distinct.has(named), `missing phase "${named}" in ${JSON.stringify([...distinct])}`).toBe(true);
        }
        // Every emit carries a human-readable message (non-empty until the
        // terminal 'complete' emit, which intentionally clears it).
        expect(messages.some((m) => /scanning/i.test(m))).toBe(true);
        expect(messages.some((m) => /pars/i.test(m))).toBe(true);
        // #918 — the streamed build sub-phases surface, not just one "building".
        expect(messages.some((m) => /service|cluster|feature|diagram/i.test(m))).toBe(true);
    });
});
