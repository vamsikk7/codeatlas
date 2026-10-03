// TEMPORARY — to be deleted. One-shot inspection of L4 node-label formats per language.
import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

const REAL_REPOS_DIR = path.resolve(__dirname, '..', 'real-repos');

describe('inspect labels', () => {
    for (const id of ['py-fastapi', 'java-spring', 'go-gin', 'rust-actix', 'kotlin-android', 'ruby-rails', 'php-laravel', 'swift-vapor', 'dart-flutter', 'csharp-aspnet']) {
        it(`${id}`, async () => {
            const repoPath = path.join(REAL_REPOS_DIR, id);
            if (!fs.existsSync(repoPath)) return;
            const r = await runScenario({ repoPath, edits: [] });
            const fileGraphs = Object.values(r.baseline.graphs || {}).filter((g: any) => g.type === 'file' && Array.isArray(g.nodes));
            // Count file graphs by whether they contain a function-type node.
            let withFunction = 0;
            let withoutFunction = 0;
            const sampleWithFn: Array<{ fp: string; functions: string[] }> = [];
            for (const g of fileGraphs) {
                const ga = g as any;
                const fns = ga.nodes.filter((n: any) => n.type === 'function').map((n: any) => n.label);
                if (fns.length > 0) {
                    withFunction++;
                    if (sampleWithFn.length < 3) sampleWithFn.push({ fp: ga.meta?.filePath, functions: fns.slice(0, 8) });
                } else {
                    withoutFunction++;
                }
            }
            console.log(`\n=== ${id} (${fileGraphs.length} file graphs, ${withFunction} w/ functions, ${withoutFunction} w/o) ===`);
            for (const s of sampleWithFn) {
                console.log(`  ${s.fp}: ${s.functions.join(', ')}`);
            }
            r.dispose();
        }, 120_000);
    }
});
