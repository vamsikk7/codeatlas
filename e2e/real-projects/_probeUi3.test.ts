// TICKET-UI-3 scratch probe — dump the L3 message-edge anchors for
// findComments and check whether the callee flow graph exists in the store.
import { describe, it } from 'vitest';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

describe('probe ui-3', () => {
    it('dump findComments sequence edges + flow graph presence', async () => {
        const repoPath = path.resolve(__dirname, '..', 'real-repos', 'ts-nestjs');
        const r = await runScenario({ repoPath, edits: [] });
        const graphs = (r.baseline as any).graphs as Record<string, any>;
        const seqIds = Object.keys(graphs).filter(g => g.startsWith('sequence:') && /findComments/i.test(g));
        console.log('SEQ_IDS', JSON.stringify(seqIds));
        for (const sid of seqIds) {
            const g = graphs[sid];
            for (const e of (g.edges ?? [])) {
                if (e.edgeType === 'message' || e.diff === 'deleted') {
                    console.log(`  EDGE id=${e.id} label=${e.label} anchor=${JSON.stringify(e.anchor)} tgtP=${JSON.stringify(e.targetParticipant?.anchor)}`);
                    console.log(`     graph.anchors[${e.id}]=${JSON.stringify(g.anchors?.[e.id])}`);
                }
            }
            console.log('  ALL_ANCHOR_KEYS', JSON.stringify(Object.keys(g.anchors ?? {})));
            for (const n of (g.nodes ?? [])) {
                if (n.type === 'participant') console.log(`  PART id=${n.id} label=${n.label} anchor=${JSON.stringify(n.anchor)} subtitle=${n.subtitle}`);
            }
        }
        const flowIds = Object.keys(graphs).filter(g => g.startsWith('flow:') && /article\.service/i.test(g));
        console.log('SERVICE_FLOW_IDS', JSON.stringify(flowIds));
        const allFlow = Object.keys(graphs).filter(g => g.startsWith('flow:')).length;
        console.log('TOTAL_FLOW_GRAPHS', allFlow);
        r.dispose();
    }, 300_000);
});
