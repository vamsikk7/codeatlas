// TEMPORARY scratch probe — TICKET-DETECT-1: where ts-nextjs-pages EVENT_LISTENER/EMIT records come from. Delete after.
import { describe, it } from 'vitest';
import * as path from 'path';
import { runScenario } from './cascadeHarness';

describe('probe ts-nextjs-pages EVENT records', () => {
    it('dumps EVENT_LISTENER/EVENT_EMIT record files + routes', async () => {
        const repoPath = path.resolve(__dirname, '..', 'real-repos', 'ts-nextjs-pages');
        const r = await runScenario({ repoPath, edits: [] });
        const apis: any[] = Object.values((r.baseline as any).apiIndex || {});
        const events = apis.filter(a => a.method === 'EVENT_LISTENER' || a.method === 'EVENT_EMIT');
        console.log(`EVENT records: ${events.length}`);
        const byFile: Record<string, number> = {};
        for (const a of events) byFile[a.filePath] = (byFile[a.filePath] || 0) + 1;
        const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 12);
        console.log('top files by EVENT count:');
        for (const [f, n] of top) console.log(`  ${n}  ${f}`);
        console.log('sample routes (receiver.event):');
        for (const a of events.slice(0, 15)) console.log(`  ${a.method.padEnd(15)} ${a.route}  (recv=${a.handlerName})  ${a.filePath.split('/').slice(-2).join('/')}`);
        r.dispose();
    }, 300_000);
});
