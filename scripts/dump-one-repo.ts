/**
 * dump-one-repo.ts <repoId>
 *
 * Runs the CodeAtlas pipeline against ONE repo and writes state.json to
 * e2e/real-repos/<id>/.codeatlas/state.json. Intended to be invoked by
 * dump-real-state.ts as a per-repo subprocess so one slow/hanging project
 * cannot block the entire batch.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SyncOrchestrator } from '../src/core/sync/syncOrchestrator';
import { SnapshotStore } from '../src/core/storage/snapshotStore';
import { CommentStore } from '../src/core/storage/commentStore';
import { setGrammarsDir, resetTreeSitterForTesting } from '../src/core/parser/treeSitterParser';

async function main() {
    const log = (m: string) => { process.stdout.write(`${m}\n`); };
    const repoId = process.argv[2];
    if (!repoId) {
        console.error('Usage: tsx scripts/dump-one-repo.ts <repoId>');
        process.exit(2);
    }
    log(`[${repoId}] start`);
    const repoRoot = path.resolve(__dirname, '..');
    const repoPath = path.join(repoRoot, 'e2e/real-repos', repoId);
    if (!fs.existsSync(repoPath)) {
        console.error(`[${repoId}] not cloned`);
        process.exit(3);
    }
    const codeatlasDir = path.join(repoPath, '.codeatlas');
    fs.mkdirSync(codeatlasDir, { recursive: true });
    const stateFile = path.join(codeatlasDir, 'state.json');
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
    log(`[${repoId}] paths ok, prepping tree-sitter`);

    resetTreeSitterForTesting();
    setGrammarsDir(path.join(repoRoot, 'grammars'));
    log(`[${repoId}] tree-sitter ready`);

    const t0 = Date.now();
    // SnapshotStore appends .codeatlas/state.json itself, so pass the repo root.
    const store = new SnapshotStore(repoPath);
    const commentStore = new CommentStore([]);
    const sync = new SyncOrchestrator(repoPath, store, commentStore);
    sync.setLogger((m: string) => log(`[${repoId}]   ${m}`));
    log(`[${repoId}] orchestrator built; calling initialize()`);
    const stats = await sync.initialize();
    log(`[${repoId}] initialize done; saving`);
    store.save();
    const ms = Date.now() - t0;
    const working = store.getWorking();
    const apis = Object.keys(working.apiIndex ?? {}).length;
    const graphs = Object.keys(working.graphs ?? {}).length;
    // Persist the raw initStats counts alongside state.json so downstream
    // reports can compare against expectations.json (which is keyed off the
    // pre-dedup `initStats.apiCount`, not `apiIndex.size`).
    fs.writeFileSync(
        path.join(codeatlasDir, 'dump-stats.json'),
        JSON.stringify({ initStats: stats, apiIndexSize: apis, graphCount: graphs }, null, 2),
    );
    log(`[${repoId}] files=${stats.fileCount} apis=${apis} (raw=${stats.apiCount}) graphs=${graphs} (${ms}ms)`);
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
