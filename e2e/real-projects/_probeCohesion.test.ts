// TEMPORARY scratch probe — feature-cluster cohesion + domain availability. Delete after.
import { describe, it } from 'vitest';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

describe('probe cohesion', () => {
    for (const repo of ['ruby-rails', 'py-django', 'ts-express-realworld', 'java-spring', 'csharp-aspnet']) {
        it(repo, async () => {
            const repoPath = path.resolve(__dirname, '..', 'real-repos', repo);
            const r = await runScenario({ repoPath, edits: [] });
            const snap: any = r.baseline;
            const feats: any[] = Object.values(snap.graphs || {}).filter((g: any) => g.type === 'feature');
            const domains: any[] = Object.values(snap.graphs || {}).filter((g: any) => g.type === 'domain');
            const domNodes = domains.flatMap(g => g.nodes || []).filter((n: any) => n.type === 'cluster');
            const meaningfulDomains = domNodes.filter((n: any) => !/^(other|misc|uncategor)/i.test(String(n.label))).length;
            const clusters = feats.flatMap(g => (g.nodes || []).filter((n: any) => (n.meta?.apisInCluster?.length ?? 0) > 0));
            const cohesions = clusters.map((n: any) => n.meta?.cohesion ?? 0);
            const zero = cohesions.filter((c: number) => c === 0).length;
            console.log(`\n### ${repo}: withApiClusters=${clusters.length} cohesion=[${cohesions.join(',')}] zeroCohesion=${zero}/${clusters.length} meaningfulDomains=${meaningfulDomains}`);
            console.log('  cluster labels:', clusters.map((n: any) => n.label).join(', '));
            r.dispose();
        }, 180_000);
    }
});
