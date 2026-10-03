// TEMPORARY scratch probe — BUG-EXP-16 evidence: JAX-RS path-param routes are verb-typed (merged), not PATH. Delete after.
import { describe, it } from 'vitest';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

describe('probe jaxrs @Path merge', () => {
    it('path-param routes carry the HTTP verb, not PATH', async () => {
        const repoPath = path.resolve(__dirname, '..', 'real-repos', 'java-jaxrs');
        const r = await runScenario({ repoPath, edits: [] });
        const apis: any[] = Object.values((r.baseline as any).apiIndex || {});
        const byMethod: Record<string, number> = {};
        for (const a of apis) byMethod[a.method] = (byMethod[a.method] || 0) + 1;
        console.log('METHOD MIX:', JSON.stringify(byMethod));
        // Records whose route has a path param — these are the merge cases.
        const pathParam = apis.filter(a => /\{[^}]+\}/.test(String(a.route)));
        console.log(`PATH-PARAM ROUTES: ${pathParam.length} (of ${apis.length})`);
        const stillPath = pathParam.filter(a => a.method === 'PATH');
        console.log(`  still labeled PATH: ${stillPath.length}`);
        for (const a of pathParam.slice(0, 12)) {
            console.log(`  ${a.method.padEnd(7)} ${String(a.route).slice(0, 34).padEnd(34)} ${String(a.filePath).split('/').slice(-2).join('/')}`);
        }
        // The remaining PATH records — confirm they are sub-resource locators (no verb sibling).
        const paths = apis.filter(a => a.method === 'PATH');
        console.log(`REMAINING PATH (sub-resource locators): ${paths.length}`);
        for (const a of paths.slice(0, 6)) {
            console.log(`  PATH ${String(a.route).slice(0, 34).padEnd(34)} ${String(a.filePath).split('/').slice(-2).join('/')} [${a.handlerName}]`);
        }
        r.dispose();
    }, 300_000);
});
