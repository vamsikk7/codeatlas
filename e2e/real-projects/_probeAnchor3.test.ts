// TICKET-DETECT-3 scratch probe — dump the records still anchored to a
// route-declaration file (routes.rb / urls.py / hono app / fiber app) AFTER
// the Rails + Django anchor passes run, with handlerName, so I can classify
// real gaps (named handler defined in another file) vs correct (inline
// closure / gem route / include aggregator). Delete after.
import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

const REAL_REPOS_DIR = path.resolve(__dirname, '..', 'real-repos');
const REPOS = ['ruby-rails', 'ruby-rails-sidekiq', 'py-django', 'py-django-celery', 'ts-hono', 'go-fiber'];

const CONFIG_FILE = /(\/|^)(urls?\.py|routes?\.(rb|php|ts|js)|router\.(ts|js)|routing\.(ts|js)|config\/routes)/i;
const isTestPath = (fp: string) => /(^|\/)(tests?|__tests__|spec|specs|test)(\/|$)|\.(test|spec)\.|_test\./i.test(fp || '');

describe('probe anchor-3', () => {
    it('dump config-anchored records per repo', async () => {
        for (const repo of REPOS) {
            const repoPath = path.join(REAL_REPOS_DIR, repo);
            if (!fs.existsSync(repoPath)) { console.log(`\n### ${repo}: NOT CLONED`); continue; }
            try {
                const r = await runScenario({ repoPath, edits: [] });
                const apis: any[] = Object.values((r.baseline as any).apiIndex || {});
                const nonTest = apis.filter(a => !isTestPath(a.filePath));
                // For hono/fiber the "app file" isn't matched by CONFIG_FILE; instead
                // flag records whose handlerName is a real identifier but the anchored
                // file is a router/app-setup file (heuristic: file basename contains
                // route/router/app/main/server AND handler is a named fn).
                const cfgAnchored = nonTest.filter(a => CONFIG_FILE.test(a.filePath || ''));
                console.log(`\n### ${repo}: apiIndex=${apis.length} nonTest=${nonTest.length} cfgAnchored=${cfgAnchored.length}`);
                for (const a of cfgAnchored) {
                    const anchoredTo = a.anchor?.filePath || a.filePath;
                    console.log(`   ${a.method} ${String(a.route).slice(0, 44).padEnd(44)} handler=${String(a.handlerName).slice(0, 40).padEnd(40)} -> ${anchoredTo}`);
                }
                r.dispose();
            } catch (e: any) {
                console.log(`\n### ${repo}: ERR ${(e?.message || e).slice(0, 120)}`);
            }
        }
    }, 900_000);
});
