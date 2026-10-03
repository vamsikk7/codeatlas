// TEMPORARY scratch probe — BUG-EXP-18: which kotlin-ktor files emit SCREEN/LIFECYCLE/DI_BINDING. Delete after.
import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

describe('probe ktor mobile bleed', () => {
    it('dumps SCREEN/LIFECYCLE/DI_BINDING record sources', async () => {
        const repoPath = path.resolve(__dirname, '..', 'real-repos', 'kotlin-ktor');
        const r = await runScenario({ repoPath, edits: [] });
        const apis: any[] = Object.values((r.baseline as any).apiIndex || {});
        const mobile = apis.filter(a => ['SCREEN', 'LIFECYCLE', 'DI_BINDING'].includes(a.method));
        console.log(`MOBILE-BLEED RECORDS: ${mobile.length}`);
        for (const a of mobile) {
            const fp = a.filePath;
            let importLine = '(no android/okhttp import found)';
            try {
                const full = path.join(repoPath, fp);
                if (fs.existsSync(full)) {
                    const src = fs.readFileSync(full, 'utf8');
                    const im = src.match(/import\s+(?:android\.|androidx\.|com\.google\.dagger|dagger\.hilt|retrofit2|okhttp3)[^\n]*/);
                    importLine = im ? im[0].trim() : importLine;
                }
            } catch { /* ignore */ }
            console.log(`  ${a.method.padEnd(11)} ${String(a.route).slice(0, 26).padEnd(26)} ${fp}`);
            console.log(`      gate← ${importLine}`);
        }
        r.dispose();
    }, 300_000);
});
