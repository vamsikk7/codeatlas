// TEMPORARY scratch probe — detection quality (method mix + anchor-to-config-file smell) for untested repos. Delete after.
import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

const REAL_REPOS_DIR = path.resolve(__dirname, '..', 'real-repos');
const REPOS = (process.env.PROBE_ONE
    ? [process.env.PROBE_ONE]
    : fs.readdirSync(REAL_REPOS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort());

// "config/router" files that a route should generally NOT anchor to (the handler lives elsewhere)
const CONFIG_FILE = /(\/|^)(urls?\.py|routes?\.(rb|php|ts|js)|router\.(ts|js)|routing\.(ts|js)|app\.(module\.ts|ts)|schema\.(graphql|ts)|config\/routes)/i;
const isTestPath = (fp: string) => /(^|\/)(tests?|__tests__|spec|specs|test)(\/|$)|\.(test|spec)\.|_test\./i.test(fp || '');

describe('probe detection quality', () => {
    it('per-repo method mix + config-anchor smell', async () => {
        for (const repo of REPOS) {
            const repoPath = path.join(REAL_REPOS_DIR, repo);
            if (!fs.existsSync(repoPath)) { console.log(`\n### ${repo}: NOT CLONED`); continue; }
            try {
                const r = await runScenario({ repoPath, edits: [] });
                const apis: any[] = Object.values((r.baseline as any).apiIndex || {});
                const byMethod: Record<string, number> = {};
                for (const a of apis) byMethod[a.method] = (byMethod[a.method] || 0) + 1;
                const nonTest = apis.filter(a => !isTestPath(a.filePath));
                const cfgAnchored = nonTest.filter(a => CONFIG_FILE.test(a.filePath || ''));
                const testN = apis.length - nonTest.length;
                console.log(`\n### ${repo}: apiIndex=${apis.length} (test=${testN})`);
                console.log('  methods:', JSON.stringify(byMethod));
                console.log(`  routes anchored to a config/router file: ${cfgAnchored.length}/${nonTest.length}`);
                // sample up to 4 config-anchored (the BUG-EXP-11 smell)
                const seen = new Set<string>();
                for (const a of cfgAnchored) {
                    const k = a.filePath; if (seen.has(k)) continue; seen.add(k);
                    console.log(`    ${a.method} ${String(a.route).slice(0, 40)} -> ${a.filePath}  [handler=${a.handlerName}]`);
                    if (seen.size >= 4) break;
                }
                r.dispose();
            } catch (e: any) {
                console.log(`\n### ${repo}: ERR ${(e?.message || e).slice(0, 80)}`);
            }
        }
    }, 900_000);
});
