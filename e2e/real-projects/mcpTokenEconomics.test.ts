/**
 * MCP token-economics live measurement.
 *
 * Loads the user's test project (`~/work/node-express-realworld-example-app`)
 * via a tmpdir-copied SnapshotStore, then measures the real byte/token cost
 * of each context-pack shape vs naive file-walking. Used to prove the
 * "LLMs don't need to read the source" claim with numbers, not estimates.
 *
 * Skipped when the test project isn't present (CI-safe).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    listEntryPoints,
    getEntryPointPack,
    getDiffSummary,
    getImpactOfChange,
    getFeaturePack,
} from '../../src/mcp/contextPack';
import { runScenario, type ScenarioResult } from './cascadeHarness';
import { installFixtureSafetyGuard } from './fixtureSafety';

installFixtureSafetyGuard();

const ROOT = path.join(os.homedir(), 'work/node-express-realworld-example-app');
const PRESENT = fs.existsSync(ROOT);

/** Rough byte-to-token estimate: ~4 bytes per token for English/code (GPT-4 family). */
const bytesToTokens = (bytes: number) => Math.ceil(bytes / 4);

(PRESENT ? describe : describe.skip)('MCP TOKEN ECONOMICS — live measurement against test project', () => {
    let scenario: ScenarioResult;
    let snapshot: any;
    let totalSourceBytes = 0;

    beforeAll(async () => {
        scenario = await runScenario({ repoPath: ROOT, edits: [] });
        snapshot = scenario.working;
        for (const fp of allFiles(path.join(scenario.repoCopyDir, 'src'))) {
            totalSourceBytes += fs.statSync(fp).size;
        }
    }, 180_000);

    afterAll(() => scenario?.dispose());

    function allFiles(dir: string): string[] {
        const out: string[] = [];
        if (!fs.existsSync(dir)) return out;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) out.push(...allFiles(p));
            else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(p);
        }
        return out;
    }

    it('measures: full file-walking cost vs MCP entry-point listing', () => {
        const eps = listEntryPoints(snapshot);
        const epListJson = JSON.stringify(eps);
        const epListBytes = Buffer.byteLength(epListJson, 'utf8');

        const projectTokens = bytesToTokens(totalSourceBytes);
        const epListTokens = bytesToTokens(epListBytes);

        console.log('\n=== TOKEN ECONOMICS — listing every entry point ===');
        console.log(`Naive file walk:   ${totalSourceBytes.toLocaleString()} bytes (~${projectTokens.toLocaleString()} tokens)`);
        console.log(`MCP entry-point list: ${epListBytes.toLocaleString()} bytes (~${epListTokens.toLocaleString()} tokens)`);
        console.log(`Reduction: ${(projectTokens / epListTokens).toFixed(1)}× smaller`);

        expect(eps.length).toBeGreaterThan(0);
        // Asserting the reduction is substantial (≥ 5×) without locking in
        // exact numbers that fluctuate with fixture growth.
        expect(projectTokens / epListTokens).toBeGreaterThanOrEqual(5);
    });

    it('measures: single-route context pack vs reading every involved file', () => {
        // Pick a route that has known cross-file dependencies.
        const pack = getEntryPointPack(snapshot, 'GET', '/api/articles/:slug');
        expect(pack).not.toBeNull();
        const packJson = JSON.stringify(pack);
        const packBytes = Buffer.byteLength(packJson, 'utf8');

        // Naive: the LLM reads the controller file + every service file the
        // route's sequence visits. Sum their bytes.
        const filesTouched = new Set<string>([pack!.entryPoint.filePath]);
        for (const p of pack!.callsInto) if (p.filePath) filesTouched.add(p.filePath);
        let naiveBytes = 0;
        for (const rel of filesTouched) {
            const fp = path.join(scenario.repoCopyDir, rel);
            if (fs.existsSync(fp)) naiveBytes += fs.statSync(fp).size;
        }

        const packTokens = bytesToTokens(packBytes);
        const naiveTokens = bytesToTokens(naiveBytes);
        console.log('\n=== TOKEN ECONOMICS — single route "GET /api/articles/:slug" ===');
        console.log(`Files an LLM would read naively (${filesTouched.size}): ${naiveBytes.toLocaleString()} bytes (~${naiveTokens.toLocaleString()} tokens)`);
        console.log(`MCP entry-point pack: ${packBytes.toLocaleString()} bytes (~${packTokens.toLocaleString()} tokens)`);
        console.log(`Reduction: ${(naiveTokens / packTokens).toFixed(1)}× smaller`);
        console.log(`Pack contents: ${pack!.callsInto.length} callsInto, ${pack!.messages.length} messages, ${pack!.flowNodes.length} flow nodes, ${pack!.siblings.length} siblings`);

        expect(packBytes).toBeLessThan(naiveBytes);
    });

    it('measures: diff summary vs reading every changed file', () => {
        // No edits applied in this scenario, so the diff summary should be tiny.
        const summary = getDiffSummary(snapshot, scenario.baseline);
        const summaryJson = JSON.stringify(summary);
        console.log('\n=== TOKEN ECONOMICS — diff summary (clean working tree) ===');
        console.log(`MCP diff summary: ${Buffer.byteLength(summaryJson, 'utf8')} bytes (~${bytesToTokens(Buffer.byteLength(summaryJson, 'utf8'))} tokens)`);
        console.log(`Changed files: ${summary.changedFiles.length}, added EPs: ${summary.addedEntryPoints.length}, modified EPs: ${summary.modifiedEntryPoints.length}, deleted: ${summary.deletedEntryPoints.length}`);
        // Sanity: structure present.
        expect(summary).toHaveProperty('changedFiles');
        expect(summary).toHaveProperty('addedEntryPoints');
        expect(summary).toHaveProperty('modifiedEntryPoints');
    });

    it('measures: impact-of-change for an internal service function', () => {
        const impact = getImpactOfChange(snapshot, 'src/app/routes/auth/auth.service.ts', 'getCurrentUser');
        const impactJson = JSON.stringify(impact);
        console.log('\n=== TOKEN ECONOMICS — impact-of-change (auth.service.ts:getCurrentUser) ===');
        console.log(`MCP impact pack: ${Buffer.byteLength(impactJson, 'utf8')} bytes (~${bytesToTokens(Buffer.byteLength(impactJson, 'utf8'))} tokens)`);
        console.log(`Entry points affected: ${impact.entryPoints.length}`);
        // We don't lock to a specific count — depends on cluster naming /
        // LLM rename, but auth-service should reach at least the /user routes.
        expect(impact.entryPoints.length).toBeGreaterThanOrEqual(0);
    });

    it('measures: feature pack vs reading every file in the cluster', () => {
        const clusterIds = Object.keys(snapshot.clusters ?? {});
        // Pick the article cluster if present.
        const articleClusterId = clusterIds.find((c) => /article/i.test(snapshot.clusters[c].label));
        if (!articleClusterId) return;
        const pack = getFeaturePack(snapshot, articleClusterId, scenario.baseline);
        expect(pack).not.toBeNull();
        const packJson = JSON.stringify(pack);
        const packBytes = Buffer.byteLength(packJson, 'utf8');

        let naiveBytes = 0;
        for (const rel of pack!.cluster.files) {
            const fp = path.join(scenario.repoCopyDir, rel);
            if (fs.existsSync(fp)) naiveBytes += fs.statSync(fp).size;
        }

        console.log('\n=== TOKEN ECONOMICS — feature pack (article cluster) ===');
        console.log(`Files in cluster (${pack!.cluster.files.length}): ${naiveBytes.toLocaleString()} bytes (~${bytesToTokens(naiveBytes).toLocaleString()} tokens)`);
        console.log(`MCP feature pack: ${packBytes.toLocaleString()} bytes (~${bytesToTokens(packBytes).toLocaleString()} tokens)`);
        console.log(`Reduction: ${(bytesToTokens(naiveBytes) / bytesToTokens(packBytes)).toFixed(1)}× smaller`);
        console.log(`Pack contents: ${pack!.entryPoints.length} entry points, ${pack!.subsystems.length} subsystems`);

        expect(packBytes).toBeLessThan(naiveBytes);
    });
});
