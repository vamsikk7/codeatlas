/**
 * samRouteExtractor.realworld.audit.test.ts — UX-24 audit (2026-06-05).
 *
 * Runs the extractor against the actual sessions-with-aws-sam repo
 * (cloned at /tmp/sessions-with-aws-sam). Reports detected route count
 * + which templates contributed. Skipped when the fixture isn't
 * present locally — this is an audit harness, not a unit test that
 * blocks CI.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { parseSamTemplate, isSamTemplatePath } from '../samRouteExtractor';

const ROOT = '/tmp/sessions-with-aws-sam';

function walk(dir: string, out: string[] = []): string[] {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return out; }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git' || e.name === '.aws-sam' || e.name === 'dist') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.isFile()) {
            const lower = e.name.toLowerCase();
            if (lower.endsWith('.yaml') || lower.endsWith('.yml')) out.push(full);
        }
    }
    return out;
}

describe('UX-24 audit: sessions-with-aws-sam', () => {
    if (!existsSync(ROOT)) {
        it.skip('fixture not present at /tmp/sessions-with-aws-sam — clone first', () => {});
        return;
    }

    const files = walk(ROOT);
    const perFile: Array<{ file: string; count: number; routes: string[] }> = [];
    let totalRoutes = 0;

    for (const f of files) {
        const content = readFileSync(f, 'utf-8');
        let records;
        if (isSamTemplatePath(f) || /AWS::Serverless|Transform:\s*AWS::Serverless/.test(content)) {
            records = parseSamTemplate(content, relative(ROOT, f));
        } else {
            records = [];
        }
        if (records.length > 0) {
            totalRoutes += records.length;
            perFile.push({ file: relative(ROOT, f), count: records.length, routes: records.map((r) => `${r.method} ${r.route}`) });
        }
    }

    it('reports detected vs expected route count + per-template breakdown', () => {
        // eslint-disable-next-line no-console
        console.log(`[UX-24 audit] yamlFiles=${files.length} templatesWithRoutes=${perFile.length} totalRoutes=${totalRoutes}`);
        for (const t of perFile.sort((a, b) => b.count - a.count)) {
            // eslint-disable-next-line no-console
            console.log(`  ${t.file} (${t.count}): ${t.routes.join(' | ')}`);
        }
        // The ground-truth in the ticket was ~38 routes. We just want to
        // see the actual current detected count so we know what gap exists.
        expect(totalRoutes).toBeGreaterThanOrEqual(0);
    });
});
