/**
 * mcpRealRepo.test.ts
 *
 * Issue 310: MCP impact/dependency tools exercised against a real-world
 * repo Snapshot rather than synthetic fixtures. Drives `analyzeImpact`
 * through the actual orchestrator output.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { setGrammarsDir, resetTreeSitterForTesting } from '../../core/parser/treeSitterParser';
import { SyncOrchestrator } from '../../core/sync/syncOrchestrator';
import { SnapshotStore } from '../../core/storage/snapshotStore';
import { CommentStore } from '../../core/storage/commentStore';
import { analyzeImpact } from '../../core/analysis/impactAnalyzer';

beforeAll(() => {
    resetTreeSitterForTesting();
    setGrammarsDir(path.join(process.cwd(), 'grammars'));
});

describe('MCP impact analysis (Issue 310)', () => {
    it('analyzeImpact runs against a real-world Snapshot and returns the changed file', async () => {
        const realRepo = path.join(process.cwd(), 'e2e/real-repos/ts-express-realworld');
        if (!fs.existsSync(realRepo)) {
            // Skip when the user hasn't fetched real repos yet.
            return;
        }
        const cd = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-real-'));
        const store = new SnapshotStore(cd);
        const sync = new SyncOrchestrator(realRepo, store, new CommentStore([]));
        await sync.initialize();

        const snapshot = store.getWorking();
        // Pick any TypeScript file in the snapshot to use as the "changed" entry.
        const tsFile = Object.keys(snapshot.files).find(f => f.endsWith('.ts'));
        expect(tsFile, 'expected at least one .ts file in the cloned repo').toBeDefined();

        const result = analyzeImpact([tsFile!], snapshot, { maxDepth: 2 });
        expect(result).toBeDefined();
        // Issue 310: drive every documented field of ImpactResult so a schema
        // regression breaks here.
        expect(result.changedFiles).toContain(tsFile);
        expect(Array.isArray(result.changedFunctionKeys)).toBe(true);
        expect(Array.isArray(result.impactedFunctions)).toBe(true);
        expect(Array.isArray(result.affectedClusterIds)).toBe(true);
        expect(Array.isArray(result.affectedServiceIds)).toBe(true);
        expect(Array.isArray(result.affectedSequenceGraphIds)).toBe(true);
        expect(Array.isArray(result.affectedFileGraphIds)).toBe(true);
        expect(Array.isArray(result.affectedFlowGraphIds)).toBe(true);
        expect(typeof result.summary.directImpacts).toBe('number');
        expect(typeof result.summary.transitiveImpacts).toBe('number');
        expect(typeof result.summary.reviewRequired).toBe('number');
        expect(result.options.maxDepth).toBe(2);

        fs.rmSync(cd, { recursive: true, force: true });
    }, 120_000);
});
