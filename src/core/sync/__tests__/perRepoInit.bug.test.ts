/**
 * ADR-034 multi-repo regression (#TDD-fix-1) — per-repo `files` table empty.
 *
 * Live-verify against /tmp/multirepo-smoke on 2026-06-03 found that for
 * several language repos (go-gin, java-spring, csharp-aspnet) the per-repo
 * state.db ended up with `apis` rows but ZERO `files` rows after a
 * WorkspaceOrchestrator init through the Tier-2 worker pool.
 *
 * These tests bypass the worker harness and exercise the SyncOrchestrator
 * directly with `repoRoot !== workspaceRoot` to isolate whether the bug is
 * in the orchestrator (initialize doesn't store files for non-JS repos
 * under the multi-repo scoping) or in something later in the pipeline
 * (worker boundary, post-init re-init, etc.).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SyncOrchestrator } from '../syncOrchestrator';
import { SnapshotStore } from '../../storage/snapshotStore';
import { CommentStore } from '../../storage/commentStore';

const tmpWorkspaces: string[] = [];

function makeWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perrepo-init-'));
    tmpWorkspaces.push(dir);
    return dir;
}

beforeEach(() => { /* fresh tmp per test */ });

afterEach(() => {
    while (tmpWorkspaces.length) {
        const dir = tmpWorkspaces.pop()!;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
});

describe('SyncOrchestrator per-repo init — files table population', () => {
    it('Go repo scoped under workspaceRoot populates working.files', async () => {
        const ws = makeWorkspace();
        const repoRoot = path.join(ws, 'svc-go');
        fs.mkdirSync(repoRoot, { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'go.mod'), 'module svc-go\n');
        fs.writeFileSync(path.join(repoRoot, 'main.go'), `
package main
import "github.com/gin-gonic/gin"
func main() {
    r := gin.Default()
    r.GET("/api/health", func(c *gin.Context) {})
    r.Run()
}
`);
        fs.writeFileSync(path.join(repoRoot, 'routes.go'), `
package main
import "github.com/gin-gonic/gin"
func RegisterRoutes(r *gin.Engine) {
    r.POST("/api/articles", createArticle)
    r.GET("/api/articles/:slug", getArticle)
}
func createArticle(c *gin.Context) {}
func getArticle(c *gin.Context) {}
`);

        const store = new SnapshotStore(repoRoot);
        const sync = new SyncOrchestrator(
            ws,             // workspaceRoot
            store,
            new CommentStore([]),
            undefined,
            undefined,
            repoRoot,       // repoRoot (multi-repo scope)
        );
        sync.setLogger(() => { /* silence */ });

        await store.load();
        await sync.initialize();

        const working = store.getWorking();
        const fileKeys = Object.keys(working.files);
        expect(fileKeys.length, `expected files for Go repo; got ${JSON.stringify(fileKeys)}`).toBeGreaterThan(0);
        // Paths must be workspace-relative (prefixed with repo name) — this is
        // what the rest of the pipeline assumes for graphId matching.
        expect(fileKeys.some(k => k.startsWith('svc-go/'))).toBe(true);
        expect(working.files['svc-go/main.go']).toBeDefined();
        expect(working.files['svc-go/routes.go']).toBeDefined();
    });

    it('Java repo scoped under workspaceRoot populates working.files', async () => {
        const ws = makeWorkspace();
        const repoRoot = path.join(ws, 'svc-java');
        const srcDir = path.join(repoRoot, 'src/main/java/com/example');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(srcDir, 'HelloController.java'), `
package com.example;
import org.springframework.web.bind.annotation.*;
@RestController
public class HelloController {
    @GetMapping("/api/hello")
    public String hello() { return "world"; }
}
`);

        const store = new SnapshotStore(repoRoot);
        const sync = new SyncOrchestrator(
            ws, store, new CommentStore([]),
            undefined, undefined, repoRoot,
        );
        sync.setLogger(() => { /* */ });

        await store.load();
        await sync.initialize();

        const working = store.getWorking();
        const fileKeys = Object.keys(working.files);
        expect(fileKeys.length, `expected files for Java repo; got ${JSON.stringify(fileKeys)}`).toBeGreaterThan(0);
        expect(working.files['svc-java/src/main/java/com/example/HelloController.java']).toBeDefined();
    });

    it('TS repo scoped under workspaceRoot populates working.files (baseline-passing)', async () => {
        const ws = makeWorkspace();
        const repoRoot = path.join(ws, 'svc-ts');
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src/server.ts'), `
import express from 'express';
const app = express();
app.get('/api/ping', (_req, res) => res.send('pong'));
app.listen(3000);
`);

        const store = new SnapshotStore(repoRoot);
        const sync = new SyncOrchestrator(
            ws, store, new CommentStore([]),
            undefined, undefined, repoRoot,
        );
        sync.setLogger(() => { /* */ });
        await store.load();
        await sync.initialize();

        const working = store.getWorking();
        expect(working.files['svc-ts/src/server.ts']).toBeDefined();
    });

    it('Go repo files survive setBaselineFromWorking + save() round-trip', async () => {
        const ws = makeWorkspace();
        const repoRoot = path.join(ws, 'svc-go');
        fs.mkdirSync(repoRoot, { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'go.mod'), 'module svc-go\n');
        fs.writeFileSync(path.join(repoRoot, 'main.go'), `
package main
func main() {}
`);

        const store = new SnapshotStore(repoRoot);
        const sync = new SyncOrchestrator(
            ws, store, new CommentStore([]),
            undefined, undefined, repoRoot,
        );
        sync.setLogger(() => { /* */ });
        await store.load();
        await sync.initialize();
        // initialize already calls setBaselineFromWorking + save internally.
        store.close();

        const reopened = new SnapshotStore(repoRoot);
        await reopened.load();
        const baseline = reopened.getBaseline();
        const working = reopened.getWorking();
        expect(Object.keys(working.files).length, 'working.files after reopen').toBeGreaterThan(0);
        expect(Object.keys(baseline.files).length, 'baseline.files after reopen').toBeGreaterThan(0);
        expect(working.files['svc-go/main.go']).toBeDefined();
        expect(baseline.files['svc-go/main.go']).toBeDefined();
    });
});
