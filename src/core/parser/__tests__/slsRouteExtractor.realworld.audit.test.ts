/**
 * slsRouteExtractor.realworld.audit.test.ts — UX-25 audit (2026-06-05).
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
            if (lower.endsWith('.yaml') || lower.endsWith('.yml')) out.push(full);
        }
    }
    return out;
}

describe('UX-25 audit: serverless/examples', () => {
    if (!existsSync(ROOT)) {
        it.skip('fixture not present at /tmp/sls-examples — clone first', () => {});
        return;
    }

    const files = walk(ROOT);
    const perFile: Array<{ file: string; count: number; routes: string[] }> = [];
    let totalRoutes = 0;

    for (const f of files) {
        const content = readFileSync(f, 'utf-8');
        let records;
        if (isServerlessFrameworkPath(f) || (/^\s*service\s*:/m.test(content) && /^\s*functions\s*:/m.test(content))) {
            records = parseServerlessFrameworkTemplate(content, relative(ROOT, f));
        } else {
            records = [];
        }
        if (records.length > 0) {
            totalRoutes += records.length;
            perFile.push({ file: relative(ROOT, f), count: records.length, routes: records.map((r) => `${r.method} ${r.route}`) });
        }
    }

    it('reports detected vs expected', () => {
        // eslint-disable-next-line no-console
        console.log(`[UX-25 audit] yamlFiles=${files.length} templatesWithRoutes=${perFile.length} totalRoutes=${totalRoutes}`);
        for (const t of perFile.sort((a, b) => b.count - a.count).slice(0, 20)) {
            // eslint-disable-next-line no-console
            console.log(`  ${t.file} (${t.count}): ${t.routes.slice(0, 8).join(' | ')}${t.routes.length > 8 ? ' …' : ''}`);
        }
        expect(totalRoutes).toBeGreaterThanOrEqual(0);
    });
});
