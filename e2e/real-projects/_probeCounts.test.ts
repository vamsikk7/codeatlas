// TEMPORARY scratch probe — accurate L2a coverage: sum apisInCluster across ALL feature graphs. Delete after.
import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

const REAL_REPOS_DIR = path.resolve(__dirname, '..', 'real-repos');
const SUSPECTS = ['go-echo', 'go-fiber', 'go-chi', 'rust-actix', 'rust-axum', 'rust-rocket', 'kotlin-ktor', 'java-micronaut', 'java-jaxrs', 'java-spring-kafka', 'ts-apollo', 'ts-hono', 'js-serverless-examples', 'ruby-sinatra', 'ruby-rails-sidekiq', 'py-django-celery', 'py-starlette',
    // healthy controls
    'go-gin', 'java-spring', 'ruby-rails', 'py-fastapi'];
const ALL = (process.env.PROBE_ALL ? fs.readdirSync(REAL_REPOS_DIR).filter(d => { try { return fs.statSync(path.join(REAL_REPOS_DIR, d)).isDirectory() && d !== '.codeatlas'; } catch { return false; } }) : SUSPECTS);
const HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY', 'ROUTE', 'RESOURCE', 'CONTROLLER'];

function apisOf(node: any): any[] {
    const a = node?.meta?.apisInCluster ?? node?.data?.apisInCluster ?? [];
    return Array.isArray(a) ? a : [];
}

describe('probe all repos L2a coverage (all feature graphs)', () => {
    it('table', async () => {
        const rows: any[] = [];
        for (const repo of ALL) {
            const repoPath = path.join(REAL_REPOS_DIR, repo);
            try {
                const r = await runScenario({ repoPath, edits: [] });
                const snap: any = r.baseline;
                const apis: any[] = Object.values(snap.apiIndex || {});
                const apiN = apis.length;
                const httpN = apis.filter(a => HTTP.includes(a.method)).length;
                const graphs: any[] = Object.values(snap.graphs || {});
                const featGraphs = graphs.filter(g => g.type === 'feature');
                const domainGraphs = graphs.filter(g => g.type === 'domain');
                // sum apisInCluster across ALL feature graphs, dedupe by apiId
                const seen = new Set<string>();
                for (const g of featGraphs) for (const n of (g.nodes || [])) for (const a of apisOf(n)) seen.add(a.apiId || `${a.method}|${a.route}|${a.filePath}`);
                const inClusterUniq = seen.size;
                // also domain graphs coverage
                const seenD = new Set<string>();
                for (const g of domainGraphs) for (const n of (g.nodes || [])) for (const a of apisOf(n)) seenD.add(a.apiId || `${a.method}|${a.route}|${a.filePath}`);
                const svc = new Set(apis.map(a => a.serviceId || a.meta?.serviceId).filter(Boolean)).size;
                rows.push({ repo, apiN, httpN, featG: featGraphs.length, inClusterUniq, domainCov: seenD.size, svc });
                r.dispose();
            } catch (e: any) {
                rows.push({ repo, err: (e?.message || String(e)).slice(0, 50) });
            }
        }
        console.log('\nrepo / apiIndex / http / featureGraphs / inCluster(all,uniq) / domainCov / lost');
        for (const r of rows.sort((a, b) => ((b.apiN - b.inClusterUniq) || 0) - ((a.apiN - a.inClusterUniq) || 0))) {
            if (r.err) { console.log(`${r.repo.padEnd(22)} ERR ${r.err}`); continue; }
            const lost = r.apiN - r.inClusterUniq;
            const flag = (lost > r.apiN * 0.5 && r.apiN > 8) ? '  <<< L2a MISSING' : (lost > 0 && r.apiN > 8 ? '  < partial' : '');
            console.log(`${r.repo.padEnd(22)} api=${String(r.apiN).padStart(4)} http=${String(r.httpN).padStart(4)} fg=${String(r.featG).padStart(2)} inClu=${String(r.inClusterUniq).padStart(4)} dom=${String(r.domainCov).padStart(4)} lost=${String(lost).padStart(4)}${flag}`);
        }
    }, 900_000);
});
