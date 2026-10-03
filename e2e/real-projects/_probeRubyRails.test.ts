// TEMPORARY scratch probe — exploratory bug hunt on ruby-rails. Delete after.
import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

const REAL_REPOS_DIR = path.resolve(__dirname, '..', 'real-repos');

describe('probe ruby-rails', () => {
    it('dump apiIndex + clusters + dupes', async () => {
        const repoPath = path.join(REAL_REPOS_DIR, 'ruby-rails');
        if (!fs.existsSync(repoPath)) { console.log('ruby-rails not cloned'); return; }
        const r = await runScenario({ repoPath, edits: [] });
        const snap: any = r.baseline;
        const apis: any[] = Object.values(snap.apiIndex || {});

        // 1) method breakdown
        const byMethod: Record<string, number> = {};
        for (const a of apis) byMethod[a.method] = (byMethod[a.method] || 0) + 1;
        console.log(`\n=== ruby-rails: ${apis.length} apiIndex records ===`);
        console.log('by method:', JSON.stringify(byMethod));

        // 2) duplicate detection (BUG-EXP-1 style): same method|route|filePath >1
        const seen = new Map<string, number>();
        for (const a of apis) {
            const k = `${a.method}|${a.route}|${a.filePath}`;
            seen.set(k, (seen.get(k) || 0) + 1);
        }
        const dupes = [...seen.entries()].filter(([, n]) => n > 1);
        console.log(`DUPLICATES (method|route|file appearing >1): ${dupes.length}`);
        for (const [k, n] of dupes.slice(0, 15)) console.log(`  ${n}×  ${k}`);

        // 2b) duplicate by apiId (should never happen — apiId is the map key, but check route+handler collisions)
        const byRouteHandler = new Map<string, number>();
        for (const a of apis) {
            const k = `${a.method} ${a.route} → ${a.handlerName}`;
            byRouteHandler.set(k, (byRouteHandler.get(k) || 0) + 1);
        }
        const rhDupes = [...byRouteHandler.entries()].filter(([, n]) => n > 1);
        console.log(`DUP route+handler pairs: ${rhDupes.length}`);
        for (const [k, n] of rhDupes.slice(0, 15)) console.log(`  ${n}×  ${k}`);

        // 3) synthetic entry-point categories (Rails-rich: FILTER, MODEL_HOOK, JOB, DB_MIGRATION, DB_SEED)
        const synthetic = ['FILTER', 'MODEL_HOOK', 'JOB', 'DB_MIGRATION', 'DB_SEED', 'SIGNAL', 'MQ_CONSUMER', 'CLI_COMMAND', 'HEALTH', 'CONTROLLER', 'RESOURCE'];
        console.log('synthetic present:', synthetic.filter(m => byMethod[m]).map(m => `${m}=${byMethod[m]}`).join(', ') || '(none)');

        // 4) feature clusters
        const clusters: any = snap.clusters || {};
        const ckeys = Object.keys(clusters);
        console.log(`\nfeature clusters: ${ckeys.length}`);
        for (const ck of ckeys.slice(0, 20)) {
            const c = clusters[ck];
            console.log(`  ${ck}: "${c.label || c.name}" files=${(c.files || c.members || []).length} apis=${c.apiCount ?? c.routeCount ?? '?'}`);
        }

        // 5) graph counts
        const gs: any[] = Object.values(snap.graphs || {});
        const byType: Record<string, number> = {};
        for (const g of gs) byType[g.type] = (byType[g.type] || 0) + 1;
        console.log('\ngraph counts by type:', JSON.stringify(byType));

        // 6) routes that anchored to a controller (railsResource / routeDeclFile) — the freshly-touched path
        const railsAnchored = apis.filter(a => a.meta?.railsResource || a.meta?.routeDeclFile);
        console.log(`\nrails route→controller anchored: ${railsAnchored.length}`);
        for (const a of railsAnchored.slice(0, 10)) console.log(`  ${a.method} ${a.route} → ${a.filePath} (decl:${a.meta?.routeDeclFile || '-'})`);

        // 7) routes still anchored to config/routes.rb (NOT re-anchored — potential bug)
        const stillInRoutesRb = apis.filter(a => /config\/routes\.rb$/.test(a.filePath || ''));
        console.log(`routes still anchored to config/routes.rb: ${stillInRoutesRb.length}`);
        for (const a of stillInRoutesRb.slice(0, 10)) console.log(`  ${a.method} ${a.route} → ${a.handlerName}`);

        // 8) DOMAIN clusters (business-intent) — does this recover articles/users/comments?
        const domains: any = snap.domainClusters || snap.domains || {};
        const dkeys = Object.keys(domains);
        console.log(`\ndomain clusters: ${dkeys.length}`);
        for (const dk of dkeys.slice(0, 20)) {
            const d = domains[dk];
            console.log(`  ${dk}: "${d.label || d.name}" files=${(d.files || d.members || []).length}`);
        }

        // 9) sequence-vs-apiIndex discrepancy (53 seq > 43 records?) — list seq graph ids not backed by an apiIndex route
        const seqGraphs: any[] = Object.values(snap.graphs || {}).filter((g: any) => g.type === 'sequence');
        console.log(`\nsequence graphs: ${seqGraphs.length} vs apiIndex records: ${apis.length}`);
        // group sequence graphs by handler file to see where the extras come from
        const seqByHandler = new Map<string, number>();
        for (const g of seqGraphs) {
            const h = (g.meta?.handlerName || g.meta?.apiMethod || g.id || '').toString();
            seqByHandler.set(h, (seqByHandler.get(h) || 0) + 1);
        }
        const seqDupes = [...seqByHandler.entries()].filter(([, n]) => n > 1);
        console.log(`sequence handler dupes: ${seqDupes.length}`);
        for (const [k, n] of seqDupes.slice(0, 10)) console.log(`  ${n}×  ${k}`);
        // sample a few sequence graph ids
        console.log('sample sequence ids:', seqGraphs.slice(0, 6).map((g: any) => g.id).join('  |  '));

        // 10) which cluster holds the HTTP routes (app?) — map api filePath → cluster
        const appApis = apis.filter(a => /GET|POST|PATCH|PUT|DELETE/.test(a.method));
        const appFiles = new Set(appApis.map(a => a.filePath));
        console.log(`\nHTTP routes span ${appFiles.size} files:`, [...appFiles].slice(0, 12).join(', '));

        r.dispose();
    }, 180_000);
});
