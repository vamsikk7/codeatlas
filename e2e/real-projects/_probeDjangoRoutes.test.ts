// TEMPORARY scratch probe — BUG-EXP-19 evidence: py-django article routes keep their backslashes. Delete after.
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

describe('probe django route backslashes', () => {
    it('article routes keep \\w / \\d', async () => {
        const repoPath = path.resolve(__dirname, '..', 'real-repos', 'py-django');
        const r = await runScenario({ repoPath, edits: [] });
        const apis: any[] = Object.values((r.baseline as any).apiIndex || {});
        const articleRoutes = apis.map(a => String(a.route)).filter(rt => rt.includes('article') || rt.includes('comment'));
        console.log('ARTICLE/COMMENT ROUTES:');
        for (const rt of [...new Set(articleRoutes)]) console.log(`  ${rt}`);
        const anyBackslash = articleRoutes.some(rt => rt.includes('\\w') || rt.includes('\\d'));
        const anyCorrupted = articleRoutes.some(rt => rt.includes('[-w]+') || rt.includes('[d]+'));
        console.log(`  hasBackslashClasses=${anyBackslash}  hasCorrupted=${anyCorrupted}`);
        r.dispose();
        expect(anyBackslash).toBe(true);
        expect(anyCorrupted).toBe(false);
    }, 300_000);
});
