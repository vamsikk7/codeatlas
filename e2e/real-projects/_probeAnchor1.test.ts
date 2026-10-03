// TICKET-ANCHOR-1 scratch probe — dump py-django RESOURCE (DRF ViewSet) records
// + their anchor, and confirm the ViewSet class file exists to anchor to.
import { describe, it } from 'vitest';
import * as path from 'path';
import { runScenario } from './cascadeHarness';
import { buildReviewContext } from '../../src/core/llm/reviewContext';

describe('probe anchor-1', () => {
    it('does a views.py change surface the DRF ViewSet entry pack?', async () => {
        const repoPath = path.resolve(__dirname, '..', 'real-repos', 'py-django');
        const r = await runScenario({ repoPath, edits: [] });
        const apis: any[] = Object.values((r.baseline as any).apiIndex || {});
        for (const a of apis) {
            if (a.method === 'RESOURCE' || /ViewSet/.test(a.handlerName || '')) {
                console.log(`REC method=${a.method} route=${a.route} handler=${a.handlerName} filePath=${a.filePath} anchor.filePath=${a.anchor?.filePath}`);
            }
        }
        // ANCHOR-1 deliverable: editing the ViewSet's views.py must surface its
        // entry pack (BUG-EXP-26 style) so a DRF handler change is reviewed.
        const ctx = buildReviewContext({ store: r.store, changedFiles: ['conduit/apps/articles/views.py'] });
        console.log('ENTRY_PACKS', ctx.entryPacks.length);
        for (const p of ctx.entryPacks) console.log(`   PACK ${(p as any).method} ${(p as any).route} handler=${(p as any).handlerName ?? (p as any).handler}`);
        r.dispose();
    }, 300_000);
});
