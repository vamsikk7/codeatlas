// TEMPORARY — diagnose ts-nuxt cascade-zero-diff failure.
import { describe, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { runScenario, applyEditOp } from './cascadeHarness';

const REPO = path.resolve(__dirname, '..', 'real-repos', 'ts-nuxt');

describe('diagnose ts-nuxt', () => {
    it('dump cascade state after edit', async () => {
        if (!fs.existsSync(REPO)) return;

        // Replicate the perRepoCascadeProbe pickEditTarget logic EXACTLY.
        const boot = await runScenario({ repoPath: REPO, edits: [] });
        const fileGraphs: any[] = Object.values(boot.baseline.graphs || {})
            .filter((g: any) => g.type === 'file' && Array.isArray(g.nodes));

        const candidates: Array<{ filePath: string; fnName: string; nodeCount: number; rawLabel: string }> = [];
        for (const fg of fileGraphs) {
            const filePath = fg.meta?.filePath as string | undefined;
            if (!filePath) continue;
            const absPath = path.join(boot.repoCopyDir, filePath);
            if (!fs.existsSync(absPath)) continue;
            if (!/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py|java|kt|go|rb|rs|cs|swift|dart|php)$/.test(filePath)) continue;
            for (const node of fg.nodes) {
                if (node.type !== 'function') continue;
                const labelRaw = (node.label ?? '').replace(/\(.*$/, '').trim();
                if (!labelRaw) continue;
                const fnName = labelRaw.includes('.') ? labelRaw.split('.').pop()! : labelRaw;
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fnName)) continue;
                if (fnName.length < 3) continue;
                if (['main', 'constructor', 'toString', 'equals', 'hashCode', 'init', 'render',
                     'render!', 'build', 'create', 'show', 'get', 'set', 'index', 'name', 'id',
                     'update', 'delete', 'save', 'find', 'load'].includes(fnName)) continue;
                candidates.push({ filePath, fnName, nodeCount: fg.nodes.length, rawLabel: node.label });
            }
        }
        candidates.sort((a, b) => b.nodeCount - a.nodeCount);
        let pick: { filePath: string; fnName: string; rawLabel: string } | null = null;
        for (let i = 0; i < Math.min(30, candidates.length); i++) {
            const c = candidates[i];
            const src = fs.readFileSync(path.join(boot.repoCopyDir, c.filePath), 'utf-8');
            if (new RegExp(`\\b${c.fnName}\\s*\\(`).test(src)) {
                pick = c;
                break;
            }
        }
        boot.dispose();
        if (!pick) { console.log('no pick'); return; }

        console.log('PICKED:', pick);
        // Read the function body
        const fullSrc = fs.readFileSync(path.join(REPO, pick.filePath), 'utf-8');
        const idx = fullSrc.search(new RegExp(`\\b${pick.fnName}\\s*\\(`));
        console.log('source around picked function:');
        console.log(fullSrc.slice(Math.max(0, idx - 100), Math.min(fullSrc.length, idx + 400)));

        // Now apply the edit and inspect the L4 file graph
        const r = await runScenario({
            repoPath: REPO,
            edits: [{
                filePath: pick.filePath,
                op: { op: 'addLinesToFunction', fnName: pick.fnName, lines: [`// probe-injected at ${Date.now()}`] },
            }],
        });

        const fgBaseline = r.baseline.graphs?.[`file:${pick.filePath}`] as any;
        const fgWorking = r.working.graphs?.[`file:${pick.filePath}`] as any;
        console.log('\n--- BASELINE file graph ---');
        console.log(`  node count: ${fgBaseline?.nodes?.length}`);
        for (const n of (fgBaseline?.nodes ?? []).slice(0, 20)) {
            console.log(`  type=${n.type} label=${JSON.stringify(n.label)} diff=${n.diff}`);
        }
        console.log('\n--- WORKING file graph ---');
        console.log(`  node count: ${fgWorking?.nodes?.length}`);
        for (const n of (fgWorking?.nodes ?? []).slice(0, 20)) {
            console.log(`  type=${n.type} label=${JSON.stringify(n.label)} diff=${n.diff}`);
        }
        const baselineHash = JSON.stringify(fgBaseline ?? {}).length;
        const workingHash = JSON.stringify(fgWorking ?? {}).length;
        console.log(`\nbaseline json bytes=${baselineHash}, working=${workingHash}, equal=${baselineHash === workingHash}`);
        console.log(`rebuiltGraphIds: ${JSON.stringify(r.rebuiltGraphIds)}`);
        console.log(`edits applied: oldLen=${r.appliedEdits[0].oldContent.length}, newLen=${r.appliedEdits[0].newContent.length}`);

        r.dispose();
    }, 180_000);
});
