/**
 * dump-real-state.ts
 *
 * Spawns one subprocess per repo (via dump-one-repo.ts) so a slow / hanging
 * project can be timed out without poisoning the whole batch. Persists
 * state.json into e2e/real-repos/<id>/.codeatlas/.
 *
 * Usage: npx tsx scripts/dump-real-state.ts [<repoId> …]
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const PER_REPO_TIMEOUT_MS = 120_000;

interface RepoSpec { id: string; }

async function runOne(repoId: string): Promise<{ id: string; ok: boolean; ms: number; output: string }> {
    return new Promise((resolve) => {
        const start = Date.now();
        const child = spawn(
            'npx',
            ['tsx', 'scripts/dump-one-repo.ts', repoId],
            { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '';
        const onData = (chunk: Buffer) => { out += chunk.toString(); };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ id: repoId, ok: false, ms: Date.now() - start, output: `(timeout after ${PER_REPO_TIMEOUT_MS}ms)\n${out}` });
        }, PER_REPO_TIMEOUT_MS);
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ id: repoId, ok: code === 0, ms: Date.now() - start, output: out });
        });
    });
}

async function main() {
    const repoRoot = path.resolve(__dirname, '..');
    const reposJson = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'e2e/real-projects/repos.json'), 'utf8'),
    ) as { repos: RepoSpec[] };
    const realReposDir = path.join(repoRoot, 'e2e/real-repos');

    const filterIds = new Set(process.argv.slice(2));
    const targets = filterIds.size > 0
        ? reposJson.repos.filter(r => filterIds.has(r.id))
        : reposJson.repos;

    const summary: Array<{ id: string; ok: boolean; ms: number }> = [];

    // Sequential is fine — each subprocess is bounded; total wall-clock <= 34 * 120s.
    for (const spec of targets) {
        const repoPath = path.join(realReposDir, spec.id);
        if (!fs.existsSync(repoPath)) {
            console.error(`[${spec.id}] not cloned, skipping`);
            continue;
        }
        const result = await runOne(spec.id);
        process.stdout.write(result.output);
        if (!result.ok) console.error(`[${spec.id}] FAIL after ${result.ms}ms`);
        summary.push({ id: spec.id, ok: result.ok, ms: result.ms });
    }

    fs.writeFileSync(
        path.join(realReposDir, '.dump-summary.json'),
        JSON.stringify(summary, null, 2),
    );
    const ok = summary.filter((s) => s.ok).length;
    console.log(`\nSummary: ${ok}/${summary.length} ok`);
}

main().catch((e) => { console.error(e); process.exit(1); });
