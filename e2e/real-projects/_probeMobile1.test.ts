// MOBILE-1 data probe — dump kotlin-android SCREEN/NAV_ROUTE records + scan
// NavHost `composable(...) { X( }` destination targets to design the classifier.
import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

const ROOT = path.resolve(__dirname, '..', 'real-repos', 'kotlin-android');

function walk(dir: string, out: string[]) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'build') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.kt')) out.push(p);
    }
}

describe('probe mobile-1', () => {
    it('dump screen/nav data + navhost targets', async () => {
        const r = await runScenario({ repoPath: ROOT, edits: [] });
        const snap = r.baseline as any;
        const apis: any[] = Object.values(snap.apiIndex || {});
        const screens = apis.filter(a => a.method === 'SCREEN');
        const navRoutes = apis.filter(a => a.method === 'NAV_ROUTE');
        console.log(`SCREEN_TOTAL=${screens.length} NAV_ROUTE_TOTAL=${navRoutes.length} snapshot.screens=${Object.keys(snap.screens || {}).length}`);
        // Distribution of screen names by suffix convention
        const endsScreen = screens.filter(s => /Screen$/.test(s.handlerName)).length;
        const endsScope = screens.filter(s => /Scope$/.test(s.handlerName)).length;
        const isPrivate = screens.filter(s => s.handlerName === 'private' || s.handlerName === 'internal' || s.handlerName === 'fun').length;
        console.log(`  SCREEN endsWith Screen=${endsScreen} endsWith Scope=${endsScope} keyword-garbage=${isPrivate}`);
        console.log('  sample SCREEN names:', JSON.stringify(screens.slice(0, 40).map(s => s.handlerName)));

        // Scan the source for NavHost destination targets: composable(...) { X( }
        const files: string[] = []; walk(ROOT, files);
        const navTargets = new Set<string>();
        const composableRe = /composable\s*(?:<[^>]*>)?\s*\([^)]*\)\s*\{([^}]*)\}/g;
        for (const f of files) {
            const src = fs.readFileSync(f, 'utf8');
            let m;
            while ((m = composableRe.exec(src)) !== null) {
                const body = m[1];
                // capture PascalCase composable calls in the lambda body
                const callRe = /\b([A-Z]\w+)\s*\(/g;
                let c;
                while ((c = callRe.exec(body)) !== null) navTargets.add(c[1]);
            }
        }
        console.log(`  NAVHOST_TARGETS (${navTargets.size}):`, JSON.stringify([...navTargets].slice(0, 40)));
        // How many SCREEN records would survive: name in navTargets OR endsWith Screen
        const survive = screens.filter(s => navTargets.has(s.handlerName) || /Screen$/.test(s.handlerName));
        console.log(`  SCREEN survivors (navTarget OR *Screen) = ${survive.length} / ${screens.length}`);
        console.log('  survivors sample:', JSON.stringify(survive.slice(0, 40).map(s => s.handlerName)));
        r.dispose();
    }, 300_000);
});
