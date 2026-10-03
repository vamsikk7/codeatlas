/**
 * cdkExtractor.realworld.audit.test.ts — UX-26 audit (2026-06-05).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { parseCdkConstructs, isCdkLikely } from '../cdkConstructExtractor';

const ROOT = '/tmp/codeatlas-aws-eval/serverless-patterns';

function walk(dir: string, out: string[] = []): string[] {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return out; }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === 'cdk.out' || e.name === 'dist') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.isFile()) {
            const lower = e.name.toLowerCase();
            if (lower.endsWith('.ts') || lower.endsWith('.py') || lower.endsWith('.js')) out.push(full);
        }
    }
    return out;
}

describe('UX-26 audit: serverless-patterns CDK files', () => {
    if (!existsSync(ROOT)) {
        it.skip('fixture not present at /tmp/codeatlas-aws-eval/serverless-patterns — clone first', () => {});
        return;
    }
    const files = walk(ROOT);
    let cdkFilesScanned = 0;
    let totalRoutes = 0;
    const perFile: Array<{ file: string; count: number; sample: string[] }> = [];

    for (const f of files) {
        const content = readFileSync(f, 'utf-8');
        if (!isCdkLikely(content)) continue;
        cdkFilesScanned++;
        const records = parseCdkConstructs(content, relative(ROOT, f));
        if (records.length > 0) {
            totalRoutes += records.length;
            perFile.push({
                file: relative(ROOT, f),
                count: records.length,
                sample: records.slice(0, 4).map((r) => `${r.method} ${r.route}`),
            });
        }
    }

    it('reports detected route count + per-file breakdown', () => {
        // eslint-disable-next-line no-console
        console.log(`[UX-26 audit] candidateFiles=${files.length} cdkFiles=${cdkFilesScanned} totalRoutes=${totalRoutes} filesContributingRoutes=${perFile.length}`);
        for (const t of perFile.sort((a, b) => b.count - a.count).slice(0, 15)) {
            // eslint-disable-next-line no-console
            console.log(`  ${t.file} (${t.count}): ${t.sample.join(' | ')}${t.count > t.sample.length ? ' …' : ''}`);
        }
        expect(totalRoutes).toBeGreaterThanOrEqual(0);
    });
});
