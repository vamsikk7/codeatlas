/**
 * perRepoServiceScope.bug.test.ts — #815 Phase 5 (2026-06-10)
 *
 * Pins that each per-repo SyncOrchestrator's `services` table contains ONLY
 * the sub-repo's own services. Before #815 Phase 5, `detectServices`
 * received `this.workspaceRoot` (the OUTER workspace) and its internal
 * `detectMultiRepoMode` re-detected every sibling sub-repo, producing N
 * services per per-repo init. Each per-repo state.db ended up with all N
 * services, which then leaked into the per-repo L1 / Map / picker / etc.
 *
 * After Phase 5, `detectServices(this.repoRoot, …)` scopes to the
 * sub-repo's tree → 1 service per per-repo init. Single-repo behaviour is
 * preserved because `repoRoot === workspaceRoot` in that mode.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SyncOrchestrator } from '../syncOrchestrator';
import { SnapshotStore } from '../../storage/snapshotStore';
import { CommentStore } from '../../storage/commentStore';

function rm(p: string): void {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* noop */ }
}

function writeService(rootAbs: string, name: string): void {
    const dir = path.join(rootAbs, name);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', dependencies: { express: '*' } }),
    );
    fs.writeFileSync(
        path.join(dir, 'src/server.js'),
        `const express = require('express');\nconst app = express();\napp.get('/${name}', (req, res) => res.send('${name}'));\napp.listen(3000);\n`,
    );
}

// #816 (2026-06-10) — un-skipped after the picker step-1 source was
// restructured to read from `aggregator.listRepos()` (extension.ts +
// standalone messageHandler.ts), so the per-repo `detectServices`
// scoping no longer regresses the UX. This test now ENFORCES the
// scoping at the SyncOrchestrator layer.
describe('#816 — per-repo SyncOrchestrator services are scoped to repoRoot', () => {
    let ws: string;

    beforeEach(() => {
        ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ph5-svc-scope-'));
        // Build a synthetic multi-repo workspace: 3 sibling Express services.
        // Sibling presence triggers `detectMultiRepoMode` → isMultiRepo=true.
        writeService(ws, 'alpha-svc');
        writeService(ws, 'beta-svc');
        writeService(ws, 'gamma-svc');
    });

    afterEach(() => {
        rm(ws);
    });

    it('each per-repo init populates ONLY its own service in the per-repo state.db', async () => {
        // Run a SyncOrchestrator per sub-repo, mimicking the production
        // dispatcher loop in `extension.ts:471` (productionRepoRunner) and
        // `mcp/workspaceBootstrap.ts:openMultiRepo`.
        const subRepos = ['alpha-svc', 'beta-svc', 'gamma-svc'];
        const summaries: Record<string, { fileCount: number; serviceCount: number; serviceNames: string[] }> = {};

        for (const name of subRepos) {
            const repoRoot = path.join(ws, name);
            const store = new SnapshotStore(repoRoot);
            await store.load();
            const orch = new SyncOrchestrator(
                ws,              // workspaceRoot — the outer multi-repo dir
                store,
                new CommentStore([]),
                undefined,
                undefined,
                repoRoot,        // ADR-034 Phase B — distinct repo scope
            );
            orch.setLogger(() => { /* noop */ });
            await orch.initialize();
            store.save();
            const working = store.getWorking();
            summaries[name] = {
                fileCount: Object.keys(working.files ?? {}).length,
                serviceCount: Object.keys(working.services ?? {}).length,
                serviceNames: Object.values(working.services ?? {}).map((s: any) => s.name).sort(),
            };
            store.close();
        }

        // Each sub-repo's state.db must hold ONLY its own service. The
        // exact name depends on detectServices' single-service fallback
        // (currently 'main' for unscoped Express apps); the important
        // invariant is that the COUNT is 1, NOT 3. Pre-#815-Phase-5 each
        // per-repo state.db had all 3 sibling services leaking in via
        // detectServices receiving the OUTER workspaceRoot.
        for (const name of subRepos) {
            const s = summaries[name];
            expect(s.serviceCount, `${name}: expected exactly 1 service (got ${s.serviceCount}, names=${JSON.stringify(s.serviceNames)})`).toBe(1);
            // Files scoped to the sub-repo's own tree (sanity check).
            expect(s.fileCount, `${name}: expected files scoped to sub-repo, got ${s.fileCount}`).toBeGreaterThan(0);
        }
    });

    it('regression: single-repo mode (repoRoot === workspaceRoot) still detects siblings as services', async () => {
        // When a SyncOrchestrator runs in single-repo mode against the
        // OUTER multi-repo workspace (no repoRoot scoping), it still picks
        // up all 3 sibling Express services. This pins the documented
        // single-repo behaviour — Phase 5's repoRoot scoping ONLY applies
        // when `repoRoot !== workspaceRoot`, never when they're the same.
        const store = new SnapshotStore(ws);
        await store.load();
        const orch = new SyncOrchestrator(
            ws,
            store,
            new CommentStore([]),
            undefined,
            undefined,
            // No repoRoot — single-repo mode, equals workspaceRoot inside
            // the orchestrator constructor.
        );
        orch.setLogger(() => { /* noop */ });
        await orch.initialize();
        store.save();
        const working = store.getWorking();
        const services = Object.values(working.services ?? {}).map((s: any) => s.name).sort();
        store.close();

        // Multi-repo detector recognises the 3 siblings — single-repo
        // SyncOrchestrator over an outer multi-repo workspace still sees
        // all 3 as siblings (this is the OLD behaviour; Phase 5 doesn't
        // change it).
        expect(services).toHaveLength(3);
        expect(services).toEqual(['alpha-svc', 'beta-svc', 'gamma-svc']);
    });
});
