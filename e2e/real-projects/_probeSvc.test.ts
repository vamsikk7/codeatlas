// TEMPORARY scratch probe — dump L1 service nodes + consumedUrls + external nodes. Delete after.
import { describe, it } from 'vitest';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

describe('probe services', () => {
    it('py-fastapi L1 service nodes + external', async () => {
        const repoPath = path.resolve(__dirname, '..', 'real-repos', 'py-fastapi');
        const r = await runScenario({ repoPath, edits: [] });
        const snap: any = r.baseline;
        const ms: any = Object.values(snap.graphs || {}).find((g: any) => g.type === 'microservice');
        console.log('\n=== microservice graph nodes ===');
        for (const n of (ms?.nodes || [])) {
            console.log(`[${n.type}] "${n.label}" ${n.subtitle || ''}  tech=${n.meta?.technology}`);
            if (n.meta?.consumedUrls?.length) console.log('   consumedUrls:', JSON.stringify(n.meta.consumedUrls));
            if (n.meta?.consumedServices?.length) console.log('   consumedServices:', JSON.stringify(n.meta.consumedServices));
        }
        console.log('\n=== edges ===');
        for (const e of (ms?.edges || [])) console.log(`   ${e.source} -> ${e.target} (${e.label || ''})`);
        r.dispose();
    }, 180_000);
});
