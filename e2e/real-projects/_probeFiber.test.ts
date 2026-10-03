// TICKET-DETECT-3 (go-fiber) scratch probe — dump Go route records with a
// dotted handlerName (pkg.Fn / recv.Method) + the function/method symbols per
// Go file, to see whether handler → defining-file resolution is unambiguous.
import { describe, it } from 'vitest';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

describe('probe fiber', () => {
    it('dump dotted-handler routes + go symbols', async () => {
        const repoPath = path.resolve(__dirname, '..', 'real-repos', 'go-fiber');
        const r = await runScenario({ repoPath, edits: [] });
        const snap = r.baseline as any;
        const apis: any[] = Object.values(snap.apiIndex || {});
        const routes = apis.filter(a => /^(GET|POST|PUT|DELETE|PATCH|HEAD)$/.test(a.method) && /(hexagonal|jwt)\//.test(a.filePath || ''));
        console.log(`HEXAGONAL_JWT_ROUTES=${routes.length}`);
        for (const a of routes.slice(0, 24)) {
            console.log(`  ${a.method} ${String(a.route).slice(0,26).padEnd(26)} handler=${String(a.handlerName).slice(0,30).padEnd(30)} filePath=${a.filePath}`);
        }
        // For a few handler names, show which Go files define a matching func/method symbol.
        const goFiles = Object.entries(snap.files || {}).filter(([f]) => f.endsWith('.go'));
        const sampleHandlers = [...new Set(routes.map(a => a.handlerName.split('.').pop()))].slice(0, 6);
        for (const h of sampleHandlers) {
            const defs: string[] = [];
            for (const [f, rec] of goFiles) {
                const fns = (rec as any).symbols?.functions ?? [];
                for (const fn of fns) {
                    const nm: string = fn.name ?? '';
                    if (nm === h || nm.endsWith('.' + h)) defs.push(`${f}:${nm}`);
                }
            }
            console.log(`  HANDLER "${h}" defined in: ${JSON.stringify(defs)}`);
        }
        r.dispose();
    }, 300_000);
});
