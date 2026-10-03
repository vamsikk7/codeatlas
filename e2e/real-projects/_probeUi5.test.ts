// TICKET-UI-5 scratch probe — for py-django CBVs, dump the L3 sequence edge
// anchors + what flow graphs exist (keyed by class or method?).
import { describe, it } from 'vitest';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

describe('probe ui-5', () => {
    it('dump CBV sequence anchors + flow graph keys', async () => {
        const repoPath = path.resolve(__dirname, '..', 'real-repos', 'py-django');
        const r = await runScenario({ repoPath, edits: [] });
        const graphs = (r.baseline as any).graphs as Record<string, any>;
        // Flow graphs for articles/views.py
        const flowIds = Object.keys(graphs).filter(g => g.startsWith('flow:') && /articles\/views\.py/.test(g));
        console.log('ARTICLES_FLOW_IDS', JSON.stringify(flowIds));
        // Sequence for ArticlesFeedAPIView + its message anchors
        const seqIds = Object.keys(graphs).filter(g => g.startsWith('sequence:') && /ArticlesFeedAPIView|ArticleViewSet/.test(g));
        console.log('SEQ_IDS', JSON.stringify(seqIds));
        for (const sid of seqIds) {
            const g = graphs[sid];
            const anchorKeys = Object.keys(g.anchors ?? {});
            for (const k of anchorKeys) console.log(`  ${sid.slice(0,60)} anchor[${k}]=${JSON.stringify(g.anchors[k])}`);
        }
        r.dispose();
    }, 300_000);
});
