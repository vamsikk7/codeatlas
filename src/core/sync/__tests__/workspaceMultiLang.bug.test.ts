/**
 * ADR-034 multi-repo regression (#TDD-fix-1) — end-to-end via WorkspaceOrchestrator.
 *
 * Replicates the production Tier-1 flow:
 *   1. Construct AggregatorStore + RepoStoreRegistry
 *   2. Construct WorkspaceOrchestrator with a real per-repo runner that
 *      wires SnapshotStore + SyncOrchestrator (mirror of extension.ts:
 *      productionRepoRunner @ src/extension.ts:411)
 *   3. await orchestrator.initialize()
 *   4. Re-open each per-repo state.db and assert `files` is populated for
 *      every detected repo, regardless of language (Go, Java, TS, Python).
 *
 * The bug surfaced live: go-gin, java-spring, csharp-aspnet had `files=0`
 * in their per-repo state.db while ts-express-realworld and py-fastapi
 * had files populated. This isolates whether the bug is in the orchestrator
 * pipeline (cleared by something after initialize) or only manifests in
 * the worker-threads boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceOrchestrator, type RepoOrchestratorRunner } from '../workspaceOrchestrator';
import { RepoStoreRegistry } from '../../storage/repoStoreRegistry';
import { AggregatorStore } from '../../storage/aggregatorStore';
import { SnapshotStore } from '../../storage/snapshotStore';
import { SyncOrchestrator } from '../syncOrchestrator';
import { CommentStore } from '../../storage/commentStore';

const tmpDirs: string[] = [];

function makeWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsorch-multilang-'));
    tmpDirs.push(dir);
    return dir;
}

function seedGoRepo(ws: string, name: string): void {
    const dir = path.join(ws, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'go.mod'), `module ${name}\n`);
    fs.writeFileSync(path.join(dir, 'main.go'), `
package main
import "github.com/gin-gonic/gin"
func main() {
    r := gin.Default()
    r.GET("/api/health", func(c *gin.Context) {})
    r.POST("/api/articles", createArticle)
    r.Run()
}
func createArticle(c *gin.Context) {}
`);
}

function seedJavaRepo(ws: string, name: string): void {
    const dir = path.join(ws, name, 'src/main/java/com/example');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(ws, name, 'pom.xml'), `<project><artifactId>${name}</artifactId></project>`);
    fs.writeFileSync(path.join(dir, 'App.java'), `
package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class App {
    @GetMapping("/api/ping")
    public String ping() { return "pong"; }
    @PostMapping("/api/users")
    public String createUser() { return "ok"; }
}
`);
}

function seedTsRepo(ws: string, name: string): void {
    const dir = path.join(ws, name, 'src');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(ws, name, 'package.json'), JSON.stringify({ name, version: '0.0.1' }));
    fs.writeFileSync(path.join(dir, 'server.ts'), `
import express from 'express';
const app = express();
app.get('/api/ping', (_req, res) => res.send('pong'));
app.listen(3000);
`);
}

function seedPyRepo(ws: string, name: string): void {
    const dir = path.join(ws, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), `[project]\nname = "${name}"\n`);
    fs.writeFileSync(path.join(dir, 'app.py'), `
from fastapi import FastAPI
app = FastAPI()
@app.get("/api/health")
def health(): return {"ok": True}
`);
}

beforeEach(() => {
    RepoStoreRegistry.setForTest(null);
    WorkspaceOrchestrator.resetForTest();
});

afterEach(() => {
    WorkspaceOrchestrator.resetForTest();
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
});

describe('WorkspaceOrchestrator multi-lang per-repo init — files table population', () => {
    it('every per-repo state.db has files populated regardless of language', async () => {
        const ws = makeWorkspace();
        seedGoRepo(ws, 'svc-go');
        seedJavaRepo(ws, 'svc-java');
        seedTsRepo(ws, 'svc-ts');
        seedPyRepo(ws, 'svc-py');

        const registry = new RepoStoreRegistry();
        const aggregator = new AggregatorStore(ws);
        await aggregator.init();
        registry.registerAggregatorStore(ws, aggregator);

        // Mirror src/extension.ts:411 productionRepoRunner — real
        // SnapshotStore + SyncOrchestrator per repo.
        const runner: RepoOrchestratorRunner = async ({ workspaceRoot, repoRoot }) => {
            const perRepoStore = new SnapshotStore(repoRoot);
            registry.registerRepoStore(repoRoot, perRepoStore);
            const perRepoOrch = new SyncOrchestrator(
                workspaceRoot,
                perRepoStore,
                new CommentStore([]),
                undefined, undefined,
                repoRoot,
            );
            perRepoOrch.setLogger(() => { /* */ });
            await perRepoStore.load();
            await perRepoOrch.initialize();
        };

        const orch = new WorkspaceOrchestrator(ws, registry, () => { /* */ }, runner);
        const result = await orch.initialize();
        expect(result.mode).toBe('multi');
        expect(result.repoCount).toBe(4);
        expect(result.failures).toHaveLength(0);

        // Now re-open each per-repo state.db FROM DISK and verify files persisted.
        const repoNames = ['svc-go', 'svc-java', 'svc-ts', 'svc-py'];
        const fileCounts: Record<string, number> = {};
        for (const name of repoNames) {
            const repoRoot = path.join(ws, name);
            const fresh = new SnapshotStore(repoRoot);
            await fresh.load();
            const working = fresh.getWorking();
            fileCounts[name] = Object.keys(working.files).length;
            fresh.close();
        }
        // Every repo must have files persisted — not just the JS/Python ones.
        for (const name of repoNames) {
            expect(
                fileCounts[name],
                `expected files for ${name}; got ${fileCounts[name]}. Full counts: ${JSON.stringify(fileCounts)}`,
            ).toBeGreaterThan(0);
        }
    });
});
