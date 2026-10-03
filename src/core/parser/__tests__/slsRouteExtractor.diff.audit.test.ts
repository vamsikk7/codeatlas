/**
 * slsRouteExtractor.diff.audit.test.ts — UX-25 (2026-06-05).
 * Finds templates where grep-based ground truth has `- http:|httpApi:|websocket:`
 * but the extractor finds 0 routes. Those are the gaps.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { parseServerlessFrameworkTemplate, isServerlessFrameworkPath } from '../serverlessFrameworkRouteExtractor';

const ROOT = '/tmp/sls-examples';

function walk(dir: string, out: string[] = []): string[] {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return out; }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '.serverless' || e.name === 'dist') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.isFile()) {
            const lower = e.name.toLowerCase();
            if (lower === 'serverless.yml' || lower === 'serverless.yaml') out.push(full);
        }
    }
    return out;
}

const HTTP_LINE = /^\s*-\s*(http|httpApi|websocket)\s*:/m;

describe('UX-25 gap audit: serverless/examples', () => {
    if (!existsSync(ROOT)) {
        it.skip('fixture not present', () => {});
        return;
    }
    const files = walk(ROOT);
    const gaps: string[] = [];
    let totalGrepRoutes = 0;
    let totalExtractorRoutes = 0;

    for (const f of files) {
        const content = readFileSync(f, 'utf-8');
        // Count grep-style ground-truth.
        const grepCount = (content.match(/^\s*-\s*(http|httpApi|websocket)\s*:/gm) ?? []).length;
        if (grepCount === 0) continue;
        totalGrepRoutes += grepCount;

        const records = isServerlessFrameworkPath(f) || (/^\s*service\s*:/m.test(content) && /^\s*functions\s*:/m.test(content))
            ? parseServerlessFrameworkTemplate(content, relative(ROOT, f))
            : [];
        totalExtractorRoutes += records.length;

        if (records.length < grepCount) {
            gaps.push(`${relative(ROOT, f)} — grep=${grepCount}, extractor=${records.length}, sample=${records.slice(0, 3).map(r => `${r.method} ${r.route}`).join(', ')}`);
        }
    }

    it('reports per-template gaps', () => {
        // eslint-disable-next-line no-console
        console.log(`[UX-25 gap audit] templates=${files.length} grep=${totalGrepRoutes} extracted=${totalExtractorRoutes} gap=${totalGrepRoutes - totalExtractorRoutes}`);
        // eslint-disable-next-line no-console
        console.log(`templates with shortfall (${gaps.length}):`);
        for (const g of gaps) console.log(`  ${g}`);
        expect(gaps.length).toBeGreaterThanOrEqual(0);
    });
});
